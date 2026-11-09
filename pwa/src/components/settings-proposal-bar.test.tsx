import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithLocale } from '../i18n/test-utils'
import { SettingsProposalBar } from './settings-proposal-bar'

describe('SettingsProposalBar', () => {
  it('says how many settings would change, to review or dismiss', () => {
    const onView = vi.fn()
    const onDismiss = vi.fn()
    const { rerender } = render(
      <SettingsProposalBar count={1} onView={onView} onDismiss={onDismiss} />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'An agent proposes 1 settings change',
    )
    rerender(
      <SettingsProposalBar count={3} onView={onView} onDismiss={onDismiss} />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'An agent proposes 3 settings changes',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(onView).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('speaks Vietnamese', () => {
    renderWithLocale(
      <SettingsProposalBar count={2} onView={vi.fn()} onDismiss={vi.fn()} />,
      'vi',
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Agent đề xuất 2 thay đổi cài đặt',
    )
    expect(screen.getByRole('button', { name: 'Bỏ qua' })).toBeVisible()
  })
})
