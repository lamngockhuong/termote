import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, type Page, test } from './fixtures'

// The last commit, opened from an empty Changes list, against a pane whose
// directory is a throwaway git repo with nothing left to commit. Needs the
// socket and session of the server under test (TMUX_SOCKET, TMUX_SESSION).
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })

const noPageScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test.describe('last commit from Changes', () => {
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

    repo = mkdtempSync(path.join(tmpdir(), 'termote-e2e-commit-'))
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'e2e@example.com')
    git(repo, 'config', 'user.name', 'e2e')
    mkdirSync(path.join(repo, 'src'))
    writeFileSync(path.join(repo, 'src/app.ts'), 'export const a = 1\n')
    writeFileSync(path.join(repo, 'old.txt'), 'kept for the rename\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    writeFileSync(path.join(repo, 'src/app.ts'), 'export const a = 1\nexport const b = 2\n')
    git(repo, 'mv', 'old.txt', 'new.txt')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'feat: add b\n\nAnd move old.txt.')

    const name = `commit-${Date.now()}`
    windowId = tmux(
      'new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', name, '-c', repo, 'bash',
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
  })

  test.afterAll(() => {
    try {
      if (windowId) tmux('kill-window', '-t', windowId)
    } catch {
      // Already gone
    }
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  test('desktop: shows HEAD, its files and a diff', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=changes`)
    const changes = page.getByRole('complementary', { name: 'Changes' })
    await expect(changes.getByText('No changes since the last commit')).toBeVisible()
    await changes.getByRole('button', { name: 'Show last commit' }).click()

    const head = git(repo, 'rev-parse', '--short=7', 'HEAD').trim()
    await expect(changes.getByText('feat: add b')).toBeVisible()
    await expect(changes.getByText('And move old.txt.')).toBeVisible()
    await expect(changes.getByText(head).first()).toBeVisible()
    const files = changes.getByRole('region', { name: 'Files' })
    await expect(files.getByRole('button', { name: /Renamed:\s*new\.txt/ })).toContainText('old.txt →')

    await files.getByRole('button', { name: /Modified:\s*app\.ts/ }).click()
    await expect(changes.locator('[data-kind="add"]')).toContainText('export const b = 2')
    await changes.getByRole('button', { name: 'Back to the commit' }).click()
    await changes.getByRole('button', { name: 'Back to changes' }).click()
    await expect(changes.getByText('No changes since the last commit')).toBeVisible()
  })

  test('mobile: fits the screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto(`${link}?view=changes`)
    await page.getByRole('button', { name: 'Show last commit' }).click()
    await page.getByRole('region', { name: 'Files' }).getByRole('button', { name: /Modified:\s*app\.ts/ }).click()
    await expect(page.locator('[data-kind="add"]')).toBeVisible()
    expect(await noPageScroll(page)).toBe(true)
  })
})
