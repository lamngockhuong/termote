import { describe, expect, it, vi } from 'vitest'
import { QUICK_ACTIONS, runAction } from './quick-actions-menu'

const action = (label: string) => {
  const found = QUICK_ACTIONS.find((a) => a.label === label)
  if (!found) throw new Error(`no action ${label}`)
  return found
}

describe('QUICK_ACTIONS', () => {
  it('lists every quick action in order', () => {
    expect(QUICK_ACTIONS.map((a) => a.label)).toEqual([
      'Clear',
      'Cancel',
      'Clear line',
      'Exit',
    ])
  })

  it.each([
    ['Cancel', 'c'],
    ['Clear line', 'u'],
    ['Exit', 'd'],
  ])('%s sends Ctrl+%s', (label, key) => {
    const onSendKey = vi.fn()
    const onSendText = vi.fn()
    runAction(action(label), { onSendKey, onSendText })
    expect(onSendKey).toHaveBeenCalledWith(key, { ctrl: true })
    expect(onSendText).not.toHaveBeenCalled()
  })

  it('the text action sends the text then Enter', () => {
    const calls: string[] = []
    runAction(action('Clear'), {
      onSendKey: (key) => calls.push(`key:${key}`),
      onSendText: (text) => calls.push(`text:${text}`),
    })
    expect(calls).toEqual(['text:clear', 'key:Enter'])
  })
})
