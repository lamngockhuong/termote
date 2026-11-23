import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// A Claude Code subagent's conversation, opened from the Chat view's strip
// of running subagents, against the stand-in Claude Code
// (tests/fixtures/fake-claude.sh) in a window of the server's own tmux
// (TMUX_SOCKET, TMUX_SESSION); Linux only, like it. Its "subagents" command
// writes the files where Claude Code keeps them: e2esub1 ended, e2esub2
// running.

const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const fakeClaude = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/fake-claude.sh',
)
const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })

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

// The session's transcript (projects/<project>/<id>.jsonl) and its
// subagents directory, once the stand-in wrote them
function sessionFiles(claudeDir: string) {
  const projects = path.join(claudeDir, 'projects')
  for (const project of readdirSync(projects)) {
    const dir = path.join(projects, project)
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const subs = path.join(dir, name.replace(/\.jsonl$/, ''), 'subagents')
      try {
        readdirSync(subs)
      } catch {
        continue
      }
      return { journal: path.join(dir, name), subs }
    }
  }
  throw new Error('no session with subagents yet')
}

test.describe('a subagent conversation', () => {
  test.skip(
    !socket || process.platform !== 'linux' || process.env.TERMOTE_E2E_ZELLIJ === '1',
    'needs TMUX_SOCKET of the server under test (Linux)',
  )

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
    windowName = `subagent-claude-${Date.now()}`
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

  test('opens from its row, follows it, and stays open when it ends', async ({
    page,
  }) => {
    await open(page, '#/overview')
    const card = page.getByRole('button', {
      name: new RegExp(`^Open chat: Claude Code, .*${windowName}$`),
    })
    await expect(card).toBeVisible({ timeout: 20000 })
    await card.click()
    await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible()

    tmux('send-keys', '-t', windowId, '-l', 'start the subagents')
    tmux('send-keys', '-t', windowId, 'Enter')
    const strip = page.getByRole('button', { name: '1 subagent running' })
    await expect(strip).toBeVisible({ timeout: 20000 })

    // By keyboard, as a native button
    const row = page.getByRole('button', {
      name: 'Open the conversation of code-reviewer: Review e2esub2',
    })
    await row.focus()
    await page.keyboard.press('Enter')
    const sheet = page.getByRole('dialog', { name: 'code-reviewer' })
    await expect(sheet).toContainText('Review e2esub2')
    const conversation = sheet.getByTestId('subagent-transcript')
    await expect(conversation).toContainText('Review it')

    // A line it writes shows while it runs
    const { journal, subs } = sessionFiles(claudeDir)
    const now = new Date().toISOString()
    appendFileSync(
      path.join(subs, 'agent-e2esub2.jsonl'),
      `${JSON.stringify({
        isSidechain: true,
        agentId: 'e2esub2',
        type: 'assistant',
        uuid: 'e2e-sub-line',
        timestamp: now,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Nothing to change in the parser.' }],
        },
      })}\n`,
    )
    await expect(conversation).toContainText('Nothing to change in the parser.', {
      timeout: 15000,
    })

    // It ends: the strip goes, the sheet stays, done
    appendFileSync(
      journal,
      `${JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: now,
        content:
          '<task-notification>\n<task-id>e2esub2</task-id>\n<status>completed</status>\n</task-notification>',
      })}\n`,
    )
    await expect(strip).toBeHidden({ timeout: 15000 })
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText(/done/)
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
  })
})
