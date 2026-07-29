# WattWorth MVP

A lightweight solar prequalification and lead-routing website for Arden Home.

## Included

- Plain HTML, CSS, and JavaScript
- Five-step homeowner questionnaire
- Conservative preliminary estimate
- Vercel serverless lead endpoint
- Google Sheets storage through a protected webhook
- Privacy, terms, and estimate-disclaimer pages

Aurora, Twilio, Resend, referral rewards, customer dashboards, financing quotes, and PDF generation are intentionally excluded from this MVP.

## Validate

```bash
npm run check
```

## Deploy

1. Import this repository into Vercel.
2. Add `GOOGLE_SHEETS_WEBHOOK_URL` and `WATTWORTH_WEBHOOK_SECRET` as environment variables.
3. Deploy.
4. Submit a test lead and confirm the row appears in the shared sheet before sending traffic.

The API fails closed: customers will not see a successful result when lead storage is unavailable.
