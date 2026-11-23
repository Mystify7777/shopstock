// R10 Phase 3b: the frontend's only production configuration variable is
// documented in frontend/.env.example, which holds no value or secret, and the
// variable it documents is the one the app actually reads. Guards against the
// example and src/main.jsx drifting apart.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const main = readFileSync(new URL('./main.jsx', import.meta.url), 'utf8');
const assignments = example.split('\n').filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line));

describe('frontend/.env.example', () => {
  it('declares exactly one variable, VITE_API_BASE_URL, with no value', () => {
    expect(assignments).toEqual(['VITE_API_BASE_URL=']);
  });

  it('documents the variable the app reads, and the same-origin default it falls back to', () => {
    expect(main).toMatch(/import\.meta\.env\.VITE_API_BASE_URL\s*\?\?\s*''/);
    expect(example).toMatch(/same origin/i);
  });

  it('states the rules the code depends on: no trailing slash, build-time, and CORS for a cross-origin API', () => {
    expect(example).toMatch(/No trailing slash/i);
    expect(example).toMatch(/BUILT/);
    expect(example).toMatch(/CORS_ORIGIN/);
  });

  it('contains no secret-looking or real hostnames', () => {
    expect(example).not.toMatch(/(secret|password|token|apikey|mongodb\+srv)/i);
    expect(example.match(/https?:\/\/[^\s]+/g)?.every((url) => /localhost/.test(url))).toBe(true);
  });
});
