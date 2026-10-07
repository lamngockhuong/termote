import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from './fixtures'

// Creating, renaming and closing a tmux session from the PWA. Needs the
// socket of the server under test, since the snapshot lists every session
// on that tmux server; the sessions made here are removed straight through
// tmux, never through the routes under test.
const socket = process.env.TMUX_SOCKET

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
const sessionNames = () => tmux('list-sessions', '-F', '#{session_name}').split('\n')

const made: string[] = []
const fresh = (prefix: string) => {
  const name = `${prefix}-${Math.random().toString(36).slice(2, 8)}`
  made.push(name)
  return name
}

async function open(page: Page) {
  await page.goto('/')
  // The first-visit gesture tour would cover the page on a phone
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true }))
  })
  await page.reload()
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
}

async function createInDialog(page: Page, name: string) {
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Directory (an absolute path on the host)').fill('/tmp')
  await page.getByRole('button', { name: 'Create' }).click()
}

test.describe('tmux sessions from the PWA', () => {
  test.skip(!socket, 'needs TMUX_SOCKET, the tmux socket of the server under test')

  test.afterEach(() => {
    for (const name of made.splice(0)) {
      for (const n of [name, `${name}-2`]) {
        try {
          tmux('kill-session', '-t', `=${n}`)
        } catch {
          // Closed by the test, or never made
        }
      }
    }
  })

  test('create, rename and close a session from the sidebar', async ({ page, request }) => {
    const snap = await (await request.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.groups, 'the server cannot manage groups')
    const defaultGroup = snap.groups[0].name
    await open(page)

    const name = fresh('e2e')
    await page.getByRole('button', { name: 'New tmux session' }).click()
    await createInDialog(page, name)

    // In tmux by the name typed, starting in /tmp; the terminal attaches to it.
    await expect.poll(sessionNames, { timeout: 10000 }).toContain(name)
    expect(tmux('display-message', '-p', '-t', `=${name}:`, '#{session_path}')).toBe('/tmp')
    await expect(page.locator(`aside section[aria-label="${name}"]`)).toBeVisible()
    await expect
      .poll(() => tmux('list-clients', '-F', '#{session_name}'), { timeout: 10000 })
      .toContain(name)

    // Renamed in place.
    const renamed = `${name}-2`
    await page.getByRole('button', { name: `Actions for tmux session ${name}` }).click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    await page.getByRole('textbox', { name: `New name for tmux session ${name}` }).fill(renamed)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect.poll(sessionNames, { timeout: 10000 }).toContain(renamed)
    await expect(page.locator(`aside section[aria-label="${renamed}"]`)).toBeVisible()

    // Closed after the confirmation; the default session shows again.
    await page.getByRole('button', { name: `Actions for tmux session ${renamed}` }).click()
    await page.getByRole('menuitem', { name: 'Close' }).click()
    const dialog = page.getByRole('dialog', { name: 'Close tmux session?' })
    await expect(dialog).toContainText(`"${renamed}"`)
    await dialog.getByRole('button', { name: 'Close tmux session' }).click()
    await expect.poll(sessionNames, { timeout: 10000 }).not.toContain(renamed)
    await expect(page.locator(`aside section[aria-label="${renamed}"]`)).toHaveCount(0)
    await expect
      .poll(() => tmux('list-clients', '-F', '#{session_name}'), { timeout: 10000 })
      .toContain(defaultGroup)
  })

  test('a name already taken is refused in the dialog', async ({ page, request }) => {
    const snap = await (await request.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.groups, 'the server cannot manage groups')
    await open(page)
    await page.getByRole('button', { name: 'New tmux session' }).click()
    await createInDialog(page, snap.groups[0].name)
    await expect(page.getByRole('alert')).toHaveText('A tmux session of that name already exists')
    // What was typed stays
    await expect(page.getByLabel('Directory (an absolute path on the host)')).toHaveValue('/tmp')
  })

  test('create a session from the mobile sessions sheet', async ({ page, request }) => {
    const snap = await (await request.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.groups, 'the server cannot manage groups')
    await page.setViewportSize({ width: 390, height: 844 })
    await open(page)
    const name = fresh('e2e-m')
    await page.getByRole('button', { name: 'Open sessions menu' }).click()
    await page.getByRole('button', { name: 'New tmux session' }).click()
    await createInDialog(page, name)
    await expect.poll(sessionNames, { timeout: 10000 }).toContain(name)
    await expect
      .poll(() => tmux('list-clients', '-F', '#{session_name}'), { timeout: 10000 })
      .toContain(name)
  })
})
