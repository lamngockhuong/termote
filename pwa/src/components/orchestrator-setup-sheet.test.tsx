import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithLocale } from '../i18n/test-utils'
import { OrchestratorSetupSheet } from './orchestrator-setup-sheet'

const ALL = [
  'termote skills install',
  'termote skills status',
  '/plugin marketplace add lamngockhuong/termote-plugins',
  '/plugin install termote@termote',
  'codex plugin marketplace add lamngockhuong/termote-plugins',
  'codex plugin add termote@termote',
]

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('OrchestratorSetupSheet', () => {
  it('shows each way to install the skill, and where it runs', () => {
    renderWithLocale(<OrchestratorSetupSheet isOpen onClose={vi.fn()} />, 'en')
    expect(
      screen.getByRole('dialog', { name: 'Let an agent fill the Plan' }),
    ).toBeVisible()
    expect(document.querySelectorAll('code')).toHaveLength(ALL.length)
    for (const line of ALL) {
      expect(screen.getByText(line)).toBeVisible()
      expect(screen.getByRole('button', { name: `Copy ${line}` })).toBeVisible()
    }
    expect(screen.getByRole('heading', { name: 'From Termote' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'As a plugin' })).toBeVisible()
    expect(screen.getByText(/Pick one way, not both/)).toBeVisible()
    expect(screen.getByText(/on the machine that runs Termote/)).toBeVisible()
    expect(screen.getByText(/running natively/)).toBeVisible()
  })

  it('copies the command of the button pressed', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    renderWithLocale(<OrchestratorSetupSheet isOpen onClose={vi.fn()} />, 'en')
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Copy termote skills status' }),
      )
    })
    expect(writeText).toHaveBeenCalledWith('termote skills status')
  })

  it.each([
    [
      'en',
      'Orchestrator guide',
      'https://termote.ohnice.app/usage/orchestrator/',
    ],
    [
      'vi',
      'Hướng dẫn orchestrator',
      'https://termote.ohnice.app/vi/usage/orchestrator/',
    ],
  ] as const)('links the guide in %s', (locale, name, href) => {
    renderWithLocale(
      <OrchestratorSetupSheet isOpen onClose={vi.fn()} />,
      locale,
    )
    const link = screen.getByRole('link', { name })
    expect(link).toHaveAttribute('href', href)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('closes from its close button', () => {
    const onClose = vi.fn()
    renderWithLocale(<OrchestratorSetupSheet isOpen onClose={onClose} />, 'en')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('draws nothing while closed', () => {
    renderWithLocale(
      <OrchestratorSetupSheet isOpen={false} onClose={vi.fn()} />,
      'en',
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
