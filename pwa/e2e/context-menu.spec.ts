import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, type Locator, test } from './fixtures'

// The browser's own context menu is blocked over the app's chrome and kept in
// fields and text to read, against a pane whose directory is a throwaway
// folder in a window of the server's tmux (TMUX_SOCKET, TMUX_SESSION).
// Playwright cannot open the real menu: each check fires a contextmenu event
// and reads whether the page cancelled it.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })

// True when the page blocked the browser's menu there
const blocked = (target: Locator) =>
  target.evaluate((el) => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    el.dispatchEvent(e)
    return e.defaultPrevented
  })

test.describe('browser context menu', () => {
  test.skip(
    !socket || process.platform !== 'linux',
    'needs TMUX_SOCKET of the server under test (Linux)',
  )

  let dir = ''
  let windowId = ''
  let link = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    const snap = await (await api.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.files, 'the backend reports no pane directory')

    dir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-menu-'))
    writeFileSync(path.join(dir, 'notes.txt'), 'text to copy\n')

    const name = `menu-${Date.now()}`
    windowId = tmux(
      'new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', name, '-c', dir, 'bash',
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
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('blocked on buttons and the Files tree, kept in a field and in a file', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    const file = panel.getByRole('treeitem', { name: 'notes.txt' })
    await expect(file).toBeVisible()

    const search = page.getByRole('button', { name: 'Search sessions' })
    expect(await blocked(search)).toBe(true)
    // A tree row's right click opens the app's own menu in its place
    expect(await blocked(file)).toBe(true)
    const menu = page.getByRole('menu', { name: 'Actions for notes.txt' })
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()

    await search.click()
    const box = page.getByRole('searchbox', { name: 'Find a session' })
    await expect(box).toBeFocused()
    expect(await blocked(box)).toBe(false)

    await file.click()
    const code = panel.getByTestId('code-block')
    await expect(code).toContainText('text to copy')
    expect(await blocked(code.getByText('text to copy'))).toBe(false)
    expect(await blocked(panel.getByRole('button', { name: 'Back to files' }))).toBe(true)
  })
})
