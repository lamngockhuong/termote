import { expect, type Page, test } from './fixtures'

// The installed app's badge counts the agents waiting on you. The Badging
// API is stubbed (a test browser installs no app), and an agent is made
// blocked in the snapshot the page reads.

type BadgeWindow = { __badgeCalls: number[] }

const lastBadge = (page: Page) =>
  page.evaluate(() => (window as unknown as BadgeWindow).__badgeCalls.at(-1))

test('counts a blocked agent on the app icon, and clears it', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: number[] = []
    ;(window as unknown as BadgeWindow).__badgeCalls = calls
    Object.defineProperty(navigator, 'setAppBadge', {
      configurable: true,
      value: async (n: number) => {
        calls.push(n)
      },
    })
    Object.defineProperty(navigator, 'clearAppBadge', {
      configurable: true,
      value: async () => {
        calls.push(0)
      },
    })
  })
  let blocked = true
  await page.route(/\/api\/mux\/snapshot(\?|$)/, async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    const pane = body.groups?.[0]?.tabs?.[0]?.panes?.[0]
    if (blocked && pane) pane.agent = { name: 'claude', status: 'blocked' }
    await route.fulfill({ response: res, json: body })
  })
  await page.goto('/')
  await expect.poll(() => lastBadge(page), { timeout: 15000 }).toBe(1)
  // The agent answered: the next poll clears it
  blocked = false
  await expect.poll(() => lastBadge(page), { timeout: 15000 }).toBe(0)
})
