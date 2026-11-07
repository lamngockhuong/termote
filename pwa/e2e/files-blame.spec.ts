import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, type Page, test } from './fixtures'

// Blame in the file viewer, against a pane whose directory is a throwaway
// git repo: two commits by two authors and a line not committed. Needs the
// socket and session of the server under test (TMUX_SOCKET, TMUX_SESSION).
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })
const commitAs = (cwd: string, name: string, message: string) =>
  git(cwd, '-c', `user.name=${name}`, '-c', `user.email=${name.toLowerCase()}@example.com`, 'commit', '-q', '-am', message)

const noPageScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

// The blame cell of a line: the first box of its row
const cellOf = (page: Page, line: number) =>
  page.locator(`[data-testid="code-block"] [data-line="${line}"] > div > :first-child`)

test.describe('blame in the file viewer', () => {
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

    repo = mkdtempSync(path.join(tmpdir(), 'termote-e2e-blame-'))
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(path.join(repo, 'notes.txt'), 'one\ntwo\nthree\n')
    git(repo, 'add', '.')
    commitAs(repo, 'Alice', 'docs: first notes')
    writeFileSync(path.join(repo, 'notes.txt'), 'one\nTWO\nthree\n')
    commitAs(repo, 'Bob', 'fix: shout two')
    // Not committed
    writeFileSync(path.join(repo, 'notes.txt'), 'one\nTWO\nTHREE\n')

    const name = `blame-${Date.now()}`
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

  test('desktop: names who changed each line, and the commit a cell opens', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    await panel.getByRole('treeitem', { name: 'notes.txt' }).click()
    await expect(panel.getByTestId('code-block')).toContainText('THREE')

    const toggle = panel.getByRole('button', { name: 'Blame' })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(cellOf(page, 1)).toContainText('Alice')
    await expect(cellOf(page, 2)).toContainText('Bob')
    await expect(cellOf(page, 3)).toHaveText('Not committed')

    await cellOf(page, 2).click()
    const details = page.getByRole('dialog', { name: 'Commit details' })
    await expect(details).toContainText('fix: shout two')
    const head = git(repo, 'rev-parse', '--short=7', 'HEAD').trim()
    await expect(details).toContainText(head)
    await page.keyboard.press('Escape')
    await expect(details).toBeHidden()

    // Still on after Changes was shown and Files opened again (no reload)
    const side = page.getByRole('group', { name: 'Side panel' })
    await side.getByRole('button', { name: 'Changes' }).click()
    await expect(page.getByRole('complementary', { name: 'Changes' })).toBeVisible()
    await side.getByRole('button', { name: 'Files' }).click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(cellOf(page, 3)).toHaveText('Not committed')

    // Off again: the column goes
    await toggle.click()
    await expect(page.getByText('Not committed')).toBeHidden()
  })

  test('phone: turned on from the menu, the page does not scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 760 })
    await page.goto(`${link}?view=files`)
    await page.getByRole('treeitem', { name: 'notes.txt' }).click()
    await expect(page.getByTestId('code-block')).toContainText('THREE')
    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Blame' }).click()
    // Initials on a phone
    await expect(cellOf(page, 1)).toContainText('A')
    await expect(cellOf(page, 3)).toHaveText('Not committed')
    expect(await noPageScroll(page)).toBe(true)
  })
})
