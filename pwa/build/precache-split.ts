// Which built files the service worker installs upfront. Mermaid, and every
// chunk only Mermaid reaches (its diagram types, layouts, d3...), stays out:
// it is fetched the first time a diagram scrolls into view, then cached at
// runtime. A chunk the app reaches too stays in, whatever it holds.

// One entry of Vite's .vite/manifest.json
export interface ManifestChunk {
  file: string
  src?: string
  imports?: string[]
  dynamicImports?: string[]
  css?: string[]
}
export type ViteManifest = Record<string, ManifestChunk>

// One entry of Workbox's precache manifest
export interface PrecacheEntry {
  url: string
}

const ENTRY = 'index.html'
// pnpm's layout (.pnpm/mermaid@x/node_modules/mermaid/) or a flat one
const MERMAID_MODULE = /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?mermaid\//
// Left out by globIgnores, fetched at runtime too (the highlighter)
const RUNTIME_ONLY = /^assets\/shiki\//

function isMermaid(key: string, chunk: ManifestChunk): boolean {
  return MERMAID_MODULE.test(chunk.src ?? key)
}

// Every key reachable from the roots through imports and dynamic imports,
// never entering a key stop refuses
function closure(
  manifest: ViteManifest,
  roots: string[],
  stop: (key: string) => boolean,
): Set<string> {
  const seen = new Set<string>()
  const todo = roots.filter((k) => manifest[k])
  while (todo.length > 0) {
    const key = todo.pop() as string
    if (seen.has(key) || stop(key)) continue
    seen.add(key)
    const chunk = manifest[key]
    for (const next of [
      ...(chunk.imports ?? []),
      ...(chunk.dynamicImports ?? []),
    ]) {
      if (manifest[next]) todo.push(next)
    }
  }
  return seen
}

function filesOf(manifest: ViteManifest, keys: Set<string>): Set<string> {
  const files = new Set<string>()
  for (const key of keys) {
    files.add(manifest[key].file)
    for (const css of manifest[key].css ?? []) files.add(css)
  }
  return files
}

// The app's files (from index.html, stopping at Mermaid) and the files only
// Mermaid reaches
export function splitFiles(manifest: ViteManifest): {
  app: Set<string>
  mermaidOnly: Set<string>
} {
  if (!manifest[ENTRY]) throw new Error(`precache: no ${ENTRY} in the manifest`)
  const mermaidKeys = Object.keys(manifest).filter((k) =>
    isMermaid(k, manifest[k]),
  )
  const app = filesOf(
    manifest,
    closure(manifest, [ENTRY], (k) => isMermaid(k, manifest[k])),
  )
  const mermaid = filesOf(
    manifest,
    closure(manifest, mermaidKeys, () => false),
  )
  const mermaidOnly = new Set([...mermaid].filter((f) => !app.has(f)))
  return { app, mermaidOnly }
}

// The precache without the files only Mermaid reaches, checked both ways:
// each of them matched (and so removed) an entry, and every script of the
// app is still there. Either going wrong throws, so the build fails.
export function splitManifest<T extends PrecacheEntry>(
  entries: T[],
  manifest: ViteManifest,
): T[] {
  const { app, mermaidOnly } = splitFiles(manifest)
  // Mermaid imported statically somewhere: all of it is the app's now
  if (mermaidOnly.size === 0) {
    throw new Error(
      'precache: no file only Mermaid reaches (imported statically, or not at all)',
    )
  }
  const all = new Set(entries.map((e) => e.url))
  // Spelled otherwise in the precache, it would stay in under that spelling
  const unmatched = [...mermaidOnly].filter((f) => !all.has(f))
  if (unmatched.length > 0) {
    throw new Error(`precache: Mermaid files not matched: ${unmatched.join(', ')}`)
  }
  const kept = entries.filter((e) => !mermaidOnly.has(e.url))
  const urls = new Set(kept.map((e) => e.url))
  const missing = [...app].filter(
    (f) => f.endsWith('.js') && !RUNTIME_ONLY.test(f) && !urls.has(f),
  )
  if (missing.length > 0) {
    throw new Error(`precache: app files missing: ${missing.join(', ')}`)
  }
  return kept
}
