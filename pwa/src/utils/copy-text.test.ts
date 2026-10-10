import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './copy-text'

function setSecure(secure: boolean) {
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: secure,
  })
}

function setClipboard(writeText?: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  })
}

describe('copyText', () => {
  let exec: ReturnType<typeof vi.fn>
  beforeEach(() => {
    document.getSelection()?.removeAllRanges()
    exec = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: exec,
    })
  })
  afterEach(() => {
    setSecure(false)
    setClipboard(undefined)
    document.body.innerHTML = ''
  })

  it('uses the Clipboard API in a secure context', async () => {
    setSecure(true)
    const writeText = vi.fn(async () => {})
    setClipboard(writeText)
    expect(await copyText('hi')).toBe('ok')
    expect(writeText).toHaveBeenCalledWith('hi')
    expect(exec).not.toHaveBeenCalled()
  })

  it('falls back to a textarea over plain HTTP, and restores focus and selection', async () => {
    setSecure(false)
    const writeText = vi.fn(async () => {})
    setClipboard(writeText)
    const input = document.createElement('input')
    const para = document.createElement('p')
    para.textContent = 'kept'
    document.body.append(input, para)
    input.focus()
    const range = document.createRange()
    range.selectNodeContents(para)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)

    let copied = ''
    exec.mockImplementation(() => {
      const area = document.activeElement as HTMLTextAreaElement
      copied = area.value.slice(area.selectionStart, area.selectionEnd)
      return true
    })
    expect(await copyText('line 1\nline 2')).toBe('ok')
    expect(writeText).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalledWith('copy')
    expect(copied).toBe('line 1\nline 2')
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.activeElement).toBe(input)
    const after = document.getSelection()!
    expect(after.rangeCount).toBe(1)
    expect(after.getRangeAt(0).startContainer).toBe(para)
  })

  it('copies from inside an open modal dialog, which makes the rest inert', async () => {
    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    const button = document.createElement('button')
    dialog.append(button)
    document.body.append(dialog)
    let parent: Element | null = null
    exec.mockImplementation(() => {
      parent = document.querySelector('textarea')!.parentElement
      return true
    })
    button.focus()
    expect(await copyText('x')).toBe('ok')
    expect(parent).toBe(dialog)
    // The dialog itself focused (a sheet as it opens), or nothing focused
    // inside it: still the open dialog
    dialog.tabIndex = -1
    dialog.focus()
    await copyText('x')
    expect(parent).toBe(dialog)
    button.blur()
    ;(document.activeElement as HTMLElement | null)?.blur()
    await copyText('x')
    expect(parent).toBe(dialog)
  })

  it('falls back when writeText is refused', async () => {
    setSecure(true)
    setClipboard(vi.fn(async () => Promise.reject(new Error('denied'))))
    expect(await copyText('x')).toBe('ok')
    expect(exec).toHaveBeenCalled()
  })

  it('falls back without a Clipboard API', async () => {
    setSecure(true)
    setClipboard(undefined)
    expect(await copyText('x')).toBe('ok')
  })

  it('fails when execCommand copies nothing or throws', async () => {
    exec.mockReturnValue(false)
    expect(await copyText('x')).toBe('failed')
    exec.mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(await copyText('x')).toBe('failed')
    expect(document.querySelector('textarea')).toBeNull()
  })
})
