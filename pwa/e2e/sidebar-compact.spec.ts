import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// The compact sidebar against a real server's tmux: one line per session
// (a workspace), its windows in the header's tab bar, the running agents
// under the list. Two sessions of its own and a stand-in Claude Code
// (tests/fixtures/fake-claude.sh) in one of them, on the server's own
// socket (TMUX_SOCKET): the snapshot lists every session there.

const socket = process.env.TMUX_SOCKET
const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
  }).trim()
const fakeClaude = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/fake-claude.sh',
)

// A session's row: "<name>, <n> tabs[, branch ..][, <status>]"
const groupRow = (page: Page, name: string) =>
  page
    .getByRole('complementary')
    .getByRole('button', { name: new RegExp(`^${name}, \\d+ tabs?`) })
const tabBar = (page: Page) => page.getByRole('tablist', { name: 'Sessions' })
const agents = (page: Page) =>
  page.getByRole('region', { name: 'Running agents' })
const filterBar = (page: Page) =>
  page.getByRole('radiogroup', { name: 'Filter sessions' })
const STATUS_TITLE: Record<string, string> = {
  blocked: 'Needs you',
  working: 'Working',
  done: 'Done',
  idle: 'Idle',
}

// Opens the app on a device with settings of its own (once: a reload keeps
// what the test changed)
async function open(page: Page, settings?: object) {
  await page.addInitScript((seed) => {
    if (sessionStorage.getItem('e2e-opened')) return
    sessionStorage.setItem('e2e-opened', '1')
    localStorage.clear()
    if (seed) localStorage.setItem('termote-settings', JSON.stringify(seed))
  }, settings)
  await page.goto('/')
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', {
    timeout: 15000,
  })
}

async function pickLayout(page: Page, layout: 'Compact' | 'Detailed') {
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings groups' })
    .getByRole('button', { name: 'Sessions' })
    .click()
  await settings
    .getByRole('radiogroup', { name: 'Sidebar layout' })
    .getByRole('radio', { name: layout })
    .click()
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
}

test.describe('compact sidebar', () => {
  test.skip(
    !socket ||
      process.platform !== 'linux' ||
      process.env.TERMOTE_E2E_ZELLIJ === '1',
    'needs TMUX_SOCKET of the server under test (Linux)',
  )
  test.describe.configure({ mode: 'serial' })

  const tag = Math.random().toString(36).slice(2, 8)
  const A = `cmp-a-${tag}`
  const B = `cmp-b-${tag}`
  let sidB = ''
  let claudeDir = ''
  let cwd = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    // The server makes its own tmux session on the first snapshot
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    expect((await api.get('/api/mux/snapshot')).ok()).toBe(true)
    claudeDir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-claude-'))
    cwd = mkdtempSync(path.join(tmpdir(), 'termote-e2e-cwd-'))
    const sidA = tmux(
      'new-session', '-d', '-s', A, '-c', '/tmp', '-n', 'a-one', '-P', '-F', '#{session_id}',
    )
    tmux('new-window', '-d', '-t', `${sidA}:`, '-n', 'a-two')
    sidB = tmux(
      'new-session', '-d', '-s', B, '-c', cwd, '-n', 'b-one', '-P', '-F', '#{session_id}',
    )
    tmux(
      'new-window', '-d', '-t', `${sidB}:`, '-n', 'b-agent', '-c', cwd,
      'env', `CLAUDE_CONFIG_DIR=${claudeDir}`, 'bash', fakeClaude,
    )
    // The server takes a few seconds to report the stand-in as an agent
    await expect
      .poll(
        async () => {
          const snap = (await (await api.get('/api/mux/snapshot')).json()) as {
            groups: { id: string; tabs: { panes: { agent?: unknown }[] }[] }[]
          }
          return snap.groups
            .find((g) => g.id === sidB)
            ?.tabs.some((t) => t.panes.some((p) => p.agent))
        },
        { timeout: 20000 },
      )
      .toBe(true)
    await api.dispose()
  })

  test.afterAll(() => {
    for (const name of [A, B]) {
      try {
        tmux('kill-session', '-t', `=${name}`)
      } catch {
        // Already gone
      }
    }
    for (const dir of [claudeDir, cwd]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('Settings puts each session on one line, its tabs in the header', async ({
    page,
  }) => {
    // The tab bar switched off: the compact layout shows it all the same
    await open(page, { showSessionTabs: false })
    await expect(tabBar(page)).toBeHidden()
    await expect(page.getByRole('region', { name: A })).toBeVisible()
    await pickLayout(page, 'Compact')
    await expect(groupRow(page, A)).toHaveAccessibleName(`${A}, 2 tabs`)
    await expect(groupRow(page, B)).toBeVisible()
    // One line per session on the socket, no tab under any
    const sessions = tmux('list-sessions', '-F', '#{session_name}').split('\n')
    await expect(
      page.getByRole('complementary').getByRole('button', { name: /, \d+ tabs?/ }),
    ).toHaveCount(sessions.length)
    await expect(page.getByRole('complementary').getByText('a-one')).toHaveCount(0)
    await expect(tabBar(page)).toBeVisible()
    // An agent runs, yet there is no filter bar
    await expect(agents(page)).toBeVisible()
    await expect(filterBar(page)).toHaveCount(0)
  })

  test('a session opens on its tabs, then on the tab last shown in it', async ({
    page,
  }) => {
    await open(page, { sidebarLayout: 'compact' })
    await groupRow(page, A).click()
    await expect(groupRow(page, A)).toHaveAttribute('aria-current', 'true')
    await expect(tabBar(page).getByRole('tab', { name: /a-one/ })).toBeVisible()
    await tabBar(page).getByRole('tab', { name: /a-two/ }).click()
    await expect(
      tabBar(page).getByRole('tab', { name: /a-two/ }),
    ).toHaveAttribute('aria-selected', 'true')
    await groupRow(page, B).click()
    await expect(tabBar(page).getByRole('tab', { name: /b-one/ })).toBeVisible()
    await expect(tabBar(page).getByRole('tab', { name: /a-one/ })).toHaveCount(0)
    await groupRow(page, A).click()
    await expect(
      tabBar(page).getByRole('tab', { name: /a-two/ }),
    ).toHaveAttribute('aria-selected', 'true')
  })

  test('the agent is listed under its status and opens its pane', async ({
    page,
  }) => {
    await open(page, { sidebarLayout: 'compact' })
    const row = agents(page).getByRole('button', { name: /b-agent/ })
    await expect(row).toBeVisible({ timeout: 20000 })
    // Under the heading of the status its badge shows
    const status = await row.locator('[data-status]').getAttribute('data-status')
    await expect(
      agents(page).getByRole('region', { name: STATUS_TITLE[status as string] }),
    ).toContainText('b-agent')
    await expect(row).toContainText(B)
    await row.click()
    await expect
      .poll(() => decodeURIComponent(new URL(page.url()).hash))
      .toContain(`#/s/${sidB}/`)
    await expect(groupRow(page, B)).toHaveAttribute('aria-current', 'true')
  })

  test('the agents take the height dragged to, after a reload too', async ({
    page,
  }) => {
    await open(page, { sidebarLayout: 'compact' })
    await expect(agents(page)).toBeVisible({ timeout: 20000 })
    const before = (await agents(page).boundingBox())!.height
    const handle = (await page
      .getByRole('separator', { name: 'Resize the agents' })
      .boundingBox())!
    const x = handle.x + handle.width / 2
    const y = handle.y + handle.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y - 40, { steps: 4 })
    await page.mouse.move(x, y - 80, { steps: 4 })
    await page.mouse.up()
    await expect
      .poll(async () => (await agents(page).boundingBox())!.height)
      .toBeCloseTo(before + 80, -1)
    const after = (await agents(page).boundingBox())!.height
    await page.reload()
    await expect(agents(page)).toBeVisible({ timeout: 20000 })
    expect((await agents(page).boundingBox())!.height).toBe(after)
  })

  test('a reload keeps the layout; Detailed brings the tabs and the filter back', async ({
    page,
  }) => {
    await open(page)
    await pickLayout(page, 'Compact')
    await page.reload()
    await page.waitForSelector('[data-testid="terminal-view"] .xterm')
    await expect(groupRow(page, A)).toBeVisible()
    await pickLayout(page, 'Detailed')
    await expect(groupRow(page, A)).toHaveCount(0)
    await expect(
      page.getByRole('region', { name: A }).getByText('a-one'),
    ).toBeVisible()
    await expect(agents(page)).toHaveCount(0)
    await expect(filterBar(page)).toBeVisible()
  })

  test('a phone keeps its sessions sheet', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await open(page, { sidebarLayout: 'compact' })
    await page.getByRole('button', { name: /^Open sessions menu/ }).click()
    const sheet = page.getByRole('dialog', { name: 'Sessions' })
    await expect(sheet.getByRole('region', { name: A })).toBeVisible()
    await expect(sheet.getByText('a-one')).toBeVisible()
    await expect(
      page.getByRole('button', { name: new RegExp(`^${A}, \\d+ tabs?`) }),
    ).toHaveCount(0)
    await expect(agents(page)).toHaveCount(0)
  })
})
