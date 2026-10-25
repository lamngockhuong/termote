import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '../contexts/theme-context'
import MarkdownPreview from './markdown-preview'

// The full-screen viewer's code fails: a render that throws is what a
// rejected import looks like to the boundary around it
vi.mock('./image-viewer', () => ({
  default: () => {
    throw new Error('chunk gone')
  },
}))
vi.mock('../utils/mermaid-render', () => ({
  renderMermaid: () =>
    Promise.resolve({
      ok: true,
      url: 'data:image/svg+xml;charset=utf-8,%3Csvg%3E',
      width: 300,
      height: 120,
      background: '#fff',
    }),
  peekMermaid: () => undefined,
}))
vi.mock('../utils/highlight', async (orig) => ({
  ...(await orig<typeof import('../utils/highlight')>()),
  highlightLang: () => Promise.resolve(null),
}))

let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => error.mockRestore())

describe('MermaidBlock when the viewer cannot be loaded', () => {
  it('tells the user, and keeps the diagram where it is', async () => {
    const notify = vi.fn()
    render(
      <ThemeProvider>
        <MarkdownPreview
          text={'```mermaid\ngraph TD\n  A --> B\n```'}
          path="docs/a.md"
          wrap={false}
          onFollow={vi.fn()}
          notify={notify}
        />
      </ThemeProvider>,
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Open Mermaid diagram 1 full screen',
      }),
    )
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Could not open the image'),
    )
    expect(notify).toHaveBeenCalledTimes(1)
    expect(screen.getByAltText('Mermaid diagram 1')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull()
  })
})
