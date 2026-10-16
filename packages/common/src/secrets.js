import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolved from this file, not cwd: every service must read the same files.
const SECRETS_DIR = path.resolve(__dirname, '../../../data/.secrets');

const cache = new Map();

/**
 * Resolves a service secret: explicit env var first, else a random value
 * generated once and persisted under data/.secrets/ (shared by all local services).
 * @param {string} name file-safe secret name
 * @param {string} [envVar] env var that overrides the file
 * @returns {string}
 */
export function resolveSecret(name, envVar) {
  const fromEnv = envVar ? (process.env[envVar] || '').trim() : '';
  if (fromEnv) return fromEnv;
  if (cache.has(name)) return cache.get(name);

  const file = path.join(SECRETS_DIR, name);
  let value = '';
  try { value = fs.readFileSync(file, 'utf8').trim(); } catch {}
  if (!value) {
    fs.mkdirSync(SECRETS_DIR, { recursive: true });
    const fresh = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(file, fresh, { flag: 'wx', mode: 0o600 });
      value = fresh;
    } catch {
      // Another process created it first: use theirs.
      value = fs.readFileSync(file, 'utf8').trim();
    }
  }
  cache.set(name, value);
  return value;
}

/** Constant-time string comparison (length-independent via hashing). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export const getAdminToken = () => resolveSecret('admin_api_token', 'ADMIN_API_TOKEN');
export const getObserverToken = () => resolveSecret('observer_api_token', 'OBSERVER_API_TOKEN');
export const getCoinStoreWebhookSecret = () => resolveSecret('coin_store_webhook_secret', 'COIN_STORE_WEBHOOK_SECRET');

/** Literal that older builds seeded into databases; must never be trusted. */
export const LEGACY_DEFAULT_WEBHOOK_SECRET = 'merchant_webhook_secret_for_wallet_store';

/** True when the request's `Authorization: Bearer` value matches any of the given tokens. */
export function hasBearer(req, ...tokens) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers?.['authorization'] || '');
  if (!match) return false;
  const presented = match[1].trim();
  return tokens.some(t => safeEqual(presented, t));
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const consumedOAuthStates = new Map();

function oauthStateMac(payload) {
  return crypto.createHmac('sha256', getObserverToken()).update(`oauth-state:${payload}`).digest('hex');
}

/**
 * Creates a signed, expiring OAuth `state` value. Mint it only from an authenticated admin route:
 * the callback accepts nothing that was not minted there, which blocks login-CSRF account linking.
 */
export function createOAuthState() {
  const payload = `${crypto.randomBytes(16).toString('hex')}.${Date.now() + OAUTH_STATE_TTL_MS}`;
  return `${payload}.${oauthStateMac(payload)}`;
}

/** Verifies signature and expiry, and accepts each state only once (per process). */
export function consumeOAuthState(state) {
  if (typeof state !== 'string') return false;
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, expiresAt, mac] = parts;
  if (!safeEqual(mac, oauthStateMac(`${nonce}.${expiresAt}`))) return false;
  const now = Date.now();
  if (!(Number(expiresAt) > now)) return false;
  for (const [key, exp] of consumedOAuthStates) if (exp <= now) consumedOAuthStates.delete(key);
  if (consumedOAuthStates.has(nonce)) return false;
  consumedOAuthStates.set(nonce, Number(expiresAt));
  return true;
}
