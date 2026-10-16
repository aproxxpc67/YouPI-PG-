# Configuration & Secret Management Guide

## 1. Environment Parameters Reference

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | Runtime environment (`development` or `production`) |
| `CONTROL_CENTER_PORT` | `8090` | Host port for the Local Process Supervisor |
| `PAYMENT_API_PORT` | `6100` | Host port for the central Payment Core REST API |
| `CHECKOUT_PORTAL_PORT` | `7000` | Host port for the customer-facing Checkout page |
| `MERCHANT_ADMIN_PORT` | `6001` | Host port for the Merchant Admin Dashboard |
| `HELP_PORTAL_PORT` | `3000` | Host port for the Customer Payment Help Portal |
| `GMAIL_OBSERVER_PORT` | `6003` | Host port for the Gmail Polling Service & OAuth Callback |
| `SMS_OBSERVER_PORT` | `6002` | Host port for the Google Messages / SMS Web Automator |
| `DATABASE_URL` | `postgresql://...` | PostgreSQL connection URL |
| `USE_SQLITE_FALLBACK` | `true` | When true, uses embedded SQLite if PostgreSQL is unreachable |
| `SQLITE_DB_PATH` | `./data/youpi_pg.sqlite`| Path to local SQLite database file |
| `ENCRYPTION_MASTER_KEY` | `64-hex chars` | 256-bit key for encrypting OAuth credentials and device keys |
| `JWT_SECRET` | `32+ chars` | Secret key for customer and admin session tokens |
| `PAYMENT_ACTIVE_WINDOW_MS` | `300000` | Duration of active payment slot (5 minutes = 300,000ms) |
| `PAYMENT_PROCESSING_WINDOW_MS` | `30000` | Duration of verification slot (30 seconds = 30,000ms) |
| `LATE_OBSERVATION_WINDOW_MS` | `1800000` | Safety window for matching late observations (30 minutes) |
| `ANDROID_ENROLLMENT_SECRET` | auto-generated | Secret used to authorize device QR pairing. If unset, a random value is created in `data/.secrets/android_enrollment_secret` |
| `ADMIN_API_TOKEN` | auto-generated | Bearer token required by `/api/v1/admin/*` (the Merchant Admin page asks for it once per tab). If unset, a random value is created in `data/.secrets/admin_api_token` |
| `OBSERVER_API_TOKEN` | auto-generated | Bearer token the local Gmail/SMS observers use to submit observations (`data/.secrets/observer_api_token`) |
| `COIN_STORE_WEBHOOK_SECRET` | auto-generated | Webhook secret seeded for the default merchant and used by the demo coin store (`data/.secrets/coin_store_webhook_secret`) |
| `YOUPI_EXPOSE_DEV_OTP` | unset | Set to `true` for local development to get the OTP in the `send-otp` response. Ignored when `NODE_ENV=production` |
| `YOUPI_ALLOW_DEV_TOOLS` | unset | Developer test-mode / simulator endpoints (`/admin/dev/*`, `simulate-observation`) are refused when `NODE_ENV=production` unless this is `true` |
| `GMAIL_REDIRECT_URI` | derived | Gmail OAuth redirect URI. Defaults to `<gmail host from your configured domain>/oauth/callback` |
| `ANDROID_HEARTBEAT_TIMEOUT_MS` | `180000` | Inactivity window before Android device is marked DISCONNECTED |

---

## 2. Cryptographic Secret Generation

Generate strong 256-bit encryption and HMAC keys using Node.js native crypto:

```bash
# Generate 256-bit Master Key (64 hex characters)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Never commit production `.env` files to source code repositories.
