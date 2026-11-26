import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from './fixtures'

// Closing the tab on screen shows the tab after it in the tab bar, else the
// one before it, as a browser does; closing another tab keeps the one on
// screen. In a group of its own made and closed through the API.
const JSON_HEADERS = { 'Content-Type': 'application/json' }

let groupId = ''
let dir = ''

const tabsOf = async (request: APIRequestContext): Promise<{ id: string; name: string }[]> => {
  const snap = await (await request.get('/api/mux/snapshot')).json()
  return snap.groups.find((g: { id: string }) => g.id === groupId)?.tabs ?? []
}
const namesOf = async (request: APIRequestContext) => (await tabsOf(request)).map((t) => t.name)

const addTab = async (request: APIRequestContext, name: string) => {
  const res = await request.post('/api/mux/tabs', { headers: JSON_HEADERS, data: { groupId, name } })
  expect(res.ok()).toBe(true)
}

// The group's tabs, named in order: its first tab is the one made with it
async function makeTabs(request: APIRequestContext, names: string[]) {
  const [first] = await tabsOf(request)
  const res = await request.patch(`/api/mux/tabs/${encodeURIComponent(first.id)}`, {
    headers: JSON_HEADERS,
    data: { name: names[0] },
  })
  expect(res.ok()).toBe(true)
  for (const name of names.slice(1)) await addTab(request, name)
  await expect.poll(() => namesOf(request)).toEqual(names)
}

async function open(page: Page, request: APIRequestContext) {
  const [first] = await tabsOf(request)
  if (process.env.TERMOTE_PASS) {
    await page.goto('/login')
    await page.getByLabel('Username').fill(process.env.TERMOTE_USER || 'admin')
    await page.getByLabel('Password').fill(process.env.TERMOTE_PASS)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL((u) => !u.pathname.startsWith('/login'))
  }
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('termote-settings', JSON.stringify({ pollInterval: 3 }))
  })
  await page.goto(`/#/s/${encodeURIComponent(groupId)}/${encodeURIComponent(first.id)}`)
  await page.reload()
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
}

const tabBar = (page: Page) => page.getByRole('tablist', { name: 'Sessions' })
const tab = (page: Page, label: string) => tabBar(page).getByRole('tab', { name: new RegExp(` ${label}$`) })
// The label of the tab shown
const selected = (page: Page) =>
  tabBar(page)
    .locator('[role="tab"][aria-selected="true"]')
    .evaluateAll((els) =>
      els
        .filter((el) => !el.closest('[data-leaving]'))
        .map((el) => (el.querySelector('.truncate')?.textContent ?? '').trim()),
    )

// Closes the tab named name (label: what the bar shows) from its × button,
// which a tab not on screen shows on hover
async function close(page: Page, request: APIRequestContext, name: string, label = name) {
  await tab(page, label).hover()
  await tabBar(page).getByRole('button', { name: `Close ${name}`, exact: true }).click()
  await page.getByRole('dialog', { name: 'Close session?' }).getByRole('button', { name: 'Close session' }).click()
  await expect.poll(() => namesOf(request), { timeout: 15000 }).not.toContain(name)
}

test.use({ viewport: { width: 1366, height: 768 } })

test.beforeEach(async ({ request }) => {
  const snap = await (await request.get('/api/mux/snapshot')).json()
  test.skip(!snap.caps.groups || snap.caps.renameTab === false, 'the server makes no groups or renames no tabs')
  dir = mkdtempSync(join(tmpdir(), 'e2e-close-tab-'))
  const run = Math.random().toString(36).slice(2, 8)
  const res = await request.post('/api/mux/groups', { headers: JSON_HEADERS, data: { name: `ct-${run}`, cwd: dir } })
  expect(res.ok()).toBe(true)
  groupId = (await res.json()).id
})

test.afterEach(async ({ request }) => {
  if (groupId) {
    await request.delete(`/api/mux/groups/${encodeURIComponent(groupId)}`, { headers: JSON_HEADERS })
  }
  groupId = ''
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

test('closing the tab on screen shows the one after it, else the one before', async ({ page, request }) => {
  await makeTabs(request, ['one', 'two', 'three', 'four'])
  await open(page, request)

  // Another tab closed: the one on screen stays
  await tab(page, 'two').click()
  await expect.poll(() => selected(page)).toEqual(['two'])
  await close(page, request, 'four')
  await expect.poll(() => selected(page)).toEqual(['two'])

  // The one on screen closed: the tab after it, not the first
  await close(page, request, 'two')
  await expect.poll(() => selected(page)).toEqual(['three'])
  // Still there after the next snapshots
  await page.waitForTimeout(3500)
  await expect.poll(() => selected(page)).toEqual(['three'])

  // The last tab of the bar closed: the one before it
  await close(page, request, 'three')
  await expect.poll(() => selected(page)).toEqual(['one'])
})

test('the neighbour follows the tab bar, tab groups gathered', async ({ page, request }) => {
  // The bar shows [g] x, y, then plain: y is after x there, not plain
  await makeTabs(request, ['g/x', 'plain', 'g/y'])
  await open(page, request)
  // plain was on screen before x: tmux would go back to it on its own
  await tab(page, 'plain').click()
  await expect.poll(() => selected(page)).toEqual(['plain'])
  await tab(page, 'x').click()
  await expect.poll(() => selected(page)).toEqual(['x'])

  await close(page, request, 'g/x', 'x')
  await expect.poll(() => selected(page)).toEqual(['y'])
})
