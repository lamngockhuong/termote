import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from './fixtures'

// The session history of a pane against the server's own Claude Code dir:
// TERMOTE_E2E_CLAUDE_DIR is the CLAUDE_CONFIG_DIR the server under test was
// started with (CI's E2E job), where the spec lays two old sessions. Resuming
// types `claude --resume <id>` into a new tab, so while the spec runs the new
// windows of the server's tmux (TMUX_SOCKET) start a bash without profile or
// rc files, a `claude` that runs the stand-in (tests/fixtures/fake-claude.sh)
// first on its PATH: a login shell's profile could put a real Claude Code
// before it. Linux only, like the stand-in.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const claudeDir = process.env.TERMOTE_E2E_CLAUDE_DIR
const fakeClaude = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/fake-claude.sh',
)

const LOGIN = 'aaaaaaaa-0000-4000-8000-00000000e2e1'
const DOCS = 'aaaaaaaa-0000-4000-8000-00000000e2e2'

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
  })

// A transcript as Claude Code writes it: rows naming their cwd and branch
function transcript(cwd: string, rows: object[]) {
  return `${rows.map((r) => JSON.stringify({ cwd, gitBranch: 'main', ...r })).join('\n')}\n`
}

test.describe('session history', () => {
  test.skip(
    !socket || !claudeDir || process.platform !== 'linux',
    'needs TMUX_SOCKET and TERMOTE_E2E_CLAUDE_DIR of the server under test (Linux)',
  )
  test.describe.configure({ mode: 'serial' })

  let cwd = ''
  let shims = ''
  let windowName = ''
  let windowId = ''
  let oldCommand = ''
  let project = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    expect((await api.get('/api/mux/snapshot')).ok()).toBe(true)
    await api.dispose()

    cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'termote-e2e-hist-')))
    project = path.join(
      claudeDir as string,
      'projects',
      cwd.replace(/[^A-Za-z0-9]/g, '-'),
    )
    mkdirSync(project, { recursive: true })
    const at = (min: number) => new Date(Date.now() - min * 60_000)
    const login = path.join(project, `${LOGIN}.jsonl`)
    writeFileSync(
      login,
      transcript(cwd, [
        { type: 'user', uuid: 'l1', timestamp: at(30).toISOString(), message: { role: 'user', content: 'Add a login page' } },
        { type: 'assistant', uuid: 'l2', timestamp: at(29).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Login page added.' }] } },
        { type: 'ai-title', aiTitle: 'Seeded login work' },
      ]),
    )
    utimesSync(login, at(5), at(5))
    const docs = path.join(project, `${DOCS}.jsonl`)
    writeFileSync(
      docs,
      transcript(cwd, [
        { type: 'user', uuid: 'd1', timestamp: at(90).toISOString(), message: { role: 'user', content: 'Write the docs' } },
        { type: 'assistant', uuid: 'd2', timestamp: at(89).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Docs written.' }] } },
      ]),
    )
    utimesSync(docs, at(60), at(60))

    // `claude` in the server's new tabs is the stand-in
    shims = mkdtempSync(path.join(tmpdir(), 'termote-e2e-shims-'))
    writeFileSync(
      path.join(shims, 'claude'),
      `#!/usr/bin/env bash\nexec bash ${JSON.stringify(fakeClaude)} "$@"\n`,
    )
    chmodSync(path.join(shims, 'claude'), 0o755)
    const line = tmux('show-environment', '-g', 'PATH').trim()
    const pathNow = line.startsWith('PATH=') ? line.slice(5) : (process.env.PATH ?? '')
    oldCommand = tmux('show-options', '-gv', 'default-command').trim()
    const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
    tmux(
      'set-option',
      '-g',
      'default-command',
      `env PATH=${q(`${shims}:${pathNow}`)} CLAUDE_CONFIG_DIR=${q(claudeDir as string)} bash --noprofile --norc`,
    )

    windowName = `history-${Date.now()}`
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
    ).trim()
  })

  test.afterAll(() => {
    try {
      tmux('set-option', '-g', 'default-command', oldCommand)
    } catch {
      // The server's tmux is gone
    }
    // Every window opened at the spec's folder: its own and the resumed one
    try {
      for (const w of tmux('list-windows', '-a', '-F', '#{window_id} #{pane_current_path}').split('\n')) {
        const [id, dir] = w.split(' ')
        if (id && (id === windowId || dir === cwd)) tmux('kill-window', '-t', id)
      }
    } catch {
      // Already gone
    }
    for (const dir of [cwd, shims, project]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  const openHistory = async (page: import('@playwright/test').Page) => {
    // The palette's commands (Mod+Shift+P)
    await page.locator('body').press('Control+Shift+P')
    const input = page.getByRole('dialog').getByRole('combobox')
    await input.fill('>Session history')
    await input.press('Enter')
    return page.getByRole('dialog', { name: 'Session history' })
  }

  test('reads an old session and resumes it in a new tab', async ({ page }) => {
    test.setTimeout(90_000)
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.getByRole('tab', { name: new RegExp(windowName) }).click()

    const sheet = await openHistory(page)
    // Newest first: the agent's title, then a first prompt standing in
    const rows = sheet.locator('[data-history-id]')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Seeded login work')
    await expect(rows.nth(1)).toContainText('Write the docs')

    await rows.nth(0).click()
    await expect(sheet.getByRole('region', { name: 'Conversation' })).toContainText('Login page added.')
    const before = tmux('list-windows', '-t', `${tmuxSession}:`).split('\n').length
    await sheet.getByRole('button', { name: 'Resume in a new tab' }).click()
    await expect(sheet).toBeHidden()

    // The new tab runs the stand-in on the old session, and its Chat view
    // shows the old conversation
    await expect
      .poll(() => tmux('list-windows', '-t', `${tmuxSession}:`).split('\n').length, { timeout: 15_000 })
      .toBeGreaterThan(before)
    const conversation = page.getByRole('region', { name: 'Conversation' })
    await expect(conversation).toContainText('Login page added.', { timeout: 20_000 })

    // A new message goes on in the same transcript
    await page.getByRole('textbox', { name: 'Message to Claude Code' }).fill('hello again')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(conversation).toContainText('You said: hello again')
    expect(readFileSync(path.join(project, `${LOGIN}.jsonl`), 'utf-8')).toContain('hello again')
  })

  test('a running session opens its tab instead of a second copy', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('tab', { name: new RegExp(windowName) }).click()
    const sheet = await openHistory(page)
    const row = sheet.locator(`[data-history-id="${LOGIN}"]`)
    await expect(row).toContainText('Running')
    await row.click()
    await expect(sheet.getByRole('button', { name: 'Resume in a new tab' })).toHaveCount(0)
    await sheet.getByRole('button', { name: 'Open the running tab' }).click()
    await expect(sheet).toBeHidden()
    await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('You said: hello again', {
      timeout: 15_000,
    })
  })
})
