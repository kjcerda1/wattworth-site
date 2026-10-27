/* Referral program: exactly ONE monetary reward, $1,000 (100000 cents), after the referred homeowner completes a
   verified qualifying solar installation. Everything before that is tracking only and earns $0.

   Journey: share -> homeowner submits their own request -> utility verification -> lead progresses ->
            installation verified by the owner -> $1,000 reward pending -> owner marks it paid.

   Rules enforced here (and by the database):
   - the referrer is chosen server-side from a real, eligible customer's own code; unknown codes are ignored,
     self-referrals (same phone or email) are rejected; first valid referral wins and is permanent
   - one lead has at most one referrer; one referred lead has at most one reward row (unique lead_id)
   - duplicates never create a reward
   - only an owner/admin can verify an installation, undo it, mark paid, or override attribution (every one is audited)
   - the partner can only report Installed on the underlying lead, which is a flag and earns nothing */
const db = require('./db');
const W = require('./shared');

const AMOUNT = W.REFERRAL.cents; // 100000
const DEAD = ['lost', 'invalid'];

// Tracking milestones (display only, none of them pay anything)
const MILESTONES = {
  submitted: 'Submitted',
  verification_complete: 'Verification complete',
  consultation: 'Consultation',
  installation_review: 'Installation being verified',
  installation_verified: 'Installation verified',
  reward_pending: 'Installation verified: $1,000 reward pending',
  paid: 'Reward paid',
  ineligible: 'Not eligible',
};

const event = (lead_id, type, actor, from_value, to_value, note) =>
  db.insert('lead_events', { lead_id, type, actor, from_value: from_value ?? null, to_value: to_value ?? null, note: note ?? null });
// db.update returns the changed rows; callers here want the single row
const upd = async (t, w, p) => { const r = await db.update(t, w, p); return Array.isArray(r) ? r[0] : r; };
const norm = (s) => String(s || '').trim().toLowerCase();

/** A code is usable only if it belongs to a real, current customer who is not the referred person. */
async function eligibleReferrer(code, who = {}) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  const owner = await db.get('leads', { own_code: c });
  if (!owner || owner.deletion_requested_at || ['invalid'].includes(owner.stage)) return null;
  if (who.phone && owner.phone === who.phone) return null;                                  // self referral
  if (who.email && owner.email && norm(owner.email) === norm(who.email)) return null;        // self referral, same email
  return owner;
}
const labelName = (o) => `${o.first_name}${o.last_name ? ' ' + o.last_name[0] + '.' : ''}`;

/** The referral record for a referred lead. Idempotent: never more than one per lead. */
async function ensureReward(lead) {
  if (!lead.referrer_code || lead.duplicate_of) return null;
  const existing = await db.select('referral_rewards', { where: { lead_id: lead.id } });
  if (existing.length) return existing[0];
  return db.insert('referral_rewards', {
    lead_id: lead.id, referrer_code: lead.referrer_code, amount_cents: 0, status: 'tracking',
    installation_confirmed_at: null, installation_verified_at: null, verified_by: null, reward_pending_at: null,
    paid_at: null, paid_by: null, transaction_ref: null, ineligible_reason: null,
  });
}

/** Where a referral is, for display. Derived, never pays anything. */
function milestoneOf(r, lead) {
  if (r.status === 'paid') return 'paid';
  if (r.status === 'ineligible') return 'ineligible';
  if (r.status === 'reward_pending') return 'reward_pending';
  if (r.status === 'installation_confirmed') return 'installation_review';
  if (lead && (lead.appointment_at || W.reached(lead.stage, 'appointment_set'))) return 'consultation';
  return lead && lead.verification_method ? 'verification_complete' : 'submitted';
}

/* ---------- referrer notifications: meaningful milestones only, never any homeowner detail ---------- */
const COPY = {
  verification_complete: ['Referral update', 'Your referral completed WattWorth verification.'],
  consultation: ['Referral update', 'Your referral is moving forward.'],
  reward_pending: ['Your $1,000 reward is pending', 'Great news — a qualifying solar installation was verified. Your $1,000 reward is pending.'],
  paid: ['Reward marked paid', 'Your $1,000 WattWorth referral reward has been marked paid.'],
};
async function notifyReferrer(r, kind) {
  const copy = COPY[kind];
  if (!copy) return;
  const referrer = await db.get('leads', { own_code: r.referrer_code });
  if (!referrer || referrer.deletion_requested_at) return;
  await require('./portal').notifyCustomer(referrer, { key: `ref:${r.id}:${kind}`, title: copy[0], body: copy[1], tag: 'referral' });
}

/** Bring the record in line with the underlying lead and send the milestone notification. Safe to call on every update. */
async function onProgress(lead) {
  if (!lead || !lead.referrer_code || lead.duplicate_of) return null;
  let r = await ensureReward(lead);
  if (!r) return null;
  if (!['paid', 'ineligible', 'reward_pending'].includes(r.status)) {
    if (DEAD.includes(lead.stage)) {
      r = await upd('referral_rewards', { id: r.id }, { status: 'ineligible', ineligible_reason: 'Lead closed: ' + lead.stage });
    } else if (r.status === 'tracking' && W.reached(lead.stage, W.REFERRAL.stage)) {
      // The partner reported Installed. A flag only: $0 until the owner verifies the installation.
      await event(lead.id, 'reward', 'system', null, 'installation_reported', null);
      r = await upd('referral_rewards', { id: r.id }, { status: 'installation_confirmed', installation_confirmed_at: new Date().toISOString() });
    }
  }
  const m = milestoneOf(r, lead);
  if (m === 'verification_complete' || m === 'consultation') await notifyReferrer(r, 'verification_complete');
  if (m === 'consultation') await notifyReferrer(r, 'consultation');
  return r;
}
const syncReward = onProgress;

/* ---------- owner/admin actions (callers must have checked admin auth) ---------- */
const HttpErr = (status, message) => Object.assign(new Error(message), { status });

async function verifyInstallation(r, actor) {
  if (r.status !== 'installation_confirmed') throw HttpErr(409, 'The installation has not been reported by the partner yet');
  const now = new Date().toISOString();
  const u = await upd('referral_rewards', { id: r.id }, { status: 'reward_pending', amount_cents: AMOUNT, installation_verified_at: now, verified_by: actor, reward_pending_at: now });
  await event(r.lead_id, 'reward', actor, 'installation_confirmed', 'reward_pending', 'Installation verified; $1,000 reward pending');
  await notifyReferrer(u, 'reward_pending');
  return u;
}
async function undoVerification(r, actor) {
  if (r.status !== 'reward_pending') throw HttpErr(409, r.status === 'paid' ? 'Already paid' : 'Nothing to undo');
  const u = await upd('referral_rewards', { id: r.id }, { status: 'installation_confirmed', amount_cents: 0, installation_verified_at: null, verified_by: null, reward_pending_at: null });
  await event(r.lead_id, 'reward', actor, 'reward_pending', 'installation_confirmed', 'Verification undone');
  return u;
}
async function markPaid(r, actor, reference) {
  if (r.status !== 'reward_pending') throw HttpErr(409, 'Verify the installation before recording a payment');
  const ref = String(reference || '').trim().slice(0, 120);
  if (!ref) throw HttpErr(400, 'Enter a payment reference (check number, transfer id)');
  const u = await upd('referral_rewards', { id: r.id }, { status: 'paid', paid_at: new Date().toISOString(), paid_by: actor, transaction_ref: ref });
  await event(r.lead_id, 'reward', actor, 'reward_pending', 'paid', 'Payment ref ' + ref);
  await notifyReferrer(u, 'paid');
  return u;
}
async function markIneligible(r, actor, reason) {
  if (r.status === 'paid') throw HttpErr(409, 'Already paid');
  const why = String(reason || '').trim().slice(0, 200) || null;
  const u = await upd('referral_rewards', { id: r.id }, { status: 'ineligible', amount_cents: 0, installation_verified_at: null, verified_by: null, reward_pending_at: null, ineligible_reason: why });
  await event(r.lead_id, 'reward', actor, r.status, 'ineligible', why);
  return u;
}
async function reinstate(r, actor) {
  if (r.status !== 'ineligible') throw HttpErr(409, 'Only a not-eligible referral can be reinstated');
  await upd('referral_rewards', { id: r.id }, { status: 'tracking', ineligible_reason: null });
  await event(r.lead_id, 'reward', actor, 'ineligible', 'tracking', 'Reinstated');
  return onProgress(await db.get('leads', { id: r.lead_id }));
}

/** Change (or clear) who referred a lead. Owner/admin only, reason required, always audited. First valid referral otherwise wins. */
async function overrideReferrer(lead, newCode, actor, reason) {
  const why = String(reason || '').trim().slice(0, 300);
  if (!why) throw HttpErr(400, 'A reason is required to change a referral');
  const existing = (await db.select('referral_rewards', { where: { lead_id: lead.id } }))[0] || null;
  if (existing && existing.status === 'paid') throw HttpErr(409, 'This reward was already paid; attribution is locked');
  const from = lead.referrer_code || null;
  let to = null, toName = null;
  if (newCode) {
    const owner = await eligibleReferrer(newCode, { phone: lead.phone, email: lead.email });
    if (!owner) throw HttpErr(400, 'That code is not an eligible referrer for this lead');
    to = owner.own_code; toName = labelName(owner);
  }
  if (to === from) throw HttpErr(409, 'That is already the referrer');
  const updated = await upd('leads', { id: lead.id }, { referrer_code: to, referrer_name: toName });
  if (!to) {
    if (existing) await markIneligible(existing, actor, 'Referral removed by admin: ' + why);
  } else if (existing) {
    await upd('referral_rewards', { id: existing.id }, { referrer_code: to, ...(existing.status === 'ineligible' ? { status: 'tracking', ineligible_reason: null } : {}) });
  } else {
    await ensureReward({ ...updated, referrer_code: to });
  }
  await event(lead.id, 'referral_override', actor, from, to, why);
  await onProgress(await db.get('leads', { id: lead.id }));
  return db.get('leads', { id: lead.id });
}

module.exports = { AMOUNT, MILESTONES, eligibleReferrer, ensureReward, syncReward, onProgress, milestoneOf, notifyReferrer, verifyInstallation, undoVerification, markPaid, markIneligible, reinstate, overrideReferrer, labelName };
