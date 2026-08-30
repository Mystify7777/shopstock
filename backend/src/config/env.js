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
 *
 * Other required values (MONGODB_URI, JWT secrets, CORS_ORIGIN, etc.) are
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
 *   corsOrigin: string
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
      parts.push(`invalid value for environment variable(s): ${result.invalid.join(', ')}`);
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
    corsOrigin: env.CORS_ORIGIN
  };
}
