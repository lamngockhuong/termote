import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, type Page, test } from './fixtures'

// "Open in new window" and the focus window it opens (solo=1): one target,
// no sidebar or tabs, nothing written over the main window's state. Against
// a pane whose directory is a throwaway git repo, in a window of the server's
// tmux, as the Files and Changes test does.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })

// What the app keeps on the device, but the release check every spec sets
const kept = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      Object.entries({ ...localStorage }).filter(([k]) => k !== 'termote-update-check'),
    ),
  )

test.describe('focus window', () => {
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

    repo = mkdtempSync(path.join(tmpdir(), 'termote-e2e-focus-'))
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'e2e@example.com')
    git(repo, 'config', 'user.name', 'e2e')
    mkdirSync(path.join(repo, 'src'))
    writeFileSync(path.join(repo, 'src/app.ts'), 'export const a = 1\n')
    writeFileSync(path.join(repo, 'README.md'), '# Focus\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    // A change, for the diff link
    writeFileSync(path.join(repo, 'src/app.ts'), 'export const a = 2\n')

    const name = `focus-${Date.now()}`
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

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
  })

  test('a tab link shows only its terminal, and keeps solo', async ({ page }) => {
    await page.goto(`${link}?solo=1`)
    await expect(page.getByTestId('terminal-view')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open in main window' })).toBeVisible()
    // No sessions sidebar, no side panel
    await expect(page.locator('aside')).toHaveCount(0)
    await expect(page).toHaveURL(/\?solo=1$/)
  })

  test('a file link shows the file in the Files panel over the terminal', async ({ page }) => {
    await page.goto(`${link}?view=files&solo=1&file=README.md`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    await expect(panel.getByRole('heading', { name: 'Focus' })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Restore panel' })).toBeVisible()
    // The Files panel is the only one: no sessions sidebar
    await expect(page.locator('aside')).toHaveCount(1)
    await expect(page).toHaveURL(/\?view=files&solo=1&file=README\.md$/)
    await expect(page).toHaveTitle('README.md — Termote')
  })

  test('a diff link shows its side in the Changes panel', async ({ page }) => {
    await page.goto(`${link}?view=changes&solo=1&file=src%2Fapp.ts`)
    const changes = page.getByRole('complementary', { name: 'Changes' })
    await expect(changes.locator('[data-kind="add"]')).toContainText('export const a = 2')
    await expect(changes.locator('[data-kind="del"]')).toContainText('export const a = 1')
  })

  test('the overview shows alone', async ({ page }) => {
    await page.goto('/#/overview?solo=1')
    await expect(page.getByRole('region', { name: 'Agents' })).toBeVisible()
    await expect(page.locator('aside')).toHaveCount(0)
    await expect(page).toHaveURL(/#\/overview\?solo=1$/)
  })

  for (const file of ['..%2F..%2Fetc%2Fpasswd', 'nope.ts']) {
    test(`a file that cannot be opened (${file}) gets a short notice`, async ({ page }) => {
      await page.goto(`${link}?view=files&solo=1&file=${file}`)
      // A warning toast is a status, not an alert
      const toast = page.getByRole('status').filter({ hasText: 'File not found or not allowed' })
      await expect(toast).toBeVisible()
      await expect(toast).not.toContainText(/passwd|nope|\//)
    })
  }

  test('opening and closing a focus window leaves the main window as it was', async ({ page, context }) => {
    await page.goto(`${link}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    await panel.getByRole('treeitem', { name: 'README.md' }).dblclick()
    await expect(panel.getByRole('heading', { name: 'Focus' })).toBeVisible()
    // The tabs are written a little after the last change
    await expect.poll(async () => Object.keys(await kept(page)).some((k) => k.startsWith('termote-files-tabs:'))).toBe(true)
    const before = await kept(page)

    const opened = context.waitForEvent('page')
    await panel.getByRole('button', { name: 'Open in new window' }).click()
    const focus = await opened
    await expect(focus).toHaveURL(/\?view=files&solo=1&file=README\.md$/)
    const focusPanel = focus.getByRole('complementary', { name: 'Files' })
    await expect(focusPanel.getByRole('heading', { name: 'Focus' })).toBeVisible()
    // Another file, another tab, back to the tree: none of it is kept
    await focusPanel.getByRole('button', { name: 'Restore panel' }).click()
    await focusPanel.getByRole('button', { name: 'Back to files' }).click()
    await focusPanel.getByRole('treeitem', { name: 'src' }).click()
    await focusPanel.getByRole('treeitem', { name: 'app.ts' }).dblclick()
    await expect(focusPanel.getByTestId('code-block')).toContainText('export const a = 2')
    await focus.waitForTimeout(1000)
    await focus.close()

    expect(await kept(page)).toEqual(before)
  })

  test('Open in main window hands the target back to the window that opened it', async ({ page, context }) => {
    await page.goto(link)
    await expect(page.getByTestId('terminal-view')).toBeVisible()
    // A focus window has Open in main window instead
    await expect(page.getByRole('button', { name: 'Open in main window' })).toHaveCount(0)
    const opened = context.waitForEvent('page')
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Open in new window' }).click()
    const focus = await opened
    await expect(focus).toHaveURL(/\?solo=1$/)
    await expect(focus.getByRole('button', { name: 'Open in main window' })).toBeVisible()
    await focus.getByRole('button', { name: 'Open in main window' }).click()
    // The focus window closes; the main window shows its target, no solo
    await expect.poll(() => focus.isClosed()).toBe(true)
    await expect(page).toHaveURL(new RegExp(`${link.slice(2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  })

  test('a phone offers no new window', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    await page.addInitScript(() =>
      localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true })),
    )
    await page.goto(`${link}?view=files`)
    await page.getByRole('treeitem', { name: 'README.md' }).click()
    await expect(page.getByRole('heading', { name: 'Focus' })).toBeVisible()
    await page.getByRole('button', { name: 'More actions' }).click()
    await expect(page.getByRole('menuitem', { name: 'Copy path' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Open in new window' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Copy link' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Open in new window' })).toHaveCount(0)
  })

  test('a focus window pushed out by newer streams says so and reconnects on demand', async ({ page, context }) => {
    test.slow()
    await page.goto(`${link}?solo=1`)
    await expect(page.getByTestId('terminal-view')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connected' })).toBeVisible()
    // The server holds 8 streams at most and drops the oldest for a new one
    const others: Page[] = []
    for (let i = 0; i < 8; i++) {
      const other = await context.newPage()
      await other.setViewportSize({ width: 1280, height: 800 })
      await other.goto(link)
      await expect(other.getByTestId('terminal-view')).toBeVisible()
      others.push(other)
    }
    const reconnect = page.getByRole('button', { name: 'Disconnected by a newer window — Reconnect' })
    await expect(reconnect).toBeVisible({ timeout: 15000 })
    // It stays down: two windows never push each other out in turn
    await page.waitForTimeout(2000)
    await expect(reconnect).toBeVisible()
    for (const other of others) await other.close()
    await reconnect.click()
    await expect(reconnect).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Connected' })).toBeVisible()
  })
})
