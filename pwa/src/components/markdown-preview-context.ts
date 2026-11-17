import { createContext } from 'react'
import type { LinkPath } from '../utils/markdown-links'

// What the parts of a Markdown preview (components/markdown-preview.tsx,
// markdown-table.tsx) read from it
export interface PreviewCtx {
  path: string
  wrap: boolean
  editing: boolean
  // The scroll box, once mounted
  scroller: () => Element | null
  go: (target: LinkPath, newTab?: boolean) => void
  notify: (message: string) => void
}

// Always provided by MarkdownPreview
export const PreviewContext = createContext({} as PreviewCtx)
