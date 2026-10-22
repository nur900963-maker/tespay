# Vincent Pay

Vincent Pay is a self-hosted payment-platform starter with a customer dashboard, owner/admin panel, API-key invoice API, a transaction ledger, signed outbound webhooks, and **direct merchant adapters** for DANA QRIS Acquirer, ShopeePay Merchant Presented Mode (MPM), and GoBiz/GoPay QRIS.

**It does not route payments through Xendit, Midtrans, Pakasir, or another gateway aggregator.** QRIS is created by calling the provider's own API using a merchant account and API access that the operator has legitimately obtained. The application then displays the QR data returned by that provider and verifies payment status by querying the same provider API.

> **Important production boundary:** this source code is prepared for integration, but no live provider credentials or merchant contract were provided with the ZIP, so live transactions cannot be verified from this package alone. Provider API access, merchant approval, the exact base URL/key/certificate details supplied during onboarding, callbacks, settlement/reconciliation, and commercial/legal requirements must be completed and tested in each merchant's own sandbox before accepting real money. This project does not claim that Vincent Pay is a licensed PJP or QRIS acquirer. The withdrawal workflow is a review queue with manual transfer confirmation; automatic payout/disbursement adapters are not included.

## What is included

- Vincent Pay branding for the public website, user dashboard, and owner panel.
- Registration/login, password reset by SMTP, API-key management, profile settings, and webhook logs.
- Direct API adapters for DANA QRIS Acquirer MPM, ShopeePay Dynamic QR MPM, and GoBiz/GoPay QRIS.
- Invoice creation with a server-side idempotency key, local QR image generation from a QR payload returned by the selected merchant, expiry, status refresh, callback-triggered status re-query, and a ledger credit applied transactionally only after a verified provider status.
- Owner dashboard with current database statistics, merchant credential setup, encrypted provider secrets, provider test status, fee/limit configuration, transaction list, withdrawal queue, user suspension, and audit log.
- Configurable fixed + percentage QRIS fee and per-channel withdrawal fee.
- Withdrawal queue with balance hold, owner approval/rejection, balance refund on rejection, and a `paid` action only after the operator actually transfers the money.
- SQLite for a standalone server and PostgreSQL for deployments that need a persistent external database (including Vercel).

## Official provider references

Use the documentation and onboarding information issued for your merchant account. API access/fields can differ by product, contract, and environment.

- DANA QRIS Acquirer overview: https://dashboard.dana.id/api-docs-v2/api/qris-acquirer/overview
- DANA Generate QRIS: https://dashboard.dana.id/api-docs-v2/api/qris-acquirer/generate-qris
- DANA official Node SDK repository: https://github.com/dana-id/dana-node
- ShopeePay Merchant Presented Mode (dynamic QR + transaction query): https://product.shopeepay.co.id/integration/api/merchant-presented-mode
- GoBiz Payment Integration (QRIS create transaction + transaction details): https://developer.gobiz.com/docs/api/payment-integration/

The adapters in `utils/providers.js` call these provider APIs directly. They do not scrape merchant dashboards, reuse browser session cookies, or use unofficial portal tokens. Confirm each request/response field against the documentation version included in your merchant onboarding.

## 1. Run on a normal server / VPS / Pterodactyl

Requirements: Node.js 18 or newer (Node 20 LTS recommended), and npm.

```bash
unzip vincent-pay-server.zip
cd vincent-pay-server
npm install
cp .env.example .env
```

Edit `.env` before starting the process:

- `JWT_SECRET`: unique random value of at least 32 characters.
- `MASTER_ENCRYPTION_KEY`: a *different* unique random value; keep it stable and backed up because it encrypts stored merchant credentials.
- `ADMIN_EMAIL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`: your owner login; set a strong password of at least 12 characters before first startup.
- `PUBLIC_URL`: the public HTTPS base URL, with no trailing slash.
- Optional `DATABASE_URL`: omit it for local SQLite, or set a persistent PostgreSQL connection string for a production server.
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`: needed for email password recovery.

Then run:

```bash
npm start
```

Open `https://your-domain/admin` or `/login`. The owner account is seeded from the environment on first startup if no admin exists yet. Do not deploy with example secrets. For VPS/Pterodactyl use a persistent volume for `data/` if SQLite is selected; for important balances and production operation, PostgreSQL with routine backups is recommended.

## 2. Deploy the Vercel ZIP

The Vercel package includes `api/index.js` and `vercel.json`. **Vercel functions do not provide durable local-file storage**, so this package intentionally requires a persistent PostgreSQL database. Do not deploy it with SQLite.

1. Extract `vincent-pay-vercel.zip` and import the folder into Vercel/GitHub.
2. Provision a PostgreSQL database that permits connections from Vercel.
3. Configure these project environment variables in Vercel for the same deployment environment:
   - `DATABASE_URL` — PostgreSQL connection string.
   - `PGSSL=require` (or follow your database provider's TLS instructions).
   - `PG_POOL_MAX=2` for a serverless pool.
   - `NODE_ENV=production`.
   - `PUBLIC_URL=https://your-deployed-domain`.
   - `JWT_SECRET`, `MASTER_ENCRYPTION_KEY`, `ADMIN_EMAIL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`.
   - SMTP variables if password reset by email is required.
   - `CORS_ORIGIN` only if you need cross-origin API calls; use exact trusted origins.
4. Redeploy after the environment variables are saved.
5. Visit `/login`, then configure merchant APIs from the owner panel at `/admin`.

`MASTER_ENCRYPTION_KEY` must remain unchanged between deployments; changing it without re-encrypting provider configurations makes the saved credentials unreadable. Use a persistent database with backups. Do not include `.env` or credential files in the repository.

## 3. Configure direct merchant APIs

Log in as owner, open **Owner Panel → Integrasi Merchant**, and enter the credentials/IDs and base URLs provided for the appropriate official product. Save, then run the credential test where available. A token/API credential check is not the same as a complete payment test: use the provider's sandbox to create a small invoice and confirm that QR generation, payment status query, and callback delivery all work before enabling live traffic.

The owner panel accepts:

- **DANA Merchant QRIS:** API base URL, partner ID, merchant ID, store ID, channel ID, private signing key, and optional terminal/origin fields.
- **ShopeePay Merchant QRIS:** API base URL, client/partner ID, client secret, merchant/store IDs, private key and optional terminal/channel fields.
- **GoBiz/GoPay QRIS:** payment API URL, OAuth URL, client ID/secret, scope, and outlet ID.

Use the exact sandbox/production URLs, key format, certificate/partner ID, store IDs and permissions issued to the approved merchant. The mode selector is a label; the configured Base URL determines which environment gets called. Never paste the merchant web dashboard password or browser session token into these fields.

The callback URLs to register during provider onboarding (where supported) are:

```text
https://your-domain/api/provider-webhooks/dana
https://your-domain/api/provider-webhooks/shopeepay
https://your-domain/api/provider-webhooks/gopay
```

Provider callbacks are only triggers. Vincent Pay re-queries the appropriate provider API before marking an invoice paid or crediting the internal balance. Make sure the callback fields/reference mapping match your merchant's version of the API documentation.

## 4. Fee, balance and withdrawal behavior

- QRIS invoice fee = fixed amount + (invoice amount × percent / 100). The platform adds this configured fee to the customer-facing invoice total.
- Withdrawal fee is configured per DANA, GoPay, ShopeePay, and manual transfer.
- A withdrawal request debits the user's available balance and records a pending balance/ledger event.
- Owner approval only changes the request to `processing`; it does **not** send money. Transfer through the selected merchant/bank channel outside the application, then mark `paid` only after checking the real transfer. Rejecting a request refunds the hold.
- The current code includes no automated withdrawal/disbursement API. A payout adapter should only be added once its provider product, authorization, status query, idempotency, reconciliation and refund behavior are explicitly documented and tested.

## 5. Public API quick reference

Base URL: `https://your-domain/api`

Send the user's API key as `Authorization: Bearer vp_live_...`.

- `GET /profile` — profile and current available balance.
- `POST /createinvoice` — create invoice. JSON: `{"amount":50000,"provider":"dana"}`. Use a stable `Idempotency-Key` header for retry-safe requests.
- `GET /checkinvoice?id=INVOICE_ID` — check invoice status.
- `GET /pricing` — current fee/limits.
- `GET /stats` — aggregate public counters.
- `GET /health` — health check.

Example:

```bash
curl -X POST "https://your-domain/api/createinvoice" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-12345" \
  -d '{"amount":50000,"provider":"dana"}'
```

The API will fail clearly if the chosen merchant adapter is not enabled or lacks required merchant credentials; it will not generate a fake QR or accept a user-facing button as proof of payment. There is no demo login or demo balance seeded in the database.

## 6. Checks and maintenance

```bash
npm run check
npm run reset-db   # SQLite only; destructive. Refuses to run if DATABASE_URL is set.
```

Before production use, also complete end-to-end sandbox tests for all three providers, webhook verification/mapping from provider documents, reconciliation, monitoring, database backups, HTTPS, alerting, rate limiting at the edge, and an incident/credential-rotation procedure. Do not use a Vercel ephemeral filesystem for balances, invoices, or merchant secrets.
