import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from './fixtures'

// The agent overview against a real server: the screen's address, its ways
// in and out and the reads behind it on every backend (the e2e-zellij job
// runs it too); with the tmux job's socket, an agent's card and a dialog
// answered from the queue, against the stand-in Claude Code of
// chat-view.spec.ts. Order and stuck marks are the unit tests'.

const snapshotOf = async (request: APIRequestContext) =>
  (await request.get('/api/mux/snapshot')).json() as Promise<{
    backend: string
    groups: { tabs: { panes: { agent?: unknown }[] }[] }[]
  }>

const agentsIn = (s: Awaited<ReturnType<typeof snapshotOf>>) =>
  s.groups.flatMap((g) => g.tabs.flatMap((t) => t.panes)).filter((p) => p.agent)
    .length

async function open(page: Page, hash = '') {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-opened')) return
    sessionStorage.setItem('e2e-opened', '1')
    localStorage.clear()
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ hasSeenGestureHints: true }),
    )
  })
  await page.goto(`/${hash}`)
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', {
    timeout: 15000,
  })
}

const overview = (page: Page) => page.getByRole('region', { name: 'Agents' })

test.describe('agent overview activity log', () => {
  test('opens beside the cards or in a sheet, and closes', async ({ page }) => {
    await open(page, '#/overview')
    const button = overview(page).getByRole('button', { name: 'Activity' })
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    const wide = (page.viewportSize()?.width ?? 0) >= 1280
    const log = wide
      ? page.getByRole('complementary', { name: 'Activity' })
      : page.getByRole('dialog', { name: 'Activity' })
    await expect(log).toBeVisible()
    await expect(log.getByRole('radiogroup', { name: 'Show changes to' })).toBeVisible()
    if (wide) await button.click()
    else await log.getByRole('button', { name: 'Close the activity' }).click()
    await expect(log).toBeHidden()
    // The log's sheet took Esc; the overview is still open.
    await expect(overview(page)).toBeVisible()
  })
})

test.describe('agent overview', () => {
  test('opens from its address, stays on reload, Esc goes to the pane', async ({
    page,
    request,
  }) => {
    await open(page, '#/overview')
    await expect(overview(page)).toBeVisible()
    await page.reload()
    await expect(overview(page)).toBeVisible()
    expect(new URL(page.url()).hash).toBe('#/overview')

    const snap = await snapshotOf(request)
    if (agentsIn(snap) === 0) {
      await expect(page.getByText('No agent is running in any session.')).toBeVisible()
    }
    // Herdr and Zellij track every pane: no note about active panes
    if (snap.backend !== 'tmux') {
      await expect(page.getByText(/active pane of each window/)).toHaveCount(0)
    }
    // The terminal under it stays mounted, out of reach
    await expect(page.locator('[data-testid="terminal-view"]')).toBeAttached()

    await page.keyboard.press('Escape')
    await expect(overview(page)).toBeHidden()
    await expect.poll(() => new URL(page.url()).hash).toMatch(/^#\/s\//)
  })

  test('desktop: the sidebar button opens it; Back and Forward move between', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await open(page)
    await page.getByRole('button', { name: 'Agent overview' }).first().click()
    await expect(overview(page)).toBeVisible()
    await page.goBack()
    await expect(overview(page)).toBeHidden()
    await page.goForward()
    await expect(overview(page)).toBeVisible()
    await page.getByRole('button', { name: 'Close the agent overview' }).click()
    await expect(overview(page)).toBeHidden()
  })

  test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

    test('the view menu opens it', async ({ page }) => {
      await open(page)
      const keys = page.getByRole('button', { name: 'Extra keys' })
      await expect(keys).toBeVisible()
      await page.getByRole('button', { name: /^View:/ }).click()
      await page.getByRole('menuitem', { name: 'Agent overview' }).click()
      await expect(overview(page)).toBeVisible()
      // The key toolbar belongs to the terminal: not under the overview
      await expect(keys).toHaveCount(0)
    })
  })

  test('the overview and activity reads: same-site, ids only', async ({ request }) => {
    const res = await request.get('/api/mux/overview')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(typeof body.serverNow).toBe('string')
    expect(Array.isArray(body.panes)).toBe(true)
    // No directory, root or transcript path in it
    expect(JSON.stringify(body)).not.toMatch(/"\/(home|tmp|root|Users)\//)

    const activity = await request.get('/api/mux/activity')
    expect(activity.status()).toBe(200)
    const log = await activity.json()
    expect(log.reset).toBe(true)
    expect(Array.isArray(log.events)).toBe(true)

    const bad = await request.get('/api/mux/activity?after=abc')
    expect(bad.status()).toBe(400)
    expect((await bad.json()).code).toBe('invalid_after')

    // A pane that does not exist has no subagents to read
    const missing = await request.get('/api/mux/panes/nope/agent/subagents')
    expect(missing.ok()).toBe(false)

    for (const path of [
      '/api/mux/overview',
      '/api/mux/activity',
      '/api/mux/panes/nope/agent/subagents',
    ]) {
      const cross = await request.get(path, { headers: { 'Sec-Fetch-Site': 'cross-site' } })
      expect(cross.status()).toBe(403)
    }
    // The snapshot carries the server's time for the clock offset
    const snap = await (await request.get('/api/mux/snapshot')).json()
    expect(typeof snap.serverNow).toBe('string')
  })
})

// A stand-in Claude Code (tests/fixtures/fake-claude.sh) in a window of the
// server's own tmux (TMUX_SOCKET, TMUX_SESSION); Linux only, like it.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const fakeClaude = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/fake-claude.sh',
)
const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })

test.describe('agent overview with an agent', () => {
  test.skip(
    !socket || process.platform !== 'linux' || process.env.TERMOTE_E2E_ZELLIJ === '1',
    'needs TMUX_SOCKET of the server under test (Linux)',
  )
  test.describe.configure({ mode: 'serial' })

  let windowName = ''
  let windowId = ''
  let claudeDir = ''
  let cwd = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    // The server makes its tmux session on the first snapshot
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    expect((await api.get('/api/mux/snapshot')).ok()).toBe(true)
    await api.dispose()
    windowName = `overview-claude-${Date.now()}`
    claudeDir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-claude-'))
    cwd = mkdtempSync(path.join(tmpdir(), 'termote-e2e-cwd-'))
    windowId = tmux(
      'new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`,
      '-n', windowName, '-c', cwd,
      'env', `CLAUDE_CONFIG_DIR=${claudeDir}`, 'bash', fakeClaude,
    ).trim()
  })

  test.afterAll(() => {
    try {
      if (windowId) tmux('kill-window', '-t', windowId)
    } catch {
      // Already gone
    }
    for (const dir of [claudeDir, cwd]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  // Types into the stand-in, as the user would in its terminal
  const say = (text: string) => {
    tmux('send-keys', '-t', windowId, '-l', text)
    tmux('send-keys', '-t', windowId, 'Enter')
  }

  test('a card per agent; it opens the agent in its Chat view', async ({ page }) => {
    await open(page, '#/overview')
    const card = page.getByRole('button', {
      name: new RegExp(`^Open chat: Claude Code, \\w[\\w ]*, (.* / )?${windowName}$`),
    })
    await expect(card).toBeVisible({ timeout: 20000 })
    await card.click()
    await expect(overview(page)).toBeHidden()
    await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toContain('?view=chat')
    await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible()
  })

  test("a card's history: the status strip and its subagents", async ({ page }) => {
    await open(page, '#/overview')
    const card = page.locator('[data-status]', {
      has: page.getByRole('button', { name: new RegExp(`, (.* / )?${windowName}$`) }),
    })
    await expect(card).toBeVisible({ timeout: 20000 })
    say('start the subagents')
    const history = card.getByRole('button', { name: /^(Hide history|History)/ })
    await history.click()
    await expect(history).toHaveAttribute('aria-expanded', 'true')
    await expect(card.getByRole('img', { name: /^Last 60 min/ })).toBeVisible()
    const tree = card.getByRole('list', { name: 'Subagents' })
    await expect(tree.getByRole('listitem')).toHaveCount(2, { timeout: 20000 })
    await expect(tree.locator('[data-status="done"]')).toHaveCount(1)
    await expect(tree.locator('[data-status="running"]')).toContainText('Grep')
    await history.click()
    await expect(
      card.getByRole('button', { name: 'History · 2 subagents, 1 running' }),
    ).toBeVisible()
  })

  test('context share, the Codex account strip and the header chip', async ({ page }) => {
    // The stand-in writes no usage: the server's answer gets a Claude
    // window share and a Codex account on top.
    // Both reads: the overview's, and the header chip's ?pane=
    await page.route(/\/api\/mux\/overview(\?|$)/, async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      for (const p of body.panes) {
        p.usage = {
          contextTokens: 144000,
          contextWindow: 200000,
          contextPercent: 72,
          exact: false,
          model: 'claude-model',
        }
        p.accountKey = 'e2e-account'
      }
      body.accounts = [{
        key: 'e2e-account',
        agent: 'codex',
        plan: 'plus',
        windows: [
          {
            usedPercent: 40,
            windowMinutes: 300,
            resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
          { usedPercent: 95, windowMinutes: 10080 },
        ],
        updatedAt: new Date().toISOString(),
      }]
      await route.fulfill({ response: res, json: body })
    })
    await page.setViewportSize({ width: 1280, height: 800 })
    await open(page, '#/overview')
    const strip = page.getByRole('region', { name: 'Accounts' })
    await expect(strip).toContainText('Codex · plus', { timeout: 20000 })
    await expect(strip).toContainText('updated just now')
    await expect(strip.getByRole('meter', { name: 'Codex 7d limit' })).toHaveAttribute(
      'data-level',
      'danger',
    )
    const card = page.locator('[data-status]', {
      has: page.getByRole('button', { name: new RegExp(`, (.* / )?${windowName}$`) }),
    })
    await expect(card).toContainText('~72%144k/200k')

    // In the pane, the header chip says the same and opens the overview
    await card.getByRole('button', { name: /^Open terminal: / }).click()
    await expect(overview(page)).toBeHidden()
    const chip = page.getByRole('button', {
      name: 'Agent usage: context ~72%, Codex 7d limit 95%. Open the agent overview',
    })
    await expect(chip).toHaveText('ctx ~72% · 7d 95%', { timeout: 20000 })
    await chip.click()
    await expect(overview(page)).toBeVisible()
  })

  test('a dialog is answered from the queue, never moving on by itself', async ({ page }) => {
    test.setTimeout(90000)
    await open(page, '#/overview')
    const queue = page.getByRole('region', { name: new RegExp(`^Needs you: Claude Code, .*${windowName}`) })

    // A wizard: a tab answered is no answer yet, the card stays on it
    say('place an order')
    const size = queue.getByRole('alertdialog', { name: 'What size do you want?' })
    await expect(size).toBeVisible({ timeout: 20000 })
    await size.getByRole('button', { name: /^1\.\s*Small/ }).click()
    const drink = queue.getByRole('alertdialog', { name: 'Which drink do you prefer?' })
    await expect(drink).toBeVisible()
    await expect(queue.getByText('Answered.')).toHaveCount(0)
    await drink.getByRole('button', { name: /^2\.\s*Coffee/ }).click()
    const review = queue.getByRole('alertdialog', { name: 'Review your answers' })
    await review.getByRole('button', { name: /^1\.\s*Submit answers/ }).click()
    await expect(queue.getByText('Answered.')).toBeVisible({ timeout: 20000 })
    await queue.getByRole('button', { name: 'Done' }).click()
    await expect(queue).toBeHidden()

    // A permission dialog, answered once
    say('ask permission please')
    const ask = page
      .getByRole('region', { name: /^Needs you: / })
      .getByRole('alertdialog', { name: 'Bash command' })
    await expect(ask).toBeVisible({ timeout: 20000 })
    await ask.getByRole('button', { name: /^1\.\s*Yes$/ }).click()
    await expect(page.getByText('Answered.')).toBeVisible({ timeout: 20000 })
  })
})
