import { test } from '@playwright/test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const screenshotsDir = join(__dirname, '../../docs/images/screenshots')

const mobileViewport = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
}

async function waitForTerminal(page: import('@playwright/test').Page) {
  await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })
}

test.describe('Capture screenshots for README', () => {
  test('mobile terminal with toolbar', async ({ browser }) => {
    const context = await browser.newContext(mobileViewport)
    const page = await context.newPage()
    await page.goto('/')
    await waitForTerminal(page)

    await page.screenshot({
      path: join(screenshotsDir, 'mobile-terminal.png'),
      fullPage: false,
    })
    await context.close()
  })

  test('mobile with session sidebar', async ({ browser }) => {
    const context = await browser.newContext(mobileViewport)
    const page = await context.newPage()
    await page.goto('/')
    await waitForTerminal(page)

    // Open sidebar by clicking hamburger menu or swipe
    const menuButton = page.locator('button[aria-label="Toggle sidebar"]')
    if (await menuButton.isVisible()) {
      await menuButton.click()
    } else {
      // Try clicking the session area in header
      await page.click('header button').catch(() => {})
    }
    await page.waitForTimeout(300)

    await page.screenshot({
      path: join(screenshotsDir, 'mobile-sidebar.png'),
      fullPage: false,
    })
    await context.close()
  })
})
