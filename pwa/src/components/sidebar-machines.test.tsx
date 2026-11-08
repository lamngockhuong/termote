import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MachineInfo } from '../hooks/use-mux-api'
import {
  busyCount,
  MachineListHeading,
  SidebarMachines,
} from './sidebar-machines'

const BOX: MachineInfo = {
  id: '0123456789abcdef',
  label: 'Box',
  status: 'online',
  groups: [
    {
      id: 'g',
      name: 'api',
      tabs: [
        {
          id: 't',
          name: 'build',
          panes: [
            {
              id: 'p1',
              name: 'tests',
              agent: { name: 'claude', status: 'blocked' },
            },
            { id: 'p2', agent: { name: 'codex', status: 'working' } },
            { id: 'p3', agent: { name: 'claude', status: 'idle' } },
            { id: 'p4', agent: { name: 'x', status: 'unknown' } },
            { id: 'p5' },
          ],
        },
      ],
    },
  ],
}

describe('SidebarMachines', () => {
  it('shows nothing without a machine', () => {
    const { container } = render(
      <SidebarMachines machines={[]} current="" onSelect={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('lists this machine first, then each with its status and busy agents', () => {
    const onSelect = vi.fn()
    render(
      <SidebarMachines
        machines={[
          BOX,
          { id: '1123456789abcdef', label: 'Pi', status: 'unauthorized' },
        ]}
        current={BOX.id}
        onSelect={onSelect}
      />,
    )
    const local = screen.getByRole('button', { name: 'This machine' })
    expect(local).not.toHaveAttribute('aria-current')
    const box = screen.getByRole('button', { name: /^Box/ })
    expect(box).toHaveAttribute('aria-current', 'true')
    expect(box).toHaveTextContent('2')
    expect(screen.getByRole('img', { name: 'Online' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Key refused' })).toBeInTheDocument()
    fireEvent.click(local)
    expect(onSelect).toHaveBeenCalledWith('')
    fireEvent.click(screen.getByRole('button', { name: /^Pi/ }))
    expect(onSelect).toHaveBeenCalledWith('1123456789abcdef')
  })

  it('lists no agents, and says what to do about a broken machine', () => {
    render(
      <SidebarMachines
        machines={[
          BOX,
          { id: '1123456789abcdef', label: 'Pi', status: 'hostkey' },
          { id: '3123456789abcdef', label: 'New', status: 'later' as never },
        ]}
        current=""
        onSelect={vi.fn()}
      />,
    )
    // The open machine's agents are in the Agents list, not here
    expect(screen.queryByText('tests')).not.toBeInTheDocument()
    // Only Machines itself folds: a machine sits level with This machine
    expect(
      screen
        .getAllByRole('button')
        .filter((b) => b.hasAttribute('aria-expanded')),
    ).toHaveLength(1)
    expect(
      screen.getByText(
        'Host key changed. Check it with: termote machine status',
      ),
    ).toBeInTheDocument()
    // A status this version does not know reads as offline
    expect(screen.getAllByRole('img', { name: 'Offline' })).toHaveLength(1)
    expect(
      screen.getByText('Offline. Check it with: termote machine status'),
    ).toBeInTheDocument()
    expect(screen.getAllByText(/termote machine status/)).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: /^Machines/ }))
    expect(
      screen.queryByRole('button', { name: 'This machine' }),
    ).not.toBeInTheDocument()
  })

  it('counts the agents that need the user or work', () => {
    expect(busyCount(BOX)).toBe(2)
    expect(busyCount({ ...BOX, groups: undefined })).toBe(0)
  })
})

describe('MachineListHeading', () => {
  it('names the machine whose list follows', () => {
    const { rerender } = render(
      <MachineListHeading machines={[BOX]} current="" />,
    )
    expect(
      screen.getByRole('heading', { name: 'On This machine' }),
    ).toBeInTheDocument()
    rerender(<MachineListHeading machines={[BOX]} current={BOX.id} />)
    expect(screen.getByRole('heading', { name: 'On Box' })).toBeInTheDocument()
  })

  it('shows nothing without a machine, or before the open one is listed', () => {
    const { container, rerender } = render(
      <MachineListHeading machines={[]} current="" />,
    )
    expect(container).toBeEmptyDOMElement()
    rerender(<MachineListHeading machines={[BOX]} current="ffffffffffffffff" />)
    expect(container).toBeEmptyDOMElement()
  })
})
