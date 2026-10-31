import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Session } from '../types/session'
import { MetaChips, OnlyPaneLine, onlyPaneOf } from './meta-chips'

describe('MetaChips', () => {
  it('shows nothing without tokens', () => {
    const { container } = render(<MetaChips />)
    render(<MetaChips tokens={[]} />)
    expect(container).toBeEmptyDOMElement()
    expect(document.querySelector('[data-meta-chips]')).toBeNull()
  })

  it('shows markup from a plugin as text, never as elements or links', () => {
    render(
      <MetaChips
        tokens={[
          { key: 'env', value: '<script>x</script>' },
          { key: 'pr', value: '<a href="https://evil.test">42</a>' },
        ]}
      />,
    )
    expect(screen.getByText('env: <script>x</script>')).toBeInTheDocument()
    expect(
      screen.getByText('pr: <a href="https://evil.test">42</a>'),
    ).toBeInTheDocument()
    const chips = document.querySelector('[data-meta-chips]') as HTMLElement
    expect(chips.querySelector('script, a, b')).toBeNull()
    expect(chips.title).toBe(
      'Reported by a Herdr plugin\nenv: <script>x</script>\npr: <a href="https://evil.test">42</a>',
    )
  })

  it('marks characters that could disguise the text', () => {
    render(<MetaChips tokens={[{ key: 'k', value: 'ab‮cd' }]} />)
    expect(screen.getByText('k: ab⟨U+202E⟩cd')).toBeInTheDocument()
  })

  it('shows three chips and the count of the rest, every one in the title', () => {
    const tokens = ['a', 'b', 'c', 'd', 'e'].map((k) => ({ key: k, value: k }))
    render(<MetaChips tokens={tokens} />)
    expect(screen.getByText('c: c')).toBeInTheDocument()
    expect(screen.queryByText('d: d')).toBeNull()
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(
      (document.querySelector('[data-meta-chips]') as HTMLElement).title,
    ).toContain('e: e')
  })
})

describe('a one-pane tab', () => {
  const tab = (panes: Session['panes']): Session => ({
    id: 't',
    name: 'tab',
    icon: '',
    description: '',
    panes,
  })
  const meta = [{ key: 'env', value: 'dev' }]

  it('is shown with its pane only when the pane has a name or metadata', () => {
    const named = { id: 'p', label: 'api', name: 'api', hasAgent: false }
    expect(onlyPaneOf(tab([named]))).toBe(named)
    const withMeta = { id: 'p', label: 'x', meta, hasAgent: false }
    expect(onlyPaneOf(tab([withMeta]))).toBe(withMeta)
    expect(onlyPaneOf(tab([{ id: 'p', label: 'x', hasAgent: false }]))).toBe(
      undefined,
    )
    expect(onlyPaneOf(tab([named, withMeta]))).toBe(undefined)
    expect(onlyPaneOf(tab(undefined))).toBe(undefined)
  })

  it('shows the name and the chips, the name made visible', () => {
    render(
      <OnlyPaneLine
        pane={{ id: 'p', label: 'x', name: 'a‮b', meta, hasAgent: false }}
      />,
    )
    expect(screen.getByText('a⟨U+202E⟩b')).toBeInTheDocument()
    expect(screen.getByText('env: dev')).toBeInTheDocument()
  })

  it('shows chips alone, and nothing without a pane', () => {
    const { container } = render(<OnlyPaneLine />)
    expect(container).toBeEmptyDOMElement()
    render(
      <OnlyPaneLine pane={{ id: 'p', label: 'x', meta, hasAgent: false }} />,
    )
    expect(
      (document.querySelector('[data-only-pane]') as HTMLElement).textContent,
    ).toBe('env: dev')
  })
})
