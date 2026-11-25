// The API-base contract (src/config/apiBaseUrl.js): what VITE_API_BASE_URL may be
// in a production build, a preview build and development, and how it is
// normalized. This is the single implementation the Vite guard, the build verifier
// and main.jsx all use, so the rules are pinned once, here.

import { describe, it, expect } from 'vitest';
import {
  API_BASE_ENV_VAR,
  assertApiBaseForBuild,
  formatApiBaseError,
  normalizeApiBaseUrl,
  profileForMode,
  validateApiBaseUrl
} from '../../src/config/apiBaseUrl.js';

const accepted = (value, profile) => {
  const result = validateApiBaseUrl(value, profile);
  expect(result, `expected ${JSON.stringify(value)} to be accepted for ${profile}`).toMatchObject({ ok: true });
  return result;
};
const rejected = (value, profile) => {
  const result = validateApiBaseUrl(value, profile);
  expect(result.ok, `expected ${JSON.stringify(value)} to be rejected for ${profile}`).toBe(false);
  return result.problems.join(' | ');
};

describe('production', () => {
  it.each([undefined, null, '', '   '])('a missing API base (%j) is rejected: production has no default', (value) => {
    expect(rejected(value, 'production')).toMatch(/is required for a production build/);
  });

  it('accepts a valid HTTPS origin', () => {
    expect(accepted('https://api.example.com', 'production')).toEqual({ ok: true, value: 'https://api.example.com', sameOrigin: false });
    expect(accepted('https://api.example.com:8443', 'production').value).toBe('https://api.example.com:8443');
  });

  it.each([
    ['https://api.example.com/', 'https://api.example.com'],
    ['https://api.example.com///', 'https://api.example.com'],
    ['  https://api.example.com/  ', 'https://api.example.com'],
    ['HTTPS://API.Example.COM', 'https://api.example.com'],
    ['https://api.example.com:443', 'https://api.example.com']
  ])('normalizes %j to %j (a trailing slash is removed, never an error)', (value, expected) => {
    expect(accepted(value, 'production').value).toBe(expected);
  });

  it.each([
    ['api.example.com', /must start with a scheme/],
    ['localhost:4000', /must start with a scheme/],
    ['//api.example.com', /must start with a scheme/],
    ['https://', /not a valid URL/],
    ['https://exa mple.com', /not a valid URL/],
    ['ftp://api.example.com', /must use http:\/\/ or https:\/\//]
  ])('rejects the malformed value %j', (value, message) => {
    expect(rejected(value, 'production')).toMatch(message);
  });

  it.each(['https://api.example.com/v1', 'https://api.example.com/api', 'https://api.example.com/a/b/'])('rejects an embedded path: %s', (value) => {
    expect(rejected(value, 'production')).toMatch(/no path/);
  });

  it('rejects a query string, a fragment and credentials', () => {
    expect(rejected('https://api.example.com?x=1', 'production')).toMatch(/query string or fragment/);
    expect(rejected('https://api.example.com#top', 'production')).toMatch(/query string or fragment/);
    expect(rejected('https://user:pw@api.example.com', 'production')).toMatch(/username or password/);
  });

  it('requires HTTPS', () => {
    expect(rejected('http://api.example.com', 'production')).toMatch(/must use https:\/\//);
  });

  it.each([
    'https://localhost',
    'https://localhost:4000',
    'https://LOCALHOST:4000',
    'https://localhost.:4000',
    'https://app.localhost',
    'https://127.0.0.1',
    'https://127.1.2.3:4000',
    'https://0.0.0.0',
    'https://[::1]',
    'https://[::1]:4000',
    'https://[::ffff:127.0.0.1]',
    'https://2130706433'
  ])('rejects the loopback/localhost origin %s', (value) => {
    expect(rejected(value, 'production')).toMatch(/localhost or a loopback address/);
  });

  it('rejects loopback over plain http too, reporting both problems', () => {
    const message = rejected('http://localhost:4000', 'production');
    expect(message).toMatch(/must use https:\/\//);
    expect(message).toMatch(/localhost or a loopback address/);
  });

  it('does not mistake a real host that merely contains "localhost" for loopback', () => {
    for (const host of ['https://localhost.example.com', 'https://mylocalhost.com', 'https://localhostfoo.example']) {
      expect(accepted(host, 'production').ok).toBe(true);
    }
  });

  it('the guidance for a local production-like build names the preview mode', () => {
    expect(rejected('https://localhost', 'production')).toMatch(/npm run build:preview/);
  });
});

describe('preview', () => {
  it('allows localhost and plain http, because the value must be set explicitly', () => {
    expect(accepted('http://localhost:4000', 'preview').value).toBe('http://localhost:4000');
    expect(accepted('http://127.0.0.1:4000/', 'preview').value).toBe('http://127.0.0.1:4000');
    expect(accepted('https://api.example.com', 'preview').value).toBe('https://api.example.com');
  });

  it('allows a missing value, which means the same origin', () => {
    expect(accepted(undefined, 'preview')).toEqual({ ok: true, value: '', sameOrigin: true });
    expect(accepted('', 'preview')).toEqual({ ok: true, value: '', sameOrigin: true });
  });

  it('is still not arbitrary: a malformed value or a path is rejected', () => {
    expect(rejected('localhost:4000', 'preview')).toMatch(/must start with a scheme/);
    expect(rejected('http://localhost:4000/api', 'preview')).toMatch(/no path/);
  });
});

describe('development', () => {
  it('stays lenient: localhost, http and a missing value are all fine', () => {
    expect(accepted('http://localhost:4000', 'development').value).toBe('http://localhost:4000');
    expect(accepted(undefined, 'development')).toEqual({ ok: true, value: '', sameOrigin: true });
  });
});

describe('mode to profile', () => {
  it.each([
    ['production', 'production'],
    ['preview', 'preview'],
    ['development', 'development'],
    ['test', 'development']
  ])('%s -> %s', (mode, profile) => {
    expect(profileForMode(mode)).toBe(profile);
  });

  it.each(['staging', 'qa', '', undefined, 'constructor', '__proto__', 'toString'])('an unrecognized mode (%j) gets the strict production rules', (mode) => {
    expect(profileForMode(mode)).toBe('production');
  });
});

describe('runtime normalization (never throws, never validates)', () => {
  it.each([
    [undefined, ''],
    [null, ''],
    [42, ''],
    ['', ''],
    ['   ', ''],
    ['https://api.example.com/', 'https://api.example.com'],
    ['https://API.example.com:443///', 'https://api.example.com'],
    ['http://localhost:4000/', 'http://localhost:4000']
  ])('%j -> %j', (value, expected) => {
    expect(normalizeApiBaseUrl(value)).toBe(expected);
  });

  it('leaves a value it cannot make sense of alone, apart from trailing slashes, so the app still opens', () => {
    expect(normalizeApiBaseUrl('api.example.com/')).toBe('api.example.com');
    expect(normalizeApiBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
  });

  it('is idempotent', () => {
    const once = normalizeApiBaseUrl('https://Api.Example.com//');
    expect(normalizeApiBaseUrl(once)).toBe(once);
  });

  it('a normalized production value never produces a double slash when a request path is appended', () => {
    expect(`${normalizeApiBaseUrl('https://api.example.com/')}/api/auth/login`).toBe('https://api.example.com/api/auth/login');
  });
});

describe('error messages', () => {
  it('never echo the rejected value, which might hold credentials', () => {
    const secret = 'pa55w0rd-should-never-appear';
    const result = validateApiBaseUrl(`https://admin:${secret}@api.example.com/v1?token=${secret}`, 'production');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(formatApiBaseError({ mode: 'production', problems: result.problems })).not.toContain(secret);
  });

  it('name the variable, the mode and where to read more', () => {
    const text = formatApiBaseError({ mode: 'production', problems: ['must use https:// in a production build'] });
    expect(text).toContain(API_BASE_ENV_VAR);
    expect(text).toContain('"production" build');
    expect(text).toContain('docs/DEPLOYMENT.md');
  });
});

describe('assertApiBaseForBuild (what the Vite guard calls)', () => {
  it('throws the formatted message for a bad production build', () => {
    expect(() => assertApiBaseForBuild({ command: 'build', mode: 'production', raw: '' })).toThrow(/Refusing to build.*is required for a production build/s);
    expect(() => assertApiBaseForBuild({ command: 'build', mode: 'production', raw: 'http://localhost:4000' })).toThrow(/loopback/);
  });

  it('returns the normalized value for a good one', () => {
    expect(assertApiBaseForBuild({ command: 'build', mode: 'production', raw: 'https://api.example.com/' })).toEqual({ ok: true, value: 'https://api.example.com', sameOrigin: false });
  });

  it('applies the preview rules to a preview build', () => {
    expect(assertApiBaseForBuild({ command: 'build', mode: 'preview', raw: 'http://localhost:4000' })).toMatchObject({ ok: true });
    expect(assertApiBaseForBuild({ command: 'build', mode: 'preview', raw: undefined })).toMatchObject({ ok: true, sameOrigin: true });
  });

  it('does not guard anything but a build: the dev server and the test runner need no configuration', () => {
    expect(assertApiBaseForBuild({ command: 'serve', mode: 'development', raw: undefined })).toBeNull();
    expect(assertApiBaseForBuild({ command: 'serve', mode: 'production', raw: '' })).toBeNull();
    expect(assertApiBaseForBuild({ command: 'serve', mode: 'test', raw: 'nonsense' })).toBeNull();
  });
});
