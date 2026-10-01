import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'

// The Chat view against a stand-in Claude Code (tests/fixtures/fake-claude.sh)
// running in a window of the server's tmux. It needs the socket and session
// the server under test uses (TMUX_SOCKET, TMUX_SESSION), so it never opens
// a window in someone's own tmux; Linux only, like the stand-in.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const fakeClaude = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/fake-claude.sh',
)

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
  })

test.describe('chat view', () => {
  test.skip(
    !socket || process.platform !== 'linux',
    'needs TMUX_SOCKET of the server under test (Linux)',
  )
  test.describe.configure({ mode: 'serial' })

  // A name of its own per run, so the tab to pick is never ambiguous
  let windowName = ''
  let claudeDir = ''
  let cwd = ''
  let windowId = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    // The server creates its tmux session on the first snapshot; before that
    // the socket has no server to open a window in.
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    expect((await api.get('/api/mux/snapshot')).ok()).toBe(true)
    await api.dispose()

    windowName = `fake-claude-${Date.now()}`
    claudeDir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-claude-'))
    cwd = mkdtempSync(path.join(tmpdir(), 'termote-e2e-cwd-'))
    windowId = tmux(
      'new-window',
      '-P',
      '-F',
      '#{window_id}',
      '-t',
      `${tmuxSession}:`,
      '-n',
      windowName,
      '-c',
      cwd,
      'env',
      `CLAUDE_CONFIG_DIR=${claudeDir}`,
      'bash',
      fakeClaude,
    ).trim()
  })

  test.afterAll(() => {
    try {
      if (windowId) tmux('kill-window', '-t', windowId)
    } catch {
      // Already gone
    }
    // The stand-in writes its session file once more as it exits
    for (const dir of [claudeDir, cwd]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('reads, sends and answers through the Chat view', async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.getByRole('tab', { name: new RegExp(windowName) }).click()

    // The switcher is offered once the server reports Claude Code in the pane
    const chatTab = page
      .getByRole('tablist', { name: 'View' })
      .getByRole('tab', { name: 'Chat' })
    await chatTab.click({ timeout: 15000 })

    // History from the transcript, markdown rendered
    const conversation = page.getByRole('region', { name: 'Conversation' })
    await expect(conversation).toContainText('Fix the build please')
    await expect(conversation.locator('strong')).toHaveText('fixed')

    // A message of two lines arrives as one turn
    const composer = page.getByRole('textbox', {
      name: 'Message to Claude Code',
    })
    const send = page.getByRole('button', { name: 'Send', exact: true })
    await composer.fill('hello from e2e\nsecond line')
    await send.click()
    await expect(conversation).toContainText('You said: hello from e2e')
    await expect(conversation).toContainText('second line')

    // A permission dialog becomes a card whose buttons answer it
    await composer.fill('ask permission please')
    await send.click()
    const card = page.getByRole('alertdialog', { name: 'Bash command' })
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: /^1\.\s*Yes$/ }).click()
    await expect(conversation).toContainText('Created scratch-one.txt.')
    await expect(card).toBeHidden()

    // A multiSelect question is shown read-only, with the way to the terminal
    await composer.fill('pick toppings')
    await send.click()
    const question = page.getByRole('alertdialog', { name: 'Which toppings do you want?' })
    await expect(question).toContainText('Answer this dialog in the terminal.')
    await expect(question.getByRole('button', { name: /^1\./ })).toHaveCount(0)
    await question.getByRole('button', { name: 'Open terminal' }).click()
    await expect(
      page
        .getByRole('tablist', { name: 'View' })
        .getByRole('tab', { name: 'Terminal' }),
    ).toHaveAttribute('aria-selected', 'true')
  })
})
