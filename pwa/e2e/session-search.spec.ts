import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from './fixtures'

// Finding a session by name in the sidebar and the phone's sessions sheet,
// against tmux sessions made here straight through the server's socket.
const socket = process.env.TMUX_SOCKET

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

const suffix = Math.random().toString(36).slice(2, 8)
const FOUND = `e2e-find-${suffix}`
const OTHER = `e2e-other-${suffix}`

async function open(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-opened')) return
    sessionStorage.setItem('e2e-opened', '1')
    localStorage.clear()
  })
  await page.goto('/')
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
}

test.describe('session search', () => {
  test.skip(!socket, 'needs TMUX_SOCKET, the tmux socket of the server under test')
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(() => {
    for (const name of [FOUND, OTHER]) tmux('new-session', '-d', '-s', name, '-c', '/tmp')
  })

  test.afterAll(() => {
    for (const name of [FOUND, OTHER]) {
      try {
        tmux('kill-session', '-t', `=${name}`)
      } catch {
        // Already gone
      }
    }
  })

  test('desktop: the sidebar lists only the matches', async ({ page, request }) => {
    const snap = await (await request.get('/api/mux/snapshot')).json()
    test.skip(snap.groups.length < 2, 'the server lists a single group')
    await page.setViewportSize({ width: 1280, height: 800 })
    await open(page)
    const sidebar = page.locator('aside')
    const found = sidebar.locator(`section[aria-label="${FOUND}"]`)
    const other = sidebar.locator(`section[aria-label="${OTHER}"]`)
    await expect(found).toBeVisible({ timeout: 15000 })
    await expect(other).toBeVisible()

    await sidebar.getByRole('button', { name: 'Search sessions' }).click()
    const box = sidebar.getByRole('searchbox', { name: 'Find a session' })
    await expect(box).toBeFocused()
    await box.fill(`FIND ${suffix}`)
    await expect(found).toBeVisible()
    await expect(other).toHaveCount(0)

    await box.fill('no-such-session-here')
    await expect(sidebar.getByText('No sessions match')).toBeVisible()
    await sidebar.getByRole('button', { name: 'Show all' }).click()
    await expect(other).toBeVisible()

    // Esc clears, then closes; the list is whole again
    await box.fill(FOUND)
    await page.keyboard.press('Escape')
    await expect(box).toHaveValue('')
    await page.keyboard.press('Escape')
    await expect(box).toBeHidden()
    await expect(other).toBeVisible()
  })

  test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

    test('the sheet opens without the box; a match is picked, and it opens whole again', async ({
      page,
      request,
    }) => {
      const snap = await (await request.get('/api/mux/snapshot')).json()
      test.skip(snap.groups.length < 2, 'the server lists a single group')
      await open(page)
      await page.getByRole('button', { name: 'Open sessions menu' }).click()
      const sheet = page.getByRole('dialog', { name: 'Sessions' })
      await expect(sheet.getByRole('region', { name: OTHER })).toBeVisible({ timeout: 15000 })
      await expect(sheet.getByRole('searchbox')).toHaveCount(0)

      await sheet.getByRole('button', { name: 'Search sessions' }).click()
      const box = sheet.getByRole('searchbox', { name: 'Find a session' })
      // Esc clears the box, then closes it; the sheet stays open
      await box.fill(FOUND)
      await page.keyboard.press('Escape')
      await expect(box).toHaveValue('')
      await page.keyboard.press('Escape')
      await expect(box).toBeHidden()
      await expect(sheet).toBeVisible()

      await sheet.getByRole('button', { name: 'Search sessions' }).click()
      await box.fill(FOUND)
      await expect(sheet.getByRole('region', { name: OTHER })).toHaveCount(0)
      await page.keyboard.press('Enter')
      await expect(sheet).toBeHidden()
      await expect
        .poll(() => tmux('list-clients', '-F', '#{session_name}'), { timeout: 10000 })
        .toContain(FOUND)

      await page.getByRole('button', { name: 'Open sessions menu' }).click()
      await expect(sheet.getByRole('searchbox')).toHaveCount(0)
      await expect(sheet.getByRole('region', { name: OTHER })).toBeVisible()
    })
  })
})
