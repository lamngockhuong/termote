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
import { expect, test } from './fixtures'

// The files a session changed through its tool calls, in Changes and in an
// old session of the history. The stand-in (tests/fixtures/fake-claude.sh)
// runs in a throwaway repo and, told "touch files", edits touched-edit.txt
// and writes touched-new.txt as Edit and Write calls, and records an Edit
// of touched-failed.txt that failed. Its transcript goes under the server's
// own Claude Code dir (TERMOTE_E2E_CLAUDE_DIR). Linux only, like the
// stand-in.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const claudeDir = process.env.TERMOTE_E2E_CLAUDE_DIR
const fakeClaude = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/fake-claude.sh',
)
const OLD = 'aaaaaaaa-0000-4000-8000-00000000e2ea'

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
  })
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' })

test.describe('files a session changed', () => {
  test.skip(
    !socket ||
      !claudeDir ||
      process.platform !== 'linux' ||
      process.env.TERMOTE_E2E_ZELLIJ === '1',
    'needs TMUX_SOCKET and TERMOTE_E2E_CLAUDE_DIR of the server under test (Linux)',
  )
  test.describe.configure({ mode: 'serial' })

  let repo = ''
  let project = ''
  let windowId = ''
  let link = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    const snap = await (await api.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.files, 'the backend reports no pane directory')

    repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'termote-e2e-touched-')))
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'e2e@example.com')
    git(repo, 'config', 'user.name', 'e2e')
    writeFileSync(path.join(repo, 'base.txt'), 'base\n')
    writeFileSync(path.join(repo, 'touched-edit.txt'), 'first line\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    // A change the agent did not make
    writeFileSync(path.join(repo, 'base.txt'), 'changed by hand\n')

    // An old session of the folder that wrote old.txt
    project = path.join(
      claudeDir as string,
      'projects',
      repo.replace(/[^A-Za-z0-9]/g, '-'),
    )
    mkdirSync(project, { recursive: true })
    const at = new Date(Date.now() - 30 * 60_000)
    const old = path.join(project, `${OLD}.jsonl`)
    writeFileSync(
      old,
      `${[
        { type: 'user', uuid: 'o1', message: { role: 'user', content: 'Write the notes' } },
        {
          type: 'assistant',
          uuid: 'o2',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_old', name: 'Write', input: { file_path: path.join(repo, 'old.txt') } }],
          },
        },
        {
          type: 'user',
          uuid: 'o3',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: 'ok' }] },
        },
      ]
        .map((r) => JSON.stringify({ cwd: repo, gitBranch: 'main', timestamp: at.toISOString(), ...r }))
        .join('\n')}\n`,
    )
    utimesSync(old, at, at)

    const name = `touched-${Date.now()}`
    windowId = tmux(
      'new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`,
      '-n', name, '-c', repo,
      'env', `CLAUDE_CONFIG_DIR=${claudeDir}`, 'bash', fakeClaude,
    ).trim()
    let tab: { id: string } | undefined
    let group: { id: string } | undefined
    await expect(async () => {
      const s = await (await api.get('/api/mux/snapshot')).json()
      group = s.groups.find((g: { tabs: { name: string }[] }) => g.tabs.some((t) => t.name === name))
      tab = group?.tabs.find((t: { name: string }) => t.name === name) as { id: string } | undefined
      expect(tab).toBeDefined()
    }).toPass()
    link = `/#/s/${encodeURIComponent(group!.id)}/${encodeURIComponent(tab!.id)}`
    await api.dispose()
    tmux('send-keys', '-t', windowId, '-l', 'touch files')
    tmux('send-keys', '-t', windowId, 'Enter')
  })

  test.afterAll(() => {
    try {
      if (windowId) tmux('kill-window', '-t', windowId)
    } catch {
      // Already gone
    }
    for (const dir of [repo, project]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('Changes lists what the session changed, each opening its diff', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=changes`)
    const changes = page.getByRole('complementary', { name: 'Changes' })
    const mode = changes.getByRole('radio', { name: 'Changed by this session' })
    // Offered once the pane's agent is known
    await expect(mode).toBeVisible({ timeout: 20_000 })
    await mode.click()
    const list = changes.getByRole('region', { name: 'Files this session changed' })
    await expect(list.getByRole('button')).toHaveCount(2, { timeout: 20_000 })
    await expect(list).toContainText('touched-new.txt')
    await expect(list).not.toContainText('base.txt')
    await expect(list).not.toContainText('touched-failed.txt')
    await expect(list).toContainText('Files changed by shell commands')

    await list.getByRole('button', { name: /touched-edit\.txt/ }).click()
    await expect(changes.locator('[data-kind="add"]')).toContainText('edited by the agent')

    // Committed from the terminal: no longer changed
    git(repo, 'commit', '-q', '-m', 'agent edit', '--', 'touched-edit.txt')
    await changes.getByRole('button', { name: 'Back to changes' }).click()
    await expect(list.getByRole('button', { name: /touched-edit\.txt/ })).toContainText(
      'no longer changed',
      { timeout: 20_000 },
    )
  })

  test('an old session of the history lists the files it changed', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(link)
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
    await page.locator('body').press('Control+Shift+P')
    const input = page.getByRole('dialog').getByRole('combobox')
    await input.fill('>Session history')
    await input.press('Enter')
    const sheet = page.getByRole('dialog', { name: 'Session history' })
    await sheet.locator(`[data-history-id="${OLD}"]`).click()
    await sheet.getByRole('button', { name: 'Files changed' }).click()
    const list = sheet.getByRole('region', { name: 'Files this session changed' })
    await expect(list.getByRole('button', { name: /old\.txt/ })).toBeVisible({ timeout: 20_000 })
  })
})
