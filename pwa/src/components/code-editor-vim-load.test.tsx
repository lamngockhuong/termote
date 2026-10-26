import { act, render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ThemeProvider } from '../contexts/theme-context'
import { useSettings } from '../hooks/use-settings'
import CodeEditor from './code-editor'

// Vim mode's chunk cannot be fetched (offline, not installed upfront)
vi.mock('@replit/codemirror-vim', () => {
  throw new Error('offline')
})

let update: ReturnType<typeof useSettings>['updateSetting'] | undefined
function Handles() {
  update = useSettings().updateSetting
  return null
}

function editor(notify: () => void, reveal = false) {
  return render(
    <ThemeProvider>
      <Handles />
      <CodeEditor
        path="a.txt"
        text="a"
        onChange={vi.fn()}
        wrap={false}
        saving={false}
        canSave
        onSave={vi.fn()}
        notify={notify}
        reveal={reveal}
      />
    </ThemeProvider>,
  )
}

it('edits without Vim when it cannot load, and tries again next time', async () => {
  const notify = vi.fn()
  const view = editor(notify, true)
  act(() => update?.('editorVim', true))
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith('Could not load Vim mode'),
  )
  expect(view.container.querySelector('.cm-vim-panel')).toBeNull()
  act(() => update?.('editorVim', false))
  act(() => update?.('editorVim', true))
  await waitFor(() => expect(notify).toHaveBeenCalledTimes(2))
  // Closing a shown sensitive file when Vim never loaded
  view.unmount()
})

it('says nothing when the editor closed before the load failed', async () => {
  const notify = vi.fn()
  const view = editor(notify)
  act(() => update?.('editorVim', true))
  view.unmount()
  await new Promise((r) => setTimeout(r, 20))
  expect(notify).not.toHaveBeenCalled()
})
