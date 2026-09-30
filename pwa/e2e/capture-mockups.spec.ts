import { join } from 'node:path'
import { expect, test } from '@playwright/test'

// Captures the redesign mockups (pwa/mockups, dev-only) for review. Needs the Vite
// dev server, not a termote server:
//   pnpm --filter termote exec vite --port 5173
//   MOCKUPS_OUT=<dir> pnpm --filter termote exec playwright test capture-mockups
// Where the PNGs go; the spec skips without it
const outDir = process.env.MOCKUPS_OUT
const baseUrl = process.env.MOCKUPS_URL || 'http://localhost:5173/mockups/'

const DIRECTIONS = ['a', 'b', 'c'] as const
const THEMES = ['dark', 'light'] as const
const SCREENS = [
  'm-terminal',
  'm-terminal-expanded',
  'm-sessions',
  'm-settings',
  'm-ime',
  'm-chat',
  'm-changes',
  'm-diff',
  'm-login',
  'm-viewonly',
  'desktop',
] as const

test.skip(!outDir, 'set MOCKUPS_OUT=<dir> to capture')

for (const dir of DIRECTIONS) {
  for (const theme of THEMES) {
    test(`mockup ${dir} ${theme}`, async ({ browser }) => {
      // deviceScaleFactor 2 keeps text sharp
      const context = await browser.newContext({
        viewport: { width: 2400, height: 1200 },
        deviceScaleFactor: 2,
        reducedMotion: 'reduce',
      })
      const page = await context.newPage()
      await page.goto(`${baseUrl}#${dir}-${theme}-all`)
      await expect(page.locator('[data-screen="desktop"]')).toBeVisible()
      for (const screen of SCREENS) {
        await page.locator(`[data-screen="${screen}"]`).screenshot({
          path: join(outDir as string, `mockup-${dir}-${screen}-${theme}.png`),
        })
      }
      await context.close()
    })
  }
}
