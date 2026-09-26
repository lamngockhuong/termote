import { test, type TestInfo } from '@playwright/test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const screenshotsDir = join(__dirname, '../../docs/images/screenshots')

// browser.newContext() does not inherit the config's `use`, so pass the
// credentials on, or an auth-enabled server only shows its 401 page.
const mobileContext = (testInfo: TestInfo) => ({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  httpCredentials: testInfo.project.use.httpCredentials,
})

async function waitForTerminal(page: import('@playwright/test').Page) {
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
  // A fresh mobile context always opens the first-run gesture hints
  await page.getByRole('button', { name: 'Got it' }).click()
}

test.describe('Capture screenshots for README', () => {
  test('mobile terminal with toolbar', async ({ browser }, testInfo) => {
    const context = await browser.newContext(mobileContext(testInfo))
    const page = await context.newPage()
    await page.goto('/')
    await waitForTerminal(page)

    await page.screenshot({
      path: join(screenshotsDir, 'mobile-terminal.png'),
      fullPage: false,
    })
    await context.close()
  })

  test('mobile with session sidebar', async ({ browser }, testInfo) => {
    const context = await browser.newContext(mobileContext(testInfo))
    const page = await context.newPage()
    await page.goto('/')
    await waitForTerminal(page)

    // The mobile bottom navigation opens the sessions panel
    await page.getByRole('button', { name: 'Toggle sessions panel' }).click()
    await page.waitForTimeout(300)

    await page.screenshot({
      path: join(screenshotsDir, 'mobile-sidebar.png'),
      fullPage: false,
    })
    await context.close()
  })
})
