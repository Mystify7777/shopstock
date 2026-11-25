// The Vite production guard (vite.config.js): `vite build` must stop, with a clear
// message, when VITE_API_BASE_URL breaks the contract for its mode, and nothing
// but a build may be affected. The hook is tested directly, and `vite build` is
// run for real to prove the process exits non-zero and writes no output.

import { describe, it, expect, afterEach } from 'vitest';
import { vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import config, { apiBaseGuard } from '../../vite.config.js';

const FRONTEND_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VITE_BIN = join(FRONTEND_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

// loadEnv merges process.env over any .env file, so stubbing the variable (even to
// '') keeps these tests independent of a developer's own .env files.
const guard = (value, { command = 'build', mode = 'production' } = {}) => {
  vi.stubEnv('VITE_API_BASE_URL', value);
  return () => apiBaseGuard().config({}, { command, mode });
};

afterEach(() => vi.unstubAllEnvs());

describe('the guard hook', () => {
  it('is the first plugin, so it runs before anything else is set up', () => {
    expect(config.plugins[0].name).toBe('shopstock-api-base-guard');
  });

  it('fails a production build with a missing API base', () => {
    expect(guard('')).toThrow(/Refusing to build.*VITE_API_BASE_URL is required for a production build/s);
  });

  it.each([
    ['http://api.example.com', /must use https:\/\//],
    ['https://localhost:4000', /localhost or a loopback address/],
    ['https://127.0.0.1:4000', /localhost or a loopback address/],
    ['api.example.com', /must start with a scheme/],
    ['https://api.example.com/v1', /no path/]
  ])('fails a production build with %s', (value, message) => {
    expect(guard(value)).toThrow(message);
  });

  it('passes a production build with a valid HTTPS origin, with or without a trailing slash', () => {
    expect(guard('https://api.example.com')).not.toThrow();
    expect(guard('https://api.example.com/')).not.toThrow();
  });

  it('applies the preview rules to a preview build: localhost and a missing value are allowed', () => {
    expect(guard('http://localhost:4000', { mode: 'preview' })).not.toThrow();
    expect(guard('', { mode: 'preview' })).not.toThrow();
  });

  it('treats an unrecognized mode as production: it is never a way around the guard', () => {
    expect(guard('http://localhost:4000', { mode: 'staging' })).toThrow(/loopback/);
  });

  it('leaves the dev server and the test runner alone', () => {
    expect(guard('', { command: 'serve', mode: 'development' })).not.toThrow();
    expect(guard('nonsense', { command: 'serve', mode: 'test' })).not.toThrow();
  });
});

describe('vite build, for real', () => {
  const outDirs = [];
  afterEach(() => {
    for (const dir of outDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function viteBuild(env, extra = []) {
    const outDir = mkdtempSync(join(tmpdir(), 'shopstock-guard-'));
    outDirs.push(outDir);
    const result = spawnSync(process.execPath, [VITE_BIN, 'build', '--outDir', outDir, '--emptyOutDir', ...extra], {
      cwd: FRONTEND_ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8'
    });
    return { ...result, output: `${result.stdout}${result.stderr}`, outDir };
  }

  it.each([
    ['unset', ''],
    ['localhost', 'http://localhost:4000'],
    ['a path', 'https://api.shopstock.invalid/v1']
  ])('exits non-zero with the reason and builds nothing when the API base is %s', (_label, value) => {
    const result = viteBuild({ VITE_API_BASE_URL: value });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('[ShopStock build] Refusing to build: VITE_API_BASE_URL is not valid for a "production" build.');
    expect(existsSync(join(result.outDir, 'index.html'))).toBe(false);
  }, 60000);

  it('a preview build is the documented way through, and it works with the value unset', () => {
    const result = viteBuild({ VITE_API_BASE_URL: '' }, ['--mode', 'preview']);
    expect(result.status).toBe(0);
    expect(existsSync(join(result.outDir, 'index.html'))).toBe(true);
  }, 60000);
});
