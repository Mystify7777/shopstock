import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// ShopStock is offline-first: the PWA plugin pre-caches the app shell so
// the UI itself loads with no network. Actual data offline-ability comes
// from IndexedDB (see src/data/db), not from this plugin — this config
// only makes sure the app *shell* boots offline.
export default defineConfig({
  plugins: [
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
    include: ["{src,tests}/**/*.test.js"],
    // fake-indexeddb/auto installs `indexedDB` and `IDBKeyRange` as
    // globals before any test file runs, which is what lets Dexie-backed
    // tests (tests/data/**) work under Node without a real browser. Pure
    // domain tests (tests/domain/**) don't touch IndexedDB at all and are
    // unaffected by this being present.
    setupFiles: ['./tests/setup/fake-indexeddb.js']
  },
  server: {
    port: 5173
  }
});
