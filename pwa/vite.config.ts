/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json'

// The packages of the editor's languages and of Vim mode, each imported the
// first time it is needed (@lezer/lr runs only their grammars). The syntax
// tree and its tags (@lezer/common, highlight) are the editor's own and stay
// with it.
const EDITOR_EXTRA =
  /\/node_modules\/(@codemirror\/(lang-[^/]+|legacy-modes|autocomplete|lint)|@replit\/codemirror-vim(-core)?|@lezer\/(?!common\/|highlight\/)[^/]+)\//

// Where a chunk goes: one made only of those packages under assets/cm/,
// never installed upfront by the service worker; any other where Vite puts it
function chunkFileName({ moduleIds }: { moduleIds: string[] }) {
  const extra =
    moduleIds.length > 0 && moduleIds.every((id) => EDITOR_EXTRA.test(id))
  return extra ? 'assets/cm/[name]-[hash].js' : 'assets/[name]-[hash].js'
}

export default defineConfig({
  define: {
    __APP_NAME__: JSON.stringify(pkg.name),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    VitePWA({
      // Disable SW in development
      selfDestroying: process.env.NODE_ENV !== 'production',
      // A new worker waits until the user reloads (the update banner): taking
      // over on its own would reload the page and lose an unsaved edit.
      registerType: 'prompt',
      // main.tsx registers through virtual:pwa-register.
      injectRegister: false,
      includeAssets: ['favicon.ico', 'favicon.svg', 'robots.txt', 'apple-touch-icon.png'],
      manifest: {
        name: 'Termote',
        short_name: 'Termote',
        description: 'Remote control CLI tools from mobile',
        // --tm-bg of the default (neutral) style in dark; a static manifest
        // cannot follow the chosen style.
        theme_color: '#1a1a1d',
        background_color: '#1a1a1d',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Full bleed, the mark inside the safe circle: Android crops it to its own shape
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          // Alpha only: Android's themed icons tint it
          {
            src: 'pwa-monochrome-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'monochrome',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Every module worker and the chunks it imports (the highlighter, its
        // themes and grammars; the CSV workers; Pele and its diagram types):
        // fetched (then cached) the first time they are needed, never
        // installed upfront.
        // Likewise the editor's languages and Vim mode (assets/cm/).
        globIgnores: ['**/assets/shiki/**', '**/assets/cm/**'],
        // Notification click (and push) handlers: public/notify-sw.js
        importScripts: ['notify-sw.js'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/assets/shiki/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'shiki',
              // Hashed names: a new build adds entries, so old ones expire
              // Grammars, themes and Pele's diagram types: about 115 files
              expiration: { maxEntries: 250, maxAgeSeconds: 30 * 24 * 3600 },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/assets/cm/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'cm',
              // About 50 language chunks and Vim mode
              expiration: { maxEntries: 150, maxAgeSeconds: 30 * 24 * 3600 },
            },
          },
        ],
        // /login and /pair are the server's sign-in and pairing forms: the
        // cached app shell in their place would leave a signed-out device
        // with no way to sign in. /login/link takes the CLI's sign-in link
        // (a POST); a GET that lands there gets the server's page too.
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/login(\?|$)/,
          /^\/pair(\?|$)/,
          /^\/login\/link(\?|$)/,
        ],
      },
    }),
  ],
  build: {
    rolldownOptions: {
      output: { chunkFileNames: chunkFileName },
    },
  },
  worker: {
    // A module worker, so each grammar or diagram type it imports is a chunk
    // of its own
    format: 'es',
    rolldownOptions: {
      output: {
        entryFileNames: 'assets/shiki/[name]-[hash].js',
        chunkFileNames: 'assets/shiki/[name]-[hash].js',
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test-setup.ts',
    // Vitest blanks CSS imports; theme-tokens.test.ts reads index.css as text.
    css: { include: [/src\/index\.css/] },
    exclude: ['e2e/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/test-setup.ts',
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/vite-env.d.ts',
        'src/main.tsx',
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
  server: {
    proxy: {
      // Dev: proxy to termote serve mode (no rewrite, routes are /api/mux/*)
      '/api/mux': {
        target: 'http://localhost:7680',
        ws: true,
      },
    },
  },
})
