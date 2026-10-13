import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import type { APIRequestContext } from '@playwright/test'
import { expect, type Page, test } from './fixtures'

// The Zellij backend from the PWA, against a Zellij of its own: the
// e2e-zellij CI job starts the server with TERMOTE_MUX=zellij, a private
// HOME and ZELLIJ_SOCKET_DIR. Without TERMOTE_E2E_ZELLIJ=1 the spec skips,
// so the tmux job (and a developer's own Zellij) is never touched; with it,
// a server on another backend is a failure. The zellij CLI, on that socket
// dir only, is used to check what happened, never to do what is tested.
const enabled = process.env.TERMOTE_E2E_ZELLIJ === '1'
const socketDir = process.env.ZELLIJ_SOCKET_DIR ?? ''

const zellij = (...args: string[]) =>
  execFileSync('zellij', args, {
    encoding: 'utf-8',
    env: { ...process.env, ZELLIJ_SOCKET_DIR: socketDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
// Every session Zellij lists, exited ones (kept to resurrect) included
const sessionList = () => {
  try {
    return zellij('list-sessions', '--no-formatting')
  } catch {
    return '' // "No active zellij sessions found."
  }
}

// The server's group id of a session: "z" + its name in unpadded base64url
const groupIdOf = (name: string) => `z${Buffer.from(name).toString('base64url')}`

const marker = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`
// Echoes a marker so that only the output holds it, not the command line
const echo = (word: string) => `echo ${word.replace('-', '""-')}`

interface Snapshot {
  backend: string
  groups: {
    id: string
    name: string
    tabs: { id: string; name: string; panes: { process?: { cwd: string } }[] }[]
  }[]
}

const snapshot = async (request: APIRequestContext): Promise<Snapshot> =>
  (await request.get('/api/mux/snapshot')).json()

// A write the cleanup sends past the UI (a same-site JSON request)
const WRITE_HEADERS = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }

const rows = (page: Page) => page.locator('[data-testid="terminal-view"] .xterm-rows')

async function open(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-opened')) return
    sessionStorage.setItem('e2e-opened', '1')
    localStorage.clear()
    localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true }))
  })
  await page.goto('/')
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
  await connected(page)
}

// Keys typed before the stream opens are dropped: wait for it and a screen
// (a phone shows the connection only while it is not connected)
async function connected(page: Page) {
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await expect(page.getByRole('button', { name: 'Connected' }).first()).toBeAttached({
      timeout: 20000,
    })
  }
  await expect(rows(page)).toHaveText(/\S/, { timeout: 20000 })
}

// Types a command through xterm's own input
async function run(page: Page, command: string) {
  await page.locator('[data-testid="terminal-view"] .xterm-helper-textarea').focus()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

// How many times word shows on the screen
const countOnScreen = (page: Page, word: string) =>
  rows(page)
    .textContent()
    .then((t) => (t ?? '').split(word).length - 1)

// A tab row of the desktop sidebar, by its exact name
const tabRow = (page: Page, name: string) =>
  page
    .locator('aside .group')
    .filter({ has: page.locator('span.truncate', { hasText: new RegExp(`^${name}$`) }) })

test.describe('Zellij from the PWA', () => {
  test.skip(!enabled, 'needs TERMOTE_E2E_ZELLIJ=1: a Zellij of its own (the e2e-zellij job)')
  test.describe.configure({ timeout: 90000 })

  // Tabs and sessions made here, closed through the API after each test
  const madeTabs: string[] = []
  const madeGroups: string[] = []

  test.beforeEach(async ({ request }) => {
    expect(socketDir, 'ZELLIJ_SOCKET_DIR').not.toBe('')
    const snap = await snapshot(request)
    // The job runs Zellij: another backend is a failure, not a skip
    expect(snap.backend, 'the server under test runs Zellij').toBe('zellij')
    expect(snap.groups.map((g) => g.name)).toContain('main')
  })

  test.afterEach(async ({ request }) => {
    const snap = await snapshot(request)
    for (const g of snap.groups) {
      if (madeGroups.includes(g.name)) {
        await request.delete(`/api/mux/groups/${encodeURIComponent(g.id)}`, {
          headers: WRITE_HEADERS,
        })
        continue
      }
      for (const t of g.tabs) {
        if (!madeTabs.includes(t.name)) continue
        await request.delete(`/api/mux/tabs/${encodeURIComponent(t.id)}`, {
          headers: WRITE_HEADERS,
        })
      }
    }
    madeTabs.length = 0
    madeGroups.length = 0
  })

  test('types into the default session and shows the output', async ({ page }) => {
    await open(page)
    await expect(page.locator('aside section[aria-label="main"]')).toBeVisible()
    await run(page, echo('zellij-e2e'))
    await expect(rows(page)).toContainText('zellij-e2e', { timeout: 15000 })
  })

  test('a new tab: rename, switch with the stream following, Ctrl+P, close', async ({ page, request }) => {
    await open(page)
    const first = (await snapshot(request)).groups.find((g) => g.name === 'main')!.tabs[0]
    await tabRow(page, first.name).locator('button').first().click()
    await connected(page)
    const inFirst = marker('first')
    await run(page, echo(inFirst))
    await expect(rows(page)).toContainText(inFirst, { timeout: 15000 })

    // New tab, shown at once (a Termote stream is a client, so Zellij lays
    // the tab out)
    const name = marker('e2e-tab')
    madeTabs.push(name)
    await page.locator('aside button[title="Add new session"]').first().click()
    await page.getByPlaceholder('Session name').fill(name)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(tabRow(page, name)).toHaveCount(1, { timeout: 15000 })
    await expect(tabRow(page, name).locator('button[aria-current="true"]')).toHaveCount(1)
    await connected(page)
    await expect(rows(page)).not.toContainText(inFirst, { timeout: 15000 })
    const inNew = marker('second')
    await run(page, echo(inNew))
    await expect(rows(page)).toContainText(inNew, { timeout: 15000 })

    // Renamed in the sidebar and in Zellij
    const renamed = marker('e2e-renamed')
    madeTabs.push(renamed)
    await tabRow(page, name).hover()
    await page.getByRole('button', { name: `Edit ${name}` }).click()
    await page.locator('aside').getByRole('textbox', { name: 'Session name' }).fill(renamed)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(tabRow(page, renamed)).toHaveCount(1, { timeout: 15000 })
    await expect
      .poll(async () => (await snapshot(request)).groups.flatMap((g) => g.tabs.map((t) => t.name)), {
        timeout: 15000,
      })
      .toContain(renamed)

    // Switching tabs: the terminal shows the tab picked
    await tabRow(page, first.name).locator('button').first().click()
    await expect(rows(page)).toContainText(inFirst, { timeout: 15000 })
    await expect(rows(page)).not.toContainText(inNew)
    await tabRow(page, renamed).locator('button').first().click()
    await expect(rows(page)).toContainText(inNew, { timeout: 15000 })
    await expect(rows(page)).not.toContainText(inFirst)

    // The toolbar's Ctrl then P reaches bash (Termote's client is locked, so
    // Zellij's own Ctrl+P pane mode does not take it): the last command
    // comes back, and Enter runs it again
    const again = marker('again')
    await run(page, echo(again))
    await expect.poll(() => countOnScreen(page, again), { timeout: 15000 }).toBe(1)
    await page.getByRole('button', { name: 'Ctrl', exact: true }).click()
    await page.getByTestId('ctrl-combos-overlay').getByRole('button', { name: '^P', exact: true }).click()
    await expect
      .poll(() => countOnScreen(page, again.replace('-', '""-')), { timeout: 15000 })
      .toBe(2)
    await page.locator('[data-testid="terminal-view"] .xterm-helper-textarea').focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => countOnScreen(page, again), { timeout: 15000 }).toBe(2)

    // Closed after the confirmation; the first tab shows again
    await tabRow(page, renamed).hover()
    await page.getByRole('button', { name: `Remove ${renamed}` }).click()
    const dialog = page.getByRole('dialog', { name: 'Close session?' })
    await dialog.getByRole('button', { name: 'Close session' }).click()
    await expect(tabRow(page, renamed)).toHaveCount(0, { timeout: 15000 })
    await expect
      .poll(async () => (await snapshot(request)).groups.flatMap((g) => g.tabs.map((t) => t.name)), {
        timeout: 15000,
      })
      .not.toContain(renamed)
  })

  test('Files lists the pane directory', async ({ page, request }) => {
    const pane = (await snapshot(request)).groups.find((g) => g.name === 'main')!.tabs[0].panes[0]
    const cwd = pane.process?.cwd ?? ''
    expect(cwd, "the pane's directory").not.toBe('')
    const file = `${marker('e2e-file')}.txt`
    try {
      await page.setViewportSize({ width: 1280, height: 800 })
      await open(page)
      // Made by the shell in the pane, so it sits in the directory the
      // server reports
      await run(page, `touch ${file}`)
      await page.getByRole('group', { name: 'Side panel' }).getByRole('button', { name: 'Files' }).click()
      const panel = page.getByRole('complementary', { name: 'Files' })
      await expect(panel).toBeVisible()
      await expect(panel.getByRole('treeitem', { name: file })).toBeVisible({ timeout: 15000 })
    } finally {
      rmSync(path.join(cwd, file), { force: true })
    }
  })

  test('renames a session with its tab on screen, then closes and deletes it', async ({ page }) => {
    await open(page)
    const name = marker('e2e-s')
    madeGroups.push(name)
    await page.getByRole('button', { name: 'New Zellij session' }).click()
    await page.getByLabel('Name', { exact: true }).fill(name)
    await page.getByLabel('Directory (an absolute path on the host)').fill('/tmp')
    await page.getByRole('button', { name: 'Create' }).click()

    // Made and shown: this page's stream is its client
    const section = (n: string) => page.locator(`aside section[aria-label="${n}"]`)
    await expect(section(name)).toBeVisible({ timeout: 20000 })
    await expect(section(name).locator('button[aria-current="true"]')).toHaveCount(1, {
      timeout: 20000,
    })
    await connected(page)
    const inSession = marker('in-session')
    await run(page, `cd /tmp && ${echo(inSession)}`)
    await expect(rows(page)).toContainText(inSession, { timeout: 15000 })

    // Renamed: every id in it changes, the tab on screen stays
    const renamed = marker('e2e-r')
    madeGroups.push(renamed)
    await page.getByRole('button', { name: `Actions for Zellij session ${name}` }).click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    await page.getByRole('textbox', { name: `New name for Zellij session ${name}` }).fill(renamed)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(section(renamed)).toBeVisible({ timeout: 20000 })
    await expect(section(name)).toHaveCount(0)
    await expect(section(renamed).locator('button[aria-current="true"]')).toHaveCount(1)
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('termote-selection-zellij')), {
        timeout: 15000,
      })
      .toContain(`"groupId":"${groupIdOf(renamed)}"`)
    await connected(page)
    await expect(rows(page)).toContainText(inSession, { timeout: 20000 })
    const afterRename = marker('after-rename')
    await run(page, echo(afterRename))
    await expect(rows(page)).toContainText(afterRename, { timeout: 15000 })
    expect(sessionList()).toContain(renamed)

    // Closed: the dialog says it is deleted, and Zellij keeps nothing of it
    await page.getByRole('button', { name: `Actions for Zellij session ${renamed}` }).click()
    await page.getByRole('menuitem', { name: 'Close' }).click()
    const dialog = page.getByRole('dialog', { name: 'Close Zellij session?' })
    await expect(dialog).toContainText(`"${renamed}"`)
    await expect(dialog).toContainText('The session is deleted')
    await expect(dialog).not.toContainText('starts a new')
    await dialog.getByRole('button', { name: 'Close Zellij session' }).click()
    await expect(section(renamed)).toHaveCount(0, { timeout: 20000 })
    await expect.poll(sessionList, { timeout: 15000 }).not.toContain(renamed)
    await expect(section('main')).toBeVisible()
  })

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

    test('Select text shows the history', async ({ page }) => {
      await open(page)
      const word = marker('select')
      // Far more lines than the screen holds: the first ones are history
      await run(page, `clear; seq -f 'line-%g' 1 200; ${echo(word)}`)
      await expect(rows(page)).toContainText(word, { timeout: 15000 })

      await page.getByRole('button', { name: 'Extra keys' }).click()
      await page.getByRole('button', { name: 'Select text' }).click()
      const sheet = page.getByRole('dialog', { name: 'Select text' })
      const text = sheet.getByTestId('select-text')
      await expect(text).toContainText(word, { timeout: 15000 })
      await expect(text).toContainText('line-1\n')
      await expect(text).toContainText('line-200\n')
      // From the server, not from what this page's terminal kept
      await expect(sheet.getByText(/Only what the terminal/)).toHaveCount(0)
      await sheet.getByRole('button', { name: 'Close' }).click()
      await expect(sheet).toHaveCount(0)
    })
  })
})
