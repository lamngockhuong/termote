import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestError } from '../hooks/use-mux-api'
import { tFor } from '../i18n/i18n-context'
import { PaneRenameDialog, paneNameProblem } from './pane-rename-dialog'

vi.mock('../hooks/use-media-query', () => ({ useIsMobile: () => false }))

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

function show(name = '', onSave = vi.fn().mockResolvedValue(undefined)) {
  const onClose = vi.fn()
  const r = render(
    <PaneRenameDialog name={name} onClose={onClose} onSave={onSave} />,
  )
  return { onClose, onSave, ...r }
}

const box = () => screen.getByRole('textbox') as HTMLInputElement
const type = (v: string) => fireEvent.change(box(), { target: { value: v } })
const save = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  })
}

describe('paneNameProblem', () => {
  const t = tFor('en')
  it('takes what the server takes', () => {
    for (const ok of ['', 'api', 'PR #42', 'Bản dựng', 'x'.repeat(64)]) {
      expect(paneNameProblem(ok, t)).toBe('')
    }
    expect(paneNameProblem('x'.repeat(65), t)).toBe('At most 64 bytes')
    expect(paneNameProblem('ứ'.repeat(22), t)).toBe('At most 64 bytes')
    for (const bad of ['-x', 'a;', 'a\u0007b', 'a‮b', 'a​b']) {
      expect(paneNameProblem(bad, t)).toMatch(/cannot start with/)
    }
  })
})

describe('PaneRenameDialog', () => {
  it('starts with the name, selected, and a hint on clearing it', () => {
    show('api')
    expect(box()).toHaveValue('api')
    expect(box()).toHaveFocus()
    expect([box().selectionStart, box().selectionEnd]).toEqual([0, 3])
    expect(
      screen.getByText('Leave empty to remove the name'),
    ).toBeInTheDocument()
    // Unchanged: nothing to send
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('sends nothing for Enter on the name as it is', async () => {
    const p = show('api')
    type(' api ')
    await act(async () => {
      fireEvent.submit(box())
    })
    expect(p.onSave).not.toHaveBeenCalled()
  })

  it('saves the trimmed name and closes', async () => {
    const p = show()
    type('  tests ')
    await save()
    expect(p.onSave).toHaveBeenCalledWith('tests')
    expect(p.onClose).toHaveBeenCalled()
  })

  it('saves an empty name to remove it, with Enter', async () => {
    const p = show('api')
    type('')
    await act(async () => {
      fireEvent.submit(box())
    })
    expect(p.onSave).toHaveBeenCalledWith('')
  })

  it('says what the server would refuse before sending', async () => {
    const p = show()
    type('-x')
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent('cannot start with')
    expect(box()).toHaveAttribute('aria-invalid', 'true')
    expect(p.onSave).not.toHaveBeenCalled()
    // Typing clears it
    type('x')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('tells a refusal by its code and stays open', async () => {
    for (const [err, text] of [
      [new RequestError(404, 'unknown_pane', 'x'), 'The pane is gone'],
      [new RequestError(400, 'invalid_name', 'x'), 'cannot start with'],
      [new RequestError(500, '', 'x'), 'Could not rename the pane'],
      [new TypeError('offline'), 'Could not rename the pane'],
    ] as const) {
      const p = show('', vi.fn().mockRejectedValue(err))
      type('api')
      await save()
      expect(screen.getByRole('alert')).toHaveTextContent(text)
      expect(p.onClose).not.toHaveBeenCalled()
      p.unmount()
    }
  })

  it('a save that ends after Cancel closes nothing twice', async () => {
    let resolve: () => void = () => {}
    const p = show(
      '',
      vi.fn(
        () =>
          new Promise<void>((r) => {
            resolve = r
          }),
      ),
    )
    type('api')
    await save()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => resolve())
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })

  it('shows nothing from a reply after it was closed', async () => {
    let reject: (e: unknown) => void = () => {}
    const p = show(
      '',
      vi.fn(
        () =>
          new Promise<void>((_, r) => {
            reject = r
          }),
      ),
    )
    type('api')
    await save()
    // A second Enter while one is out sends nothing
    await act(async () => {
      fireEvent.submit(box())
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(p.onClose).toHaveBeenCalledTimes(1)
    await act(async () => reject(new RequestError(404, 'unknown_pane', 'x')))
    expect(screen.queryByRole('alert')).toBeNull()
    // A second save while one is out sends nothing
    expect(p.onSave).toHaveBeenCalledTimes(1)
  })
})
