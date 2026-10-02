import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SlashCommand } from '../utils/slash-commands'
import { SlashCommandList, slashOptionId } from './slash-command-list'

const commands: SlashCommand[] = [
  {
    name: 'model',
    description: 'Switch the model',
    source: 'builtin',
    terminal: true,
  },
  {
    name: 'deploy',
    description: 'Deploy it',
    source: 'project',
    kind: 'command',
  },
  { name: 'helper', source: 'user', kind: 'skill' },
  { name: 'kai:translate', source: 'plugin', kind: 'skill' },
]

describe('SlashCommandList', () => {
  it('shows each command with its description and tags', () => {
    render(
      <SlashCommandList
        id="l"
        commands={commands}
        active={1}
        onPick={vi.fn()}
        onActive={vi.fn()}
      />,
    )
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(4)
    expect(options[0].textContent).toContain('/model')
    expect(options[0].textContent).toContain('Switch the model')
    expect(options[0].textContent).toContain('opens in Terminal')
    expect(options[0].textContent).toContain('built-in')
    expect(options[1].getAttribute('aria-selected')).toBe('true')
    expect(options[1].id).toBe(slashOptionId('l', 1))
    expect(options[1].textContent).toContain('project')
    expect(options[2].textContent).toContain('skill')
    expect(options[2].textContent).toContain('user')
    expect(options[3].textContent).toContain('/kai:translate')
    expect(options[3].textContent).toContain('plugin')
  })

  it('picks on click, highlights on hover and keeps the focus where it is', () => {
    const onPick = vi.fn()
    const onActive = vi.fn()
    render(
      <SlashCommandList
        id="l"
        commands={commands}
        active={0}
        onPick={onPick}
        onActive={onActive}
      />,
    )
    const [first, second] = screen.getAllByRole('option')
    fireEvent.mouseMove(first)
    expect(onActive).not.toHaveBeenCalled()
    fireEvent.mouseMove(second)
    expect(onActive).toHaveBeenCalledWith(1)
    // mousedown is prevented so the textarea keeps the focus
    expect(fireEvent.mouseDown(second)).toBe(false)
    fireEvent.click(second)
    expect(onPick).toHaveBeenCalledWith(commands[1])
  })

  it('scrolls the highlighted row into view', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    const { rerender } = render(
      <SlashCommandList
        id="l"
        commands={commands}
        active={0}
        onPick={vi.fn()}
        onActive={vi.fn()}
      />,
    )
    rerender(
      <SlashCommandList
        id="l"
        commands={commands}
        active={2}
        onPick={vi.fn()}
        onActive={vi.fn()}
      />,
    )
    expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' })
    // @ts-expect-error restore jsdom's missing method
    delete Element.prototype.scrollIntoView
  })

  it('says when nothing matches', () => {
    render(
      <SlashCommandList
        id="l"
        commands={[]}
        active={0}
        onPick={vi.fn()}
        onActive={vi.fn()}
      />,
    )
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByText('No matching command')).toBeTruthy()
  })
})
