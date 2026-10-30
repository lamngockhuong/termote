import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type APIRequestContext, expect, type Page, test, watchViolations } from './fixtures'
import { makeCode, pairStranger } from './pairing'

// Review comments: lines of two changed files commented on in Changes, kept
// in the tab's sessionStorage (a reload and another tab keep them), then
// sent to an agent pane as one message, cleared only once it was taken. The
// agent route is intercepted: CI has no real agent. Run it against an
// isolated server (its own HOME and XDG dirs).
const tag = `${Date.now()}`
const auth = process.env.TERMOTE_E2E_AUTH === '1'
const herdr = process.env.TERMOTE_E2E_HERDR === '1'
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const fakeClaude = path.resolve(import.meta.dirname, '../../tests/fixtures/fake-claude.sh')

interface Snapshot {
  caps: Record<string, unknown>
  groups: { id: string; name: string; tabs: { id: string; name: string; panes: { id: string; agent?: unknown }[] }[] }[]
}

const snapshot = async (request: APIRequestContext): Promise<Snapshot> => {
  const res = await request.get('/api/mux/snapshot')
  expect(res.status()).toBe(200)
  return res.json()
}

const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })

// A repo with two committed files, both changed since: a.ts line 2, b.md
// line 1
function makeRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'termote-e2e-review-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'e2e@example.com')
  git(repo, 'config', 'user.name', 'e2e')
  writeFileSync(path.join(repo, 'a.ts'), 'const a = 1\nconst b = 2\n')
  writeFileSync(path.join(repo, 'b.md'), '# Title\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  writeFileSync(path.join(repo, 'a.ts'), `const a = 1\nconst b = ${tag}\n`)
  writeFileSync(path.join(repo, 'b.md'), '# New title\n')
  return repo
}

// The link to the tab named name, once the snapshot lists it
async function tabLink(request: APIRequestContext, name: string) {
  let link = ''
  let pane = ''
  await expect(async () => {
    const s = await snapshot(request)
    const group = s.groups.find((g) => g.tabs.some((t) => t.name === name))
    const tab = group?.tabs.find((t) => t.name === name)
    expect(tab).toBeDefined()
    link = `/#/s/${encodeURIComponent(group!.id)}/${encodeURIComponent(tab!.id)}`
    pane = tab!.panes[0].id
  }).toPass()
  return { link, pane }
}

const changesPanel = (page: Page) => page.getByRole('complementary', { name: 'Changes' })

// Opens the diff of file (not staged) in the Changes panel
async function openDiff(page: Page, file: string) {
  const panel = changesPanel(page)
  const back = panel.getByRole('button', { name: 'Back to changes' })
  if (await back.isVisible()) await back.click()
  await panel.getByRole('region', { name: 'Changes' }).getByRole('button', { name: new RegExp(`:\\s*${file.replace('.', '\\.')}`) }).click()
  await expect(panel.getByTestId('diff')).toBeVisible()
}

// Comments text on line n of the diff shown
async function comment(page: Page, n: number, text: string) {
  const panel = changesPanel(page)
  await panel.getByRole('button', { name: `Line ${n}`, exact: true }).click()
  await panel.getByRole('button', { name: 'Comment', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Add a comment' })
  await sheet.getByRole('textbox', { name: 'Comment' }).fill(text)
  await sheet.getByRole('button', { name: 'Add' }).click()
  await expect(sheet).toHaveCount(0)
}

const reviewButton = (page: Page) => changesPanel(page).getByRole('button', { name: /^Review, / })

test.describe('review comments', () => {
  test.skip(auth || herdr, 'runs on the tmux server without sign-in')
  test.skip(!socket || process.platform !== 'linux', 'needs TMUX_SOCKET of the server under test (Linux)')
  test.describe.configure({ mode: 'serial' })

  let repo = ''
  let claudeDir = ''
  let link = ''
  const windows: string[] = []
  const repoWindow = `review-repo-${tag}`
  const agentWindow = `review-agent-${tag}`

  test.beforeAll(async ({ request }) => {
    expect((await snapshot(request)).caps.agentChat, 'the server sends to agents').toBe(true)
    repo = makeRepo()
    claudeDir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-claude-'))
    windows.push(
      tmux('new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', repoWindow, '-c', repo, 'bash').trim(),
      tmux(
        'new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', agentWindow, '-c', repo,
        'env', `CLAUDE_CONFIG_DIR=${claudeDir}`, 'bash', fakeClaude,
      ).trim(),
    )
    link = (await tabLink(request, repoWindow)).link
    // Sending needs the agent seen, which takes the server a few seconds
    await expect(async () => {
      const s = await snapshot(request)
      const tab = s.groups.flatMap((g) => g.tabs).find((t) => t.name === agentWindow)
      expect(tab?.panes[0].agent).toBeDefined()
    }).toPass({ timeout: 20000 })
  })

  test.afterAll(() => {
    try {
      for (const id of windows) tmux('kill-window', '-t', id)
    } catch {
      // Already gone
    }
    for (const dir of [repo, claudeDir]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    // tmux shows every client its session's current window, which the page
    // follows: the repo's window, or the page leaves it midway
    tmux('select-window', '-t', windows[0])
  })

  test('comments on two files go to the agent as one message', async ({ page }) => {
    test.setTimeout(60000)
    const sent: string[] = []
    await page.route('**/agent/message', async (route) => {
      sent.push((route.request().postDataJSON() as { text: string }).text)
      await route.fulfill({ status: 204 })
    })
    await page.goto(`${link}?view=changes`)
    await openDiff(page, 'a.ts')
    await comment(page, 2, `Why ${tag}?`)
    await openDiff(page, 'b.md')
    await comment(page, 1, 'Keep the old title')
    await expect(reviewButton(page)).toHaveAccessibleName('Review, 2 comments')

    await reviewButton(page).click()
    const review = page.getByRole('dialog', { name: 'Review (2)' })
    await expect(review.getByRole('region')).toHaveCount(2)
    await review.getByRole('button', { name: 'Send to…' }).click()
    await page.getByRole('dialog', { name: 'Send to which agent?' }).getByRole('button', { name: new RegExp(agentWindow) }).click()
    await expect(page.getByText('Sent to Claude Code')).toBeVisible({ timeout: 15000 })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain(`Review of my changes in ${repo} (2 comments).`)
    expect(sent[0]).toContain('1. `a.ts` line 2 (unstaged diff')
    expect(sent[0]).toContain(`+const b = ${tag}`)
    expect(sent[0]).toContain(`Comment: Why ${tag}?`)
    expect(sent[0]).toContain('2. `b.md` line 1 (unstaged diff')
    expect(sent[0]).toContain('Comment: Keep the old title')
    await expect(reviewButton(page)).toHaveCount(0)
  })

  test('the review outlives a reload and another tab; a refused send keeps it', async ({ page }) => {
    test.setTimeout(60000)
    let refuse = true
    await page.route('**/agent/message', async (route) => {
      if (refuse)
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'input_not_ready', error: 'the agent is working' }),
        })
      else await route.fulfill({ status: 204 })
    })
    await page.goto(`${link}?view=changes`)
    await openDiff(page, 'a.ts')
    await comment(page, 2, 'Kept')
    await expect(reviewButton(page)).toHaveAccessibleName('Review, 1 comment')

    await page.reload()
    await expect(reviewButton(page)).toHaveAccessibleName('Review, 1 comment')
    await page.getByRole('tab', { name: new RegExp(agentWindow) }).click()
    await page.getByRole('tab', { name: new RegExp(repoWindow) }).click()
    await expect(reviewButton(page)).toHaveAccessibleName('Review, 1 comment')

    await reviewButton(page).click()
    await page.getByRole('dialog', { name: 'Review (1)' }).getByRole('button', { name: 'Send to…' }).click()
    await page.getByRole('dialog', { name: 'Send to which agent?' }).getByRole('button', { name: new RegExp(agentWindow) }).click()
    await expect(page.getByText('Not sent: The agent cannot take input right now')).toBeVisible({ timeout: 15000 })
    // Still there, sent to the agent picked once it is free
    const review = page.getByRole('dialog', { name: 'Review (1)' })
    await expect(review.getByText('Kept')).toBeVisible()
    refuse = false
    await review.getByRole('button', { name: 'Send to Claude Code' }).click()
    await expect(page.getByText('Sent to Claude Code')).toBeVisible({ timeout: 15000 })
    await expect(reviewButton(page)).toHaveCount(0)
  })
})

// A view-only device has no way to comment: no line buttons, no Review. The
// e2e job's server with sign-in.
test.describe('review comments on a view-only device', () => {
  test.skip(!auth, 'needs TERMOTE_E2E_AUTH=1 and a server with sign-in on (TERMOTE_PASS)')
  test.skip(!socket || process.platform !== 'linux', 'needs TMUX_SOCKET of the server under test (Linux)')
  const name = `e2e-review-view-${tag}`
  const repoWindow = `review-view-${tag}`
  let repo = ''
  let windowId = ''

  test.afterAll(async ({ request }) => {
    const res = await request.get('/api/mux/devices')
    const { devices } = (await res.json()) as { devices: { id: string; name: string }[] }
    for (const d of devices.filter((d) => d.name === name))
      await request.delete(`/api/mux/devices/${d.id}`, { headers: { 'Content-Type': 'application/json' } })
    try {
      if (windowId) tmux('kill-window', '-t', windowId)
    } catch {
      // Already gone
    }
    if (repo) rmSync(repo, { recursive: true, force: true, maxRetries: 5 })
  })

  test('sees no line buttons and no Review', async ({ browser, baseURL, request }) => {
    test.setTimeout(60000)
    repo = makeRepo()
    windowId = tmux('new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', repoWindow, '-c', repo, 'bash').trim()
    tmux('select-window', '-t', windowId)
    const { link, pane } = await tabLink(request, repoWindow)
    const violations: string[][] = []
    const view = await pairStranger(browser, baseURL, (await makeCode(request, 'view', name)).code, async (p) => {
      violations.push(await watchViolations(p))
    })
    try {
      await view.setViewportSize({ width: 1280, height: 800 })
      // A review this tab would show, were it allowed one
      await view.evaluate(
        ([key, value]) => sessionStorage.setItem(key, value),
        [
          `termote-review:${pane}`,
          JSON.stringify({
            v: 1,
            comments: [{ id: 'x', root: repo, path: 'a.ts', source: 'unstaged', start: 2, end: 2, text: 't', at: 1 }],
          }),
        ],
      )
      await view.goto(`${link}?view=changes`)
      await openDiff(view, 'a.ts')
      await expect(changesPanel(view).locator('[data-kind="add"]')).toContainText(`const b = ${tag}`)
      await expect(changesPanel(view).getByRole('button', { name: /^(Removed line|Line) \d+$/ })).toHaveCount(0)
      await expect(reviewButton(view)).toHaveCount(0)
      expect(violations.flat(), 'Content-Security-Policy violations').toEqual([])
    } finally {
      await view.context().close()
    }
  })
})
