import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestError } from '../hooks/use-mux-api'
import { tFor } from '../i18n/i18n-context'
import { openFileInWindows, openInWindowsError } from './open-in-windows'

const mockOpen = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  openInWindows: (...a: unknown[]) => mockOpen(...a),
}))

const err = (status: number, code = '', root?: string) =>
  new RequestError(status, code, 'x', { root })

beforeEach(() => mockOpen.mockReset())

describe('openInWindowsError', () => {
  it.each([
    [
      err(501, 'unavailable'),
      "Windows can't be reached from this server (WSL interop is off)",
    ],
    [err(403, 'sensitive'), 'a.html may contain secrets; not opened'],
    [err(403, 'not_allowed'), "a.html can't be opened from here"],
    [err(403, 'symlink'), 'A link on that path; not opened'],
    [err(429, 'busy'), 'Too many files at once; try again'],
    [err(403, 'view_only'), 'This device is view only'],
    [err(404), 'a.html is gone'],
    [err(409, 'x', '/new'), "The pane's directory changed"],
    [
      err(400, 'windows_name'),
      "a.html's path has a character Windows reads differently (such as \\ or a comma); not opened",
    ],
    [
      err(403, 'runs_program'),
      'Windows may run a.html as a program; not opened',
    ],
    [
      err(403, 'folder_reaches'),
      'a.html, or a folder on the way to it, holds or sits beside entries (shortcuts, desktop.ini, shell folders, broken links) Windows may follow to another computer while it shows them; not opened',
    ],
    [err(400, 'not_file'), 'Windows could not open a.html'],
    [new Error('offline'), 'Windows could not open a.html'],
  ])('%s', (e, text) => {
    expect(openInWindowsError(e, 'a.html', tFor('en'))).toBe(text)
  })
})

describe('openFileInWindows', () => {
  const file = {
    paneId: '3',
    place: 'notes',
    root: '/home/me/repo',
    path: 'site/index.html',
    reveal: false,
  }

  it('asks the server and says it opened', async () => {
    mockOpen.mockResolvedValue(undefined)
    const notify = vi.fn()
    await openFileInWindows(file, notify, tFor('en'))
    expect(mockOpen).toHaveBeenCalledWith(
      { paneId: '3', place: 'notes' },
      { root: '/home/me/repo', path: 'site/index.html', reveal: false },
    )
    expect(notify).toHaveBeenCalledWith('Opened index.html in Windows', {
      variant: 'success',
    })
  })

  it('sends the root itself as "." and names it by its path', async () => {
    mockOpen.mockResolvedValue(undefined)
    const notify = vi.fn()
    await openFileInWindows({ ...file, path: '' }, notify, tFor('en'))
    expect(mockOpen.mock.calls[0][1].path).toBe('.')
    expect(notify.mock.calls[0][0]).toBe('Opened /home/me/repo in Windows')
  })

  it('tells a refusal, and the root that moved', async () => {
    mockOpen.mockRejectedValueOnce(err(409, '', '/elsewhere'))
    const notify = vi.fn()
    const moved = vi.fn()
    await openFileInWindows(file, notify, tFor('en'), moved)
    expect(moved).toHaveBeenCalledWith('/elsewhere')
    expect(notify).toHaveBeenCalledWith("The pane's directory changed", {
      variant: 'danger',
    })
    mockOpen.mockRejectedValueOnce(err(403, 'sensitive'))
    await openFileInWindows(file, notify, tFor('en'), moved)
    expect(moved).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenLastCalledWith(
      'index.html may contain secrets; not opened',
      { variant: 'danger' },
    )
  })

  it('asks before a file Windows runs, then sends run', async () => {
    mockOpen.mockRejectedValueOnce(err(403, 'runs_program'))
    const notify = vi.fn()
    const ask = vi.fn()
    const cmd = { ...file, path: 'tools/build.cmd' }
    await openFileInWindows(cmd, notify, tFor('en'), undefined, ask)
    expect(ask).toHaveBeenCalledWith(cmd)
    expect(notify).not.toHaveBeenCalled()

    mockOpen.mockResolvedValueOnce(undefined)
    await openFileInWindows({ ...cmd, run: true }, notify, tFor('en'))
    expect(mockOpen.mock.calls[1][1]).toEqual({
      root: '/home/me/repo',
      path: 'tools/build.cmd',
      reveal: false,
      run: true,
    })
    expect(notify).toHaveBeenCalledWith('Opened build.cmd in Windows', {
      variant: 'success',
    })
  })

  it('never asks again once run was sent', async () => {
    mockOpen.mockRejectedValueOnce(err(403, 'runs_program'))
    const notify = vi.fn()
    const ask = vi.fn()
    await openFileInWindows(
      { ...file, run: true },
      notify,
      tFor('en'),
      undefined,
      ask,
    )
    expect(ask).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(
      'Windows may run index.html as a program; not opened',
      { variant: 'danger' },
    )
  })
})
