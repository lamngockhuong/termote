import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, type Page, test } from './fixtures'

// The command palette and app shortcuts on a desktop (Linux, Chromium: no
// Cmd key here, the Apple keys are unit tested), against a pane whose
// directory is a throwaway folder, in a window of the server's tmux
// (TMUX_SOCKET, TMUX_SESSION), as in files-search.spec.ts.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })

const rows = (page: Page) => page.locator('[data-testid="terminal-view"] .xterm-rows')
const xterm = (page: Page) => page.locator('[data-testid="terminal-view"] .xterm-helper-textarea')
const palette = (page: Page) => page.getByRole('dialog').filter({ has: page.getByRole('combobox') })
const filesPanel = (page: Page) => page.getByRole('complementary', { name: 'Files' })

test.describe('command palette', () => {
  test.skip(
    !socket || process.platform !== 'linux' || !!process.env.TERMOTE_E2E_HERDR,
    'needs TMUX_SOCKET of the server under test (Linux, tmux job)',
  )
  test.skip(({ browserName }) => browserName !== 'chromium', 'desktop keys on Chromium')
  test.describe.configure({ mode: 'serial' })
  test.use({ viewport: { width: 1280, height: 800 } })

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

    dir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-palette-'))
    mkdirSync(path.join(dir, 'src'))
    writeFileSync(path.join(dir, 'src/app.ts'), 'export const app = 1\n')
    writeFileSync(path.join(dir, 'alpha.md'), '# Alpha\n')
    writeFileSync(path.join(dir, 'beta.md'), '# Beta\n')

    const name = `palette-${Date.now()}`
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

  // The pane on screen, focus outside the terminal
  async function open(page: Page) {
    await page.addInitScript(() => {
      localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true }))
    })
    await page.goto(link)
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
    await expect(rows(page)).toHaveText(/\S/, { timeout: 15000 })
    await page.getByRole('button', { name: 'Command palette' }).focus()
  }

  test('Ctrl+P opens a file typed in two keys, Enter before the results', async ({ page }) => {
    await open(page)
    await expect(filesPanel(page)).toHaveCount(0)
    await page.keyboard.press('Control+P')
    await expect(palette(page)).toBeVisible()
    await page.keyboard.type('ap')
    // At once, not waiting for the list
    await page.keyboard.press('Enter')
    await expect(palette(page)).toHaveCount(0)
    await expect(filesPanel(page).getByRole('tab', { name: /app\.ts/ })).toBeVisible()
    // Focus is on the file, not back in the terminal
    await expect(xterm(page)).not.toBeFocused()
  })

  test('Ctrl+P then Enter goes back to the file before', async ({ page }) => {
    await open(page)
    for (const name of ['alpha', 'beta']) {
      await page.keyboard.press('Control+P')
      await page.keyboard.type(name)
      await expect(palette(page).getByRole('option', { name: new RegExp(`^${name}\\.md`) })).toBeVisible()
      await page.keyboard.press('Enter')
      await expect(filesPanel(page).getByRole('heading', { name: name[0].toUpperCase() + name.slice(1) })).toBeVisible()
    }
    await page.keyboard.press('Control+P')
    await expect(palette(page).getByRole('option').first()).toContainText('alpha.md')
    await page.keyboard.press('Enter')
    await expect(filesPanel(page).getByRole('heading', { name: 'Alpha' })).toBeVisible()
  })

  test('Ctrl+Shift+P runs a command; one that cannot run says why', async ({ page }) => {
    await open(page)
    await page.keyboard.press('Control+Shift+P')
    const box = palette(page).getByRole('combobox')
    await expect(box).toHaveValue('>')
    await box.fill('>show chat')
    const chat = palette(page).getByRole('option', { name: /Show Chat/ })
    await expect(chat).toHaveAttribute('aria-disabled', 'true')
    await expect(chat).toContainText('No agent chat in this pane')
    await page.keyboard.press('Enter')
    await expect(palette(page)).toBeVisible()
    await box.fill('>toggle the files panel')
    await page.keyboard.press('Enter')
    await expect(palette(page)).toHaveCount(0)
    await expect(filesPanel(page)).toBeVisible()
  })

  test('the palette keeps its keys from the browser while open', async ({ page }) => {
    await open(page)
    await page.keyboard.press('Control+Shift+P')
    const options = palette(page).getByRole('option')
    await expect(options.first()).toHaveAttribute('aria-selected', 'true')
    // Its own key again moves down the list
    await page.keyboard.press('Control+Shift+P')
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
    // Ctrl+P (print, left to the browser) switches to files instead
    await page.evaluate(() => {
      window.addEventListener('keydown', (e) => {
        ;(window as unknown as { kept?: boolean }).kept = e.defaultPrevented
      })
    })
    await page.keyboard.press('Control+P')
    await expect(palette(page).getByRole('combobox')).toHaveValue('')
    await expect(palette(page)).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true)
  })

  test('a changed key works after a reload; a shared one is marked', async ({ page }) => {
    await open(page)
    await page.keyboard.press('Control+Shift+P')
    await palette(page).getByRole('combobox').fill('>settings: shortcuts')
    await page.keyboard.press('Enter')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Change the key of Go to file' }).click()
    await page.keyboard.press('Control+Alt+O')
    await expect(settings.getByText('Ctrl+Alt+O')).toBeVisible()
    await settings.getByRole('button', { name: 'Change the key of Show help' }).click()
    await page.keyboard.press('Control+Alt+O')
    await expect(settings.getByText('Also used by Go to file')).toBeVisible()
    await expect(settings.getByText('Also used by Show help')).toBeVisible()
    await settings.getByRole('button', { name: 'Remove the key of Show help' }).click()

    await page.reload()
    await expect(rows(page)).toHaveText(/\S/, { timeout: 15000 })
    await page.getByRole('button', { name: 'Command palette' }).focus()
    await page.keyboard.press('Control+Alt+O')
    await expect(palette(page)).toBeVisible()
    await expect(palette(page).getByRole('combobox')).toHaveValue('')
  })

  test('Ctrl+P in the terminal is the pane’s; Ctrl+Shift+P opens the palette', async ({ page }) => {
    await open(page)
    await xterm(page).focus()
    await page.keyboard.type('clear')
    await page.keyboard.press('Enter')
    await page.keyboard.type('echo pal""-mark')
    await page.keyboard.press('Enter')
    const marks = async () => ((await rows(page).innerText()).match(/^pal-mark\s*$/gm) ?? []).length
    await expect.poll(marks, { timeout: 10000 }).toBe(1)
    // ^P reaches bash: the last command again
    await page.keyboard.press('Control+P')
    await page.keyboard.press('Enter')
    await expect(palette(page)).toHaveCount(0)
    await expect.poll(marks, { timeout: 10000 }).toBe(2)
    await page.keyboard.press('Control+Shift+P')
    await expect(palette(page)).toBeVisible()
  })
})
