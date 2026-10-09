import { describe, expect, it } from 'vitest'
import {
  type PrecacheEntry,
  splitFiles,
  splitManifest,
  type ViteManifest,
} from './precache-split'

const MM = 'node_modules/.pnpm/mermaid@12.1.0/node_modules/mermaid/dist'

// The shape of a real build: the app's lazy preview imports Mermaid
// dynamically; Mermaid imports its diagram types itself, and shares one
// chunk (debug) with the app.
const manifest: ViteManifest = {
  'index.html': {
    file: 'assets/index-a.js',
    src: 'index.html',
    imports: ['_debug-d.js'],
    dynamicImports: ['src/components/markdown-preview.tsx'],
    css: ['assets/index-a.css'],
  },
  'src/components/markdown-preview.tsx': {
    file: 'assets/markdown-preview-b.js',
    src: 'src/components/markdown-preview.tsx',
    dynamicImports: [`${MM}/mermaid.core.mjs`],
  },
  '_debug-d.js': { file: 'assets/debug-d.js' },
  [`${MM}/mermaid.core.mjs`]: {
    file: 'assets/mermaid.core-c.js',
    src: `${MM}/mermaid.core.mjs`,
    imports: ['_debug-d.js', '_dagre-e.js'],
    dynamicImports: [`${MM}/chunks/flowDiagram.mjs`, 'missing.js'],
  },
  '_dagre-e.js': { file: 'assets/dagre-e.js' },
  [`${MM}/chunks/flowDiagram.mjs`]: {
    file: 'assets/flowDiagram-f.js',
    src: `${MM}/chunks/flowDiagram.mjs`,
    imports: ['_dagre-e.js'],
    css: ['assets/flow-f.css'],
  },
}

const entry = (url: string): PrecacheEntry => ({ url })

const allEntries = [
  'index.html',
  'assets/index-a.js',
  'assets/index-a.css',
  'assets/markdown-preview-b.js',
  'assets/debug-d.js',
  'assets/mermaid.core-c.js',
  'assets/dagre-e.js',
  'assets/flowDiagram-f.js',
  'assets/flow-f.css',
  'favicon.svg',
].map(entry)

describe('splitFiles', () => {
  it('keeps what the app reaches and splits off what only Mermaid does', () => {
    const { app, mermaidOnly } = splitFiles(manifest)
    expect([...app].sort()).toEqual([
      'assets/debug-d.js',
      'assets/index-a.css',
      'assets/index-a.js',
      'assets/markdown-preview-b.js',
    ])
    expect([...mermaidOnly].sort()).toEqual([
      'assets/dagre-e.js',
      'assets/flow-f.css',
      'assets/flowDiagram-f.js',
      'assets/mermaid.core-c.js',
    ])
  })

  it('knows Mermaid in a flat node_modules', () => {
    const flat: ViteManifest = {
      'index.html': { file: 'assets/i.js', dynamicImports: ['m'] },
      m: { file: 'assets/m.js', src: 'node_modules/mermaid/dist/m.mjs' },
    }
    expect([...splitFiles(flat).mermaidOnly]).toEqual(['assets/m.js'])
  })

  it('throws without index.html', () => {
    expect(() => splitFiles({})).toThrow(/no index.html/)
  })
})

describe('splitManifest', () => {
  it('drops the files only Mermaid reaches', () => {
    expect(splitManifest(allEntries, manifest).map((e) => e.url)).toEqual([
      'index.html',
      'assets/index-a.js',
      'assets/index-a.css',
      'assets/markdown-preview-b.js',
      'assets/debug-d.js',
      'favicon.svg',
    ])
  })

  it('leaves the highlighter alone (globIgnores keeps it out)', () => {
    const withShiki: ViteManifest = {
      ...manifest,
      'index.html': {
        ...manifest['index.html'],
        dynamicImports: [
          'src/components/markdown-preview.tsx',
          'src/utils/highlight-worker.ts',
        ],
      },
      'src/utils/highlight-worker.ts': { file: 'assets/shiki/worker-w.js' },
    }
    expect(splitManifest(allEntries, withShiki)).toHaveLength(6)
  })

  it('throws when Mermaid is no longer lazy', () => {
    // Bundled into the app's own chunks: every Mermaid file is the app's too
    const eager: ViteManifest = {
      ...manifest,
      'index.html': {
        ...manifest['index.html'],
        imports: ['_debug-d.js', '_dagre-e.js', '_app.js'],
      },
      '_app.js': {
        file: 'assets/mermaid.core-c.js',
        imports: ['_flow.js'],
      },
      '_flow.js': {
        file: 'assets/flowDiagram-f.js',
        css: ['assets/flow-f.css'],
      },
    }
    expect(() => splitManifest(allEntries, eager)).toThrow(/imported statically/)
  })

  it('throws when a Mermaid file is spelled otherwise in the precache', () => {
    const slashed = allEntries.map((e) =>
      e.url === 'assets/dagre-e.js' ? entry('/assets/dagre-e.js') : e,
    )
    expect(() => splitManifest(slashed, manifest)).toThrow(
      /not matched: assets\/dagre-e.js/,
    )
  })

  it('throws when a script of the app is missing from the precache', () => {
    const without = allEntries.filter(
      (e) => e.url !== 'assets/markdown-preview-b.js',
    )
    expect(() => splitManifest(without, manifest)).toThrow(
      /app files missing: assets\/markdown-preview-b.js/,
    )
  })
})
