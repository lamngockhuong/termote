/// <reference types="vitest" />
import { createHash } from 'node:crypto'
import { cpSync, createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, defineConfig, type Plugin, type Rolldown } from 'vite'
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

function pdfjsAssets(base: string): Plugin {
  let outDir = 'dist'
  return {
    name: 'termote-pdfjs-assets',
    configResolved(c) {
      outDir = c.build.outDir
    },
    // Dev: served from the package, at the paths of the build
    configureServer(server) {
      server.middlewares.use(`${base}${PDFJS_ASSETS}/`, (req, res, next) => {
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

// The Mermaid sandbox page, the page mermaid-render.ts frames with
// sandbox="allow-scripts". Its origin is opaque, so it can load nothing from
// the server (no cookie goes with its requests, and a module or import()
// would need CORS): it is one inline script, the sandbox's code with the
// worker's bundle (mermaid-worker.ts, every diagram type of Pele) as a
// string it starts from a blob: URL. The server allows that script by its
// hash (server/security_headers.go). Built as assets/mermaid-sandbox-<hash>
// .html, named by its content, so it is cached like every asset (a year,
// and by the service worker once fetched); in dev it is SANDBOX_DEV.
const SANDBOX_DEV = 'assets/mermaid-sandbox-dev.html'
const PWA_ROOT = dirname(fileURLToPath(import.meta.url))

// The demo's Content-Security-Policy: the server's (server/security_headers.go)
// less what a meta policy cannot hold (frame-ancestors, sandbox), as
// directives with {scripts} standing for the page's inline script hashes. A
// Go test (TestDemoPolicyMatchesServer) keeps the two equal.
const DEMO_CSP: { app: string[]; sandbox: string[] } = JSON.parse(
  readFileSync(join(PWA_ROOT, 'demo-csp.json'), 'utf8'),
)

// The CSP source of an inline script, hashed as the browser does
function scriptHash(script: string): string {
  return `'sha256-${createHash('sha256').update(script).digest('base64')}'`
}

function cspMeta(directives: string[], scripts: string[]): string {
  const policy = directives
    .map((d) => d.replace('{scripts}', scripts.join(' ')).trim())
    .join('; ')
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`
}

// What search engines show for the demo page (termote.ohnice.app/demo/, in
// the site's sitemap). The installed app keeps the bare title: it is not on
// the web, and a canonical there would point at the demo.
const DEMO_HEAD = [
  '<title>Termote Demo: Try the Terminal Remote Control in Your Browser</title>',
  '<meta name="description" content="Try Termote in your browser with sample sessions, Agent Chat and git changes, without installing anything. Termote controls Claude Code and your terminal from your phone." />',
  '<link rel="canonical" href="https://termote.ohnice.app/demo/" />',
  '<meta property="og:title" content="Termote Demo" />',
  '<meta property="og:description" content="Try Termote in your browser, without installing anything." />',
  '<meta property="og:type" content="website" />',
  '<meta property="og:url" content="https://termote.ohnice.app/demo/" />',
  '<meta property="og:image" content="https://termote.ohnice.app/og-image.png" />',
  '<meta name="twitter:card" content="summary_large_image" />',
].join('\n    ')

// The demo page's head: its policy, after its last change (one hash per
// inline script without attributes, the theme script, as the server allows
// them), and DEMO_HEAD in place of the bare title
function demoHead(): Plugin {
  return {
    name: 'termote-demo-head',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
          (m) => scriptHash(m[1]),
        )
        const charset = /(<meta charset="UTF-8" \/>)/
        // Without its policy the demo would run with none, and no test of
        // violations would notice
        if (!charset.test(html)) throw new Error('demo: no <meta charset> to put the CSP after')
        const title = /<title>Termote<\/title>/
        if (!title.test(html)) throw new Error('demo: no <title>Termote</title> to replace')
        return html
          .replace(charset, `$1\n    ${cspMeta(DEMO_CSP.app, scripts)}`)
          .replace(title, DEMO_HEAD)
      },
    },
  }
}

// One classic script of entry and all it imports
async function iife(entry: string, define: Record<string, string>) {
  const out = (await build({
    configFile: false,
    root: PWA_ROOT,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': '"production"', ...define },
    build: {
      write: false,
      lib: { entry: join(PWA_ROOT, entry), formats: ['iife'], name: 'termote' },
    },
  })) as Rolldown.RolldownOutput[]
  const chunk = out[0].output.find((o) => o.type === 'chunk')
  if (!chunk) throw new Error(`no script built from ${entry}`)
  return chunk.code
}

// csp: the page's own policy as a meta element (the demo: GitHub Pages
// sends no header), {scripts} standing for its script's hash
async function sandboxPage(csp?: string[]): Promise<string> {
  const worker = await iife('src/utils/mermaid-worker.ts', {})
  const code = await iife('src/mermaid-sandbox-main.ts', {
    __MERMAID_WORKER__: JSON.stringify(worker),
  })
  // Never let the HTML parser end or reopen the script early: both only
  // occur inside the worker's string, where \/ and \! read as / and !.
  const safe = code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
  const meta = csp ? cspMeta(csp, [scriptHash(safe)]) : ''
  return `<!doctype html><meta charset="utf-8">${meta}<title>Mermaid</title><script>${safe}</script>\n`
}

function mermaidSandbox(base: string, csp?: string[]): Plugin {
  let built: { fileName: string; html: string } | undefined
  let dev: Promise<string> | undefined
  return {
    name: 'termote-mermaid-sandbox',
    // Built before the app, which names its URL (__MERMAID_SANDBOX_URL__)
    async config(_, { command }) {
      let fileName = SANDBOX_DEV
      if (command === 'build') {
        const html = await sandboxPage(csp)
        const hash = createHash('sha256').update(html).digest('hex').slice(0, 10)
        fileName = `assets/mermaid-sandbox-${hash}.html`
        built = { fileName, html }
      }
      return { define: { __MERMAID_SANDBOX_URL__: JSON.stringify(`${base}${fileName}`) } }
    },
    // Dev: built on the first request, and again after a failed build
    configureServer(server) {
      server.middlewares.use(`${base}${SANDBOX_DEV}`, (_req, res, next) => {
        dev ??= sandboxPage(csp)
        dev.then(
          (html) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(html)
          },
          (err) => {
            dev = undefined
            next(err)
          },
        )
      })
    },
    generateBundle() {
      if (built) this.emitFile({ type: 'asset', fileName: built.fileName, source: built.html })
    },
  }
}

// The demo (--mode demo) is served at /demo/ and installs nothing: no
// manifest, no service worker (virtual:pwa-register is a no-op)
export default defineConfig(({ mode }) => {
  const demo = mode === 'demo'
  const base = demo ? '/demo/' : '/'
  return {
    base,
    define: {
      __APP_NAME__: JSON.stringify(pkg.name),
      __APP_VERSION__: JSON.stringify(pkg.version),
      __PDFJS_ASSETS__: JSON.stringify(`${base}${PDFJS_ASSETS}/`),
    },
    plugins: [
      react(),
      pdfjsAssets(base),
      mermaidSandbox(base, demo ? DEMO_CSP.sandbox : undefined),
      ...(demo ? [demoHead()] : []),
      VitePWA({
        disable: demo,
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
          // themes and grammars; the CSV workers):
          // fetched (then cached) the first time they are needed, never
          // installed upfront.
          // Likewise the editor's languages and Vim mode (assets/cm/), and the
          // document viewers with pdf.js's maps, fonts and decoders
          // (assets/doc/).
          // The Mermaid sandbox page (Pele inline) likewise.
          globIgnores: [
            '**/assets/mermaid-sandbox-*.html',
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
                // Grammars and themes: about 100 files; the document workers
                // (pdf.js, SheetJS, mammoth)
                expiration: { maxEntries: 300, maxAgeSeconds: 30 * 24 * 3600 },
              },
            },
            {
              urlPattern: ({ url }) => url.pathname.startsWith('/assets/mermaid-sandbox-'),
              handler: 'CacheFirst',
              options: {
                cacheName: 'mermaid',
                // One page per build
                expiration: { maxEntries: 2, maxAgeSeconds: 30 * 24 * 3600 },
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
          // The Mermaid sandbox page (its iframe is a navigation), like any
          // asset, is never the app shell.
          navigateFallbackDenylist: [
            /^\/api\//,
            /^\/assets\//,
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
          'src/mermaid-sandbox-main.ts',
          // The demo layer, never in the release build: its routes are held
          // to the app's by src/demo/router.test.ts, its pages by
          // e2e/demo.spec.ts
          'src/demo/**',
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
          target: 'http://127.0.0.1:7680',
          ws: true,
        },
        // A machine's routes, forwarded by the server (streams included)
        '/api/machines': {
          target: 'http://127.0.0.1:7680',
          ws: true,
        },
      },
    },
  }
})
