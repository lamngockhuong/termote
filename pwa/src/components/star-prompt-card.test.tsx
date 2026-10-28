import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { APP_INFO } from '../utils/app-info'
import { STAR_PROMPT_KEY } from '../utils/star-prompt'
import { StarPromptCard } from './star-prompt-card'

describe('StarPromptCard', () => {
  beforeEach(() => localStorage.clear())

  it('shows nothing unless the prompt is pending', () => {
    const { container } = render(<StarPromptCard version="1.14.0" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('links the repository in a new tab', () => {
    localStorage.setItem(STAR_PROMPT_KEY, 'pending')
    render(<StarPromptCard version="1.14.0" />)
    expect(screen.getByText(/Updated to v1\.14\.0/)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /^Star on GitHub/ })
    expect(link).toHaveAttribute('href', APP_INFO.repository)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it.each([
    ['the link', () => screen.getByRole('link', { name: /^Star on GitHub/ })],
    [
      'a middle click on the link',
      () => screen.getByRole('link', { name: /^Star on GitHub/ }),
      'aux',
    ],
    ['No thanks', () => screen.getByRole('button', { name: 'No thanks' })],
  ])('ends for good after %s', (_, target, how?: string) => {
    localStorage.setItem(STAR_PROMPT_KEY, 'pending')
    const { unmount } = render(<StarPromptCard version="1.14.0" />)
    if (how === 'aux')
      fireEvent(
        target(),
        new MouseEvent('auxclick', { bubbles: true, button: 1 }),
      )
    else fireEvent.click(target())
    expect(screen.queryByText(/Updated to/)).not.toBeInTheDocument()
    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBe('done')
    unmount()
    render(<StarPromptCard version="1.14.0" />)
    expect(screen.queryByText(/Updated to/)).not.toBeInTheDocument()
  })
})
