import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from './fixtures'

// Moving tmux windows from the PWA, in a tmux session of its own on the
// server's socket (never the shared one). Windows are told apart by name and
// window id, never by index: a move shifts the indexes.
const socket = process.env.TMUX_SOCKET

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

interface Tab {
  id: string
  key: string
  name: string
}

test.describe('reordering tmux windows', () => {
  test.skip(!socket, 'needs TMUX_SOCKET, the tmux socket of the server under test')
  test.describe.configure({ mode: 'serial' })

  let sid = ''
  let names: string[] = []
  const order = () => tmux('list-windows', '-t', sid, '-F', '#{window_name}').split('\n')

  // The session's tabs as the server lists them, in order.
  const tabsOf = async (page: Page): Promise<Tab[]> => {
    const snap = await (await page.request.get('/api/mux/snapshot')).json()
    return snap.groups.find((g: { id: string }) => g.id === sid)?.tabs ?? []
  }
  const tabNamed = async (page: Page, name: string) =>
    (await tabsOf(page)).find((t) => t.name === name) as Tab

  // A row's own button: the one with the shortcut, not its hover Edit and
  // Remove buttons, whose labels hold the name too
  const sidebarRows = (page: Page, name: RegExp) =>
    page.locator('aside button[aria-keyshortcuts]').filter({ hasText: name })
  const sidebarRow = (page: Page, name: string) => sidebarRows(page, new RegExp(name))

  async function open(page: Page, hash = '') {
    await page.goto('/')
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true, pollInterval: 1 }))
    })
    await page.goto(`/${hash}`)
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
  }

  test.beforeEach(async ({ request }) => {
    const snap = await (await request.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.reorderTabs, 'the server cannot move tabs (tmux older than 3.2)')
    const run = Math.random().toString(36).slice(2, 8)
    sid = tmux('new-session', '-d', '-P', '-F', '#{session_id}', '-s', `reorder-${run}`)
    names = ['a', 'b', 'c'].map((n) => `${n}-${run}`)
    for (const name of names) tmux('new-window', '-d', '-t', `${sid}:`, '-n', name)
    tmux('kill-window', '-t', `${sid}:^`)
    expect(order()).toEqual(names)
  })

  test.afterEach(() => {
    try {
      if (sid) tmux('kill-session', '-t', sid)
    } catch {
      // Already gone
    }
  })

  test('drag a window above another, and Alt+Up, in the desktop sidebar', async ({ page }) => {
    const [a, b, c] = names
    await open(page)
    await expect(sidebarRow(page, c)).toBeVisible()
    // The top part of a's row: before it
    await sidebarRow(page, c)
      .locator('..')
      .dragTo(sidebarRow(page, a).locator('..'), { targetPosition: { x: 10, y: 2 } })
    await expect.poll(order).toEqual([c, a, b])
    await expect(sidebarRows(page, new RegExp(`${a}|${b}|${c}`))).toHaveText([
      new RegExp(c),
      new RegExp(a),
      new RegExp(b),
    ])
    // A click still selects a row
    await sidebarRow(page, b).click()
    await expect.poll(() => tmux('display-message', '-p', '-t', sid, '#{window_name}')).toBe(b)

    await sidebarRow(page, b).focus()
    await page.keyboard.press('Alt+ArrowUp')
    await expect.poll(order).toEqual([c, b, a])
    await expect(sidebarRow(page, b)).toBeFocused()
  })

  test('an open rename form and a close follow their window, by key', async ({ page }) => {
    const [a, b, c] = names
    await open(page)
    await sidebarRow(page, b).hover()
    await page.getByRole('button', { name: `Edit ${b}` }).click()
    await expect(page.getByRole('textbox', { name: 'Session name' })).toHaveValue(b)
    // Another device moves c to the top: tmux shifts a and b up one index
    const before = await tabNamed(page, b)
    const tabC = await tabNamed(page, c)
    const moved = await page.request.post(`/api/mux/tabs/${encodeURIComponent(tabC.id)}/move`, {
      data: { index: 0 },
    })
    expect(moved.status()).toBe(200)
    await expect.poll(order).toEqual([c, a, b])
    await expect.poll(async () => (await tabNamed(page, b)).id).not.toBe(before.id)
    // A poll later, the form is still on b
    await page.waitForTimeout(1500)
    await expect(page.getByRole('textbox', { name: 'Session name' })).toHaveValue(b)
    await page.getByRole('button', { name: 'Cancel' }).click()

    // b's old id names a now: a close with b's key is refused
    const stale = await page.request.delete(
      `/api/mux/tabs/${encodeURIComponent(before.id)}?key=${encodeURIComponent(before.key)}`,
      { headers: { 'Content-Type': 'application/json' } },
    )
    expect(stale.status()).toBe(409)
    expect((await stale.json()).code).toBe('changed')
    expect(order()).toEqual([c, a, b])
  })

  test('the move routes refuse a bad index, an unknown tab, a group on tmux', async ({ request }) => {
    const snap = await (await request.get('/api/mux/snapshot')).json()
    const tab = snap.groups.find((g: { id: string }) => g.id === sid).tabs[0]
    const bad = await request.post(`/api/mux/tabs/${encodeURIComponent(tab.id)}/move`, { data: { index: 99 } })
    expect(bad.status()).toBe(400)
    expect((await bad.json()).code).toBe('invalid_index')
    const unknown = await request.post(`/api/mux/tabs/${encodeURIComponent(`${sid}:999`)}/move`, { data: { index: 0 } })
    expect(unknown.status()).toBe(404)
    expect((await unknown.json()).code).toBe('unknown_tab')
    const group = await request.post(`/api/mux/groups/${encodeURIComponent(sid)}/move`, { data: { index: 0 } })
    expect(group.status()).toBe(501)
    expect((await group.json()).code).toBe('unsupported')
    expect(order()).toEqual(names)
  })

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

    test('Move down on the current session row', async ({ page }) => {
      const [a, b, c] = names
      await page.goto('/')
      const tab = await tabNamed(page, a)
      await open(page, `#/s/${encodeURIComponent(sid)}/${encodeURIComponent(tab.id)}`)
      await page.getByRole('button', { name: 'Open sessions menu' }).click()
      await page.getByRole('button', { name: `Move ${a} down` }).click()
      await expect.poll(order).toEqual([b, a, c])
    })
  })
})
