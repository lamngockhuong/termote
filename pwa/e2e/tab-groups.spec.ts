import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from './fixtures'

// Tab groups: tabs of a workspace gathered by the part of their name before
// the first "/" ("review/PR 1"), after the group's coloured name in the one
// tab bar, like a browser's. On any backend that makes groups and renames
// tabs, in a group of its own made and closed through the API, at the sizes
// of a desktop, a laptop, a tablet and a phone.
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

const tabBar = (page: Page) => page.getByRole('tablist', { name: 'Sessions' })
const tab = (page: Page, name: string) => tabBar(page).getByRole('tab', { name: new RegExp(name) })
const groupName = (page: Page, name: string) => tabBar(page).locator(`[data-group-chip="${name}"]`)
// What the tab bar shows, left to right: a group's name as [name]
const shown = (page: Page) =>
  tabBar(page)
    .locator('[role="tab"], [data-group-chip]')
    .evaluateAll((els) =>
      els
        .filter((el) => !el.closest('[data-leaving]'))
        .map((el) =>
          el instanceof HTMLElement && el.dataset.groupChip !== undefined
            ? `[${el.dataset.groupChip}]`
            : (el.querySelector('.truncate')?.textContent ?? '').trim(),
        ),
    )

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
  dir = mkdtempSync(join(tmpdir(), 'e2e-tab-groups-'))
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

// An upright tablet leaves the tab bar next to nothing beside the sidebar:
// its sidebar is collapsed, as a user there has it.
const WIDE = [
  { size: 'desktop', viewport: { width: 1920, height: 1080 }, hasTouch: false, sidebarCollapsed: false },
  { size: 'laptop', viewport: { width: 1366, height: 768 }, hasTouch: false, sidebarCollapsed: false },
  { size: 'tablet', viewport: { width: 1024, height: 768 }, hasTouch: true, sidebarCollapsed: false },
  { size: 'upright tablet', viewport: { width: 820, height: 1180 }, hasTouch: true, sidebarCollapsed: true },
]

for (const { size, viewport, hasTouch, sidebarCollapsed } of WIDE) {
  test.describe(`Tab groups on a ${size}`, () => {
    test.use({ viewport, hasTouch })

    test('a tab moves into a new group from its menu, and new tabs join it', async ({ page, request }) => {
      await open(page, request, { sidebarCollapsed })
      await expect.poll(() => shown(page)).toEqual(['main'])

      // New tab group…: named on the tab, which is renamed into it
      await tab(page, 'main').click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'New tab group…' }).click()
      const field = page.getByRole('textbox', { name: 'New tab group for main' })
      await field.fill('review')
      await field.press('Enter')
      await expect.poll(() => namesOf(request)).toEqual(['review/main'])
      // One bar: the group's name, then its tab without the group's
      await expect.poll(() => shown(page)).toEqual(['[review]', 'main'])
      await expectFits(page)

      // + adds a tab at once, into the group on screen
      await page.getByRole('button', { name: 'Add session' }).click()
      await expect.poll(() => namesOf(request)).toEqual(['review/main', 'review/1'])
      await expect.poll(() => shown(page)).toEqual(['[review]', 'main', '1'])

      // The group's menu adds a tab in it, named in the form
      await groupName(page, 'review').click({ button: 'right' })
      await page.getByRole('menuitem', { name: /New tab in this group/ }).click()
      const form = page.getByRole('form', { name: 'New session' })
      await expect(form.getByRole('combobox', { name: 'Tab group' })).toHaveValue('review')
      await form.getByRole('combobox').fill('coding')
      await form.getByRole('textbox', { name: 'Session name' }).fill('api')
      await form.getByRole('button', { name: 'Add' }).click()
      await expect.poll(() => namesOf(request)).toEqual(['review/main', 'review/1', 'coding/api'])
      await expect.poll(() => shown(page)).toEqual(['[review]', 'main', '1', '[coding]', 'api'])
      await expectFits(page)
    })

    test('a group collapses and expands, keeping the tab on screen', async ({ page, request }) => {
      await nameFirstTab(request, 'notes')
      await addTab(request, 'review/one')
      await addTab(request, 'review/two')
      await open(page, request, { sidebarCollapsed })
      await expect.poll(() => shown(page)).toEqual(['notes', '[review]', 'one', 'two'])

      await groupName(page, 'review').click()
      await expect.poll(() => shown(page)).toEqual(['notes', '[review]'])
      await expect(groupName(page, 'review')).toHaveAttribute('aria-expanded', 'false')
      await expect(groupName(page, 'review')).toContainText('2')
      // Kept across a reload in this browser
      await page.reload()
      await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
      await expect.poll(() => shown(page)).toEqual(['notes', '[review]'])
      await expectFits(page)

      // From its menu: expanded again
      await groupName(page, 'review').click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Expand' }).click()
      await expect.poll(() => shown(page)).toEqual(['notes', '[review]', 'one', 'two'])

      // The tab on screen stays when its group collapses
      await tab(page, 'two').click()
      await expect(tab(page, 'two')).toHaveAttribute('aria-selected', 'true')
      await groupName(page, 'review').click()
      await expect.poll(() => shown(page)).toEqual(['notes', '[review]', 'two'])
    })

    test("menus move a tab between groups, rename a group and ungroup its tabs", async ({ page, request }) => {
      await nameFirstTab(request, 'review/one')
      await addTab(request, 'review/two')
      await addTab(request, 'coding/api')
      await addTab(request, 'notes')
      await open(page, request, { sidebarCollapsed })
      await expect.poll(() => shown(page)).toEqual(['[review]', 'one', 'two', '[coding]', 'api', 'notes'])

      // A tab's menu offers the other groups: notes into coding
      await tab(page, 'notes').click({ button: 'right' })
      const group = page.getByRole('group', { name: 'Add to tab group' })
      await expect(group.getByRole('menuitem')).toHaveText(['review', 'coding', 'New tab group…'])
      await group.getByRole('menuitem', { name: 'coding' }).click()
      await expect.poll(() => namesOf(request)).toEqual(['review/one', 'review/two', 'coding/api', 'coding/notes'])
      await expect.poll(() => shown(page)).toEqual(['[review]', 'one', 'two', '[coding]', 'api', 'notes'])

      // And out of its group
      await tab(page, 'api').click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Remove from tab group' }).click()
      await expect.poll(() => namesOf(request)).toEqual(['review/one', 'review/two', 'api', 'coding/notes'])
      await expect.poll(() => shown(page)).toEqual(['[review]', 'one', 'two', 'api', '[coding]', 'notes'])

      // A group's rename renames each of its tabs
      await groupName(page, 'review').click({ button: 'right' })
      await page.getByRole('menuitem', { name: /Rename tab group/ }).click()
      const field = page.getByRole('textbox', { name: 'New name for tab group review' })
      await field.fill('specs')
      await field.press('Enter')
      await expect.poll(() => namesOf(request)).toEqual(['specs/one', 'specs/two', 'api', 'coding/notes'])
      await expect.poll(() => shown(page)).toEqual(['[specs]', 'one', 'two', 'api', '[coding]', 'notes'])

      // Ungroup: its tabs keep their names without the group's
      await groupName(page, 'specs').click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Ungroup' }).click()
      await expect.poll(() => namesOf(request)).toEqual(['one', 'two', 'api', 'coding/notes'])
      await expect.poll(() => shown(page)).toEqual(['one', 'two', 'api', '[coding]', 'notes'])
      await expectFits(page)
    })

    test("a rename with F2 edits the tab's name without its group's", async ({ page, request }) => {
      await nameFirstTab(request, 'review/one')
      await open(page, request, { sidebarCollapsed })
      await tab(page, 'one').focus()
      await page.keyboard.press('F2')
      const field = page.getByRole('textbox', { name: 'New name for review/one' })
      await expect(field).toHaveValue('one')
      await field.fill('auth')
      await field.press('Enter')
      await expect.poll(() => namesOf(request)).toEqual(['review/auth'])
      await expect.poll(() => shown(page)).toEqual(['[review]', 'auth'])
    })

    test('the new session form of the compact sidebar starts with the group on screen', async ({
      page,
      request,
    }) => {
      await nameFirstTab(request, 'review/one')
      await open(page, request, { sidebarLayout: 'compact', sidebarCollapsed })
      await expect(groupName(page, 'review')).toBeVisible()
      await page.getByRole('button', { name: 'Add session' }).click()
      const form = page.getByRole('form', { name: 'New session' })
      await expect(form.getByRole('combobox')).toHaveValue('review')
      await form.getByRole('textbox', { name: 'Session name' }).fill('two')
      await form.getByRole('textbox', { name: 'Session name' }).press('Enter')
      await expect.poll(() => namesOf(request)).toEqual(['review/one', 'review/two'])
      // Cleared: a tab in no group
      await page.getByRole('button', { name: 'Add session' }).click()
      await form.getByRole('combobox').fill('')
      await form.getByRole('textbox', { name: 'Session name' }).fill('notes')
      await form.getByRole('button', { name: 'Add' }).click()
      await expect.poll(() => namesOf(request)).toEqual(['review/one', 'review/two', 'notes'])
      await expectFits(page)
    })

    test('a tab dragged into a group joins it, and dragged away leaves it', async ({ page, request }) => {
      test.skip(hasTouch, 'tabs drag with a mouse or a pen')
      await nameFirstTab(request, 'review/one')
      await addTab(request, 'review/two')
      await addTab(request, 'notes')
      await open(page, request, { sidebarCollapsed })
      await expect.poll(() => shown(page)).toEqual(['[review]', 'one', 'two', 'notes'])

      // The pointer taken from the middle of a tab to x: the tab lands where
      // its left edge passes the middle of the ones before it
      const drag = async (name: string, to: () => Promise<number>) => {
        const from = (await tab(page, name).boundingBox())!
        const y = from.y + from.height / 2
        await page.mouse.move(from.x + from.width / 2, y)
        await page.mouse.down()
        await page.mouse.move(from.x + from.width / 2 - 12, y, { steps: 3 })
        await page.mouse.move(await to(), y, { steps: 8 })
        await page.mouse.up()
      }
      // notes between one and two: into review, in that place
      await drag('notes', async () => {
        const notes = (await tab(page, 'notes').boundingBox())!
        return (await tab(page, 'two').boundingBox())!.x + notes.width / 2 + 2
      })
      await expect.poll(() => namesOf(request)).toEqual(['review/one', 'review/notes', 'review/two'])
      await expect.poll(() => shown(page)).toEqual(['[review]', 'one', 'notes', 'two'])

      // one before the group's name: out of it
      await drag('one', async () => (await groupName(page, 'review').boundingBox())!.x - 20)
      await expect.poll(() => namesOf(request)).toEqual(['one', 'review/notes', 'review/two'])
      await expect.poll(() => shown(page)).toEqual(['one', '[review]', 'notes', 'two'])
      await expectFits(page)
    })

    test('a group dragged by its name moves with its tabs, and keys take a tab out of it', async ({ page, request }) => {
      // review's tabs apart on the server: one move cannot carry the group
      await nameFirstTab(request, 'review/one')
      await addTab(request, 'notes')
      await addTab(request, 'review/two')
      await addTab(request, 'coding/api')
      await open(page, request, { sidebarCollapsed })
      await expect.poll(() => shown(page)).toEqual(['[review]', 'one', 'two', 'notes', '[coding]', 'api'])

      if (!hasTouch) {
        // review's name dragged past the end of the bar
        const from = (await groupName(page, 'review').boundingBox())!
        const end = (await tab(page, 'api').boundingBox())!
        const y = from.y + from.height / 2
        await page.mouse.move(from.x + from.width / 2, y)
        await page.mouse.down()
        await page.mouse.move(from.x + from.width / 2 + 12, y, { steps: 3 })
        await page.mouse.move(end.x + end.width + 200, y, { steps: 10 })
        await page.mouse.up()
        await expect.poll(() => shown(page)).toEqual(['notes', '[coding]', 'api', '[review]', 'one', 'two'])
        await expect.poll(() => namesOf(request)).toEqual(['notes', 'coding/api', 'review/one', 'review/two'])
      }

      // Alt+Left on a group's first tab takes it out of the group
      await tab(page, 'one').click()
      await tab(page, 'one').focus()
      await page.keyboard.press('Alt+ArrowLeft')
      await expect.poll(() => namesOf(request)).toContain('one')
      await expect.poll(async () => (await shown(page)).join(' ')).toMatch(/one \[review\] two/)
      await expectFits(page)
    })
  })
}

test.describe('Tab groups on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the header has no tab bar, and the sessions sheet shows the whole names', async ({ page, request }) => {
    await nameFirstTab(request, 'review/one')
    await addTab(request, 'coding/api')
    await open(page, request)
    await expect(tabBar(page)).toHaveCount(0)
    await expectFits(page)
    await page.getByRole('button', { name: 'Open sessions menu' }).click()
    const sheet = page.getByRole('dialog')
    await expect(sheet.getByText('review/one').first()).toBeVisible()
    await expect(sheet.getByText('coding/api').first()).toBeVisible()
    await expectFits(page)
  })
})
