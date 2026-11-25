// The frontend's only production configuration variable is documented in
// frontend/.env.example, which holds no value or secret, and the variable it
// documents is the one the app actually reads and the build actually checks. Guards
// against the example, src/main.jsx and the API-base rules drifting apart.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const main = readFileSync(new URL('./main.jsx', import.meta.url), 'utf8');
const assignments = example.split('\n').filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line));

describe('frontend/.env.example', () => {
  it('declares exactly one variable, VITE_API_BASE_URL, with no value', () => {
    expect(assignments).toEqual(['VITE_API_BASE_URL=']);
  });

  it('documents the variable the app reads, through the one shared normalizer', () => {
    expect(main).toMatch(/normalizeApiBaseUrl\(import\.meta\.env\.VITE_API_BASE_URL\)/);
    expect(main).not.toMatch(/VITE_API_BASE_URL\s*\?\?/);
  });

  it('states the production contract: required, HTTPS, no loopback, and the build fails otherwise', () => {
    expect(example).toMatch(/PRODUCTION build[^\n]*REQUIRED/);
    expect(example).toMatch(/HTTPS origin/);
    expect(example).toMatch(/localhost or any\s+#\s+loopback address/);
    expect(example).toMatch(/build FAILS/);
  });

  it('states what a trailing slash and a path do, and that the value is inlined at build time', () => {
    expect(example).toMatch(/trailing\s+# slash is accepted and removed/);
    expect(example).toMatch(/No path/);
    expect(example).toMatch(/BUILT/);
  });

  it('names the explicit preview mode and the development behavior, and the CORS that a cross-origin API needs', () => {
    expect(example).toMatch(/npm run build:preview/);
    expect(example).toMatch(/same\s+(?:#\s+)?origin/);
    expect(example).toMatch(/CORS_ORIGIN/);
  });

  it('contains no secret-looking text and only reserved example hosts or localhost', () => {
    expect(example).not.toMatch(/(secret|password|token|apikey|mongodb\+srv)/i);
    const hosts = (example.match(/https?:\/\/[a-z0-9][^\s,)]*/gi) ?? []).map((url) => new URL(url.replace(/\.$/, '')).hostname);
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.every((host) => host === 'localhost' || host === 'api.example.com')).toBe(true);
  });
});
