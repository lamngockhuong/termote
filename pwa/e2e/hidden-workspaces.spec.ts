import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Hiding a workspace on this browser, against a real server's tmux: gone
// from the compact sidebar, its agents and the palette, still hidden after a
// reload, shown for a while and hidden again, then unhidden. Two sessions of
// its own, a stand-in Claude Code (tests/fixtures/fake-claude.sh) in the one
// hidden, on the server's own socket (TMUX_SOCKET). Other specs may add
// sessions to that socket meanwhile, so places are compared between this
// spec's two sessions only.

const socket = process.env.TMUX_SOCKET
const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
  }).trim()
const fakeClaude = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/fake-claude.sh',
)

const sidebar = (page: Page) => page.getByRole('complementary').first()
// A session's row: "<name>, <n> tabs[, ...]"
const rowName = (name: string) => new RegExp(`^${name}, `)
const groupRow = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: rowName(name) })
const agents = (page: Page) =>
  page.getByRole('region', { name: 'Running agents' })
const palette = (page: Page) =>
  page.getByRole('dialog').filter({ has: page.getByRole('combobox') })

// Where a comes before b among the rows: -1 before, 1 after
async function order(page: Page, a: string, b: string) {
  const labels = await sidebar(page)
    .getByRole('button', { name: /, \d+ tabs?/ })
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
  const at = (n: string) => labels.findIndex((l) => l.startsWith(`${n}, `))
  expect(at(a)).toBeGreaterThanOrEqual(0)
  expect(at(b)).toBeGreaterThanOrEqual(0)
  return Math.sign(at(a) - at(b))
}

async function menu(page: Page, name: string, item: string) {
  await groupRow(page, name).hover()
  await sidebar(page)
    .getByRole('button', { name: `Actions for tmux session ${name}` })
    .click()
  await page.getByRole('menuitem', { name: item }).click()
}

test.describe('hidden workspaces', () => {
  test.skip(
    !socket ||
      process.platform !== 'linux' ||
      process.env.TERMOTE_E2E_ZELLIJ === '1',
    'needs TMUX_SOCKET of the server under test (Linux)',
  )
  test.describe.configure({ mode: 'serial', timeout: 90000 })
  test.use({ viewport: { width: 1280, height: 800 } })

  const tag = Math.random().toString(36).slice(2, 8)
  const SHOWN = `hid-v-${tag}`
  const HIDDEN = `hid-h-${tag}`
  const AGENT_TAB = `h-agent-${tag}`
  let claudeDir = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    expect((await api.get('/api/mux/snapshot')).ok()).toBe(true)
    claudeDir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-claude-'))
    tmux('new-session', '-d', '-s', SHOWN, '-c', '/tmp', '-n', 'v-one')
    const sid = tmux(
      'new-session', '-d', '-s', HIDDEN, '-c', '/tmp', '-n', 'h-one', '-P', '-F', '#{session_id}',
    )
    tmux(
      'new-window', '-d', '-t', `${sid}:`, '-n', AGENT_TAB, '-c', '/tmp',
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
            .find((g) => g.id === sid)
            ?.tabs.some((t) => t.panes.some((p) => p.agent))
        },
        { timeout: 20000 },
      )
      .toBe(true)
    await api.dispose()
  })

  test.afterAll(() => {
    for (const name of [SHOWN, HIDDEN]) {
      try {
        tmux('kill-session', '-t', `=${name}`)
      } catch {
        // Already gone
      }
    }
    if (claudeDir) {
      rmSync(claudeDir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('hide, show for a while, hide again and unhide a workspace', async ({
    page,
  }) => {
    // A device of its own, in the compact layout (once: a reload keeps what
    // the test changed)
    await page.addInitScript(() => {
      if (sessionStorage.getItem('e2e-opened')) return
      sessionStorage.setItem('e2e-opened', '1')
      localStorage.clear()
      localStorage.setItem(
        'termote-settings',
        JSON.stringify({ sidebarLayout: 'compact' }),
      )
    })
    await page.goto('/')
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', {
      timeout: 15000,
    })
    await expect(groupRow(page, HIDDEN)).toBeVisible()
    await expect(
      agents(page).getByRole('button', { name: new RegExp(AGENT_TAB) }),
    ).toBeVisible({ timeout: 20000 })
    const before = await order(page, HIDDEN, SHOWN)

    await menu(page, HIDDEN, 'Hide')
    await expect(groupRow(page, HIDDEN)).toHaveCount(0)
    await expect(groupRow(page, SHOWN)).toBeVisible()
    await expect(sidebar(page)).not.toContainText(HIDDEN)
    await expect(sidebar(page)).not.toContainText(AGENT_TAB)
    await expect(sidebar(page).getByText('1 hidden')).toBeVisible()

    // Not in the palette's list of tabs either
    await page.keyboard.press('Control+P')
    await expect(palette(page).getByRole('combobox')).toBeFocused()
    await palette(page).getByRole('combobox').fill('@h-')
    await expect(palette(page)).not.toContainText(AGENT_TAB)
    await expect(palette(page)).not.toContainText(HIDDEN)
    await page.keyboard.press('Escape')
    await expect(palette(page)).toHaveCount(0)

    // Still hidden after a reload
    await page.reload()
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', {
      timeout: 15000,
    })
    await expect(groupRow(page, SHOWN)).toBeVisible()
    await expect(groupRow(page, HIDDEN)).toHaveCount(0)

    // Shown for a while, in its place
    await sidebar(page).getByRole('button', { name: 'Show' }).click()
    await expect(groupRow(page, HIDDEN)).toBeVisible()
    await expect(groupRow(page, HIDDEN)).toHaveAccessibleName(
      new RegExp(`^${HIDDEN}, Hidden, `),
    )
    expect(await order(page, HIDDEN, SHOWN)).toBe(before)
    await expect(sidebar(page).getByText('Showing 1 hidden')).toBeVisible()

    // Hidden again straight away
    await sidebar(page).getByRole('button', { name: 'Hide again' }).click()
    await expect(groupRow(page, HIDDEN)).toHaveCount(0)

    // Unhidden for good
    await sidebar(page).getByRole('button', { name: 'Show' }).click()
    await menu(page, HIDDEN, 'Unhide')
    await expect(sidebar(page).getByText(/hidden$/)).toHaveCount(0)
    await page.reload()
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', {
      timeout: 15000,
    })
    await expect(groupRow(page, HIDDEN)).toHaveAccessibleName(
      new RegExp(`^${HIDDEN}, \\d+ tabs?`),
    )
  })
})
