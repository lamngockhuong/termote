import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, type Page, test } from '@playwright/test'

// Files and Changes against a pane whose directory is a throwaway git repo,
// in a window of the server's tmux. Like the Chat view test it needs the
// socket and session the server under test uses (TMUX_SOCKET, TMUX_SESSION).
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })

// The page has nothing wider than the screen: only code frames scroll sideways
const noPageScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test.describe('files and changes views', () => {
  test.skip(
    !socket || process.platform !== 'linux',
    'needs TMUX_SOCKET of the server under test (Linux)',
  )
  test.describe.configure({ mode: 'serial' })

  let repo = ''
  let windowId = ''
  let link = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    const snap = await (await api.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.files, 'the backend reports no pane directory')

    repo = mkdtempSync(path.join(tmpdir(), 'termote-e2e-repo-'))
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'e2e@example.com')
    git(repo, 'config', 'user.name', 'e2e')
    mkdirSync(path.join(repo, 'src'))
    writeFileSync(
      path.join(repo, 'src/app.ts'),
      'export function add(a: number, b: number) {\n  return a + b\n}\n',
    )
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')

    const name = `files-${Date.now()}`
    windowId = tmux(
      'new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', name, '-c', repo, 'bash',
    ).trim()
    // A link straight to the window: no tab to click on mobile
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
  })

  test.afterAll(() => {
    try {
      if (windowId) tmux('kill-window', '-t', windowId)
    } catch {
      // Already gone
    }
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  test('desktop: Files and Changes open next to the terminal', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)

    const panel = page.getByRole('complementary', { name: 'Files' })
    await expect(panel).toBeVisible()
    await expect(page.locator('#view-panel-terminal')).toBeVisible()
    await expect(
      page.getByRole('group', { name: 'Side panel' }).getByRole('button', { name: 'Files' }),
    ).toHaveAttribute('aria-pressed', 'true')

    await panel.getByRole('treeitem', { name: 'src' }).click()
    await panel.getByRole('treeitem', { name: 'app.ts' }).click()
    const code = panel.getByTestId('code-block')
    await expect(code).toContainText('return a + b')
    // Highlighted by the worker: tokens carry a colour
    await expect(code.locator('span[style*="color"]').first()).toBeVisible({ timeout: 10000 })

    // A change to the file and a new one show in Changes
    writeFileSync(
      path.join(repo, 'src/app.ts'),
      'export function add(a: number, b: number) {\n  return b + a\n}\n',
    )
    writeFileSync(path.join(repo, 'notes.txt'), 'hello\n')
    await page.getByRole('group', { name: 'Side panel' }).getByRole('button', { name: 'Changes' }).click()
    const changes = page.getByRole('complementary', { name: 'Changes' })
    await expect(changes.getByRole('region', { name: 'Untracked' })).toContainText('notes.txt')
    await changes.getByRole('region', { name: 'Changes' }).getByRole('button', { name: /app\.ts/ }).click()
    await expect(changes.locator('[data-kind="add"]')).toContainText('return b + a')
    await expect(changes.locator('[data-kind="del"]')).toContainText('return a + b')
  })

  test('a sensitive file is shown only after saying so', async ({ page }) => {
    writeFileSync(path.join(repo, '.env'), 'TOKEN=e2e-secret\n')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    const env = panel.getByRole('treeitem', { name: /^\.env/ })
    await expect(env).toContainText('Sensitive')
    await env.click()
    await expect(page.getByText('This file may contain secrets. Show its contents?')).toBeVisible()
    await expect(panel.getByTestId('code-block')).toHaveCount(0)
    await page.getByRole('button', { name: 'Show', exact: true }).click()
    await expect(panel.getByTestId('code-block')).toContainText('TOKEN=e2e-secret')
  })

  test('mobile: both are views of the switcher and fit the screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    // The first-visit gesture tour would cover the view
    await page.addInitScript(() =>
      localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true })),
    )
    await page.goto(`${link}?view=files`)
    await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('treeitem', { name: 'src' }).click()
    await page.getByRole('treeitem', { name: 'app.ts' }).click()
    await expect(page.getByTestId('code-block')).toContainText('return b + a')
    expect(await noPageScroll(page)).toBe(true)

    await page.getByRole('tab', { name: 'Changes' }).click()
    await page.getByRole('region', { name: 'Changes' }).getByRole('button', { name: /app\.ts/ }).click()
    await expect(page.locator('[data-kind="add"]')).toBeVisible()
    expect(await noPageScroll(page)).toBe(true)
  })
})
