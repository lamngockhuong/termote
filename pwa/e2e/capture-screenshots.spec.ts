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
  test('mobile terminal view', async ({ browser }) => {
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

  test('keyboard toolbar', async ({ browser }) => {
    const context = await browser.newContext(mobileViewport)
    const page = await context.newPage()
    await page.goto('/')
    await waitForTerminal(page)

    const terminal = page.locator('.xterm-screen').first()
    if (await terminal.isVisible()) {
      await terminal.click({ force: true })
      await page.waitForTimeout(300)
    }

    await page.screenshot({
      path: join(screenshotsDir, 'keyboard-toolbar.png'),
      fullPage: false,
    })
    await context.close()
  })

  test('desktop view', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    })
    const page = await context.newPage()
    await page.goto('/')
    await waitForTerminal(page)

    await page.screenshot({
      path: join(screenshotsDir, 'desktop-terminal.png'),
      fullPage: false,
    })
    await context.close()
  })
})
