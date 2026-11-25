// Environment config loading + fail-loud startup validation.
//
// Locked contract (Phase 5A completion gate): the app refuses to boot if a
// required .env value is missing, rather than discovering a missing secret
// on the first request that happens to need it. This module is imported
// exactly once, at the top of the boot sequence, before anything else
// (Mongo connection, Express app) is constructed.
//
// This module does NOT call dotenv/config itself -- the caller (server.js)
// is responsible for that, so this module stays trivially testable with
// plain process.env manipulation and no import-order side effects.

/**
 * Split CORS_ORIGIN into its allowed origins. The variable is a
 * comma-separated allow-list (e.g. the dev server and the preview build both
 * need to be allowed), with surrounding whitespace and empty entries ignored.
 *
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function parseCorsOrigins(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

// A CORS origin is exactly scheme://host[:port] -- no path, no trailing
// slash, no wildcard. Browsers compare the Origin header to the response
// header byte-for-byte, so an entry like "http://localhost:5173/" would
// never match and would fail only at request time, in the browser. Reject
// it at startup instead.
function isValidCorsOrigin(entry) {
  try {
    const url = new URL(entry);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === entry;
  } catch {
    return false;
  }
}

/**
 * TRUST_PROXY is optional: the number of reverse proxies between the internet and
 * this server (0 or more). Unset or blank means "leave Express's default alone", so
 * a server reached directly behaves exactly as it always has. Express then trusts
 * that many X-Forwarded-For hops, which is what lets the auth rate limiter see each
 * client's own address instead of the proxy's. Only a whole, non-negative number is
 * accepted: `true`, a list of addresses, a negative or a fractional value are not.
 *
 * @param {string | undefined} value
 * @returns {{ ok: true, value: number | null } | { ok: false }}
 */
export function parseTrustProxy(value) {
  const text = String(value ?? '').trim();
  if (text === '') return { ok: true, value: null };
  if (!/^\d+$/.test(text)) return { ok: false };
  const hops = Number(text);
  return Number.isSafeInteger(hops) ? { ok: true, value: hops } : { ok: false };
}

// In production the access-token secret must be a real one. Presence alone would
// let the documented example value (or a short guessable one) boot and mint tokens
// anyone could forge. Development and test keep the lighter, presence-only check.
export const JWT_SECRET_MIN_LENGTH = 32;

function isProduction(env) {
  return String(env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

// Every "change-me..." value in backend/.env.example is a placeholder, not a secret.
function isPlaceholderSecret(value) {
  return /^change-?me/i.test(value.trim());
}

function isAcceptableProductionJwtSecret(value) {
  return value.trim().length >= JWT_SECRET_MIN_LENGTH && !isPlaceholderSecret(value);
}

const REQUIRED_VARS = [
  'MONGODB_URI',
  'JWT_ACCESS_SECRET',
  'JWT_ACCESS_EXPIRES_IN',
  'REFRESH_TOKEN_EXPIRES_IN_DAYS',
  'SEED_USERNAME',
  'SEED_PASSWORD',
  'CORS_ORIGIN'
];

/**
 * Validate that every required environment variable is present and
 * non-empty, AND that the ones with a specific expected shape actually
 * have it -- not just presence-checked and then silently coerced to NaN
 * or an invalid value downstream. Currently shape-validated:
 *   - REFRESH_TOKEN_EXPIRES_IN_DAYS: must parse as a finite, positive number
 *   - PORT: optional; if present, must parse as a finite, positive integer
 *   - CORS_ORIGIN: a comma-separated list of one or more origins, each exactly
 *     scheme://host[:port] (http or https; no path, trailing slash or wildcard)
 *   - TRUST_PROXY: optional; if present and non-blank, a whole number of proxy
 *     hops, 0 or more
 *   - JWT_ACCESS_SECRET: when NODE_ENV is "production", at least 32 characters
 *     and not an example placeholder
 *
 * Other required values (MONGODB_URI, SEED_* etc.) are
 * presence-checked only here -- their shape is validated by whatever
 * actually consumes them (e.g. the Mongo connection module surfacing its
 * own connection error for a malformed URI), not duplicated here.
 *
 * @param {NodeJS.ProcessEnv} env Defaults to process.env; accepting an
 *   explicit env object (rather than reading process.env internally) is
 *   what makes this function testable without mutating global state.
 * @returns {{ ok: true } | { ok: false, missing: string[], invalid: string[] }}
 */
export function validateEnv(env = process.env) {
  const missing = REQUIRED_VARS.filter((key) => !env[key] || env[key].trim() === '');

  // Shape checks only run for variables that are actually present --
  // a missing variable is already reported via `missing` above, and
  // reporting it again as "invalid" would be redundant/confusing.
  const invalid = [];

  if (!missing.includes('REFRESH_TOKEN_EXPIRES_IN_DAYS')) {
    const parsed = Number(env.REFRESH_TOKEN_EXPIRES_IN_DAYS);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      invalid.push('REFRESH_TOKEN_EXPIRES_IN_DAYS');
    }
  }

  if (!missing.includes('CORS_ORIGIN')) {
    const origins = parseCorsOrigins(env.CORS_ORIGIN);
    if (origins.length === 0 || !origins.every(isValidCorsOrigin)) {
      invalid.push('CORS_ORIGIN');
    }
  }

  if (!parseTrustProxy(env.TRUST_PROXY).ok) {
    invalid.push('TRUST_PROXY');
  }

  if (isProduction(env) && !missing.includes('JWT_ACCESS_SECRET') && !isAcceptableProductionJwtSecret(env.JWT_ACCESS_SECRET)) {
    invalid.push('JWT_ACCESS_SECRET');
  }

  if (env.PORT && env.PORT.trim() !== '') {
    const parsedPort = Number(env.PORT);
    if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
      invalid.push('PORT');
    }
  }

  if (missing.length > 0 || invalid.length > 0) {
    return { ok: false, missing, invalid };
  }
  return { ok: true };
}

// What to do about an invalid value, shown next to its NAME. Never the value itself:
// some of these are secrets.
const INVALID_HINTS = {
  JWT_ACCESS_SECRET: `in production it must be at least ${JWT_SECRET_MIN_LENGTH} characters and not the example placeholder`,
  TRUST_PROXY: 'expected a whole number of proxy hops (0 or more), or leave it unset'
};

/**
 * Validate and, on failure, log a clear message and exit the process
 * immediately (fail loud at startup -- Phase 5A locked contract). On
 * success, returns a small typed config object so callers don't need to
 * read process.env directly (and so REFRESH_TOKEN_EXPIRES_IN_DAYS is
 * already parsed to a number rather than every call site re-parsing it).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{
 *   mongodbUri: string,
 *   port: number,
 *   nodeEnv: string,
 *   jwtAccessSecret: string,
 *   jwtAccessExpiresIn: string,
 *   refreshTokenExpiresInDays: number,
 *   seedUsername: string,
 *   seedPassword: string,
 *   corsOrigins: string[],
 *   trustProxy: number | null
 * }}
 */
export function loadConfig(env = process.env) {
  const result = validateEnv(env);
  if (!result.ok) {
    const parts = [];
    if (result.missing.length > 0) {
      parts.push(`missing required environment variable(s): ${result.missing.join(', ')}`);
    }
    if (result.invalid.length > 0) {
      const described = result.invalid.map((key) => (INVALID_HINTS[key] ? `${key} (${INVALID_HINTS[key]})` : key));
      parts.push(`invalid value for environment variable(s): ${described.join(', ')}`);
    }
    // eslint-disable-next-line no-console -- intentional startup diagnostic,
    // this is the one place a raw console.error is correct: the app is
    // refusing to boot, before any logging infrastructure exists.
    console.error(
      `[ShopStock backend] Refusing to start: ${parts.join('; ')}. ` +
      'Copy backend/.env.example to backend/.env and fill in real values.'
    );
    process.exit(1);
  }

  return {
    mongodbUri: env.MONGODB_URI,
    port: Number(env.PORT) || 4000,
    nodeEnv: env.NODE_ENV || 'development',
    jwtAccessSecret: env.JWT_ACCESS_SECRET,
    jwtAccessExpiresIn: env.JWT_ACCESS_EXPIRES_IN,
    refreshTokenExpiresInDays: Number(env.REFRESH_TOKEN_EXPIRES_IN_DAYS),
    seedUsername: env.SEED_USERNAME,
    seedPassword: env.SEED_PASSWORD,
    corsOrigins: parseCorsOrigins(env.CORS_ORIGIN),
    // null = TRUST_PROXY unset: createApp() then leaves Express's default alone.
    trustProxy: parseTrustProxy(env.TRUST_PROXY).value
  };
}
