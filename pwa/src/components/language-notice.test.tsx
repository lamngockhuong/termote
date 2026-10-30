import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithLocale } from '../i18n/test-utils'
import { LanguageNotice } from './language-notice'

describe('LanguageNotice', () => {
  it('says so in Vietnamese and goes back to English', () => {
    const onEnglish = vi.fn()
    const onDismiss = vi.fn()
    renderWithLocale(
      <LanguageNotice onEnglish={onEnglish} onDismiss={onDismiss} />,
      'vi',
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Termote giờ có tiếng Việt cho toàn bộ giao diện.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Chuyển về English' }))
    expect(onEnglish).toHaveBeenCalledOnce()
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Đã hiểu' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
