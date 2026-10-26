/* Shared by the API (require) and the dashboards (<script>). Single source of truth for stages, fees and rollups. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WW = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const STAGES = [
    { key: 'received', label: 'Received' },
    { key: 'contacted', label: 'Contacted' },
    { key: 'appointment_set', label: 'Appointment set' },
    { key: 'proposal_sent', label: 'Proposal sent' },
    { key: 'signed', label: 'Signed' },
    { key: 'installed', label: 'Installed' },
    { key: 'lost', label: 'Lost' },
    { key: 'invalid', label: 'Invalid lead' },
  ];
  const KEYS = STAGES.map((s) => s.key);
  const LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));
  const IN_PLACE = ['signed', 'installed'];
  // Stage at which the lead fee becomes owed. Change here if the agreement says otherwise (e.g. 'installed').
  const FEE_TRIGGER = 'signed';
  // Referral milestones. `stage` = stage that unlocks it. Amounts from the referral program.
  const REFERRAL = {
    submitted: { label: 'Form submitted', cents: 5000, stage: null },
    estimate: { label: 'Estimate completed', cents: 10000, stage: 'proposal_sent' },
    installed: { label: 'Installed', cents: 100000, stage: 'installed', delayDays: 30 },
  };

  const idx = (k) => KEYS.indexOf(k);
  const DEAD = ['lost', 'invalid'];
  const reached = (stage, target) => !DEAD.includes(stage) && idx(stage) >= idx(target);

  function tierFor(tiers, kw) {
    if (kw === null || kw === undefined || kw === '' || isNaN(Number(kw))) return null;
    const n = Number(kw);
    return (tiers || []).find((t) => n >= Number(t.min_kw) && (t.max_kw === null || t.max_kw === undefined || n < Number(t.max_kw))) || null;
  }

  const modeOf = (partner) => (partner && partner.fee_mode === 'flat' ? 'flat' : 'split');
  /** Your share of a deal under a percentage split. null until both the percent and the partner's commission are known. */
  function shareFor(lead, partner) {
    const pct = partner && partner.split_percent != null && partner.split_percent !== '' ? Number(partner.split_percent) : null;
    if (pct === null || isNaN(pct)) return { pct: null, share: null };
    if (lead.commission_cents == null) return { pct, share: null };
    return { pct, share: Math.round((Number(lead.commission_cents) * pct) / 100) };
  }

  /** What you are owed on one lead.
   *  state: not_yet | on_hold | waived | credit_due | owed | paid
   *         | needs_commission | split_unset            (percentage split)
   *         | needs_size | no_tier | rate_unset          (flat fee by system size)
   *  cents = balance still owed (owed), full share (paid), or amount to credit back (credit_due).
   *  share_cents / collected_cents are always the total share and what has been received. */
  function feeFor(lead, tiers, trigger, partner) {
    trigger = trigger || FEE_TRIGGER;
    const split = modeOf(partner) === 'split';
    const collected = Number(lead.commission_collected_cents || 0);
    if (lead.stage === 'invalid') {
      if (lead.dispute_status !== 'accepted') return { state: 'on_hold', cents: 0, collected_cents: collected };
      const had = split ? collected : (lead.fee_paid_at ? ((tierFor(tiers, lead.system_kw) || {}).fee_cents || 0) : 0);
      return had > 0 || (!split && lead.fee_paid_at) ? { state: 'credit_due', cents: had, collected_cents: had } : { state: 'waived', cents: 0, collected_cents: 0 };
    }
    if (!reached(lead.stage, trigger)) return { state: 'not_yet', cents: 0, collected_cents: collected };

    if (split) {
      const { pct, share } = shareFor(lead, partner);
      if (pct === null) return { state: 'split_unset', cents: 0, collected_cents: collected };
      if (share === null) return { state: 'needs_commission', cents: 0, collected_cents: collected, pct };
      const balance = Math.max(0, share - collected);
      if (share > 0 && balance === 0) return { state: 'paid', cents: share, share_cents: share, collected_cents: collected, pct };
      if (share === 0) return { state: 'paid', cents: 0, share_cents: 0, collected_cents: collected, pct };
      return { state: 'owed', cents: balance, share_cents: share, collected_cents: collected, pct };
    }

    // flat fee by system size
    if (lead.fee_paid_at) {
      const t = tierFor(tiers, lead.system_kw);
      const c = t && t.fee_cents != null ? t.fee_cents : 0;
      return { state: 'paid', cents: c, share_cents: c, collected_cents: c };
    }
    if (lead.system_kw === null || lead.system_kw === undefined || lead.system_kw === '') return { state: 'needs_size', cents: 0, collected_cents: 0 };
    const t = tierFor(tiers, lead.system_kw);
    if (!t) return { state: 'no_tier', cents: 0, collected_cents: 0 };
    if (t.fee_cents === null || t.fee_cents === undefined) return { state: 'rate_unset', cents: 0, collected_cents: 0, tier: t.label };
    return { state: 'owed', cents: t.fee_cents, share_cents: t.fee_cents, collected_cents: 0, tier: t.label };
  }

  /** The date a fee became owed: when the deal reached the trigger stage. */
  function feeDate(lead, trigger) {
    trigger = trigger || FEE_TRIGGER;
    return (trigger === 'installed' ? lead.installed_at : lead.signed_at) || null;
  }

  const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  /** Ad spend vs results, by month. Leads are grouped by the month they arrived (UTC). */
  function marketing(real, spend, now) {
    const ym = (iso) => String(iso).slice(0, 7);
    const months = {};
    const row = (m) => (months[m] = months[m] || { month: m, spendCents: 0, leads: 0, signed: 0 });
    spend.forEach((x) => { row(x.month).spendCents += x.amount_cents; });
    real.filter((l) => l.stage !== 'invalid').forEach((l) => { const r = row(ym(l.created_at)); r.leads++; if (IN_PLACE.includes(l.stage)) r.signed++; });
    const list = Object.values(months).sort((a, b) => (a.month < b.month ? 1 : -1)).map((r) => ({
      ...r, cplCents: r.leads && r.spendCents ? Math.round(r.spendCents / r.leads) : null, cpsCents: r.signed && r.spendCents ? Math.round(r.spendCents / r.signed) : null,
    }));
    const tot = list.reduce((a, r) => ({ s: a.s + r.spendCents, l: a.l + r.leads, d: a.d + r.signed }), { s: 0, l: 0, d: 0 });
    return { months: list.slice(0, 12), totalSpendCents: tot.s, cplCents: tot.s && tot.l ? Math.round(tot.s / tot.l) : null, cpsCents: tot.s && tot.d ? Math.round(tot.s / tot.d) : null };
  }

  /** Customer-portal signals: threads waiting on the partner, reply speed, and customers who say they were not reached. */
  function portalStats(real, messages, now) {
    const by = {};
    messages.forEach((m) => (by[m.lead_id] = by[m.lead_id] || []).push(m));
    const waits = []; let unanswered = 0;
    Object.values(by).forEach((list) => {
      list.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      let pending = null;
      list.forEach((m) => {
        if (m.sender === 'customer') { if (!pending) pending = m; }
        else if (pending) { waits.push((new Date(m.created_at) - new Date(pending.created_at)) / 3600000); pending = null; }
      });
      if (pending && now - new Date(pending.created_at).getTime() > 24 * 3600e3) unanswered++;
    });
    waits.sort((a, b) => a - b);
    return {
      messagesUnanswered: unanswered,
      replyMedianHours: waits.length ? waits[Math.floor(waits.length / 2)] : null,
      contactConfirmedYes: real.filter((l) => l.contact_confirmed === 'yes').length,
      contactConfirmedNo: real.filter((l) => l.contact_confirmed === 'no').length,
      erasureRequests: real.filter((l) => l.deletion_requested_at).length,
    };
  }

  function buildSummary(d, now) {
    now = now || Date.now();
    const leads = d.leads || [];
    const tiers = d.tiers || [];
    const pmap = Object.fromEntries((d.partners || []).map((p) => [p.id, p]));
    const real = leads.filter((l) => !l.duplicate_of);
    const valid = real.filter((l) => l.stage !== 'invalid'); // flagged/credited leads don't count against close rate
    const monthStart = new Date(now); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const byStage = Object.fromEntries(KEYS.map((k) => [k, 0]));
    real.forEach((l) => { byStage[l.stage] = (byStage[l.stage] || 0) + 1; });

    // Cumulative funnel: how many leads have reached at least each stage (lost excluded)
    const funnel = KEYS.filter((k) => !DEAD.includes(k)).map((k) => ({
      key: k, label: LABEL[k], count: real.filter((l) => reached(l.stage, k)).length,
    }));

    let owed = 0, paid = 0, needsSetup = 0, credits = 0;
    real.forEach((l) => {
      const f = feeFor(l, tiers, undefined, pmap[l.partner_id]);
      l.fee = f;
      if (f.state === 'owed') owed += f.cents;
      if (f.state === 'paid' || f.state === 'owed') paid += f.collected_cents || 0;       // received so far (partial payments count)
      if (f.state === 'credit_due') credits += f.cents;
      if (['needs_size', 'no_tier', 'rate_unset', 'needs_commission', 'split_unset'].includes(f.state)) needsSetup++;
    });

    const payouts = d.payouts || [];
    const payoutsDue = payouts.filter((p) => p.status === 'pending' && (!p.due_at || new Date(p.due_at).getTime() <= now));
    const payoutsUpcoming = payouts.filter((p) => p.status === 'pending' && p.due_at && new Date(p.due_at).getTime() > now);

    const contacted = real.filter((l) => l.first_contacted_at);
    const speed = contacted.map((l) => (new Date(l.first_contacted_at) - new Date(l.created_at)) / 3600000).sort((a, b) => a - b);
    const medianHrs = speed.length ? speed[Math.floor(speed.length / 2)] : null;
    const stale = real.filter((l) => l.stage === 'received' && now - new Date(l.created_at).getTime() > 24 * 3600000);

    const deliveries = d.deliveries || [];
    const sentIds = new Set(deliveries.filter((x) => x.status === 'sent').map((x) => x.lead_id));
    const delivered = real.filter((l) => sentIds.has(l.id)).length;
    const unreported = real.filter((l) => l.stage === 'received' && now - new Date(l.created_at).getTime() > 7 * 864e5).length;

    // Acquisition: leads per week (last 8, Monday start, UTC), sources, cities, average bill
    const wk0 = (() => { const x = new Date(now); x.setUTCHours(0, 0, 0, 0); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.getTime(); })();
    const weeks = Array.from({ length: 8 }, (_, i) => {
      const start = wk0 - (7 - i) * 7 * 864e5;
      return { start: new Date(start).toISOString().slice(0, 10), count: real.filter((l) => { const t = new Date(l.created_at).getTime(); return t >= start && t < start + 7 * 864e5; }).length };
    });
    const tally = (keyFn) => {
      const m = {};
      real.filter((l) => l.stage !== 'invalid').forEach((l) => { const k = keyFn(l); if (!k) return; const r = (m[k] = m[k] || { name: k, count: 0, signed: 0 }); r.count++; if (IN_PLACE.includes(l.stage)) r.signed++; });
      return Object.values(m).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    };
    const sources = tally((l) => (l.utm && l.utm.utm_source) || l.source || 'Direct').slice(0, 8);
    const cities = tally((l) => l.city).slice(0, 8);
    const bills = real.map((l) => Number(l.monthly_bill)).filter((n) => n > 0);
    const acquisition = { weeks, sources, cities, avgBill: bills.length ? Math.round(bills.reduce((a, b) => a + b, 0) / bills.length) : null };

    // Per-partner results, for comparing reps
    const partnerStats = (d.partners || []).map((p) => {
      const mine = real.filter((l) => l.partner_id === p.id);
      return {
        id: p.id, name: p.name, company: p.company || null, leads: mine.length,
        delivered: mine.filter((l) => sentIds.has(l.id)).length,
        contacted: mine.filter((l) => l.first_contacted_at).length,
        inPlace: mine.filter((l) => IN_PLACE.includes(l.stage)).length,
        owedCents: mine.reduce((a, l) => a + (l.fee && l.fee.state === 'owed' ? l.fee.cents : 0), 0),
        paidCents: mine.reduce((a, l) => a + (l.fee && ['paid', 'owed'].includes(l.fee.state) ? l.fee.collected_cents || 0 : 0), 0),
        commissionCents: mine.reduce((a, l) => a + (Number(l.commission_cents) || 0), 0),
        splitPercent: p.split_percent == null ? null : Number(p.split_percent), feeMode: modeOf(p),
      };
    });
    return {
      kpis: {
        total: real.length,
        thisMonth: real.filter((l) => new Date(l.created_at).getTime() >= monthStart.getTime()).length,
        inPlace: real.filter((l) => IN_PLACE.includes(l.stage)).length,
        installed: byStage.installed,
        lost: byStage.lost,
        active: real.filter((l) => !['installed', 'lost', 'invalid'].includes(l.stage)).length,
        invalid: byStage.invalid,
        disputesPending: real.filter((l) => l.stage === 'invalid' && l.dispute_status === 'pending').length,
        creditsDueCents: credits,
        stale: stale.length,
        medianHoursToContact: medianHrs,
        closeRate: valid.length ? Math.round((valid.filter((l) => IN_PLACE.includes(l.stage)).length / valid.length) * 1000) / 10 : 0,
        feesOwedCents: owed, feesPaidCents: paid, feesNeedingSetup: needsSetup,
        payoutsDueCents: payoutsDue.reduce((s, p) => s + p.amount_cents, 0),
        payoutsUpcomingCents: payoutsUpcoming.reduce((s, p) => s + p.amount_cents, 0),
        deliveryFailures: deliveries.filter((x) => x.status === 'failed' || x.status === 'skipped').length,
        delivered, deliveryRate: real.length ? Math.round((delivered / real.length) * 100) : 0,
        contacted: contacted.length, contactRate: real.length ? Math.round((contacted.length / real.length) * 100) : 0, unreported,
        ...portalStats(real, d.messages || [], now),
      },
      byStage, funnel, acquisition, partnerStats, marketing: marketing(real, d.ad_spend || [], now),
    };
  }

  return { STAGES, KEYS, LABEL, IN_PLACE, FEE_TRIGGER, REFERRAL, tierFor, feeFor, shareFor, modeOf, feeDate, buildSummary, money, reached };
});
