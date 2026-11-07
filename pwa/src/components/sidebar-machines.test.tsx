import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MachineInfo } from '../hooks/use-mux-api'
import { busyCount, machineAgents, SidebarMachines } from './sidebar-machines'

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

  it("opens a machine's agents, or what to do about a broken one", () => {
    render(
      <SidebarMachines
        machines={[
          BOX,
          { id: '1123456789abcdef', label: 'Pi', status: 'hostkey' },
          {
            id: '2123456789abcdef',
            label: 'Idle',
            status: 'online',
            groups: [],
          },
          { id: '3123456789abcdef', label: 'New', status: 'later' as never },
        ]}
        current=""
        onSelect={vi.fn()}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Show the agents of Box' }),
    )
    expect(screen.getByText('tests')).toBeInTheDocument()
    expect(screen.getAllByText(/· api \/ build/).length).toBeGreaterThan(0)
    expect(
      screen.getByRole('img', { name: 'Agent blocked' }),
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Show the agents of Pi' }),
    )
    expect(screen.getByText(/termote machine status/)).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Show the agents of Idle' }),
    )
    expect(screen.getByText('No agent runs here')).toBeInTheDocument()
    // A status this version does not know reads as offline
    expect(screen.getAllByRole('img', { name: 'Offline' })).toHaveLength(1)
    fireEvent.click(
      screen.getByRole('button', { name: 'Show the agents of Box' }),
    )
    expect(screen.queryByText('tests')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Machines/ }))
    expect(
      screen.queryByRole('button', { name: 'This machine' }),
    ).not.toBeInTheDocument()
  })

  it('counts the agents that need the user or work', () => {
    expect(machineAgents(BOX)).toHaveLength(4)
    expect(busyCount(BOX)).toBe(2)
    expect(busyCount({ ...BOX, groups: undefined })).toBe(0)
  })
})
