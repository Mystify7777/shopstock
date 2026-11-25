// frontend/vercel.json: the one rewrite a single-page app needs on Vercel, and
// nothing else. A hard refresh on /products/abc is a request for a path that is
// not a file; without a rewrite to index.html it would 404 on the host even
// though the client-side router knows the route.
//
// This pins the file's contract. That Vercel applies it is Vercel's documented
// behavior for Vite single-page apps; it is verified on a real deployment, not here.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8');
const config = JSON.parse(raw);

describe('frontend/vercel.json', () => {
  it('is valid JSON with exactly one key: rewrites', () => {
    expect(Object.keys(config)).toEqual(['rewrites']);
  });

  it('has exactly one rewrite, sending every path to /index.html', () => {
    expect(config.rewrites).toEqual([{ source: '/(.*)', destination: '/index.html' }]);
  });

  it('adds no headers, redirects, caching, cleanUrls or other deployment behavior', () => {
    for (const key of ['headers', 'redirects', 'routes', 'cleanUrls', 'trailingSlash', 'buildCommand', 'outputDirectory', 'env', 'functions']) {
      expect(config).not.toHaveProperty(key);
    }
  });

  it('does not rewrite API calls to the frontend: the API is a different origin, not a path here', () => {
    expect(raw).not.toMatch(/\/api/);
  });
});
