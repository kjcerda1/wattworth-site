# WattWorth MVP

A lightweight solar prequalification and lead-routing website for Arden Home.

## Included

- Plain HTML, CSS, and JavaScript
- Six-step homeowner questionnaire
- Conservative preliminary estimate
- Flexible utility verification: homeowners can upload a PDF/PNG/JPG electric bill up to 3 MB, enter electric provider plus meter number, or provide both
- Vercel serverless lead endpoint
- Google Sheets storage through a protected webhook
- Google Drive bill-file storage through Apps Script
- Referral code capture and secure aggregate referral dashboard summary protected by a private access token
- Privacy, terms, and estimate-disclaimer pages

Aurora, Twilio, Resend, customer accounts, financing quotes, tax-credit claims, and PDF generation are intentionally excluded from this MVP.

## Validate

```bash
npm run check
```

## Deploy

1. Import this repository into Vercel.
2. Add `GOOGLE_SHEETS_WEBHOOK_URL` and `WATTWORTH_WEBHOOK_SECRET` as Vercel environment variables.
3. In Apps Script, set script properties for `WATTWORTH_WEBHOOK_SECRET`, `WATTWORTH_SPREADSHEET_ID`, and `WATTWORTH_BILL_UPLOAD_FOLDER_ID`.
4. Deploy.
5. Submit bill-only, meter-only, and combined verification test leads before sending traffic. Bill submissions should create a private Drive file URL; meter-only submissions should create a Sheet row without a Drive file.
6. Create a `Referral Admin` sheet with `Referral Code`, `Access Token SHA-256`, `Status`, `Created At`, and `Notes` columns. Generate each private dashboard token with at least 32 cryptographically secure random bytes, give the raw token only to the intended referrer, and store only its SHA-256 hash in the sheet. Visit `/referrals.html?access=<private-token>` and confirm the aggregate dashboard summary loads without exposing personal details. Referral rewards remain $1,000 after a verified qualifying solar installation and are not automatic payouts.

The API fails closed: customers will not see a successful result when lead or bill storage is unavailable.


## Upload Limit

The current implementation sends bill files as base64 inside a JSON request to a Vercel Function. Vercel Functions have a 4.5 MB request body limit, and base64 adds roughly one third overhead before JSON framing. To keep the current path fail-closed under that platform limit, the implemented upload cap is 3 MB.

To support 5 MB or larger bills reliably, use a direct-to-storage upload flow instead of proxying the file through the Vercel Function. The smallest secure next architecture is: Vercel validates lead metadata and issues a short-lived signed upload token; the browser uploads the bill directly to the storage target; storage returns a private file reference; Vercel finalizes the lead row only after the private file reference is confirmed. Do not expose the webhook secret or a public bill URL to the browser.

## Referral Dashboard Access

Referral codes are used for lead attribution only. Dashboard access requires a separate private token. Generate each token with at least 32 random bytes from a cryptographically secure generator, store the raw token only in the private dashboard URL shared with the referrer, and store only the token's SHA-256 hash in the `Referral Admin` sheet. The public dashboard API accepts the private token, hashes it server-side, and asks Apps Script to compare the hash against the admin sheet.

The referral dashboard response is intentionally aggregate-only. It must not include names, contact details, ZIP codes, meter numbers, utility data, bill metadata, notes, Sheet rows, or Drive data.