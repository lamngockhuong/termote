import { execFileSync } from 'node:child_process'
import type { APIRequestContext } from '@playwright/test'
import { expect, type Page, test } from './fixtures'

// The Pane menu of the header against a real backend: split, zoom, swap,
// resize and close on the backend of the job running it. On Herdr the page
// shows the split tab's panes side by side (the layout view): typing reaches
// the pane picked, and the desktop's layout shows as it changes; a phone
// shows one pane and offers split and close alone.
// TERMOTE_E2E_HERDR=1 (the e2e-herdr job) is Herdr on HERDR_SOCKET_PATH,
// TERMOTE_E2E_ZELLIJ=1 (the e2e-zellij job) is Zellij on ZELLIJ_SOCKET_DIR,
// else tmux on TMUX_SOCKET (the E2E job). Without that socket the spec skips,
// so a developer's own Herdr, Zellij or tmux is never read; with it, a server
// on another backend, or one without caps.paneLayout, is a failure. Each
// backend's own CLI, on that socket only, reads what the snapshot does not
// show (the zoom, where a pane sits), never does what is tested.
const herdr = process.env.TERMOTE_E2E_HERDR === '1'
const zellij = process.env.TERMOTE_E2E_ZELLIJ === '1'
const backend = herdr ? 'herdr' : zellij ? 'zellij' : 'tmux'
const SOCKET_VAR = { tmux: 'TMUX_SOCKET', herdr: 'HERDR_SOCKET_PATH', zellij: 'ZELLIJ_SOCKET_DIR' }[backend]
const socket = process.env[SOCKET_VAR] ?? ''

const cli = (bin: string, ...args: string[]) =>
  execFileSync(bin, args, {
    encoding: 'utf-8',
    env: { ...process.env, [SOCKET_VAR]: socket },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

// The group a backend's spec makes its tab in: tmux's E2E session, the job's
// Herdr workspace, the Zellij session the server made
const GROUP = { tmux: 'e2e', herdr: 'e2e-repo', zellij: 'main' }[backend]

interface ZellijPane {
  id: number
  is_plugin: boolean
  tab_id: number
  is_fullscreen: boolean
  pane_x: number
  pane_columns: number
}

// Zellij: <group>:p<n> is terminal_<n> of the session. A listing now and
// then fails or comes back empty while the session is busy: asked again, as
// the server's own runner does
function zellijPanes(): ZellijPane[] {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = cli('zellij', '--session', GROUP, 'action', 'list-panes', '-a', '-j')
      if (out) return JSON.parse(out).filter((p: ZellijPane) => !p.is_plugin)
    } catch (err) {
      if (attempt === 5) throw err
    }
    if (attempt === 5) throw new Error('zellij list-panes printed nothing')
    execFileSync('sleep', ['0.3'])
  }
}
const zellijPane = (paneId: string) =>
  zellijPanes().find((p) => p.id === Number(paneId.slice(paneId.lastIndexOf(':p') + 2)))

const herdrLayout = (paneId: string) =>
  JSON.parse(cli('herdr', 'pane', 'layout', '--pane', paneId)).result.layout

// Whether the tab holding paneId is zoomed, as the backend says
function zoomed(paneId: string): boolean {
  if (backend === 'herdr') return herdrLayout(paneId).zoomed === true
  if (backend === 'tmux') return cli('tmux', '-S', socket, 'display', '-p', '-t', paneId, '#{window_zoomed_flag}') === '1'
  const tab = zellijPane(paneId)?.tab_id
  return zellijPanes().some((p) => p.tab_id === tab && p.is_fullscreen)
}

// Where paneId sits across its tab: its left column and its width
function columns(paneId: string): { x: number; width: number } {
  if (backend === 'tmux') {
    const [x, width] = cli('tmux', '-S', socket, 'display', '-p', '-t', paneId, '#{pane_left} #{pane_width}')
      .split(' ')
      .map(Number)
    return { x, width }
  }
  if (backend === 'herdr') {
    const layout = herdrLayout(paneId)
    const { rect } = layout.panes.find((p: { pane_id: string }) => p.pane_id === paneId)
    return { x: rect.x, width: rect.width }
  }
  const p = zellijPane(paneId)!
  return { x: p.pane_x, width: p.pane_columns }
}

interface Snapshot {
  backend: string
  caps: { paneLayout?: boolean; clientSideSelect?: boolean; paneStream?: boolean }
  groups: { id: string; name: string; tabs: { id: string; name: string; panes?: { id: string }[] }[] }[]
}

const snapshot = async (request: APIRequestContext): Promise<Snapshot> =>
  (await request.get('/api/mux/snapshot')).json()

// A write sent past the UI (a same-site JSON request)
const WRITE_HEADERS = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }

const panesOf = async (request: APIRequestContext, tabId: string) =>
  (await snapshot(request)).groups.flatMap((g) => g.tabs).find((t) => t.id === tabId)?.panes ?? []

const strip = (page: Page) => page.getByRole('group', { name: 'Panes' })

async function connected(page: Page) {
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
  await expect(page.getByRole('button', { name: 'Connected' }).first()).toBeAttached({ timeout: 20000 })
}

// A pane of Herdr's layout view, its box on the page, and the text its
// terminal shows
const layoutPane = (page: Page, id: string) => page.locator(`[data-pane-id="${id}"]`)
const box = async (page: Page, id: string) => (await layoutPane(page, id).boundingBox())!
const screenText = (page: Page, id: string) => layoutPane(page, id).locator('.xterm-rows')

const menuButton = (page: Page) => page.getByRole('button', { name: 'Pane', exact: true })

async function paneAction(page: Page, item: string) {
  await menuButton(page).click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

test.describe(`Pane layout on ${backend}`, () => {
  test.skip(!socket, `needs ${SOCKET_VAR}, the ${backend} socket of the server under test`)
  test.describe.configure({ timeout: 90000 })

  let groupId = ''
  let tabId = ''
  // The page picks the pane it streams (Herdr, Zellij), and so the new one
  // after a split
  let clientSide = false
  // The page shows one pane (Herdr): zoom, swap and resize are not offered
  let paneStream = false

  test.beforeEach(async ({ request }) => {
    const snap = await snapshot(request)
    expect(snap.backend, `the server under test runs ${backend}`).toBe(backend)
    expect(snap.caps.paneLayout, 'caps.paneLayout').toBe(true)
    clientSide = snap.caps.clientSideSelect === true
    paneStream = snap.caps.paneStream === true
    const group = snap.groups.find((g) => g.name === GROUP)
    expect(group, `the ${GROUP} group`).toBeTruthy()
    groupId = group!.id
  })

  test.afterEach(async ({ request }) => {
    if (tabId) {
      await request.delete(`/api/mux/tabs/${encodeURIComponent(tabId)}`, { headers: WRITE_HEADERS })
    }
    tabId = ''
  })

  test('split right, zoom, swap, resize, then close the pane shown', async ({ page, request }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('e2e-opened')) return
      sessionStorage.setItem('e2e-opened', '1')
      localStorage.clear()
    })
    // The page first: on Zellij its stream is the client a new tab needs
    await page.goto('/')
    await connected(page)
    // A tab of its own, so a split never lands in another spec's tab
    const res = await request.post('/api/mux/tabs', {
      headers: WRITE_HEADERS,
      data: { groupId, name: `e2e-panes-${Math.random().toString(36).slice(2, 8)}` },
    })
    expect(res.ok()).toBe(true)
    tabId = (await res.json()).id
    await expect.poll(async () => (await panesOf(request, tabId)).length, { timeout: 15000 }).toBe(1)
    const [first] = await panesOf(request, tabId)
    await page.goto(`/#/s/${encodeURIComponent(groupId)}/${encodeURIComponent(tabId)}`)
    await page.reload()
    await connected(page)

    // Split: a second pane, right of the first, in the snapshot and the strip
    await paneAction(page, 'Split right')
    await expect.poll(async () => (await panesOf(request, tabId)).length, { timeout: 15000 }).toBe(2)
    await expect(strip(page).locator('button[aria-pressed]')).toHaveCount(2, { timeout: 15000 })
    await expect(strip(page).locator('button[aria-pressed="true"]')).toHaveCount(1)
    const added = (await panesOf(request, tabId)).find((p) => p.id !== first.id)!
    expect(columns(added.id).x).toBeGreaterThan(columns(first.id).x)

    // The first pane shown again where the page picked the new one
    if (clientSide) {
      await strip(page).locator('button[aria-pressed="false"]').click()
      await expect(strip(page).locator('button[aria-pressed="false"]')).toHaveCount(1)
    }

    if (paneStream) {
      // Herdr: the two panes side by side, the new one on the right, at
      // the same height
      await expect(layoutPane(page, first.id)).toBeVisible({ timeout: 15000 })
      await expect(layoutPane(page, added.id)).toBeVisible()
      const [left, right] = [await box(page, first.id), await box(page, added.id)]
      expect(right.x).toBeGreaterThan(left.x + left.width / 2)
      expect(Math.abs(right.y - left.y)).toBeLessThan(2)

      // Keys go to the pane picked only, and picking moves no focus in Herdr
      const focusedBefore = herdrLayout(first.id).focused_pane_id
      const mark = Math.random().toString(36).slice(2, 8)
      await layoutPane(page, first.id).locator('.xterm').click()
      await page.keyboard.type(`echo left-${mark}`)
      await page.keyboard.press('Enter')
      await expect(screenText(page, first.id)).toContainText(`left-${mark}`, { timeout: 15000 })
      await strip(page).locator('button[aria-pressed="false"]').click()
      await page.keyboard.type(`echo right-${mark}`)
      await page.keyboard.press('Enter')
      await expect(screenText(page, added.id)).toContainText(`right-${mark}`, { timeout: 15000 })
      await expect(screenText(page, first.id)).not.toContainText(`right-${mark}`)
      await expect(screenText(page, added.id)).not.toContainText(`left-${mark}`)
      expect(herdrLayout(first.id).focused_pane_id).toBe(focusedBefore)

      // Zoom: the zoomed pane alone fills the space, then both again
      await paneAction(page, 'Zoom')
      await expect.poll(() => zoomed(added.id), { timeout: 15000 }).toBe(true)
      await expect(layoutPane(page, first.id)).toBeHidden({ timeout: 15000 })
      await expect.poll(async () => (await box(page, added.id)).width, { timeout: 15000 }).toBeGreaterThan(
        right.width * 1.5,
      )
      await paneAction(page, 'Zoom')
      await expect.poll(() => zoomed(added.id), { timeout: 15000 }).toBe(false)
      await expect(layoutPane(page, first.id)).toBeVisible({ timeout: 15000 })

      // Swapped with the next, two panes of one size: the page follows the
      // desktop, the first pane now on the right
      await strip(page).locator('button[aria-pressed="false"]').click()
      await paneAction(page, 'Swap with next pane')
      await expect.poll(() => columns(first.id).x > columns(added.id).x, { timeout: 15000 }).toBe(true)
      await expect
        .poll(async () => (await box(page, first.id)).x > (await box(page, added.id)).x, { timeout: 5000 })
        .toBe(true)

      // Resize: the first pane's left edge moves, on the page too
      const width = (await box(page, first.id)).width
      await paneAction(page, 'Resize left')
      await expect.poll(async () => (await box(page, first.id)).width, { timeout: 5000 }).not.toBeCloseTo(width, 0)
      await page.keyboard.press('Escape')

      // A phone shows one pane: split and close alone
      const size = page.viewportSize()!
      await page.setViewportSize({ width: 390, height: 800 })
      await expect(page.locator('[data-pane-id]')).toHaveCount(0, { timeout: 15000 })
      await menuButton(page).click()
      await expect(page.getByRole('menuitem', { name: 'Split right', exact: true })).toBeVisible()
      for (const name of [/Zoom/, /Swap/, /Resize/]) await expect(page.getByRole('menuitem', { name })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await page.setViewportSize(size)
    } else {
      // Zoom toggles the tab: on, then off again
      expect(zoomed(first.id)).toBe(false)
      await paneAction(page, 'Zoom')
      await expect.poll(() => zoomed(first.id), { timeout: 15000 }).toBe(true)
      await paneAction(page, 'Zoom')
      await expect.poll(() => zoomed(first.id), { timeout: 15000 }).toBe(false)

      // Swapped with the next: the first pane moves to the right
      await paneAction(page, 'Swap with next pane')
      await expect.poll(() => columns(first.id).x > columns(added.id).x, { timeout: 15000 }).toBe(true)

      // Resize: its left edge moves, so it changes width; the menu stays open
      const before = columns(first.id).width
      await paneAction(page, 'Resize left')
      await expect.poll(() => columns(first.id).width, { timeout: 15000 }).not.toBe(before)
      await expect(page.getByRole('menuitem', { name: 'Resize left', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
    }

    // The pane shown closes after the confirmation; the strip goes with it
    await paneAction(page, 'Close pane')
    await page.getByRole('dialog', { name: 'Close pane?' }).getByRole('button', { name: 'Close pane' }).click()
    await expect
      .poll(async () => (await panesOf(request, tabId)).map((p) => p.id), { timeout: 15000 })
      .toEqual([added.id])
    await expect(strip(page)).toHaveCount(0)
  })
})
