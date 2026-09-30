import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, type Page, type TestInfo, test } from '@playwright/test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const screenshotsDir = join(__dirname, '../../docs/images/screenshots')

type UiStyle = 'terminal' | 'native' | 'neutral'

// browser.newContext() does not inherit the config's `use`, so pass the
// credentials on, or an auth-enabled server only shows its 401 page.
const mobileContext = (testInfo: TestInfo) => ({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark' as const,
  httpCredentials: testInfo.project.use.httpCredentials,
})

// Opens the app in a fresh context with the given style saved, the gesture
// hints already seen so no overlay covers the screen.
async function openApp(
  browser: Browser,
  testInfo: TestInfo,
  style: UiStyle = 'neutral',
  context = mobileContext(testInfo),
): Promise<Page> {
  const ctx = await browser.newContext(context)
  await ctx.addInitScript((s) => {
    localStorage.setItem('termote-theme', 'dark')
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ uiStyle: s, hasSeenGestureHints: true }),
    )
  }, style)
  const page = await ctx.newPage()
  await page.goto('/')
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
  // The stream is open once the shell has drawn its prompt
  await page.waitForFunction(
    () => (document.querySelector('.xterm-rows') as HTMLElement | null)?.innerText.trim(),
    undefined,
    { timeout: 15000 },
  )
  await page.waitForTimeout(500)
  return page
}

test.describe('Capture screenshots for README', () => {
  test('mobile terminal with toolbar', async ({ browser }, testInfo) => {
    const page = await openApp(browser, testInfo)
    await page.screenshot({ path: join(screenshotsDir, 'mobile-terminal.png') })
    await page.context().close()
  })

  test('mobile with session sidebar', async ({ browser }, testInfo) => {
    const page = await openApp(browser, testInfo)
    // The session chip in the header opens the sessions panel
    await page.getByRole('button', { name: 'Open sessions menu' }).click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(screenshotsDir, 'mobile-sidebar.png') })
    await page.context().close()
  })

  test('desktop terminal', async ({ browser }, testInfo) => {
    const page = await openApp(browser, testInfo, 'neutral', {
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: false,
      colorScheme: 'dark',
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    await page.screenshot({ path: join(screenshotsDir, 'desktop-terminal.png') })
    await page.context().close()
  })

  test('the three interface styles side by side', async ({ browser }, testInfo) => {
    const shots: { style: UiStyle; data: string }[] = []
    for (const style of ['terminal', 'native', 'neutral'] as const) {
      const page = await openApp(browser, testInfo, style)
      const buf = await page.screenshot()
      shots.push({ style, data: buf.toString('base64') })
      await page.context().close()
    }

    // Lay the three captures out on one page and capture that
    const ctx = await browser.newContext({
      viewport: { width: 1230, height: 900 },
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    const label = (s: string) => s[0].toUpperCase() + s.slice(1)
    await page.setContent(`<!doctype html>
      <body style="margin:0;background:#18181b;font:600 16px system-ui;color:#e4e4e7">
        <div style="display:flex;gap:30px;padding:10px 20px">
          ${shots
            .map(
              (s) => `<figure style="margin:0;text-align:center">
                <img src="data:image/png;base64,${s.data}" style="width:370px;border-radius:14px;display:block">
                <figcaption style="margin-top:8px">${label(s.style)}</figcaption>
              </figure>`,
            )
            .join('')}
        </div>
      </body>`)
    await page.screenshot({ path: join(screenshotsDir, 'ui-styles.png'), fullPage: true })
    await ctx.close()
  })
})
