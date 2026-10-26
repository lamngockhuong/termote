/// <reference types="vitest" />
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, normalize, sep } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json'

// The packages of the editor's languages and of Vim mode, each imported the
// first time it is needed (@lezer/lr runs only their grammars). The syntax
// tree and its tags (@lezer/common, highlight) are the editor's own and stay
// with it.
const EDITOR_EXTRA =
  /\/node_modules\/(@codemirror\/(lang-[^/]+|legacy-modes|autocomplete|lint)|@replit\/codemirror-vim(-core)?|@lezer\/(?!common\/|highlight\/)[^/]+)\//

// The document viewers (PDF, .xlsx, .docx) and what only they use: pdf.js
// on the main thread, the viewers themselves. SheetJS and mammoth run in
// workers (assets/shiki/).
const DOC_EXTRA =
  /(\/node_modules\/pdfjs-dist\/|\/src\/components\/(document|pdf|xlsx|docx)-[^/]+$|\/src\/utils\/(document-worker-client|pdf-[^/]+|sheet-tsv|docx-sanitize)\.ts$)/

// The lazy chunk FileViewer imports for a document
const DOC_ENTRY = /\/src\/components\/document-preview\.tsx$/

// Where a chunk goes: one made only of the editor's packages under
// assets/cm/, of the document viewers' under assets/doc/, neither installed
// upfront by the service worker; any other where Vite puts it
function chunkFileName({ moduleIds }: { moduleIds: string[] }) {
  const only = (re: RegExp) =>
    moduleIds.length > 0 && moduleIds.every((id) => re.test(id))
  if (only(EDITOR_EXTRA)) return 'assets/cm/[name]-[hash].js'
  // The viewers' own chunk carries what only they import with it
  if (only(DOC_EXTRA) || moduleIds.some((id) => DOC_ENTRY.test(id)))
    return 'assets/doc/[name]-[hash].js'
  return 'assets/[name]-[hash].js'
}

// pdf.js's own stylesheet goes with the viewer
function assetFileName({ originalFileNames }: { originalFileNames: string[] }) {
  return originalFileNames.some((f) => f.includes('pdfjs-dist/'))
    ? 'assets/doc/[name]-[hash][extname]'
    : 'assets/[name]-[hash][extname]'
}

// What pdf.js fetches by URL at run time: character maps (CJK text), the
// standard fonts, and the JS decoders of JPEG 2000 and JBIG2 it imports with
// useWasm off. Served from a directory named by its version, since /assets
// is cached for a year as immutable (server/serve.go).
const require = createRequire(import.meta.url)
const PDFJS_DIR = dirname(require.resolve('pdfjs-dist/package.json'))
const PDFJS_VERSION: string = require('pdfjs-dist/package.json').version
const PDFJS_ASSETS = `assets/doc/pdfjs-${PDFJS_VERSION}`
const PDFJS_FILES = [
  'cmaps',
  'standard_fonts',
  'wasm/openjpeg_nowasm_fallback.js',
  'wasm/jbig2_nowasm_fallback.js',
]

function pdfjsAssets(): Plugin {
  let outDir = 'dist'
  return {
    name: 'termote-pdfjs-assets',
    configResolved(c) {
      outDir = c.build.outDir
    },
    // Dev: served from the package, at the paths of the build
    configureServer(server) {
      server.middlewares.use(`/${PDFJS_ASSETS}/`, (req, res, next) => {
        let rel: string
        try {
          rel = normalize(decodeURIComponent((req.url ?? '').split('?')[0]))
        } catch {
          return next()
        }
        const file = join(PDFJS_DIR, rel)
        const allowed = PDFJS_FILES.some((f) => {
          const top = join(PDFJS_DIR, f)
          return file === top || file.startsWith(top + sep)
        })
        if (!allowed || !existsSync(file) || !statSync(file).isFile())
          return next()
        if (file.endsWith('.js'))
          res.setHeader('Content-Type', 'text/javascript')
        createReadStream(file).pipe(res)
      })
    },
    writeBundle() {
      for (const f of PDFJS_FILES)
        cpSync(join(PDFJS_DIR, f), join(outDir, PDFJS_ASSETS, f), {
          recursive: true,
        })
    },
  }
}

export default defineConfig({
  define: {
    __APP_NAME__: JSON.stringify(pkg.name),
    __APP_VERSION__: JSON.stringify(pkg.version),
    __PDFJS_ASSETS__: JSON.stringify(`/${PDFJS_ASSETS}/`),
  },
  plugins: [
    react(),
    pdfjsAssets(),
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
        // Likewise the editor's languages and Vim mode (assets/cm/), and the
        // document viewers with pdf.js's maps, fonts and decoders
        // (assets/doc/).
        globIgnores: [
          '**/assets/shiki/**',
          '**/assets/cm/**',
          '**/assets/doc/**',
        ],
        // Notification click (and push) handlers: public/notify-sw.js
        importScripts: ['notify-sw.js'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/assets/shiki/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'shiki',
              // Hashed names: a new build adds entries, so old ones expire
              // Grammars, themes and Pele's diagram types: about 115 files;
              // the document workers (pdf.js, SheetJS, mammoth)
              expiration: { maxEntries: 300, maxAgeSeconds: 30 * 24 * 3600 },
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
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/assets/doc/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'doc',
              // The viewers, and the character maps and fonts a PDF asks
              // for (about 190 files in all)
              expiration: { maxEntries: 300, maxAgeSeconds: 30 * 24 * 3600 },
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
      output: { chunkFileNames: chunkFileName, assetFileNames: assetFileName },
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
