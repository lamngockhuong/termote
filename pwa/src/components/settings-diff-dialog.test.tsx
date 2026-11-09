import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tFor } from '../i18n/i18n-context'
import type { SettingChange } from '../utils/settings-registry'
import { formatSettingValue, SettingsDiffDialog } from './settings-diff-dialog'

const t = tFor('en')

describe('formatSettingValue', () => {
  const row: SettingChange = { key: 'x', before: 1, after: 2 }
  const cmd: SettingChange = {
    key: 'shortcuts',
    command: 'tab.new',
    before: undefined,
    after: undefined,
  }
  it('words each kind of value', () => {
    expect(formatSettingValue(row, undefined, t, false)).toBe('not set')
    expect(formatSettingValue(cmd, undefined, t, false)).toBe('default')
    expect(formatSettingValue(row, true, t, false)).toBe('on')
    expect(formatSettingValue(row, false, t, false)).toBe('off')
    expect(formatSettingValue(row, 13, t, false)).toBe('13')
    expect(formatSettingValue(row, '', t, false)).toBe('empty')
    expect(formatSettingValue(row, 'Mono‮', t, false)).toBe('Mono⟨U+202E⟩')
    expect(formatSettingValue(row, [], t, false)).toBe('empty')
    expect(formatSettingValue(row, ['a', 1, 'b​'], t, false)).toBe(
      'a, 1, b⟨U+200B⟩',
    )
    expect(formatSettingValue(row, { a: 1 }, t, false)).toBe('{"a":1}')
    expect(formatSettingValue(row, null, t, false)).toBe('null')
  })

  it('writes a chord as the platform does', () => {
    expect(formatSettingValue(cmd, { key: 'Mod+Shift+K' }, t, false)).toBe(
      'Ctrl+Shift+K',
    )
    expect(formatSettingValue(cmd, { key: 'Mod+Shift+K' }, t, true)).toBe('⇧⌘K')
    expect(
      formatSettingValue(cmd, { key: null, inTerminal: true }, t, false),
    ).toBe('none · in the terminal too')
    expect(formatSettingValue(cmd, { inTerminal: false }, t, false)).toBe(
      'default',
    )
    // A skipped entry shows as it came
    expect(
      formatSettingValue({ ...cmd, skip: 'invalid' }, { key: 5 }, t, false),
    ).toBe('{"key":5}')
  })
})

describe('SettingsDiffDialog', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
  })

  const rows: SettingChange[] = [
    { key: 'theme', before: 'system', after: 'dark' },
    { key: 'editorFontSize', before: 13, after: 99, skip: 'invalid' },
    { key: 'future', before: undefined, after: 1, skip: 'unknown' },
    {
      key: 'shortcuts',
      command: 'pane.next',
      before: undefined,
      after: { key: 'Mod+Shift+C' },
      skip: 'device',
    },
    { key: 'notifyAgents', before: undefined, after: true, skip: 'deviceOnly' },
  ]

  it('lists each change, marks what cannot apply, and applies on Apply', () => {
    const onApply = vi.fn()
    const onCancel = vi.fn()
    render(
      <SettingsDiffDialog
        isOpen
        title="Settings an agent proposes"
        rows={rows}
        onApply={onApply}
        onCancel={onCancel}
      />,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Only this browser changes.')
    const table = within(dialog).getByRole('table')
    const theme = within(table).getByRole('row', { name: /theme/ })
    expect(theme).toHaveTextContent('systemdark')
    for (const text of [
      'Skipped: not a value it can take',
      'Skipped: this version does not know it',
      'Skipped: not usable on this device',
      'Skipped: set on each device',
    ])
      expect(table).toHaveTextContent(text)
    expect(
      within(table).getByRole('rowheader', { name: 'pane.next' }),
    ).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))
    expect(onApply).toHaveBeenCalledOnce()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('turns Apply off for a newer proposal, or nothing to apply', () => {
    const { rerender } = render(
      <SettingsDiffDialog
        isOpen
        title="T"
        rows={rows}
        stale="newer"
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The agent proposed something newer',
    )
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    rerender(
      <SettingsDiffDialog
        isOpen
        title="T"
        rows={rows}
        stale="gone"
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This proposal expired or is no longer on the server',
    )
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    rerender(
      <SettingsDiffDialog
        isOpen
        title="T"
        rows={[]}
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Nothing would change in this browser.',
    )
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
  })
})
