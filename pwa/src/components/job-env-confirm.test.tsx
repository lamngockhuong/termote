import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockConfirm, mockDismiss } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockDismiss: vi.fn(),
}))
vi.mock('../hooks/use-media-query', () => ({ useIsMobile: () => false }))
vi.mock('../hooks/use-jobs', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-jobs')>()),
  confirmJobEnv: (...a: unknown[]) => mockConfirm(...a),
  dismissJobEnv: (...a: unknown[]) => mockDismiss(...a),
}))

import { type Job, RequestError } from '../hooks/use-mux-api'
import { JobEnvConfirmNotice } from './job-env-confirm'

const job = (files: string[]): Job => ({
  id: '0123456789abcdef',
  title: 'Fix login',
  state: 'review',
  updated: 'u1',
  live: { status: 'idle' },
  envConfirm: { files, at: '2026-11-25T09:00:00Z' },
})

const button = (name: string) => screen.getByRole('button', { name })

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  })
  mockConfirm.mockReset()
  mockDismiss.mockReset()
})

describe('JobEnvConfirmNotice', () => {
  it('names the files, asks with Cancel focused, and runs the cleanup on a yes', async () => {
    const j = job(['.env.local', 'app/.env​'])
    mockConfirm.mockResolvedValue({ ...j, state: 'done' })
    render(<JobEnvConfirmNotice job={j} canConfirm />)
    expect(
      screen.getByText(
        /removing the worktree deletes 2 \.env files git ignores/,
      ),
    ).toBeInTheDocument()
    fireEvent.click(button('Review files'))
    expect(
      screen.getByText('Delete these files with the worktree?'),
    ).toBeInTheDocument()
    expect(screen.getByText('.env.local')).toBeInTheDocument()
    // A hidden character in a name shows
    expect(screen.getByText('app/.env⟨U+200B⟩')).toBeInTheDocument()
    expect(button('Cancel')).toHaveFocus()
    await act(async () => fireEvent.click(button('Delete and clean up')))
    expect(mockConfirm).toHaveBeenCalledWith(j)
    expect(screen.getByRole('status')).toHaveTextContent(
      'The job was cleaned up',
    )
  })

  it('says one file in the singular, and Cancel sends nothing', () => {
    render(<JobEnvConfirmNotice job={job(['.env'])} canConfirm />)
    expect(
      screen.getByText(/deletes 1 \.env file git ignores/),
    ).toBeInTheDocument()
    fireEvent.click(button('Review files'))
    fireEvent.click(button('Cancel'))
    expect(mockConfirm).not.toHaveBeenCalled()
  })

  it("says the server's refusal, or that the cleanup failed", async () => {
    mockConfirm.mockRejectedValueOnce(
      new RequestError(409, 'finish_env_changed', 'changed'),
    )
    render(<JobEnvConfirmNotice job={job(['.env'])} canConfirm />)
    fireEvent.click(button('Review files'))
    await act(async () => fireEvent.click(button('Delete and clean up')))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The .env files to confirm changed. Read them again',
    )
    mockConfirm.mockRejectedValueOnce(new Error('network'))
    fireEvent.click(button('Review files'))
    await act(async () => fireEvent.click(button('Delete and clean up')))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not clean up the job',
    )
  })

  it('dismisses the ask, saying a refusal', async () => {
    const j = job(['.env'])
    mockDismiss.mockResolvedValueOnce(j)
    render(<JobEnvConfirmNotice job={j} canConfirm />)
    await act(async () => fireEvent.click(button('Dismiss')))
    expect(mockDismiss).toHaveBeenCalledWith(j)
    expect(screen.queryByRole('alert')).toBeNull()
    mockDismiss.mockRejectedValueOnce(
      new RequestError(403, 'finish_env_pwa_only', 'no'),
    )
    await act(async () => fireEvent.click(button('Dismiss')))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Only you confirm this, in the app signed in with the password or a paired device',
    )
  })

  it('offers no confirm where this browser may not give one', () => {
    render(<JobEnvConfirmNotice job={job(['.env'])} canConfirm={false} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(
      screen.getByText(
        'Confirm this in the app signed in with the password or a paired device',
      ),
    ).toBeInTheDocument()
  })

  it('reads a job without the ask as no files', () => {
    const j = { ...job([]), envConfirm: undefined }
    render(<JobEnvConfirmNotice job={j} canConfirm={false} />)
    expect(screen.getByText(/deletes 0 \.env files/)).toBeInTheDocument()
  })
})
