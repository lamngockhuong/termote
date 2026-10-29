import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithLocale } from './test-utils'
import { renderTags, Trans } from './trans'

describe('renderTags', () => {
  it('draws each known tag and keeps the text around it', () => {
    const { container } = render(
      <p>
        {renderTags('Press <kbd>Esc</kbd> or <b>Done</b>.', {
          kbd: (s) => <kbd>{s}</kbd>,
          b: (s) => <strong>{s}</strong>,
        })}
      </p>,
    )
    expect(container.innerHTML).toBe(
      '<p>Press <kbd>Esc</kbd> or <strong>Done</strong>.</p>',
    )
  })

  it('ends on a tag', () => {
    const { container } = render(
      <p>{renderTags('<b>x</b>', { b: (s) => <b>{s}</b> })}</p>,
    )
    expect(container.innerHTML).toBe('<p><b>x</b></p>')
  })

  it('shows an unknown tag as its text, never as markup', () => {
    const { container } = render(<p>{renderTags('<i>x</i><img src=y>', {})}</p>)
    expect(container.innerHTML).toBe('<p>x&lt;img src=y&gt;</p>')
  })
})

describe('Trans', () => {
  it('reads the message in the app language', () => {
    renderWithLocale(<Trans k="common.next" tags={{}} />, 'vi')
    expect(screen.getByText('Tiếp')).toBeInTheDocument()
  })

  it('reads the message in the tour language with tour', () => {
    render(<Trans k="common.back" tags={{}} tour />)
    expect(screen.getByText('Back')).toBeInTheDocument()
  })
})
