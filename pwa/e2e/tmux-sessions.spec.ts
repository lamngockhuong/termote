import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'

// Every session on the server's tmux is a group. A session made outside
// Termote shows in the sidebar; picking one of its tabs attaches the terminal
// to that session and the pick survives a reload. Needs the socket of the
// server under test: the snapshot lists every session, so on the default
// tmux server this would show (and attach to) the user's own sessions.
const socket = process.env.TMUX_SOCKET

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' }).trim()

test.describe('several tmux sessions', () => {
  test.skip(!socket, 'needs TMUX_SOCKET, the tmux socket of the server under test')

  const name = `e2e-${Math.random().toString(36).slice(2, 8)}`
  let sid = ''

  test.beforeAll(() => {
    sid = tmux('new-session', '-d', '-s', name, '-c', '/tmp', '-n', 'first-win', '-P', '-F', '#{session_id}')
    tmux('new-window', '-t', sid, '-n', 'second-win')
  })

  test.afterAll(() => {
    try {
      tmux('kill-session', '-t', `=${name}`)
    } catch {
      // Already gone
    }
  })

  test('a tab of another session attaches to that session', async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })

    const group = page.locator(`aside section[aria-label="${name}"]`)
    await expect(group).toBeVisible({ timeout: 10000 })
    await group.getByText('first-win').click()

    // The address bar names the session by its id, and termote's client is
    // attached to it.
    await expect(page).toHaveURL(new RegExp(`#/s/${encodeURIComponent(sid)}/${encodeURIComponent(`${sid}:0`)}$`))
    await expect
      .poll(() => tmux('list-clients', '-t', sid, '-F', '#{session_id}:#{window_index}'), { timeout: 10000 })
      .toContain(`${sid}:0`)

    // Opened again without the link: this device keeps its session.
    await page.goto('/')
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
    await expect(page).toHaveURL(new RegExp(`#/s/${encodeURIComponent(sid)}/`))
    await expect
      .poll(() => tmux('list-clients', '-t', sid, '-F', '#{session_id}'), { timeout: 10000 })
      .toContain(sid)
  })
})
