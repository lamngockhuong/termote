import { execFileSync } from 'node:child_process'
import { type APIRequestContext, expect, type Page, test } from './fixtures'

// A tab made on a desktop takes the keys at once: typed right after the +
// of the header's tab bar or the sidebar's form, without a click in the
// terminal, the keys reach the new tab's shell. Against the server's own
// tmux (TMUX_SOCKET), where what the pane shows is read back.

const socket = process.env.TMUX_SOCKET
const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

interface Tab {
  id: string
  name: string
  panes: { id: string }[]
}
const tabsNow = async (request: APIRequestContext): Promise<Tab[]> => {
  const snap = (await (await request.get('/api/mux/snapshot')).json()) as {
    groups: { tabs: Tab[] }[]
  }
  return snap.groups.flatMap((g) => g.tabs)
}

const terminalInput = (page: Page) => page.locator('[data-testid="terminal-view"] .xterm-helper-textarea')

test.describe('a new tab takes the keys', () => {
  test.skip(!socket, "needs TMUX_SOCKET (the server's tmux)")

  let before = new Set<string>()
  const made: string[] = []

  test.beforeEach(async ({ page, request }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('e2e-opened')) return
      sessionStorage.setItem('e2e-opened', '1')
      localStorage.clear()
    })
    await page.goto('/')
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
    before = new Set((await tabsNow(request)).map((t) => t.id))
  })

  test.afterEach(async ({ request }) => {
    for (const id of made.splice(0)) {
      await request.delete(`/api/mux/tabs/${encodeURIComponent(id)}`, {
        headers: { 'Content-Type': 'application/json' },
      })
    }
  })

  // The tab the add made, once the server lists it
  const newTab = async (request: APIRequestContext) => {
    let tab: Tab | undefined
    await expect
      .poll(async () => {
        tab = (await tabsNow(request)).find((t) => !before.has(t.id))
        return !!tab
      })
      .toBe(true)
    made.push(tab!.id)
    return tab!
  }

  // Typed with no click in the terminal: the new tab's shell runs it
  const typesIntoNewTab = async (page: Page, tab: Tab) => {
    await expect(terminalInput(page)).toBeFocused()
    const mark = `nt-${Date.now() % 100000}`
    await page.keyboard.type(`echo ${mark}-$((6*7))`)
    await page.keyboard.press('Enter')
    await expect
      .poll(() => tmux('capture-pane', '-p', '-J', '-t', tab.panes[0].id), { timeout: 10000 })
      .toContain(`${mark}-42`)
  }

  test('from the header’s +', async ({ page, request }) => {
    const plus = page.getByRole('button', { name: 'Add session', exact: true })
    await plus.click()
    const tab = await newTab(request)
    await typesIntoNewTab(page, tab)
  })

  test('from the sidebar’s form', async ({ page, request }) => {
    await page.click('button[title="Add new session"]')
    const name = `focus-${Date.now() % 100000}`
    await page.getByPlaceholder('Session name').fill(name)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    const tab = await newTab(request)
    expect(tab.name).toBe(name)
    await typesIntoNewTab(page, tab)
  })
})
