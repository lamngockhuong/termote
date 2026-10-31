import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from './fixtures'

// Sheets, menus, views and tabs fade out instead of vanishing. Checked by
// state (data-closing / data-leaving, inert), never by measuring time: the
// only number is an upper bound for the element to be gone.

const socket = process.env.TMUX_SOCKET

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

const xterm = (page: Page) => page.locator('[data-testid="terminal-view"] .xterm')
const rows = (page: Page) => page.locator('[data-testid="terminal-view"] .xterm-rows')

async function open(page: Page, hash = '') {
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('termote-settings', JSON.stringify({ pollInterval: 1 }))
  })
  await page.goto(`/${hash}`)
  await page.reload()
  await xterm(page).waitFor({ timeout: 10000 })
}

// Records, from now on, each element that showed leaving or closing: its
// tag, whether it was inert and whether it took pointer events. The window
// is too short to catch reliably by polling from the test.
async function recordExits(page: Page) {
  await page.evaluate(() => {
    const seen: { tag: string; inert: boolean; pointer: string }[] = []
    ;(window as unknown as { __exits: typeof seen }).__exits = seen
    const look = () => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-closing], [data-leaving]')) {
        if (seen.some((s) => s.tag === el.tagName)) continue
        seen.push({ tag: el.tagName, inert: el.inert, pointer: getComputedStyle(el).pointerEvents })
      }
    }
    new MutationObserver(look).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-closing', 'data-leaving'],
    })
  })
}

const exits = (page: Page) =>
  page.evaluate(() => (window as unknown as { __exits: { tag: string; inert: boolean; pointer: string }[] }).__exits)

const openSettings = async (page: Page) => {
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await expect(page.locator('dialog[open]')).toBeVisible()
}

test.describe('exit motion', () => {
  test('a closed sheet fades out, inert, and what is under it takes a click at once', async ({ page }) => {
    await open(page)
    const more = (await page.getByRole('button', { name: 'More' }).boundingBox())!
    await openSettings(page)
    await recordExits(page)
    await page.locator('dialog[open]').getByRole('button', { name: 'Close' }).click()
    // No waiting: the button under the fading sheet answers this click
    await page.mouse.click(more.x + more.width / 2, more.y + more.height / 2)
    await expect(page.getByRole('menu', { name: 'More' })).toBeVisible()
    expect(await exits(page)).toContainEqual({ tag: 'DIALOG', inert: true, pointer: 'none' })
    await expect(page.locator('dialog')).toHaveCount(0, { timeout: 500 })
  })

  test('with reduced motion a closed sheet goes at once', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await open(page)
    await openSettings(page)
    await recordExits(page)
    await page.locator('dialog[open]').getByRole('button', { name: 'Close' }).click()
    expect(await page.locator('dialog').count()).toBe(0)
    expect(await exits(page)).toEqual([])
  })

  test('back on the terminal, keys reach it while the view fades out', async ({ page }) => {
    await open(page)
    const view = page.getByRole('tablist', { name: 'View' })
    // Files is a side panel on a desktop; Tasks covers the terminal
    await view.getByRole('tab', { name: 'Tasks' }).click()
    await expect(page.locator('#view-panel-tasks')).toBeVisible({ timeout: 10000 })
    await recordExits(page)
    await view.getByRole('tab', { name: 'Terminal' }).click()
    // No waiting: the click lands on the terminal under the fading view
    const box = (await xterm(page).boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.type('echo mot""ion-mark')
    await page.keyboard.press('Enter')
    await expect.poll(async () => /^motion-mark\s*$/m.test(await rows(page).innerText()), { timeout: 10000 }).toBe(
      true,
    )
    expect(await exits(page)).toContainEqual({ tag: 'DIV', inert: true, pointer: 'none' })
  })
})

test.describe('a closed session tab', () => {
  test.skip(!socket, 'needs TMUX_SOCKET, the tmux socket of the server under test')

  let sid = ''

  test.afterEach(() => {
    try {
      if (sid) tmux('kill-session', '-t', sid)
    } catch {
      // Already gone
    }
  })

  test('fades out, inert and out of reach, then goes', async ({ page }) => {
    const run = Math.random().toString(36).slice(2, 8)
    sid = tmux('new-session', '-d', '-P', '-F', '#{session_id}', '-s', `motion-${run}`, '-n', `keep-${run}`)
    tmux('new-window', '-d', '-t', `${sid}:`, '-n', `gone-${run}`)
    const snap = await (await page.request.get('/api/mux/snapshot')).json()
    const tabs = snap.groups.find((g: { id: string }) => g.id === sid).tabs as { id: string; name: string }[]
    const keep = tabs.find((t) => t.name === `keep-${run}`)!
    await open(page, `#/s/${encodeURIComponent(sid)}/${encodeURIComponent(keep.id)}`)
    const header = page.locator('header [data-tour="session-tabs"]')
    const gone = header.locator('.group').filter({ hasText: `gone-${run}` })
    await expect(gone).toBeVisible()
    await recordExits(page)
    tmux('kill-window', '-t', `${sid}:gone-${run}`)
    await expect(gone).toHaveCount(0, { timeout: 10000 })
    expect(await exits(page)).toContainEqual({ tag: 'DIV', inert: true, pointer: 'none' })
    // The tabs left still answer the keys
    await expect(header.getByRole('tab')).toHaveCount(1)
  })
})
