import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readSettings, writeSettingsPatch } from '../hooks/use-settings'
import { resetAllShortcuts } from '../hooks/use-shortcuts'
import { IMPORT_MAX_BYTES } from '../utils/settings-registry'
import {
  EXPORT_FILE_NAME,
  SettingsTransferSection,
} from './settings-transfer-section'

const saved = vi.hoisted(() => vi.fn(async (_f: File) => {}))
vi.mock('../utils/download-file', () => ({ saveMadeFile: saved }))
const copied = vi.hoisted(() => ({
  text: '',
  result: 'ok' as 'ok' | 'failed',
}))
vi.mock('../utils/copy-text', () => ({
  copyText: vi.fn(async (text: string) => {
    copied.text = text
    return copied.result
  }),
}))

const exported = (values: Record<string, unknown>) =>
  JSON.stringify({ termote: 'settings', v: 1, values })

async function pickFile(content: string, size?: number) {
  const file = new File([content], 's.json', { type: 'application/json' })
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size })
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Settings file to import'), {
      target: { files: [file] },
    })
  })
}

beforeEach(() => {
  localStorage.clear()
  resetAllShortcuts()
  saved.mockReset()
  saved.mockResolvedValue(undefined)
  copied.result = 'ok'
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

describe('SettingsTransferSection', () => {
  it('saves and copies the settings of this browser', async () => {
    writeSettingsPatch({ editorVim: true })
    render(<SettingsTransferSection />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save to a file' }))
    })
    const file = saved.mock.calls[0][0]
    expect(file.name).toBe(EXPORT_FILE_NAME)
    expect(JSON.parse(await file.text()).values.editorVim).toBe(true)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    })
    expect(JSON.parse(copied.text).termote).toBe('settings')
    expect(screen.getByRole('status')).toHaveTextContent('Copied the settings')
  })

  it('says when saving or copying fails', async () => {
    saved.mockRejectedValue(new Error('denied'))
    copied.result = 'failed'
    render(<SettingsTransferSection />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save to a file' }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The file could not be saved',
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The settings could not be copied',
    )
  })

  it('imports a file through the before/after table', async () => {
    render(<SettingsTransferSection />)
    await pickFile(exported({ editorVim: true, notifyAgents: true }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Import settings')
    expect(dialog).toHaveTextContent('Skipped: set on each device')
    // Nothing changes before Apply
    expect(readSettings().editorVim).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))
    expect(readSettings().editorVim).toBe(true)
    expect(readSettings().notifyAgents).toBe(false)
    expect(screen.getByRole('status')).toHaveTextContent('Applied 1 change')
  })

  it('imports pasted text, and cancels without a change', async () => {
    render(<SettingsTransferSection />)
    const review = screen.getByRole('button', { name: 'Review' })
    expect(review).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Or paste exported settings'), {
      target: { value: exported({ theme: 'dark', editorFontSize: 15 }) },
    })
    fireEvent.click(review)
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(localStorage.getItem('termote-theme')).toBeNull()
    fireEvent.click(review)
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply' }),
    )
    expect(localStorage.getItem('termote-theme')).toBe('dark')
    expect(screen.getByRole('status')).toHaveTextContent('Applied 2 changes')
    expect(screen.getByLabelText('Or paste exported settings')).toHaveValue('')
  })

  it('says why a file or text cannot be imported', async () => {
    render(<SettingsTransferSection />)
    await pickFile('{')
    expect(screen.getByRole('alert')).toHaveTextContent('This is not JSON')
    await pickFile('{"termote":"settings","v":9,"values":{}}')
    expect(screen.getByRole('alert')).toHaveTextContent('from a newer termote')
    await pickFile('{}')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This is not an export of termote settings',
    )
    await pickFile('{}', IMPORT_MAX_BYTES + 1)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This is larger than 64 KB',
    )
    fireEvent.change(screen.getByLabelText('Or paste exported settings'), {
      target: { value: ' '.repeat(IMPORT_MAX_BYTES) + '{}' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This is larger than 64 KB',
    )
    const broken = new File(['x'], 's.json')
    broken.text = () => Promise.reject(new Error('gone'))
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Settings file to import'), {
        target: { files: [broken] },
      })
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The file could not be read',
    )
    // No file picked
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Settings file to import'), {
        target: { files: [] },
      })
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the file picker', () => {
    render(<SettingsTransferSection />)
    const input = screen.getByLabelText('Settings file to import')
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Import a file…' }))
    expect(click).toHaveBeenCalled()
  })
})
