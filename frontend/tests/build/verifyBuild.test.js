// scripts/verify-build.mjs: the build verifier. verifyDist() is exercised on a
// minimal fixture build that is broken one way at a time, so every check is shown
// to fail for its own reason; then the real CLI is run against a real build.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_API_ORIGIN, LOOPBACK_ORIGIN_PATTERN, verifyDist } from '../../scripts/verify-build.mjs';

const FRONTEND_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCRIPT = join(FRONTEND_ROOT, 'scripts', 'verify-build.mjs');
const API = 'https://api.example.test';

// The smallest bytes a PNG reader accepts for its size: signature + IHDR.
function png(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const INDEX_HTML = `<!doctype html><html><head>
<meta name="theme-color" content="#0f172a" />
<link rel="icon" href="/favicon.ico" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<script type="module" crossorigin src="/assets/index-abc.js"></script>
<link rel="manifest" href="/manifest.webmanifest">
<script id="vite-plugin-pwa:register-sw" src="/registerSW.js"></script>
</head><body><div id="root"></div></body></html>`;

const MANIFEST = {
  name: 'ShopStock',
  short_name: 'ShopStock',
  start_url: '/',
  display: 'standalone',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
  ]
};

const SW = `import"./workbox-abc123";precacheAndRoute([{url:"index.html",revision:"1"},{url:"icons/icon-192.png",revision:"1"},{url:"icons/icon-512.png",revision:"1"},{url:"apple-touch-icon.png",revision:"1"},{url:"favicon.ico",revision:"1"}]);`;

// Third-party text that mentions localhost WITHOUT being an origin: this is what real
// libraries contain, and it must never fail a build.
const LIBRARY_TEXT = 'const isLocal=/localhost|127\\.0\\.0\\.1/.test(location.href);const doc="see localhost docs and 127.0.0.1";';

let dir;
function writeFixture({ bundle = `${LIBRARY_TEXT}fetch("${API}/api/health");` } = {}) {
  const put = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  put('index.html', INDEX_HTML);
  put('manifest.webmanifest', JSON.stringify(MANIFEST));
  put('icons/icon-192.png', png(192, 192));
  put('icons/icon-512.png', png(512, 512));
  put('apple-touch-icon.png', png(180, 180));
  put('favicon.ico', 'ico');
  put('sw.js', SW);
  put('workbox-abc123.js', '// workbox');
  put('registerSW.js', '// register');
  put('assets/index-abc.js', bundle);
  return put;
}

const run = (overrides = {}) => verifyDist({ distDir: dir, profile: 'production', apiBase: API, ...overrides });
const failing = (result) => result.checks.filter((check) => !check.ok).map((check) => check.name);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shopstock-vb-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a complete production build', () => {
  it('passes every check', () => {
    writeFixture();
    const result = run();
    expect(failing(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('checks the manifest, the service worker, the icons and the API origin', () => {
    writeFixture();
    const names = run().checks.map((check) => check.name).join('\n');
    expect(names).toMatch(/manifest\.webmanifest is present/);
    expect(names).toMatch(/sw\.js is present/);
    expect(names).toMatch(/manifest icon \/icons\/icon-512\.png is a PNG of the declared size/);
    expect(names).toMatch(/configured API origin \(https:\/\/api\.example\.test\) is present/);
    expect(names).toMatch(/no loopback API origin/);
  });
});

describe('the precache list, in either of the formats Workbox writes', () => {
  it('reads the pretty-printed form a non-production NODE_ENV produces', () => {
    const put = writeFixture();
    put('sw.js', SW.replace(/\{url:"([^"]+)",revision:"1"\}/g, '{\n  "url": "$1",\n  "revision": "1"\n}'));
    const result = run();
    expect(failing(result)).toEqual([]);
  });

  it('still fails when index.html is missing from a pretty-printed list', () => {
    const put = writeFixture();
    put('sw.js', SW.replace('{url:"index.html",revision:"1"},', '').replace(/\{url:"([^"]+)",revision:"1"\}/g, '{ "url": "$1", "revision": "1" }'));
    expect(failing(run())).toContain('the precache includes index.html');
  });
});

describe('the manifest and icons', () => {
  it('fails when the manifest is missing', () => {
    const put = writeFixture();
    rmSync(join(dir, 'manifest.webmanifest'));
    expect(failing(run())).toContain('manifest.webmanifest is present and valid JSON');
    put; // fixture helper kept for symmetry
  });

  it('fails when the manifest is not valid JSON', () => {
    const put = writeFixture();
    put('manifest.webmanifest', '{ not json');
    expect(failing(run())).toContain('manifest.webmanifest is present and valid JSON');
  });

  it('fails when a required manifest field is missing', () => {
    const put = writeFixture();
    put('manifest.webmanifest', JSON.stringify({ ...MANIFEST, start_url: '' }));
    expect(failing(run())).toContain('manifest has name, short_name, start_url and display');
  });

  it('fails when a manifest icon file is not in the build', () => {
    writeFixture();
    rmSync(join(dir, 'icons', 'icon-512.png'));
    expect(failing(run())).toContain('manifest icon /icons/icon-512.png exists in the build');
  });

  it('fails when an icon is not a PNG, or is not the size the manifest declares', () => {
    const put = writeFixture();
    put('icons/icon-192.png', 'not a png');
    put('icons/icon-512.png', png(256, 256));
    const names = failing(run());
    expect(names).toContain('manifest icon /icons/icon-192.png is a PNG of the declared size');
    expect(names).toContain('manifest icon /icons/icon-512.png is a PNG of the declared size');
  });

  it('fails when the manifest declares no 512x512 icon', () => {
    const put = writeFixture();
    put('manifest.webmanifest', JSON.stringify({ ...MANIFEST, icons: [MANIFEST.icons[0]] }));
    expect(failing(run())).toContain('manifest declares a 512x512 PNG icon');
  });

  it('checks a maskable icon the same way once the manifest names one', () => {
    const put = writeFixture();
    put('manifest.webmanifest', JSON.stringify({ ...MANIFEST, icons: [...MANIFEST.icons, { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }] }));
    expect(failing(run())).toContain('manifest icon /icons/icon-512-maskable.png exists in the build');
    put('icons/icon-512-maskable.png', png(512, 512));
    expect(failing(run())).not.toContain('manifest icon /icons/icon-512-maskable.png exists in the build');
  });

  it('fails when the touch icon or favicon file is missing, or index.html does not link the manifest', () => {
    writeFixture();
    rmSync(join(dir, 'apple-touch-icon.png'));
    rmSync(join(dir, 'favicon.ico'));
    const put = writeFixture;
    expect(failing(run())).toEqual(expect.arrayContaining(['index.html links an apple-touch-icon that exists', 'index.html links a favicon that exists']));
    writeFileSync(join(dir, 'index.html'), INDEX_HTML.replace('<link rel="manifest" href="/manifest.webmanifest">', ''));
    expect(failing(run())).toContain('index.html links the manifest');
    put;
  });
});

describe('the service worker', () => {
  it('fails when sw.js is missing', () => {
    writeFixture();
    rmSync(join(dir, 'sw.js'));
    expect(failing(run())).toContain('sw.js is present and uses Workbox precaching');
  });

  it('fails when the Workbox runtime it imports is missing', () => {
    writeFixture();
    rmSync(join(dir, 'workbox-abc123.js'));
    expect(failing(run())).toContain('the Workbox runtime the service worker imports is present');
  });

  it('fails when index.html is not precached', () => {
    const put = writeFixture();
    put('sw.js', SW.replace('{url:"index.html",revision:"1"},', ''));
    expect(failing(run())).toContain('the precache includes index.html');
  });

  it('fails when an icon is not precached, so the app could not install offline', () => {
    const put = writeFixture();
    put('sw.js', SW.replace('{url:"icons/icon-512.png",revision:"1"},', ''));
    const failed = run().checks.find((check) => check.name.startsWith('the precache includes every icon'));
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain('icons/icon-512.png');
  });

  it('fails when registerSW.js is missing', () => {
    writeFixture();
    rmSync(join(dir, 'registerSW.js'));
    expect(failing(run())).toContain('registerSW.js is present and linked');
  });
});

describe('the API origin', () => {
  it('fails when the configured origin is not in the bundle', () => {
    writeFixture({ bundle: `${LIBRARY_TEXT}fetch("https://some-other-host.test/api/health");` });
    expect(failing(run())).toContain(`the configured API origin (${API}) is present in the bundle`);
  });

  it('has nothing to look for when the build is same-origin by configuration', () => {
    writeFixture({ bundle: LIBRARY_TEXT });
    const result = run({ profile: 'preview', apiBase: '' });
    expect(failing(result)).toEqual([]);
    expect(result.checks.map((check) => check.name).join('\n')).toMatch(/same origin by configuration/);
  });
});

describe('loopback origins', () => {
  it.each(['http://localhost:4000', 'https://localhost', 'http://127.0.0.1:4000/api', 'http://0.0.0.0:4000', 'http://[::1]:4000', 'http://dev.localhost:4000'])('fails a production build that contains %s', (origin) => {
    writeFixture({ bundle: `${LIBRARY_TEXT}fetch("${API}/x");const stale="${origin}";` });
    const failed = run().checks.find((check) => check.name === 'no loopback API origin is baked into the build');
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain(origin.replace(/\/api$/, ''));
  });

  it('finds a loopback origin in index.html and the service worker too, not just the bundle', () => {
    const put = writeFixture();
    put('sw.js', `${SW}/*http://localhost:4000*/`);
    expect(failing(run())).toContain('no loopback API origin is baked into the build');
  });

  it('does NOT fail on library text that merely contains the words "localhost" or "127.0.0.1"', () => {
    writeFixture({ bundle: `${LIBRARY_TEXT}fetch("${API}/x");` });
    expect(failing(run())).toEqual([]);
  });

  it('does not mistake a real host that contains "localhost" for loopback', () => {
    writeFixture({ bundle: `fetch("${API}/x");const a="https://localhost.example.com/docs";const b="https://mylocalhost.com";` });
    expect(failing(run())).toEqual([]);
  });

  it('allows loopback origins in a preview build', () => {
    writeFixture({ bundle: 'fetch("http://localhost:4000/api/health");' });
    const result = run({ profile: 'preview', apiBase: 'http://localhost:4000' });
    expect(failing(result)).toEqual([]);
  });

  it('the pattern is exported and matches origins, not words', () => {
    const matches = (text) => [...text.matchAll(LOOPBACK_ORIGIN_PATTERN)].map((match) => match[0]);
    expect(matches('a http://localhost:4000/x b https://127.0.0.1 c')).toEqual(['http://localhost:4000', 'https://127.0.0.1']);
    expect(matches('/localhost|127\\.0\\.0\\.1/ localhost 127.0.0.1')).toEqual([]);
  });
});

describe('the command line, against a real build', () => {
  // NODE_ENV is pinned to what `npm run verify:build` really runs under (unset, so
  // a production build) rather than the 'test' this runner sets, which changes how
  // Workbox formats the service worker.
  const cli = (args, env) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd: FRONTEND_ROOT, env: { ...process.env, NODE_ENV: 'production', ...env }, encoding: 'utf8' });

  it('verifies a real production build with no configuration, says it used the fixture origin, and never touches dist/', () => {
    const distBefore = existsSync(join(FRONTEND_ROOT, 'dist')) ? readdirSync(join(FRONTEND_ROOT, 'dist')).join() : null;
    const result = cli([], { VITE_API_BASE_URL: '' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`fixture origin ${FIXTURE_API_ORIGIN}`);
    expect(result.stdout).toContain('NOT your deployment configuration');
    expect(result.stdout).toContain('PASS  no loopback API origin is baked into the build');
    expect(result.stdout).not.toContain('FAIL');
    const distAfter = existsSync(join(FRONTEND_ROOT, 'dist')) ? readdirSync(join(FRONTEND_ROOT, 'dist')).join() : null;
    expect(distAfter).toBe(distBefore);
  }, 120000);

  it('uses the real origin when one is configured, and says nothing about a fixture', () => {
    const result = cli([], { VITE_API_BASE_URL: 'https://api.real-shop.test/' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('the configured API origin (https://api.real-shop.test) is present in the bundle');
    expect(result.stdout).not.toContain('fixture origin');
  }, 120000);

  it('refuses a production build configured with localhost, with the guard message, and exits 1', () => {
    const result = cli([], { VITE_API_BASE_URL: 'http://localhost:4000' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Refusing to build');
    expect(result.stdout).toContain('loopback');
  }, 60000);

  it('verifies a preview build with the preview contract', () => {
    const result = cli(['--mode', 'preview'], { VITE_API_BASE_URL: 'http://localhost:4000' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('preview contract');
    expect(result.stdout).toContain('loopback origins are allowed for a preview build');
  }, 120000);

  it('verifies an existing build directory, and fails it when the configured origin is not in it', () => {
    writeFixture();
    const good = cli(['--dist', dir], { VITE_API_BASE_URL: API });
    expect(good.status, good.stdout + good.stderr).toBe(0);
    const wrong = cli(['--dist', dir], { VITE_API_BASE_URL: 'https://another-origin.test' });
    expect(wrong.status).toBe(1);
    expect(wrong.stdout).toContain('FAIL  the configured API origin (https://another-origin.test) is present in the bundle');
  }, 60000);

  it('cannot verify an existing production build without knowing the origin it was built with', () => {
    writeFixture();
    const result = cli(['--dist', dir], { VITE_API_BASE_URL: '' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('is required for a production build');
  }, 60000);
});
