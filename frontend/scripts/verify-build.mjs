// Verifies a ShopStock frontend BUILD ARTIFACT. It checks what was built; it does
// not check a deployment (no network, no hosting, no real API).
//
//   npm run verify:build                  Build into a temporary directory with the
//                                         production contract and verify that. If
//                                         VITE_API_BASE_URL is not set, a fixture
//                                         origin is used (and said so) so the check
//                                         needs no configuration. Never touches dist/.
//   npm run verify:build -- --dist dist   Verify an existing build, for example the
//                                         one a deploy produced. VITE_API_BASE_URL
//                                         must be set to the value it was built with.
//   npm run verify:build -- --mode preview   Use the preview contract (see
//                                         src/config/apiBaseUrl.js).
//
// What it checks: index.html; the web manifest and every icon it names (present,
// a real PNG, the declared size); the touch icon and favicon; the service worker
// and its precache; the configured API origin is present in the bundle; and, for a
// production build, that no loopback origin (http://localhost:4000, 127.0.0.1, ...)
// is baked into it.
//
// It looks for loopback ORIGINS (scheme + host), never the bare words, because
// third-party code contains harmless text such as /localhost|127\.0\.0\.1/ (a
// "running on localhost?" test) that is not an API origin.
//
// The URL rules come from src/config/apiBaseUrl.js and are not repeated here.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { API_BASE_ENV_VAR, formatApiBaseError, profileForMode, validateApiBaseUrl } from '../src/config/apiBaseUrl.js';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A reserved, never-resolving host (RFC 2606). Used only so a build can be verified
// on a machine with no configuration; it is never a deployment value.
export const FIXTURE_API_ORIGIN = 'https://api.shopstock.invalid';

// A loopback origin: scheme, then localhost / *.localhost / 127.x.x.x / 0.0.0.0 /
// [::] / [::1], then a boundary. The boundary keeps real hosts such as
// localhost.example.com or localhostfoo.com from matching.
export const LOOPBACK_ORIGIN_PATTERN =
  /\bhttps?:\/\/(?:(?:[a-z0-9-]+\.)*localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])(?=[:/?#"'`\s)\],;]|$)(?::\d+)?/gi;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngSize(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readText(file) {
  return readFileSync(file, 'utf8');
}

function listFiles(dir, predicate) {
  return existsSync(dir) ? readdirSync(dir).filter(predicate).map((name) => join(dir, name)) : [];
}

// `<link ... rel="x" ... href="y">` in any attribute order.
function findLinkHrefs(html, rel) {
  const hrefs = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attrRel = /\brel="([^"]*)"/i.exec(tag)?.[1];
    const attrHref = /\bhref="([^"]*)"/i.exec(tag)?.[1];
    if (attrRel?.split(/\s+/).includes(rel) && attrHref) hrefs.push(attrHref);
  }
  return hrefs;
}

const stripSlash = (path) => path.replace(/^\/+/, '');

/**
 * Verify a finished build.
 *
 * @param {{ distDir: string, profile: import('../src/config/apiBaseUrl.js').ApiBaseProfile, apiBase: string }} input
 *   apiBase is the validated, normalized origin the build was made with ('' for
 *   same origin).
 * @returns {{ ok: boolean, checks: Array<{ name: string, ok: boolean, detail?: string }> }}
 */
export function verifyDist({ distDir, profile, apiBase }) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), ...(detail ? { detail } : {}) });
  const at = (...parts) => join(distDir, ...parts);

  // --- index.html
  const indexPath = at('index.html');
  const hasIndex = existsSync(indexPath);
  check('index.html is present', hasIndex);
  const html = hasIndex ? readText(indexPath) : '';

  // --- web manifest and its icons
  let manifest = null;
  if (existsSync(at('manifest.webmanifest'))) {
    try {
      manifest = JSON.parse(readText(at('manifest.webmanifest')));
    } catch {
      manifest = null;
    }
  }
  check('manifest.webmanifest is present and valid JSON', manifest !== null);
  const manifestIcons = Array.isArray(manifest?.icons) ? manifest.icons : [];
  if (manifest) {
    const missingFields = ['name', 'short_name', 'start_url', 'display'].filter((key) => typeof manifest[key] !== 'string' || manifest[key] === '');
    check('manifest has name, short_name, start_url and display', missingFields.length === 0, missingFields.length ? `missing: ${missingFields.join(', ')}` : undefined);
    for (const size of ['192x192', '512x512']) {
      check(`manifest declares a ${size} PNG icon`, manifestIcons.some((icon) => icon.sizes === size && icon.type === 'image/png'));
    }
    for (const icon of manifestIcons) {
      const file = at(stripSlash(String(icon.src ?? '')));
      const label = `manifest icon ${icon.src}`;
      if (!icon.src || !existsSync(file)) {
        check(`${label} exists in the build`, false);
        continue;
      }
      const size = readPngSize(file);
      const declared = /^(\d+)x(\d+)$/.exec(String(icon.sizes ?? ''));
      const matches = size && declared && size.width === Number(declared[1]) && size.height === Number(declared[2]);
      check(`${label} is a PNG of the declared size`, matches, size ? `${size.width}x${size.height}, declared ${icon.sizes}` : 'not a PNG');
    }
  }

  // --- index.html links: manifest, touch icon, favicon
  check('index.html links the manifest', findLinkHrefs(html, 'manifest').length > 0);
  const touchIcons = findLinkHrefs(html, 'apple-touch-icon');
  check('index.html links an apple-touch-icon that exists', touchIcons.length > 0 && touchIcons.every((href) => existsSync(at(stripSlash(href)))));
  const favicons = findLinkHrefs(html, 'icon');
  check('index.html links a favicon that exists', favicons.length > 0 && favicons.every((href) => existsSync(at(stripSlash(href)))));

  // --- service worker and its precache
  const swPath = at('sw.js');
  const sw = existsSync(swPath) ? readText(swPath) : '';
  check('sw.js is present and uses Workbox precaching', sw.includes('precacheAndRoute'));
  const workboxRef = /workbox-[a-f0-9]+/.exec(sw)?.[0];
  check('the Workbox runtime the service worker imports is present', Boolean(workboxRef) && existsSync(at(`${workboxRef}.js`)));
  check('registerSW.js is present and linked', existsSync(at('registerSW.js')) && html.includes('registerSW.js'));
  // Workbox writes the precache list minified ({url:"index.html"}) or, under a
  // non-production NODE_ENV, pretty-printed ({ "url": "index.html" }); read both.
  const precached = new Set([...sw.matchAll(/["']?\burl["']?\s*:\s*["']([^"']+)["']/g)].map((match) => match[1]));
  check('the precache includes index.html', precached.has('index.html'));
  const needed = [...manifestIcons.map((icon) => stripSlash(String(icon.src ?? ''))), ...touchIcons.map(stripSlash), ...favicons.map(stripSlash)];
  const unprecached = [...new Set(needed)].filter((path) => path && !precached.has(path));
  check('the precache includes every icon, so the app installs offline', manifest !== null && unprecached.length === 0, unprecached.length ? `not precached: ${unprecached.join(', ')}` : undefined);

  // --- the API origin
  const bundles = listFiles(at('assets'), (name) => name.endsWith('.js'));
  const bundleText = bundles.map(readText).join('\n');
  if (apiBase === '') {
    check('API origin: same origin by configuration (nothing to look for in the bundle)', true);
  } else {
    check(`the configured API origin (${apiBase}) is present in the bundle`, bundleText.includes(apiBase));
  }

  // --- loopback origins
  const scanned = [indexPath, swPath, at('registerSW.js'), ...bundles, ...listFiles(distDir, (name) => /^workbox-.*\.js$/.test(name))].filter((file) => existsSync(file));
  const found = [];
  for (const file of scanned) {
    for (const match of readText(file).matchAll(LOOPBACK_ORIGIN_PATTERN)) found.push(`${match[0]} (${file.slice(distDir.length + 1)})`);
  }
  if (profile === 'production') {
    check('no loopback API origin is baked into the build', found.length === 0, found.length ? `found: ${[...new Set(found)].slice(0, 3).join(', ')}` : undefined);
  } else {
    check(`loopback origins are allowed for a ${profile} build (${found.length} found)`, true);
  }

  return { ok: checks.every((item) => item.ok), checks };
}

function parseArgs(argv) {
  const args = { mode: 'production', dist: null, keep: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') args.mode = argv[++i];
    else if (arg === '--dist') args.dist = argv[++i];
    else if (arg === '--keep') args.keep = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.mode || (args.dist !== null && !args.dist)) throw new Error('--mode and --dist each need a value');
  return args;
}

const HELP = `Usage: node scripts/verify-build.mjs [--mode <mode>] [--dist <dir>] [--keep]

  (no --dist)  build into a temporary directory and verify it. Never touches dist/.
  --dist <dir> verify an existing build. Set ${API_BASE_ENV_VAR} to the value it was built with.
  --mode <m>   production (default) or preview. See src/config/apiBaseUrl.js.
  --keep       keep the temporary build directory and print its path.`;

/**
 * Command-line entry. Returns the process exit code.
 * @param {string[]} argv
 * @param {{ log?: (line: string) => void }} [io]
 */
export async function main(argv, { log = console.log } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    log(HELP);
    return 0;
  }
  const { build, loadEnv } = await import('vite');
  const profile = profileForMode(args.mode);
  const configured = loadEnv(args.mode, FRONTEND_ROOT, 'VITE_')[API_BASE_ENV_VAR] ?? '';

  let raw = configured;
  let usedFixture = false;
  if (args.dist === null && profile === 'production' && configured.trim() === '') {
    raw = FIXTURE_API_ORIGIN;
    usedFixture = true;
  }
  const validated = validateApiBaseUrl(raw, profile);
  if (!validated.ok) {
    log(formatApiBaseError({ mode: args.mode, problems: validated.problems }));
    return 1;
  }

  let distDir;
  let tempDir = null;
  if (args.dist !== null) {
    distDir = resolve(args.dist);
    if (!existsSync(distDir)) {
      log(`Build directory not found: ${distDir}`);
      return 1;
    }
  } else {
    tempDir = mkdtempSync(join(tmpdir(), 'shopstock-verify-'));
    distDir = tempDir;
    const previous = process.env[API_BASE_ENV_VAR];
    process.env[API_BASE_ENV_VAR] = raw;
    try {
      await build({ root: FRONTEND_ROOT, mode: args.mode, logLevel: 'warn', build: { outDir: tempDir, emptyOutDir: true } });
    } finally {
      if (previous === undefined) delete process.env[API_BASE_ENV_VAR];
      else process.env[API_BASE_ENV_VAR] = previous;
    }
  }

  try {
    const result = verifyDist({ distDir, profile, apiBase: validated.value });
    log(`Verifying a "${args.mode}" build (${profile} contract) in ${args.dist !== null ? distDir : 'a temporary directory'}`);
    for (const item of result.checks) log(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? ` (${item.detail})` : ''}`);
    if (usedFixture) {
      log(`\nNote: ${API_BASE_ENV_VAR} is not set, so this build used the fixture origin ${FIXTURE_API_ORIGIN}.`);
      log('That verifies the build contract and the artifact, NOT your deployment configuration.');
    }
    log(`\n${result.ok ? 'Build verified.' : 'Build verification FAILED.'} This checks the build artifact only; it does not check a deployment.`);
    return result.ok ? 0 : 1;
  } finally {
    if (tempDir !== null && !args.keep) rmSync(tempDir, { recursive: true, force: true });
    else if (tempDir !== null) log(`Kept: ${tempDir}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  );
}
