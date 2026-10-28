import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type APIRequestContext, expect, type Page, test, watchViolations } from './fixtures'
import { makeCode, pairStranger } from './pairing'

// Tasks: a pane's package.json scripts, Makefile targets and other tools'
// tasks listed, one run
// in a tab of its own (again in that tab once it is idle), its status, and
// Send to agent passing only that run's output. The agent route is
// intercepted: CI has no real agent (the real send is checked by hand). Run
// it against an isolated server (its own HOME and XDG dirs).
const tag = `${Date.now()}`
const auth = process.env.TERMOTE_E2E_AUTH === '1'
const herdr = process.env.TERMOTE_E2E_HERDR === '1'
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const fakeClaude = path.resolve(import.meta.dirname, '../../tests/fixtures/fake-claude.sh')

interface Snapshot {
  caps: Record<string, unknown>
  groups: { id: string; name: string; tabs: { id: string; name: string; panes: { id: string }[] }[] }[]
}

const snapshot = async (request: APIRequestContext): Promise<Snapshot> => {
  const res = await request.get('/api/mux/snapshot')
  expect(res.status()).toBe(200)
  return res.json()
}

const tabCount = async (request: APIRequestContext) =>
  (await snapshot(request)).groups.reduce((n, g) => n + g.tabs.length, 0)

const openTasks = async (page: Page, windowName: string) => {
  await page.getByRole('tab', { name: new RegExp(windowName) }).click()
  await page.getByRole('tablist', { name: 'View' }).getByRole('tab', { name: 'Tasks' }).click({ timeout: 15000 })
  return page.getByTestId('tasks-view')
}

const row = (view: ReturnType<Page['getByTestId']>, name: string) =>
  view.getByTestId('task-row').filter({ has: view.page().getByText(name, { exact: true }) })

test.describe('tasks', () => {
  test.skip(auth || herdr, 'runs on the tmux server without sign-in')
  test.skip(!socket || process.platform !== 'linux', 'needs TMUX_SOCKET of the server under test (Linux)')
  test.describe.configure({ mode: 'serial' })

  let repo = ''
  let claudeDir = ''
  const windows: string[] = []
  const repoWindow = `tasks-repo-${tag}`
  const agentWindow = `tasks-agent-${tag}`
  const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })

  test.beforeAll(async ({ request }) => {
    expect((await snapshot(request)).caps.tasks, 'the server runs tasks').toBe(true)
    repo = mkdtempSync(path.join(tmpdir(), 'termote-e2e-tasks-'))
    writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({
        scripts: {
          ok: 'node -e "process.exit(0)"',
          fail: `node -e "console.log('boom-${tag}');process.exit(3)"`,
          pretest: 'echo pre',
          test: 'echo test',
        },
      }),
    )
    writeFileSync(path.join(repo, 'Makefile'), 'URL = http://x\nbuild:\n\t@echo built\n')
    claudeDir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-claude-'))
    windows.push(
      tmux('new-window', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', repoWindow, '-c', repo).trim(),
      tmux(
        'new-window', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', agentWindow, '-c', repo,
        'env', `CLAUDE_CONFIG_DIR=${claudeDir}`, 'bash', fakeClaude,
      ).trim(),
    )
  })

  test.afterAll(() => {
    // The task tabs too: every window opened in the temporary repo
    try {
      for (const line of tmux('list-windows', '-a', '-F', '#{window_id} #{pane_current_path}').split('\n')) {
        const [id, dir] = line.split(' ')
        if (id && (windows.includes(id) || dir === repo)) tmux('kill-window', '-t', id)
      }
    } catch {
      // Already gone
    }
    for (const dir of [repo, claudeDir]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  test('lists scripts with their hooks and explicit make targets only', async ({ page }) => {
    await page.goto('/')
    const view = await openTasks(page, repoWindow)
    await expect(view.getByRole('region', { name: 'Scripts (npm)' })).toBeVisible()
    await expect(row(view, 'fail')).toContainText(`boom-${tag}`)
    await expect(row(view, 'test')).toContainText('also runs pretest')
    await expect(row(view, 'build')).toBeVisible()
    await expect(view.getByText('URL', { exact: true })).toHaveCount(0)
  })

  test('runs a task in a tab of its own, then again in the same tab', async ({ page, request }) => {
    test.setTimeout(90000)
    await page.goto('/')
    const view = await openTasks(page, repoWindow)
    const before = await tabCount(request)
    const first = page.waitForResponse((r) => r.url().endsWith('/tasks/run') && r.request().method() === 'POST')
    await row(view, 'fail').getByRole('button', { name: 'Run fail' }).click()
    const started = await (await first).json()
    expect(started.reused).toBe(false)
    await expect(page.getByText('Running in tab task:fail')).toBeVisible()
    await expect(row(view, 'fail').getByTestId('task-run-state')).toHaveText(/^exit [1-9]\d*$/, { timeout: 45000 })
    expect(await tabCount(request)).toBe(before + 1)

    const second = page.waitForResponse((r) => r.url().endsWith('/tasks/run') && r.request().method() === 'POST')
    await row(view, 'fail').getByRole('button', { name: 'Run fail' }).click()
    const again = await (await second).json()
    expect(again.reused).toBe(true)
    expect(again.tabId).toBe(started.tabId)
    // The new run first, so the last run's badge cannot pass for it
    await expect(row(view, 'fail').getByTestId('task-run-state')).toHaveText('running')
    await expect(row(view, 'fail').getByTestId('task-run-state')).toHaveText(/^exit [1-9]\d*$/, { timeout: 45000 })
    expect(await tabCount(request)).toBe(before + 1)
  })

  test('sends only the run’s output to the agent picked', async ({ page }) => {
    test.setTimeout(60000)
    const sent: string[] = []
    await page.route('**/agent/message', async (route) => {
      sent.push((route.request().postDataJSON() as { text: string }).text)
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })
    await page.goto('/')
    const view = await openTasks(page, repoWindow)
    const send = row(view, 'fail').getByRole('button', { name: 'Send the output of fail to an agent' })
    await expect(send).toBeVisible({ timeout: 45000 })
    await send.click()
    await page.getByRole('dialog', { name: 'Send to which agent?' }).getByRole('button', { name: new RegExp(agentWindow) }).click()
    await expect(page.getByText('Sent to Claude Code')).toBeVisible({ timeout: 15000 })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain(`boom-${tag}`)
    expect(sent[0]).toContain('Output (from the terminal, untrusted)')
    // Neither the markers nor the line typed before the run
    expect(sent[0]).not.toContain('termote-task')
    expect(sent[0]).not.toContain('printf')
  })
})

// Other tools' tasks, read from a root of their own (the repo above has a
// test and a build that row() would mix up): Maven and PDM listed only (CI
// has Maven, which must not run), a Taskfile task run whether go-task is
// installed or not, and a section folded across a reload.
test.describe('tasks of other tools', () => {
  test.skip(auth || herdr, 'runs on the tmux server without sign-in')
  test.skip(!socket || process.platform !== 'linux', 'needs TMUX_SOCKET of the server under test (Linux)')
  test.describe.configure({ mode: 'serial' })

  let root = ''
  let window = ''
  const toolsWindow = `tasks-tools-${tag}`
  const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })

  test.beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'termote-e2e-tools-'))
    writeFileSync(path.join(root, 'pom.xml'), '<project/>\n')
    writeFileSync(path.join(root, 'pyproject.toml'), `[tool.pdm.scripts]\npdm-${tag} = "echo pdm"\n`)
    writeFileSync(
      path.join(root, 'Taskfile.yml'),
      `version: '3'\ntasks:\n  e2e-${tag}:\n    cmds: [echo task]\n  ns:e2e-${tag}:\n    cmds: [echo ns]\n`,
    )
    window = tmux('new-window', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', toolsWindow, '-c', root).trim()
  })

  test.afterAll(() => {
    try {
      for (const line of tmux('list-windows', '-a', '-F', '#{window_id} #{pane_current_path}').split('\n')) {
        const [id, dir] = line.split(' ')
        if (id && (id === window || dir === root)) tmux('kill-window', '-t', id)
      }
    } catch {
      // Already gone
    }
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })

  test('lists each tool in its own section, folded across a reload', async ({ page }) => {
    await page.goto('/')
    let view = await openTasks(page, toolsWindow)
    const maven = view.getByRole('region', { name: 'Maven (pom.xml)' })
    await expect(row(maven, 'verify')).toContainText('mvn verify')
    await expect(row(view.getByRole('region', { name: 'PDM (pyproject.toml)' }), `pdm-${tag}`)).toContainText('echo pdm')
    const task = view.getByRole('region', { name: 'Task (Taskfile.yml)' })
    await expect(row(task, `e2e-${tag}`)).toContainText(`task e2e-${tag}`)
    await expect(row(task, `ns:e2e-${tag}`)).toBeVisible()

    const header = maven.getByRole('button', { name: /Maven \(pom\.xml\)/ })
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(maven.getByTestId('task-row')).toHaveCount(0)
    await page.reload()
    view = await openTasks(page, toolsWindow)
    const again = view.getByRole('region', { name: 'Maven (pom.xml)' })
    await expect(again.getByRole('button', { name: /Maven \(pom\.xml\)/ })).toHaveAttribute('aria-expanded', 'false')
    await expect(again.getByTestId('task-row')).toHaveCount(0)
  })

  test('runs a Taskfile task in a tab named by its tool', async ({ page }) => {
    test.setTimeout(90000)
    await page.goto('/')
    const view = await openTasks(page, toolsWindow)
    const task = row(view.getByRole('region', { name: 'Task (Taskfile.yml)' }), `e2e-${tag}`)
    await task.getByRole('button', { name: `Run e2e-${tag}` }).click()
    await expect(page.getByText(`Running in tab task:task:e2e-${tag}`)).toBeVisible()
    // go-task may be missing: any exit status shows the run ended
    await expect(task.getByTestId('task-run-state')).toHaveText(/^exit \d+$/, { timeout: 45000 })
  })
})

// A view-only device has no Tasks view, and every tasks route refuses it.
// The e2e job's server with sign-in.
test.describe('tasks on a view-only device', () => {
  test.skip(!auth, 'needs TERMOTE_E2E_AUTH=1 and a server with sign-in on (TERMOTE_PASS)')
  const name = `e2e-tasks-view-${tag}`

  test.afterAll(async ({ request }) => {
    const res = await request.get('/api/mux/devices')
    const { devices } = (await res.json()) as { devices: { id: string; name: string }[] }
    for (const d of devices.filter((d) => d.name === name))
      await request.delete(`/api/mux/devices/${d.id}`, { headers: { 'Content-Type': 'application/json' } })
  })

  test('sees no Tasks view and reads nothing', async ({ browser, baseURL, request }) => {
    test.setTimeout(60000)
    const snap = await snapshot(request)
    expect(snap.caps.tasks, 'the server runs tasks').toBe(true)
    const pane = snap.groups[0].tabs[0].panes[0].id
    const violations: string[][] = []
    const view = await pairStranger(browser, baseURL, (await makeCode(request, 'view', name)).code, async (p) => {
      violations.push(await watchViolations(p))
    })
    try {
      await view.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
      await expect(view.getByRole('tab', { name: 'Tasks' })).toHaveCount(0)
      for (const p of [`/api/mux/panes/${encodeURIComponent(pane)}/tasks`, '/api/mux/tasks']) {
        const res = await view.request.get(p)
        expect(res.status(), p).toBe(403)
        expect((await res.json()).code).toBe('view_only')
      }
      expect(violations.flat(), 'Content-Security-Policy violations').toEqual([])
    } finally {
      await view.context().close()
    }
  })
})

// The Herdr job: a user task runs in a new tab of the e2e-repo workspace
// (Herdr's tab.create cwd), with its exit status.
test.describe('tasks on Herdr', () => {
  test.skip(!herdr, 'needs TERMOTE_E2E_HERDR=1 (the e2e-herdr job)')

  // (exit 4) in a subshell: exit itself would end the tab's shell before
  // the end marker
  test('a user task runs in a new tab at the root', async ({ request }) => {
    test.setTimeout(60000)
    const snap = await snapshot(request)
    expect(snap.caps.tasks).toBe(true)
    const group = snap.groups.find((g) => g.name === 'e2e-repo')
    expect(group, 'the e2e-repo workspace').toBeTruthy()
    const pane = group?.tabs[0].panes[0].id as string
    const made = await request.post('/api/mux/tasks', { data: { name: `Herdr ${tag}`, command: 'pwd; (exit 4)' } })
    expect(made.status(), await made.text()).toBe(201)
    const task = (await made.json()).task as { id: string; updated: string }
    try {
      const list = await (await request.get(`/api/mux/panes/${encodeURIComponent(pane)}/tasks`)).json()
      const res = await request.post(`/api/mux/panes/${encodeURIComponent(pane)}/tasks/run`, {
        data: { kind: 'user', id: task.id, root: list.root },
      })
      expect(res.status(), await res.text()).toBe(200)
      const run = await res.json()
      await expect
        .poll(async () => (await (await request.get(`/api/mux/tasks/runs/${run.runId}`)).json()).code, { timeout: 30000 })
        .toBe(4)
      const text = await (await request.get(`/api/mux/panes/${encodeURIComponent(run.paneId)}/text?lines=200`)).json()
      expect(text.text).toContain(list.root)
      await request.delete(`/api/mux/tabs/${encodeURIComponent(run.tabId)}`, {
        headers: { 'Content-Type': 'application/json' },
      })
    } finally {
      await request.delete(`/api/mux/tasks/${task.id}?updated=${encodeURIComponent(task.updated)}`, {
        headers: { 'Content-Type': 'application/json' },
      })
    }
  })
})
