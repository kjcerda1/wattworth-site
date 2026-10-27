# WattWorth

Solar lead-gen funnel plus the lead system behind it, deployed together on Vercel.

- `/` serves `wattworthsolar_platform.html`: the SunLoop funnel (bill, ownership, roof, then address and contact details, then the quote). The visitor must tick the consent box. The lead is POSTed to `/api/leads` on the same origin.
- `/api`, `/lib`: lead intake, delivery to your solar partner (email, text, webhook), partner updates, owner analytics, commission split, cron retries.
- `/portal/`: the customer app (installable PWA). Each customer gets a private link, sees where their project is, messages their specialist, gets push notifications and appointment reminders, and has their own referral link. Try it at `/portal/#t=demo`.
- `/partner/`: your partner's phone dashboard. `/admin/`: your follow-along dashboard. Try either with the access key `demo`.
- `wattworth*.zip` are the older funnel drafts and strategy notes. They are excluded from the deployed site (`.vercelignore`).

Funnel to dashboard in one line: visitor submits the funnel, `/api/leads` stores it with the exact consent wording, it goes to your partner by email, text and webhook, he updates the deal status and commission on his phone, and you follow along.

---

# WattWorth lead tracking + partner dashboard

Self-contained module for your Vercel project. Plain HTML/CSS/JS and Node serverless functions, no frameworks, no npm dependencies. Aurora is not used anywhere.

## How it is meant to be used
Your partner runs every lead start to finish on his own company platform. This system only captures leads from your funnel, sends each one to him, and gives you a dashboard to follow along. You manage nothing day to day.
- **Overview**: leads per week, where they come from (ad source), top cities, how many reached your partner, how many he contacted, deals in place, commission owed, and a side-by-side table once you add more reps.
- **Statuses**: deal outcomes come from your partner. Easiest for him: his CRM or Zapier posts updates to `/api/inbound` (zero extra work), or he taps statuses in `/partner/`. Without either, you still see every lead and what was sent, but not which deals closed.
- **Optional**: Settings (commission rates, ad spend, invalid-lead review, CSV export) and monthly statements. Invalid-lead flags are accepted automatically after 5 days. Partner nudges are off unless you set `NUDGE_PARTNERS=true`.
- **Adding another rep**: Partners tab -> add -> send the link and key. Each rep's results appear in the By partner table.

## What it does
- **Funnel -> `POST /api/leads`**: stores the lead and the exact consent wording shown, then sends it to the partner by email (Resend), SMS (Twilio) and optional webhook. Every send is logged per channel, failures retry every 15 min (max 5).
- **Partner dashboard `/partner/`**: the partner signs in with a personal access key on his phone, sees his leads, taps one, sets the status, system size, contract value and a note. Full history is kept.
- **Owner dashboard `/admin/`**: pipeline, deals in place, what was sent and whether it arrived (with Resend button), your percentage share of each deal's commission (with partial payments and an after-ad-spend view), referral rewards (one $1,000 reward per referred installation, verified by you before payment), partner management, CSV export.
- **Works with any partner system**: `POST /api/inbound` lets his CRM, Zapier or Make push status updates by lead ref; the webhook pushes new leads into his CRM; `/api/export` gives CSV.

## Also included
- **Invalid-lead disputes**: Pedro marks a lead "Invalid lead" with a required reason (wrong number, renter...). You get an alert and accept or decline in the Deals tab. Accepted = no commission share (or a credit if you were already paid on it); declined = the lead goes back to its previous stage.
- **Alerts to you** (`OWNER_EMAIL`, `OWNER_PHONE`): a send that fails 5 times, a deal reaching Signed, and a daily summary at 9am Central. Each alert is sent once. Email and text work independently, so if one is down the other still goes out.
- **Nudges to Pedro** (off by default, set `NUDGE_PARTNERS=true`): once a day, email and text listing leads nobody has contacted in 24 hours.
- **Monthly statements**: Money tab -> pick month and partner -> open (print or save as PDF) or email it. Includes credits for invalid leads and lists unpriced deals separately. Optional `STATEMENT_PAYMENT_NOTE` (how to pay you) and `STATEMENT_ISSUER`.
- **Ad spend**: Money tab -> add monthly spend. The Overview then shows cost per lead and cost per signed deal.
- **Intake rate limit**: 5 submissions per IP per hour (add Vercel firewall rules too).

## Setup (about 15 minutes)
1. Create a NEW Supabase project for WattWorth (do not reuse another product's project), then in its SQL editor run `supabase/schema.sql`. It enables RLS on every table, creates the private `electric-bills` bucket with a restrictive storage policy, and strips table privileges from the browser roles. The service-role key stays in Vercel env vars only.
2. Copy this folder's `api/`, `lib/`, `assets/`, `partner/`, `admin/`, `vercel.json` into your WattWorth Vercel project (merge `vercel.json` if you have one).
3. Vercel env vars:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `ADMIN_TOKEN` (long random string; your owner login)
   - `CRON_SECRET` (long random string)
   - `APP_URL` (e.g. https://wattworth.yourdomain.com)
   - `ALLOWED_ORIGINS` (comma list of funnel origins that post to /api/leads)
   - `OWNER_EMAIL`, `OWNER_PHONE` (your alerts)
   - `RESEND_API_KEY`, `MAIL_FROM`
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (optional; not needed while your partner is email-only)
   - Customer app: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (run `npm install && npm run vapid` once and paste the output; keep the private key secret and never change it later or every customer has to re-enable notifications)
   - Customer replies by email: `INBOUND_EMAIL_DOMAIN` (a domain or subdomain you verified for receiving in Resend), `RESEND_WEBHOOK_SECRET` (signing secret of the webhook below)
   - `DISPLAY_TZ` (default `America/Chicago`, used in reminder wording)
4. Resend inbound (so Pedro can answer a customer just by replying to the email): add your receiving domain in Resend, add its MX record, then create a webhook for the `email.received` event pointing to `https://YOUR-DOMAIN/api/emailin` and copy its signing secret into `RESEND_WEBHOOK_SECRET`. Replies only count when they come from the partner's own email address; quoted text is stripped.
5. Deploy. Open `/admin/`, sign in with `ADMIN_TOKEN`, Partners tab -> add Pedro -> copy his access key (shown once) -> send him `/partner/` plus the key.
6. Partners tab -> add the phone customers will see him call from, and set your share (%) for each partner and who pays for ads. Leave it blank until you've agreed it in writing; nothing is counted until it's set.
7. The funnel already posts to `/api/leads`; no snippet needed.

Local run: `ADMIN_TOKEN=dev node dev.js` (in-memory store, no keys needed). Tests: `npm test`. Enter `demo` as the key on either sign-in screen for sample data.

## Cron note
`vercel.json` runs retries every 15 minutes and the daily summary at 14:00 UTC. Vercel's free Hobby plan only allows daily crons: if you are on Hobby, keep the daily one and have Make.com call `GET /api/cron` every 15 minutes with header `Authorization: Bearer <CRON_SECRET>` (and remove the 15-minute entry from `vercel.json`).

## Things you must set or confirm
- **Commission split**: you earn a percentage of the commission your partner's company pays them on each deal. Set it once per partner (Partners tab). Typical: 30% for you if the partner pays for ads, 40% if you do, but that is a business decision, so agree it in writing first. The percentage is blank on purpose and nothing is counted until it is set.
- **How the amount gets in**: your partner enters "Your company's commission on this deal" on signed or installed deals in his dashboard (or his CRM posts it to `/api/inbound` with `commission_dollars`). You can also type it yourself in the deal. It is self-reported, so ask for his company's payout statements and keep them with your agreement.
- **Staged payments**: companies often pay commission in stages (signing, install, final). When he updates the total earned so far, your share updates. Use "Add payment" in the Money tab as money reaches you; the balance falls and the deal turns Paid at zero. "Paid in full" settles it in one tap.
- **Flat-fee mode** still exists per partner (`fee_mode: 'flat'`, rates by system size in Settings) for a partner who prefers a fixed fee per deal.
- **When your share is owed**: `FEE_TRIGGER` in `lib/shared.js` (default: Signed). Change to `installed` if that's the deal.
- **Referral program**: the only customer reward is **$1,000 after the referred homeowner completes a verified qualifying solar installation**. Nothing is earned at form submission or estimate. Each referred lead gets one `referral_rewards` row (unique per lead), which moves `tracking` -> `installation_confirmed` (partner reports Installed) -> `reward_pending` (you verify the installation, Money tab) -> `paid` (you record a payment reference). Nothing is paid automatically; lost or invalid leads become `ineligible`.
- **TCPA / referral wording**: the consent text and referral-program terms are yours to have an attorney review; the code does not change them. The funnel must send `consent: true` and the exact `consent_text` it displayed; intake rejects anything without both.
- Partner access keys are stored hashed. Rotate one from the Partners tab if a phone is lost.

## Required utility verification
Every homeowner must give at least one complete method: an electric bill upload (PDF, JPG or PNG, max 3 MB) **or** electric provider + meter number, or both. A provider without a meter (or the reverse) is rejected, even with a bill attached. The server enforces this on `POST /api/leads` (size, declared MIME type, file signature, empty or truncated files); the funnel's own checks are only a convenience, and the database has a matching check constraint.
- Bills are stored in a **private** Supabase Storage bucket (`electric-bills`, created by `schema.sql`). The leads table keeps only the object path, filename, MIME type and SHA-256. There is no public bucket and no permanent URL.
- Pedro and you open a bill through `GET /api/bill?lead_id=...` (partner key for his own leads, or the admin token). Each view is logged. `&signed=1` returns a 60-second signed URL instead.
- Customers never see the meter number, the bill, its path or internal notes in their tracker.
- Deleting a lead (admin Erase) also deletes its stored bill.
- Request size: bills travel as base64 inside the JSON request, so keep the 3 MB cap (Vercel's request limit is about 4.5 MB).

## Customer app (`/portal/`)
- **Access**: a private link (`/portal/#t=<token>`) is shown after the funnel and emailed to the customer. The token sits in the URL fragment so it never reaches server logs. Customers who lose it enter their email on the app's first screen and get a fresh link. Duplicate submissions never get a token; the original email gets the link instead.
- **What customers see**: progress steps, consultation time, their specialist's name, company and phone, messages, referral link and earnings status. They never see notes, commission, fees, consent records or the partner's email.
- **Messaging**: customer messages arrive by email to the partner with a reply-to address; replying to that email posts into the customer's thread. Partners can also reply from `/partner/`.
- **Notifications**: push first (Android and desktop immediately; iPhone only after Add to Home Screen, iOS 16.4+), email fallback only when push is not available. Stage changes, new messages, and consultation reminders (24h and 1h before) are sent once each. Reminders rely on the 15-minute cron (Vercel Pro).
- **Privacy**: customers can request deletion in the app; their link is revoked immediately and you get an alert; erase from Deals in `/admin/`.
- **Referrals (V2)**: each customer's code is issued by the server. Attribution is captured server-side: unknown codes, self-referrals (same phone or email) and duplicates are ignored, the first valid referral wins, and one lead has one referrer. The Refer tab shows the code, personal link, QR code, Share/Copy and a ready-to-share message with a disclosure line, plus aggregate counts (Total, Verified, In progress, Installed, Reward pending, Paid) and an anonymized list ("Referral #1"). The referrer API returns a purpose-built object, never a lead row: no names, contact details, address, ZIP, provider, meter, bill, notes, proposal or partner commission. Milestone notifications: verification complete, moving forward, reward pending, reward paid. Only the owner can verify or undo an installation, mark a reward paid (with a payment reference), mark ineligible or reinstate, and override attribution (reason required, written to the audit trail). Partners can only report Installed; that is a flag, not a reward.
