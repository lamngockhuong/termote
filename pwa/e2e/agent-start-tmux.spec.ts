import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from './fixtures'

// Starting an agent from the Chat view on tmux, which has no agent.start:
// the server types `claude` into the pane's shell itself. The window runs a
// bash without profile or rc files whose PATH starts with a `claude` that
// runs the stand-in (tests/fixtures/fake-claude.sh), so a real Claude Code
// is never started. Needs the socket and session of the server under test
// (TMUX_SOCKET, TMUX_SESSION); Linux only, like the stand-in.
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

test.describe('agent start on tmux', () => {
  test.skip(
    !socket || process.platform !== 'linux',
    'needs TMUX_SOCKET of the server under test (Linux)',
  )

  let windowName = ''
  let windowId = ''
  let claudeDir = ''
  let cwd = ''
  let shims = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    // The server creates its tmux session on the first snapshot
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    const snap = await api.get('/api/mux/snapshot')
    expect(snap.ok()).toBe(true)
    await api.dispose()

    claudeDir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-start-claude-'))
    cwd = mkdtempSync(path.join(tmpdir(), 'termote-e2e-start-cwd-'))
    shims = mkdtempSync(path.join(tmpdir(), 'termote-e2e-start-shims-'))
    writeFileSync(
      path.join(shims, 'claude'),
      `#!/usr/bin/env bash\nexec bash ${JSON.stringify(fakeClaude)} "$@"\n`,
    )
    chmodSync(path.join(shims, 'claude'), 0o755)

    windowName = `agent-start-${Date.now()}`
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
      `PATH=${shims}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      `CLAUDE_CONFIG_DIR=${claudeDir}`,
      'bash',
      '--noprofile',
      '--norc',
    ).trim()
  })

  test.afterAll(() => {
    try {
      if (windowId) tmux('kill-window', '-t', windowId)
    } catch {
      // Already gone
    }
    for (const dir of [claudeDir, cwd, shims]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('starts Claude Code in an idle pane from the Chat view', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.getByRole('tab', { name: new RegExp(windowName) }).click()

    // An idle shell offers the Chat view with the start buttons
    await page
      .getByRole('tablist', { name: 'View' })
      .getByRole('tab', { name: 'Chat' })
      .click({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Claude Code', exact: true }).click()

    // The line was typed into the pane's shell: once the agent runs there
    // its conversation shows (the stand-in clears the screen as it starts,
    // so the typed line is not left to read)
    const conversation = page.getByRole('region', { name: 'Conversation' })
    await expect(conversation).toContainText('Fix the build please', {
      timeout: 20_000,
    })
    await expect(
      page.getByRole('textbox', { name: 'Message to Claude Code' }),
    ).toBeVisible()
  })
})
