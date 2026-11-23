import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Token totals and estimated costs against the server's own Claude Code dir
// (TERMOTE_E2E_CLAUDE_DIR, the CLAUDE_CONFIG_DIR the server under test was
// started with): the machine's totals read only that dir, so the stand-in
// (tests/fixtures/fake-claude.sh) writes its transcript there. Its "usage"
// reply is one message in two rows of 1000 input, 200000 cache read, 5000
// cache write and 2000 output tokens of claude-sonnet-5-5: 208k tokens,
// about $0.05, once (not twice) when the rows are counted by message.
// Linux only, like the stand-in.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const claudeDir = process.env.TERMOTE_E2E_CLAUDE_DIR
const fakeClaude = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/fake-claude.sh',
)
const OLD = 'aaaaaaaa-0000-4000-8000-00000000e2e9'

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
  })

async function open(page: Page, hash = '') {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-opened')) return
    sessionStorage.setItem('e2e-opened', '1')
    localStorage.clear()
  })
  await page.goto(`/${hash}`)
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', {
    timeout: 15000,
  })
}

test.describe('agent tokens and cost', () => {
  test.skip(
    !socket ||
      !claudeDir ||
      process.platform !== 'linux' ||
      process.env.TERMOTE_E2E_ZELLIJ === '1',
    'needs TMUX_SOCKET and TERMOTE_E2E_CLAUDE_DIR of the server under test (Linux)',
  )
  test.describe.configure({ mode: 'serial' })

  let windowName = ''
  let windowId = ''
  let cwd = ''
  let project = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    expect((await api.get('/api/mux/snapshot')).ok()).toBe(true)
    await api.dispose()
    cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'termote-e2e-usage-')))
    project = path.join(
      claudeDir as string,
      'projects',
      cwd.replace(/[^A-Za-z0-9]/g, '-'),
    )
    mkdirSync(project, { recursive: true })
    // An old session of the folder, with usage: one message of Opus 5.5,
    // 1M input tokens, $4.
    const at = new Date(Date.now() - 30 * 60_000)
    const old = path.join(project, `${OLD}.jsonl`)
    writeFileSync(
      old,
      `${[
        { type: 'user', uuid: 'o1', timestamp: at.toISOString(), message: { role: 'user', content: 'Plan the release' } },
        {
          type: 'assistant',
          uuid: 'o2',
          timestamp: at.toISOString(),
          message: {
            id: 'msg_e2e_old',
            model: 'claude-opus-5-5',
            role: 'assistant',
            content: [{ type: 'text', text: 'Release planned.' }],
            usage: { input_tokens: 1_000_000, output_tokens: 0 },
          },
        },
      ]
        .map((r) => JSON.stringify({ cwd, gitBranch: 'main', ...r }))
        .join('\n')}\n`,
    )
    utimesSync(old, at, at)

    windowName = `usage-claude-${Date.now()}`
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
    for (const dir of [cwd, project]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test("a card shows its session's tokens and cost; Today adds them up; Settings hides the cost", async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await open(page, '#/overview')
    const card = page.locator('[data-status]', {
      has: page.getByRole('button', { name: new RegExp(`, (.* / )?${windowName}$`) }),
    })
    await expect(card).toBeVisible({ timeout: 20_000 })
    tmux('send-keys', '-t', windowId, '-l', 'count the usage')
    tmux('send-keys', '-t', windowId, 'Enter')

    // Counted once: 208k, not 416k
    const line = card.getByTestId('session-usage')
    await expect(line).toHaveText('Tokens used by this session: 208k tokens · ~$0.05', {
      timeout: 40_000,
    })
    // Behind the header's tokens, which show once a session counted any
    const tokens = page.getByRole('button', { name: /^Tokens today/ })
    await tokens.click({ timeout: 70_000 })
    const strip = page.getByRole('region', { name: 'Agent tokens' })
    await expect(strip.locator('[data-agent="claude"]')).toContainText('Today', {
      timeout: 70_000,
    })
    await expect(strip.locator('[data-agent="claude"]')).toContainText('tokens · ~$')

    await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('menuitem', { name: 'Settings' }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings
      .getByRole('navigation', { name: 'Settings groups' })
      .getByRole('button', { name: 'Sessions' })
      .click()
    const cost = settings.getByRole('switch', { name: 'Estimated cost' })
    await expect(cost).toHaveAttribute('aria-checked', 'true')
    await cost.click()
    await expect(cost).toHaveAttribute('aria-checked', 'false')
    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()
    await expect(line).toHaveText('Tokens used by this session: 208k tokens')
    // Settings closed the panel: open it again to read it, and the button
    // never shows a cost
    await expect(tokens).not.toContainText('$')
    await tokens.click()
    await expect(strip).toBeVisible()
    await expect(strip).not.toContainText('$')
  })

  test("the history shows the folder's totals and an old session's", async ({ page }) => {
    await open(page)
    await page.getByRole('tab', { name: new RegExp(windowName) }).click()
    await page.locator('body').press('Control+Shift+P')
    const input = page.getByRole('dialog').getByRole('combobox')
    await input.fill('>Session history')
    await input.press('Enter')
    const sheet = page.getByRole('dialog', { name: 'Session history' })
    await expect(sheet.getByRole('region', { name: 'Agent tokens' })).toContainText('Today', {
      timeout: 20_000,
    })
    await sheet.locator(`[data-history-id="${OLD}"]`).click()
    await expect(sheet.getByTestId('session-usage')).toHaveText(
      'Tokens used by this session: 1.0M tokens · ~$4.00',
    )
  })
})
