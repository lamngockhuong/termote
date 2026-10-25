import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from './fixtures'

// The Search tab of Files against a pane whose directory is a throwaway git
// repo, in a window of the server's tmux (TMUX_SOCKET, TMUX_SESSION), as in
// files-changes.spec.ts.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })

test.describe('files content search', () => {
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

    repo = mkdtempSync(path.join(tmpdir(), 'termote-e2e-search-'))
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'e2e@example.com')
    git(repo, 'config', 'user.name', 'e2e')
    mkdirSync(path.join(repo, 'src'))
    // Far enough down that the line has to be scrolled to
    const lines = Array.from({ length: 200 }, (_, i) => `const filler${i} = ${i}`)
    lines[149] = 'const needleValue = 42'
    writeFileSync(path.join(repo, 'src/app.ts'), `${lines.join('\n')}\n`)
    writeFileSync(path.join(repo, '.gitignore'), 'build/\n')
    mkdirSync(path.join(repo, 'build'))
    writeFileSync(path.join(repo, 'build/out.js'), 'needleValue\n')
    writeFileSync(path.join(repo, '.env'), 'TOKEN=needleValue\n')
    git(repo, 'add', 'src', '.gitignore')
    git(repo, 'commit', '-q', '-m', 'init')
    // Untracked, not ignored: searched
    writeFileSync(path.join(repo, 'notes.md'), '# Notes\n\nthe needleValue again\n')

    const name = `search-${Date.now()}`
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

  test('finds a string, opens it at its line, and Back shows the same results', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    await expect(panel.getByRole('treeitem', { name: 'src' })).toBeVisible()

    // Ctrl+Shift+F from inside Files: the Search tab, its box focused
    await panel.getByRole('treeitem', { name: 'src' }).focus()
    await page.keyboard.press('Control+Shift+F')
    const box = panel.getByRole('searchbox', { name: 'Search file contents' })
    await expect(box).toBeFocused()

    let searches = 0
    page.on('request', (r) => {
      if (r.url().includes('/files/search?')) searches++
    })
    await box.fill('needleValue')
    const results = panel.getByRole('list', { name: 'Search results' })
    await expect(panel.getByText('2 lines in 2 files')).toBeVisible()
    // Ignored and sensitive files are never searched; the sensitive one is counted
    await expect(results).not.toContainText('out.js')
    await expect(results).not.toContainText('.env')
    await expect(panel.getByText('1 sensitive file not searched')).toBeVisible()
    await expect(results.locator('mark').first()).toHaveText('needleValue')

    // The line opens highlighted, scrolled into view
    await results.getByRole('button', { name: /^150const needleValue = 42/ }).click()
    const code = panel.getByTestId('code-block')
    const row = code.locator('[data-line="150"]')
    await expect(row).toHaveClass(/bg-accent/)
    await expect(row).toBeInViewport()

    // Markdown opens as its source at the line, the preview setting unchanged
    await panel.getByRole('button', { name: 'Back to files' }).click()
    await expect(box).toHaveValue('needleValue')
    await expect(panel.getByText('2 lines in 2 files')).toBeVisible()
    expect(searches).toBe(1)
    await results.getByRole('button', { name: /^3the needleValue again/ }).click()
    await expect(code.locator('[data-line="3"]')).toHaveClass(/bg-accent/)
    await expect(panel.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'false')
  })

  test('an invalid regex is told under the box', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    await panel.getByRole('radio', { name: 'Search' }).click()
    await panel.getByRole('button', { name: 'Regular expression' }).click()
    await panel.getByRole('searchbox', { name: 'Search file contents' }).fill('needle(')
    await expect(panel.getByRole('alert')).toHaveText('Invalid regular expression')
    await panel.getByRole('searchbox', { name: 'Search file contents' }).fill('needle\\w+ = \\d+')
    await expect(panel.getByText('1 line in 1 file')).toBeVisible()
  })
})
