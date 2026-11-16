import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from './fixtures'

// FatherTabs: tabs of a workspace gathered by the part of their name before
// the first "/" ("review/PR 1"), in a row above the tab bar. On any backend
// that makes groups and renames tabs, in a group of its own made and closed
// through the API, at the sizes of a desktop, a laptop, a tablet and a phone.
const JSON_HEADERS = { 'Content-Type': 'application/json' }

interface Tab {
  id: string
  name: string
}

let groupId = ''
let dir = ''
let run = ''

// The group's tabs as the server lists them, in order.
const tabsOf = async (request: APIRequestContext): Promise<Tab[]> => {
  const snap = await (await request.get('/api/mux/snapshot')).json()
  return snap.groups.find((g: { id: string }) => g.id === groupId)?.tabs ?? []
}
const namesOf = async (request: APIRequestContext) => (await tabsOf(request)).map((t) => t.name)

const addTab = async (request: APIRequestContext, name: string) => {
  const res = await request.post('/api/mux/tabs', { headers: JSON_HEADERS, data: { groupId, name } })
  expect(res.ok()).toBe(true)
}

// The group's first tab is the one the backend made with it: named here.
const nameFirstTab = async (request: APIRequestContext, name: string) => {
  const [first] = await tabsOf(request)
  const res = await request.patch(`/api/mux/tabs/${encodeURIComponent(first.id)}`, {
    headers: JSON_HEADERS,
    data: { name },
  })
  expect(res.ok()).toBe(true)
}

async function open(page: Page, request: APIRequestContext, settings: Record<string, unknown> = {}) {
  const { sidebarCollapsed = false, ...rest } = settings
  const [first] = await tabsOf(request)
  // A server with sign-in on (TERMOTE_PASS): a page gets the form, never a
  // Basic challenge
  if (process.env.TERMOTE_PASS) {
    await page.goto('/login')
    await page.getByLabel('Username').fill(process.env.TERMOTE_USER || 'admin')
    await page.getByLabel('Password').fill(process.env.TERMOTE_PASS)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL((u) => !u.pathname.startsWith('/login'))
  }
  await page.goto('/')
  await page.evaluate(([s, collapsed]) => {
    localStorage.clear()
    // The shortest refresh the settings take (POLL_INTERVAL_OPTIONS)
    localStorage.setItem('termote-settings', JSON.stringify({ pollInterval: 3, ...s }))
    if (collapsed) localStorage.setItem('sidebar-collapsed', 'true')
  }, [rest, sidebarCollapsed] as const)
  await page.goto(`/#/s/${encodeURIComponent(groupId)}/${encodeURIComponent(first.id)}`)
  await page.reload()
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
}

const fatherRow = (page: Page) => page.getByRole('tablist', { name: 'FatherTabs' })
const father = (page: Page, name: string) => fatherRow(page).getByRole('tab', { name: new RegExp(`^${name}`) })
const tabBar = (page: Page) => page.getByRole('tablist', { name: 'Sessions' })
const tab = (page: Page, name: string) => tabBar(page).getByRole('tab', { name: new RegExp(name) })
// The names the tab bar shows, left to right
const shown = async (page: Page) =>
  (await tabBar(page).getByRole('tab').locator('span.truncate').allInnerTexts()).map((n) => n.trim())

// Nothing of the page is wider than the window, and the terminal is on it
async function expectFits(page: Page) {
  const { scroll, width } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }))
  expect(scroll).toBeLessThanOrEqual(width)
  await expect(page.locator('[data-testid="terminal-view"] .xterm').first()).toBeVisible()
}

test.beforeEach(async ({ request }) => {
  const snap = await (await request.get('/api/mux/snapshot')).json()
  test.skip(!snap.caps.groups || snap.caps.renameTab === false, 'the server makes no groups or renames no tabs')
  run = Math.random().toString(36).slice(2, 8)
  dir = mkdtempSync(join(tmpdir(), 'e2e-father-'))
  const res = await request.post('/api/mux/groups', { headers: JSON_HEADERS, data: { name: `ft-${run}`, cwd: dir } })
  expect(res.ok()).toBe(true)
  groupId = (await res.json()).id
  await nameFirstTab(request, 'main')
})

test.afterEach(async ({ request }) => {
  if (groupId) {
    await request.delete(`/api/mux/groups/${encodeURIComponent(groupId)}`, { headers: JSON_HEADERS })
  }
  groupId = ''
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

// An upright tablet leaves the tab bar next to nothing beside the sidebar,
// FatherTabs or not: its sidebar is collapsed, as a user there has it.
const WIDE = [
  { size: 'desktop', viewport: { width: 1920, height: 1080 }, hasTouch: false, sidebarCollapsed: false },
  { size: 'laptop', viewport: { width: 1366, height: 768 }, hasTouch: false, sidebarCollapsed: false },
  { size: 'tablet', viewport: { width: 1024, height: 768 }, hasTouch: true, sidebarCollapsed: false },
  { size: 'upright tablet', viewport: { width: 820, height: 1180 }, hasTouch: true, sidebarCollapsed: true },
]

for (const { size, viewport, hasTouch, sidebarCollapsed } of WIDE) {
  test.describe(`FatherTabs on a ${size}`, () => {
    test.use({ viewport, hasTouch })

    test('a tab moves into a new FatherTab from its menu, and new tabs join it', async ({ page, request }) => {
      await open(page, request, { sidebarCollapsed })
      await expect(tab(page, 'main')).toBeVisible()
      await expect(fatherRow(page)).toHaveCount(0)

      // New FatherTab…: named on the tab, which is renamed into it
      await tab(page, 'main').click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'New FatherTab…' }).click()
      const field = page.getByRole('textbox', { name: 'New FatherTab for main' })
      await field.fill('review')
      await field.press('Enter')
      await expect(father(page, 'review')).toHaveAttribute('aria-selected', 'true')
      await expect.poll(() => namesOf(request)).toEqual(['review/main'])
      // The tab bar shows the name without its FatherTab
      await expect.poll(() => shown(page)).toEqual(['main'])
      await expectFits(page)

      // + adds a tab at once, into the FatherTab on screen
      await page.getByRole('button', { name: 'Add session' }).click()
      await expect.poll(() => namesOf(request)).toEqual(['review/main', 'review/New'])
      await expect.poll(() => shown(page)).toEqual(['main', 'New'])
      await expect(father(page, 'review')).toContainText('2')

      // The row's + asks for a new FatherTab and its first tab
      await page.getByRole('button', { name: 'New FatherTab' }).click()
      const form = page.getByRole('form', { name: 'New session' })
      await expect(form.getByRole('combobox', { name: 'FatherTab (optional)' })).toBeFocused()
      await form.getByRole('combobox').fill('coding')
      await form.getByRole('textbox', { name: 'Session name' }).fill('api')
      await form.getByRole('button', { name: 'Add' }).click()
      await expect.poll(() => namesOf(request)).toEqual(['review/main', 'review/New', 'coding/api'])
      await expect(father(page, 'coding')).toHaveAttribute('aria-selected', 'true')
      await expect.poll(() => shown(page)).toEqual(['api'])
      await expectFits(page)

      // The row is above the tab bar, both inside the window, and it has the
      // header's width: every FatherTab is in view
      const rowBox = (await fatherRow(page).boundingBox())!
      const barBox = (await tabBar(page).boundingBox())!
      expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(barBox.y + 1)
      expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(viewport.width)
      expect(barBox.x + barBox.width).toBeLessThanOrEqual(viewport.width)
      await expect(father(page, 'review')).toBeInViewport({ ratio: 1 })
      await expect(father(page, 'coding')).toBeInViewport({ ratio: 1 })
    })

    test('a FatherTab opens on the tab last shown in it, and the menu moves a tab between them', async ({
      page,
      request,
    }) => {
      await nameFirstTab(request, 'review/one')
      await addTab(request, 'review/two')
      await addTab(request, 'coding/api')
      await addTab(request, 'notes')
      await open(page, request, { sidebarCollapsed })
      await expect(father(page, 'review')).toHaveAttribute('aria-selected', 'true')
      await expect(fatherRow(page).getByRole('tab')).toHaveText([/^review/, /^coding/, /^Other/])
      await expect.poll(() => shown(page)).toEqual(['one', 'two'])

      // two shown, then coding: review opens on two again
      await tab(page, 'two').click()
      await expect(tab(page, 'two')).toHaveAttribute('aria-selected', 'true')
      await father(page, 'coding').click()
      await expect.poll(() => shown(page)).toEqual(['api'])
      await father(page, 'review').click()
      await expect(tab(page, 'two')).toHaveAttribute('aria-selected', 'true')
      // Other: the tabs in none
      await father(page, 'Other').click()
      await expect.poll(() => shown(page)).toEqual(['notes'])
      await expectFits(page)

      // Its menu offers the other FatherTabs: into coding
      await tab(page, 'notes').click({ button: 'right' })
      const group = page.getByRole('group', { name: 'Move to FatherTab' })
      await expect(group.getByRole('menuitem')).toHaveText(['review', 'coding', 'New FatherTab…'])
      await group.getByRole('menuitem', { name: 'coding' }).click()
      await expect.poll(() => namesOf(request)).toEqual(['review/one', 'review/two', 'coding/api', 'coding/notes'])
      // The tab on screen went there, and the row follows it; Other is gone
      await expect(father(page, 'coding')).toHaveAttribute('aria-selected', 'true')
      await expect(father(page, 'Other')).toHaveCount(0)
      await expect.poll(() => shown(page)).toEqual(['api', 'notes'])

      // And out of any
      await tab(page, 'api').click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'No FatherTab' }).click()
      await expect.poll(() => namesOf(request)).toEqual(['review/one', 'review/two', 'api', 'coding/notes'])
      await expect(father(page, 'Other')).toBeVisible()
      await expectFits(page)
    })

    test('a rename with F2 edits the whole name', async ({ page, request }) => {
      await nameFirstTab(request, 'review/one')
      await open(page, request, { sidebarCollapsed })
      await tab(page, 'one').focus()
      await page.keyboard.press('F2')
      const field = page.getByRole('textbox', { name: 'New name for review/one' })
      await expect(field).toHaveValue('review/one')
      await field.fill('specs/auth')
      await field.press('Enter')
      await expect.poll(() => namesOf(request)).toEqual(['specs/auth'])
      await expect(father(page, 'specs')).toHaveAttribute('aria-selected', 'true')
      await expect.poll(() => shown(page)).toEqual(['auth'])
    })

    test('the new session form of the compact sidebar starts with the FatherTab on screen', async ({
      page,
      request,
    }) => {
      await nameFirstTab(request, 'review/one')
      await open(page, request, { sidebarLayout: 'compact', sidebarCollapsed })
      await expect(father(page, 'review')).toBeVisible()
      await page.getByRole('button', { name: 'Add session' }).click()
      const form = page.getByRole('form', { name: 'New session' })
      await expect(form.getByRole('combobox')).toHaveValue('review')
      await form.getByRole('textbox', { name: 'Session name' }).fill('two')
      await form.getByRole('textbox', { name: 'Session name' }).press('Enter')
      await expect.poll(() => namesOf(request)).toEqual(['review/one', 'review/two'])
      // Cleared: a tab in no FatherTab
      await page.getByRole('button', { name: 'Add session' }).click()
      await form.getByRole('combobox').fill('')
      await form.getByRole('textbox', { name: 'Session name' }).fill('notes')
      await form.getByRole('button', { name: 'Add' }).click()
      await expect.poll(() => namesOf(request)).toEqual(['review/one', 'review/two', 'notes'])
      await expectFits(page)
    })

    test('a tab dragged onto a FatherTab is renamed into it', async ({ page, request }) => {
      test.skip(hasTouch, 'tabs drag with a mouse or a pen')
      await nameFirstTab(request, 'review/one')
      await addTab(request, 'coding/api')
      await addTab(request, 'notes')
      await open(page, request, { sidebarCollapsed })
      await expect(father(page, 'coding')).toBeVisible()

      const dragOnto = async (name: string, to: string) => {
        const from = (await tab(page, name).boundingBox())!
        const target = (await father(page, to).boundingBox())!
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
        await page.mouse.down()
        await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 3 })
        await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 6 })
        // The FatherTab under the pointer is marked
        await expect(father(page, to)).toHaveAttribute('data-drop-target', 'true')
        await page.mouse.up()
        await expect(father(page, to)).not.toHaveAttribute('data-drop-target')
      }

      // review's only tab: review goes with it
      await dragOnto('one', 'coding')
      await expect.poll(() => namesOf(request)).toEqual(['coding/one', 'coding/api', 'notes'])
      await expect(father(page, 'review')).toHaveCount(0)
      await expect.poll(() => shown(page)).toEqual(['one', 'api'])
      // Onto Other: out of any
      await dragOnto('api', 'Other')
      await expect.poll(() => namesOf(request)).toEqual(['coding/one', 'api', 'notes'])
      // Onto its own FatherTab: nothing changes
      await dragOnto('one', 'coding')
      await expect.poll(() => namesOf(request)).toEqual(['coding/one', 'api', 'notes'])
      await expectFits(page)
    })
  })
}

test.describe('FatherTabs on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the header has no row, and the sessions sheet shows the whole names', async ({ page, request }) => {
    await nameFirstTab(request, 'review/one')
    await addTab(request, 'coding/api')
    await open(page, request)
    await expect(fatherRow(page)).toHaveCount(0)
    await expect(tabBar(page)).toHaveCount(0)
    await expectFits(page)
    await page.getByRole('button', { name: 'Open sessions menu' }).click()
    const sheet = page.getByRole('dialog')
    await expect(sheet.getByText('review/one').first()).toBeVisible()
    await expect(sheet.getByText('coding/api').first()).toBeVisible()
    await expectFits(page)
  })
})
