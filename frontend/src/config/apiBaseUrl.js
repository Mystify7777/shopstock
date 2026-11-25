// The one place that decides what VITE_API_BASE_URL may be.
//
// The value is the origin of the ShopStock API (scheme://host[:port]); every
// request is sent to `${origin}/api/...`. Vite inlines it when the app is BUILT,
// so a wrong value is shipped to every user. Three callers share these rules and
// none of them re-implements them:
//
//   - vite.config.js          fails a production build with a clear message;
//   - scripts/verify-build.mjs  re-checks a finished build against the same rules;
//   - src/main.jsx            normalizes the value at runtime.
//
// Pure on purpose: no import.meta.env, no process.env, no I/O, so it runs in the
// browser bundle and in Node alike. Messages never echo the value they reject.

export const API_BASE_ENV_VAR = 'VITE_API_BASE_URL';

/** @typedef {'development' | 'preview' | 'production'} ApiBaseProfile */

// Vite's `--mode` decides the profile. `preview` is the explicit escape hatch for
// a local production-like build (`npm run build:preview`). Any mode this file does
// not recognize gets the strict production rules: unknown must never be lenient.
const PROFILE_BY_MODE = {
  development: 'development',
  test: 'development',
  preview: 'preview',
  production: 'production'
};

/**
 * @param {string} mode Vite's mode (`vite build --mode <mode>`).
 * @returns {ApiBaseProfile}
 */
export function profileForMode(mode) {
  return Object.hasOwn(PROFILE_BY_MODE, mode) ? PROFILE_BY_MODE[mode] : 'production';
}

function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host === '0.0.0.0') return true;
  // URL() writes IPv6 in compressed form, so these three cover ::1, ::, and the
  // IPv4-mapped 127.x.x.x range.
  return host === '[::1]' || host === '[::]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
}

/**
 * Parse an http(s) URL without throwing.
 * @param {string} value Already trimmed and non-empty.
 * @returns {{ ok: true, url: URL } | { ok: false, problem: string }}
 */
function parseHttpUrl(value) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return { ok: false, problem: 'must start with a scheme: https://… (http:// is only accepted outside production)' };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, problem: 'is not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, problem: 'must use http:// or https://' };
  }
  return { ok: true, url };
}

/**
 * Normalize for use at runtime. Lenient and never throws: the app must still
 * open (it is offline-first) even if the value is odd. Strict validation belongs
 * to the build (validateApiBaseUrl), not to a browser check.
 *
 *   missing / blank            -> ''  (same origin)
 *   a valid http(s) origin     -> its origin: lower-case host, default port and
 *                                 trailing slashes removed
 *   anything else              -> trimmed, trailing slashes removed
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeApiBaseUrl(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '') return '';
  const parsed = parseHttpUrl(trimmed);
  const isBareOrigin = parsed.ok && parsed.url.pathname.replace(/\/+$/, '') === '' && !parsed.url.search && !parsed.url.hash;
  return isBareOrigin ? parsed.url.origin : trimmed.replace(/\/+$/, '');
}

/**
 * Validate a value against the contract for a profile.
 *
 *   production   required; https only; an origin with no path, query, fragment or
 *                credentials; not localhost or any loopback address
 *   preview      optional (missing means same origin); http or https; loopback is
 *                allowed because the value must be set explicitly
 *   development  as preview
 *
 * A trailing slash is accepted and removed, never rejected.
 *
 * @param {unknown} raw
 * @param {ApiBaseProfile} profile
 * @returns {{ ok: true, value: string, sameOrigin: boolean } | { ok: false, problems: string[] }}
 */
export function validateApiBaseUrl(raw, profile) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';

  if (trimmed === '') {
    if (profile === 'production') {
      return { ok: false, problems: ["is required for a production build; set it to the backend's HTTPS origin, for example https://api.example.com"] };
    }
    return { ok: true, value: '', sameOrigin: true };
  }

  const parsed = parseHttpUrl(trimmed);
  if (!parsed.ok) return { ok: false, problems: [parsed.problem] };
  const { url } = parsed;

  const problems = [];
  if (url.username !== '' || url.password !== '') {
    problems.push('must not contain a username or password');
  }
  if (url.search !== '' || url.hash !== '' || /[?#]/.test(trimmed)) {
    problems.push('must not contain a query string or fragment');
  }
  if (url.pathname.replace(/\/+$/, '') !== '') {
    problems.push('must be an origin only (scheme://host[:port]) with no path');
  }
  if (profile === 'production') {
    if (url.protocol !== 'https:') {
      problems.push('must use https:// in a production build');
    }
    if (isLoopbackHost(url.hostname)) {
      problems.push('must not point at localhost or a loopback address in a production build (use `npm run build:preview` for a local production-like build)');
    }
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: url.origin, sameOrigin: false };
}

/**
 * Human-readable failure text for a rejected value. Never includes the value.
 * @param {{ mode: string, problems: string[] }} failure
 * @returns {string}
 */
export function formatApiBaseError({ mode, problems }) {
  return [
    `[ShopStock build] Refusing to build: ${API_BASE_ENV_VAR} is not valid for a "${mode}" build.`,
    ...problems.map((problem) => `  - ${API_BASE_ENV_VAR} ${problem}`),
    'See docs/DEPLOYMENT.md, "Frontend configuration".'
  ].join('\n');
}

/**
 * The build-time guard. Only `vite build` is guarded: the dev server and the test
 * runner stay usable with no configuration. Throws with a clear message when the
 * value breaks the contract for the build's mode.
 *
 * @param {{ command: string, mode: string, raw: unknown }} input
 * @returns {{ ok: true, value: string, sameOrigin: boolean } | null} null when not a build.
 */
export function assertApiBaseForBuild({ command, mode, raw }) {
  if (command !== 'build') return null;
  const result = validateApiBaseUrl(raw, profileForMode(mode));
  if (!result.ok) throw new Error(formatApiBaseError({ mode, problems: result.problems }));
  return result;
}
