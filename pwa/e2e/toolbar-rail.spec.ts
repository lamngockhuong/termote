import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from './fixtures'

// The header gives its room to the tabs: the view and panel labels drop
// while the tabs overflow, and a setting moves the controls to a bar down
// the right edge.

const waitForTerminal = (page: Page) =>
  page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })

const openSettingsGroup = async (page: Page, group: string) => {
  await page.getByRole('button', { name: /^More/ }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await page.getByRole('navigation', { name: 'Settings groups' }).getByRole('button', { name: group }).click()
}

const pickToolbar = async (page: Page, position: 'Header' | 'Right bar') => {
  await openSettingsGroup(page, 'Sessions')
  await page.getByRole('radiogroup', { name: 'Toolbar position' }).getByRole('radio', { name: position }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden()
}

test.describe('the right bar', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForTerminal(page)
  })

  test('holds the controls beside the views, and gives them back', async ({ page }) => {
    const header = page.locator('header')
    const bar = page.getByRole('navigation', { name: 'Toolbar' })
    await expect(bar).toHaveCount(0)
    await pickToolbar(page, 'Right bar')
    await expect(bar).toBeVisible()
    // The header keeps the tabs and the menu only
    await expect(header.getByRole('tablist', { name: 'View' })).toHaveCount(0)
    await expect(header.getByRole('button', { name: 'Files' })).toHaveCount(0)
    const settings = JSON.parse((await page.evaluate(() => localStorage.getItem('termote-settings')))!)
    expect(settings.toolbarPosition).toBe('right')
    // At the right edge, as tall as the views
    const box = (await bar.boundingBox())!
    expect(box.x + box.width).toBe(1280)
    expect(box.width).toBe(40)

    // The Pane menu opens to the bar's left, whole on the screen
    const pane = bar.getByRole('button', { name: 'Pane' })
    if (await pane.count()) {
      await pane.click()
      const menu = (await page.getByRole('menu', { name: 'Pane' }).boundingBox())!
      expect(menu.x + menu.width).toBeLessThanOrEqual(box.x)
      expect(menu.x).toBeGreaterThanOrEqual(0)
      expect(menu.y + menu.height).toBeLessThanOrEqual(800)
      await page.keyboard.press('Escape')
    }

    // Files opens beside the terminal; maximized, it leaves the bar in reach
    const files = bar.getByRole('button', { name: 'Files' })
    await files.click()
    const panel = page.getByRole('complementary', { name: 'Files' })
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: 'Maximize panel' }).click()
    const panelBox = (await panel.boundingBox())!
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(box.x + 1)
    await files.click()
    await expect(panel).toBeHidden()

    // The palette and fullscreen are buttons on the bar
    await bar.getByRole('button', { name: 'Command palette' }).click()
    await expect(page.getByRole('dialog').filter({ has: page.getByRole('combobox') })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(bar.getByRole('button', { name: 'Enter fullscreen' })).toBeVisible()
    await page.getByRole('button', { name: /^More/ }).click()
    await expect(page.getByRole('menuitem', { name: /Command palette/ })).toHaveCount(0)
    await page.keyboard.press('Escape')

    await pickToolbar(page, 'Header')
    await expect(bar).toHaveCount(0)
    await expect(header.getByRole('button', { name: 'Files' })).toBeVisible()
  })

  test('switches the view with Up and Down', async ({ page }) => {
    await pickToolbar(page, 'Right bar')
    const views = page.getByRole('navigation', { name: 'Toolbar' }).getByRole('tablist', { name: 'View' })
    test.skip((await views.count()) === 0, 'the pane offers one view only')
    await expect(views).toHaveAttribute('aria-orientation', 'vertical')
    const tabs = views.getByRole('tab')
    await tabs.first().focus()
    await page.keyboard.press('ArrowDown')
    await expect(tabs.nth(1)).toBeFocused()
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowUp')
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
  })
})

// tmux windows of a session of its own on the server's socket
const socket = process.env.TMUX_SOCKET
const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

test.describe('labels giving way to the tabs', () => {
  test.skip(!socket, 'needs TMUX_SOCKET, the tmux socket of the server under test')
  test.use({ viewport: { width: 1440, height: 900 } })

  let sid = ''
  test.beforeEach(() => {
    const run = Math.random().toString(36).slice(2, 8)
    sid = tmux('new-session', '-d', '-P', '-F', '#{session_id}', '-s', `labels-${run}`)
  })
  test.afterEach(() => {
    try {
      if (sid) tmux('kill-session', '-t', sid)
    } catch {
      // Already gone
    }
  })

  test('drops the labels while the tabs overflow, and takes them back', async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('termote-settings', JSON.stringify({ pollInterval: 1 }))
    })
    const snap = await (await page.request.get('/api/mux/snapshot')).json()
    const tab = snap.groups.find((g: { id: string }) => g.id === sid).tabs[0]
    await page.goto(`/#/s/${encodeURIComponent(sid)}/${encodeURIComponent(tab.id)}`)
    await page.reload()
    await waitForTerminal(page)
    // The first label of the header's view or panel buttons; sr-only is
    // position: absolute, a shown label is in the row
    const label = page.locator('header [data-header-label]').first()
    await expect(label).toHaveCSS('position', 'static')

    const extra = Array.from({ length: 14 }, (_, i) => `a-rather-long-window-${i}`)
    for (const name of extra) tmux('new-window', '-d', '-t', `${sid}:`, '-n', name)
    const tabs = page.locator('header [data-tour="session-tabs"] [role="tab"]')
    await expect(tabs).toHaveCount(extra.length + 1)
    await expect(label).toHaveCSS('position', 'absolute')
    // Still named by the button
    await expect(page.locator('header').getByRole('button', { name: 'Files' })).toBeVisible()

    for (const name of extra) tmux('kill-window', '-t', `${sid}:=${name}`)
    await expect(tabs).toHaveCount(1)
    await expect(label).toHaveCSS('position', 'static')
  })
})
