import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from './fixtures'

// Creating, renaming and closing a tmux session from the PWA. Needs the
// socket of the server under test, since the snapshot lists every session
// on that tmux server; the sessions made here are removed straight through
// tmux, never through the routes under test.
const socket = process.env.TMUX_SOCKET

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
const sessionNames = () => tmux('list-sessions', '-F', '#{session_name}').split('\n')

const made: string[] = []
const fresh = (prefix: string) => {
  const name = `${prefix}-${Math.random().toString(36).slice(2, 8)}`
  made.push(name)
  return name
}

async function open(page: Page) {
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.clear()
  })
  await page.reload()
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
}

type RecentGroup = { id: string; name: string; cwd: string }

const recentGroups = async (request: APIRequestContext): Promise<RecentGroup[]> => {
  const res = await request.get('/api/mux/recent-groups')
  expect(res.status()).toBe(200)
  return (await res.json()).groups
}

// Removes the recent groups in dir, never another's: a local run may be
// against the user's own server
async function clearRecent(request: APIRequestContext, dir: string) {
  for (const g of await recentGroups(request)) {
    if (g.cwd !== dir) continue
    await request.delete(`/api/mux/recent-groups/${g.id}`, {
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

async function createInDialog(page: Page, name: string) {
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Directory (an absolute path on the host)').fill('/tmp')
  await page.getByRole('button', { name: 'Create' }).click()
}

test.describe('tmux sessions from the PWA', () => {
  test.skip(!socket, 'needs TMUX_SOCKET, the tmux socket of the server under test')

  test.afterEach(() => {
    for (const name of made.splice(0)) {
      for (const n of [name, `${name}-2`]) {
        try {
          tmux('kill-session', '-t', `=${n}`)
        } catch {
          // Closed by the test, or never made
        }
      }
    }
  })

  test('create, rename and close a session from the sidebar', async ({ page, request }) => {
    const snap = await (await request.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.groups, 'the server cannot manage groups')
    const defaultGroup = snap.groups[0].name
    await open(page)

    const name = fresh('e2e')
    await page.getByRole('button', { name: 'New tmux session' }).click()
    await createInDialog(page, name)

    // In tmux by the name typed, starting in /tmp; the terminal attaches to it.
    await expect.poll(sessionNames, { timeout: 10000 }).toContain(name)
    expect(tmux('display-message', '-p', '-t', `=${name}:`, '#{session_path}')).toBe('/tmp')
    await expect(page.locator(`aside section[aria-label="${name}"]`)).toBeVisible()
    await expect
      .poll(() => tmux('list-clients', '-F', '#{session_name}'), { timeout: 10000 })
      .toContain(name)

    // Renamed in place.
    const renamed = `${name}-2`
    await page.getByRole('button', { name: `Actions for tmux session ${name}` }).click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    await page.getByRole('textbox', { name: `New name for tmux session ${name}` }).fill(renamed)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect.poll(sessionNames, { timeout: 10000 }).toContain(renamed)
    await expect(page.locator(`aside section[aria-label="${renamed}"]`)).toBeVisible()

    // Closed after the confirmation; the default session shows again.
    await page.getByRole('button', { name: `Actions for tmux session ${renamed}` }).click()
    await page.getByRole('menuitem', { name: 'Close' }).click()
    const dialog = page.getByRole('dialog', { name: 'Close tmux session?' })
    await expect(dialog).toContainText(`"${renamed}"`)
    await dialog.getByRole('button', { name: 'Close tmux session' }).click()
    await expect.poll(sessionNames, { timeout: 10000 }).not.toContain(renamed)
    await expect(page.locator(`aside section[aria-label="${renamed}"]`)).toHaveCount(0)
    await expect
      .poll(() => tmux('list-clients', '-F', '#{session_name}'), { timeout: 10000 })
      .toContain(defaultGroup)
  })

  test('a name already taken is refused in the dialog', async ({ page, request }) => {
    const snap = await (await request.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.groups, 'the server cannot manage groups')
    await open(page)
    await page.getByRole('button', { name: 'New tmux session' }).click()
    await createInDialog(page, snap.groups[0].name)
    await expect(page.getByRole('alert')).toHaveText('A tmux session of that name already exists')
    // What was typed stays
    await expect(page.getByLabel('Directory (an absolute path on the host)')).toHaveValue('/tmp')
  })

  test('create a session from the mobile sessions sheet', async ({ page, request }) => {
    const snap = await (await request.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.groups, 'the server cannot manage groups')
    await page.setViewportSize({ width: 390, height: 844 })
    await open(page)
    const name = fresh('e2e-m')
    await page.getByRole('button', { name: 'Open sessions menu' }).click()
    await page.getByRole('button', { name: 'New tmux session' }).click()
    await createInDialog(page, name)
    await expect.poll(sessionNames, { timeout: 10000 }).toContain(name)
    await expect
      .poll(() => tmux('list-clients', '-F', '#{session_name}'), { timeout: 10000 })
      .toContain(name)
  })

  test('a recent directory fills in the dialog, with a free name', async ({ page, request }) => {
    const snap = await (await request.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.groups, 'the server cannot manage groups')
    expect(snap.caps.recentGroups, 'a full client reads the recent groups').toBe(true)
    // A directory of its own, not the /tmp the other tests use
    const dir = mkdtempSync(join(tmpdir(), 'e2e-recent-'))
    try {
      await open(page)
      const name = fresh('e2e-r')
      const dialog = page.getByRole('dialog', { name: 'New tmux session' })
      const recent = dialog.getByRole('region', { name: 'Recent' })
      const use = dialog.getByRole('button', { name: new RegExp(`^Use .* in ${dir}$`) })

      // Made, then closed.
      await page.getByRole('button', { name: 'New tmux session' }).click()
      await page.getByLabel('Name', { exact: true }).fill(name)
      await page.getByLabel('Directory (an absolute path on the host)').fill(dir)
      await page.getByRole('button', { name: 'Create' }).click()
      await expect.poll(sessionNames, { timeout: 10000 }).toContain(name)
      // Closed from the PWA, which moves its terminal off it first: killed
      // in tmux under an attached stream, the name could be taken again.
      await page.getByRole('button', { name: `Actions for tmux session ${name}` }).click()
      await page.getByRole('menuitem', { name: 'Close' }).click()
      await page
        .getByRole('dialog', { name: 'Close tmux session?' })
        .getByRole('button', { name: 'Close tmux session' })
        .click()
      await expect.poll(sessionNames, { timeout: 10000 }).not.toContain(name)
      await expect(page.locator(`aside section[aria-label="${name}"]`)).toHaveCount(0)

      // First in the list, as typed; a tap fills both fields, Create makes it.
      await page.getByRole('button', { name: 'New tmux session' }).click()
      await expect(recent.getByRole('listitem').first()).toContainText(name)
      await expect(use).toHaveAccessibleName(`Use ${name} in ${dir}`)
      await use.click()
      await expect(page.getByLabel('Name', { exact: true })).toHaveValue(name)
      await expect(page.getByLabel('Directory (an absolute path on the host)')).toHaveValue(dir)
      await page.getByRole('button', { name: 'Create' }).click()
      await expect.poll(sessionNames, { timeout: 10000 }).toContain(name)
      await expect(page.locator(`aside section[aria-label="${name}"]`)).toBeVisible()

      // With that session open, the name filled in is the next free one.
      await page.getByRole('button', { name: 'New tmux session' }).click()
      await use.click()
      await expect(page.getByLabel('Name', { exact: true })).toHaveValue(`${name}-2`)
      await page.getByRole('button', { name: 'Create' }).click()
      await expect.poll(sessionNames, { timeout: 10000 }).toContain(`${name}-2`)

      // One entry for the directory, under the last name.
      await page.getByRole('button', { name: 'New tmux session' }).click()
      await expect(use).toHaveCount(1)
      await expect(use).toHaveAccessibleName(`Use ${name}-2 in ${dir}`)
      await page.getByRole('button', { name: 'Cancel' }).click()

      // On a phone the list sits above the name, which stays in view with
      // Create.
      await page.setViewportSize({ width: 375, height: 667 })
      await open(page)
      await page.getByRole('button', { name: 'Open sessions menu' }).click()
      await page.getByRole('button', { name: 'New tmux session' }).click()
      const nameField = page.getByLabel('Name', { exact: true })
      await expect(recent).toBeVisible()
      const listBox = (await recent.boundingBox())!
      expect(listBox.y).toBeLessThan((await nameField.boundingBox())!.y)
      await expect(nameField).toBeInViewport()
      await expect(page.getByRole('button', { name: 'Create' })).toBeInViewport()
      expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0)

      // Removed, on the server too.
      await dialog.getByRole('button', { name: `Remove ${name}-2 from recent` }).click()
      await expect(use).toHaveCount(0)
      expect((await recentGroups(request)).filter((g) => g.cwd === dir)).toEqual([])
      await open(page)
      await page.getByRole('button', { name: 'Open sessions menu' }).click()
      await page.getByRole('button', { name: 'New tmux session' }).click()
      await expect(page.getByLabel('Name', { exact: true })).toBeVisible()
      await expect(use).toHaveCount(0)
    } finally {
      await clearRecent(request, dir)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the menu of the last session in the sidebar shows whole, over the view', async ({
    page,
    request,
  }) => {
    const snap = await (await request.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.groups, 'the server cannot manage groups')
    // Enough sessions, in a short window, for the last one to sit low
    for (let i = 0; i < 4; i++) tmux('new-session', '-d', '-s', fresh('e2e-menu'), '-c', '/tmp')
    await page.setViewportSize({ width: 1280, height: 480 })
    await open(page)
    const last = page.locator('aside section').last()
    const button = last.getByRole('button', { name: /^Actions for tmux session / })
    await last.hover()
    await button.click()
    const menu = page.getByRole('menu', { name: (await button.getAttribute('aria-label'))! })
    await expect(menu).toBeInViewport({ ratio: 1 })
    // Wider than the sidebar, it covers the view instead of being cut
    const aside = (await page.locator('aside').boundingBox())!
    const box = (await menu.boundingBox())!
    expect(box.x + box.width).toBeGreaterThan(aside.x + aside.width)
    const list = page.locator('aside .scrollbar-hover')
    expect(await list.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0)
    // Scrolling the list under it closes it
    await list.evaluate((el) => el.dispatchEvent(new Event('scroll')))
    await expect(menu).toBeHidden()
  })
})
