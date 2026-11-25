import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { API_BASE_ENV_VAR, assertApiBaseForBuild } from './src/config/apiBaseUrl.js';

// A production build must not silently ship the wrong API origin, so `vite build`
// stops when VITE_API_BASE_URL breaks the contract for its mode (see
// src/config/apiBaseUrl.js). Only builds are guarded: the dev server and the test
// runner need no configuration. `vite build --mode preview` is the explicit,
// documented way to build against a local or http backend.
export function apiBaseGuard() {
  return {
    name: 'shopstock-api-base-guard',
    config(_config, { command, mode }) {
      const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_');
      assertApiBaseForBuild({ command, mode, raw: env[API_BASE_ENV_VAR] });
    }
  };
}

// ShopStock is offline-first: the PWA plugin pre-caches the app shell so
// the UI itself loads with no network. Actual data offline-ability comes
// from IndexedDB (see src/data/db), not from this plugin — this config
// only makes sure the app *shell* boots offline.
export default defineConfig({
  plugins: [
    apiBaseGuard(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'ShopStock',
        short_name: 'ShopStock',
        description: 'Offline-first inventory management for small shops',
        theme_color: '#0f172a',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      workbox: {
        // App shell + static assets only. API calls are handled by our own
        // sync queue, not by service-worker network interception, so we
        // deliberately don't add runtime caching rules for /api/* here.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}']
      }
    })
  ],
  test: {
    environment: 'node',
    // Component tests (src/components/**, src/pages/**) need a real DOM to
    // render into and query against, so they run under jsdom. Everything
    // else (domain, repositories, services) stays on the default `node`
    // environment above -- no DOM is needed there, and node is faster.
    environmentMatchGlobs: [
      ['src/components/**', 'jsdom'],
      ['src/pages/**', 'jsdom'],
      ['src/hooks/**', 'jsdom'],
      ['src/data/sync/syncTriggers.test.js', 'jsdom']
    ],
    include: ['{src,tests}/**/*.test.{js,jsx}'],
    // fake-indexeddb/auto installs `indexedDB` and `IDBKeyRange` as
    // globals before any test file runs, which is what lets Dexie-backed
    // tests (tests/data/**) work under Node without a real browser. Pure
    // domain tests (tests/domain/**) don't touch IndexedDB at all and are
    // unaffected by this being present.
    //
    // tests/setup/jest-dom.js is guarded internally (see that file) so it
    // has no effect under `node` -- it only activates jest-dom matchers
    // when a DOM is present, i.e. under the jsdom environment above.
    setupFiles: [
      './tests/setup/fake-indexeddb.js',
      './tests/setup/jest-dom.js'
    ]
  },
  server: {
    port: 5173
  }
});
