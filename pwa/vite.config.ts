/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json'

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
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // The highlighter worker, its themes and grammars: fetched (then
        // cached) the first time Files shows a file, never installed upfront.
        globIgnores: ['**/assets/shiki/**'],
        // Notification click (and push) handlers: public/notify-sw.js
        importScripts: ['notify-sw.js'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/assets/shiki/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'shiki',
              // Hashed names: a new build adds entries, so old ones expire
              expiration: { maxEntries: 120, maxAgeSeconds: 30 * 24 * 3600 },
            },
          },
        ],
        // /login is the server's sign-in form: the cached app shell in its
        // place would leave a signed-out device with no way to sign in.
        navigateFallbackDenylist: [/^\/api\//, /^\/login(\?|$)/],
      },
    }),
  ],
  worker: {
    // A module worker, so each grammar it imports is a chunk of its own
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
