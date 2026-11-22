import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from './fixtures'

// Stop in the Chat view against the stand-in Claude Code
// (tests/fixtures/fake-claude.sh), whose slow turn an Escape interrupts. It
// needs the socket and session of the server under test (TMUX_SOCKET,
// TMUX_SESSION), so it never opens a window in someone's own tmux; Linux
// only, like the stand-in.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const fakeClaude = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/fake-claude.sh',
)
const INTERRUPTED = '[Request interrupted by user]'

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
  })

// Every transcript line the stand-in wrote under dir.
function transcriptText(dir: string): string {
  let out = ''
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      out += readFileSync(path.join(e.parentPath, e.name), 'utf-8')
    }
  }
  return out
}

test.describe('agent stop', () => {
  test.skip(
    !socket || process.platform !== 'linux',
    'needs TMUX_SOCKET of the server under test (Linux)',
  )

  let windowName = ''
  let claudeDir = ''
  let cwd = ''
  let windowId = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    expect((await api.get('/api/mux/snapshot')).ok()).toBe(true)
    await api.dispose()
    windowName = `fake-stop-${Date.now()}`
    claudeDir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-claude-'))
    cwd = mkdtempSync(path.join(tmpdir(), 'termote-e2e-cwd-'))
    windowId = tmux(
      'new-window',
      '-d',
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
      'FAKE_CLAUDE_SLOW=60',
      'bash',
      fakeClaude,
    ).trim()
    tmux('select-window', '-t', windowId)
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

  test('Stop ends the turn the agent is working on, once', async ({ page }) => {
    test.setTimeout(90_000)
    await page.goto('/')
    await page.getByRole('tab', { name: new RegExp(windowName) }).click()
    await page
      .getByRole('tablist', { name: 'View' })
      .getByRole('tab', { name: 'Chat' })
      .click({ timeout: 15_000 })
    const conversation = page.getByRole('region', { name: 'Conversation' })
    await expect(conversation).toContainText('Fix the build please')

    const composer = page.getByRole('textbox', { name: 'Message to Claude Code' })
    const stop = page.getByRole('button', { name: 'Stop Claude Code' })
    // Not while the agent waits for a message
    await expect(stop).toHaveCount(0)
    await composer.fill('think slow please')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(stop).toBeVisible({ timeout: 15_000 })
    await stop.click()
    // Pressed again while stopping: it is disabled, nothing more goes
    await expect(
      page.getByRole('button', { name: 'Stopping Claude Code…' }),
    ).toBeDisabled()
    // The server shows Claude Code's interrupt line as a note
    await expect(conversation).toContainText('Interrupted', { timeout: 10_000 })
    await expect(stop).toHaveCount(0, { timeout: 10_000 })
    expect(conversation.getByText('Done thinking.')).toHaveCount(0)
    expect(transcriptText(claudeDir).split(INTERRUPTED).length - 1).toBe(1)
  })
})
