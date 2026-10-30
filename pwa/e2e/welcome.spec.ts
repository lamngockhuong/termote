import { expect, type Page, test } from './fixtures'

// The welcome screen on a device's first visit: once, as a sheet on a phone
// and a dialog on desktop, in English or Vietnamese. Every other spec starts
// as a device that saw it (fixtures.ts, firstRunSeen).
test.use({ firstRunSeen: false })

const welcome = (page: Page) => page.getByTestId('welcome')

// The app is up: the first session list is in, so the screen has decided
async function appReady(page: Page) {
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
}

test.describe('welcome screen', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('desktop: once, as a dialog; Settings shows it again', async ({ page }) => {
    await page.goto('/')
    await expect(welcome(page)).toBeVisible({ timeout: 10000 })
    await expect(welcome(page)).toHaveAttribute('data-layout', 'dialog')
    await expect(page.getByRole('dialog', { name: 'Your terminal, in any browser.' })).toBeVisible()
    await expect(welcome(page)).toContainText('Your setup')
    await expect(welcome(page)).toContainText('Keys worth knowing')
    // Marked seen as it opened, not when it closes
    const seen = await page.evaluate(() => JSON.parse(localStorage.getItem('termote-settings') ?? '{}'))
    expect(seen.welcomeSeenVersion).toBeGreaterThan(0)
    await welcome(page).getByRole('button', { name: 'Close' }).click()
    await expect(welcome(page)).toBeHidden()

    await page.reload()
    await appReady(page)
    await page.waitForTimeout(500)
    await expect(welcome(page)).toBeHidden()

    await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('menuitem', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Data & help' }).click()
    await page.getByRole('button', { name: 'Show welcome screen' }).click()
    await expect(welcome(page)).toBeVisible()
  })

  test('EN | VI switches in place and is kept', async ({ page }) => {
    await page.goto('/')
    await expect(welcome(page)).toBeVisible({ timeout: 10000 })
    await welcome(page).getByRole('radio', { name: 'VI' }).click()
    await expect(page.getByRole('dialog', { name: 'Terminal của bạn, trên mọi trình duyệt.' })).toBeVisible()
    await expect(welcome(page)).toContainText('Bản cài của bạn')
    // The whole app with it
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi')
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('termote-settings') ?? '{}'))
    expect(saved.language).toBe('vi')
    // Picked now: no banner telling the device the app speaks it
    expect(saved.languageNoticeSeen).toBe(true)
    await welcome(page).getByRole('radio', { name: 'EN' }).click()
    await expect(page.getByRole('dialog', { name: 'Your terminal, in any browser.' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })
})

test.describe('welcome screen in a Vietnamese browser', () => {
  test.use({ locale: 'vi-VN', viewport: { width: 1280, height: 800 } })

  test('speaks Vietnamese at first', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('dialog', { name: 'Terminal của bạn, trên mọi trình duyệt.' })).toBeVisible({
      timeout: 10000,
    })
    await expect(welcome(page).getByRole('radio', { name: 'VI' })).toHaveAttribute('aria-checked', 'true')
  })
})

test.describe('welcome screen on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('a sheet with the gestures; Skip closes it', async ({ page }) => {
    await page.goto('/')
    await expect(welcome(page)).toBeVisible({ timeout: 10000 })
    await expect(welcome(page)).toHaveAttribute('data-layout', 'sheet')
    await expect(page.getByRole('dialog', { name: 'Your terminal, from this phone.' })).toBeVisible()
    await expect(welcome(page)).toContainText('Gestures')
    await expect(welcome(page)).toContainText('Can type')
    await welcome(page).getByRole('button', { name: 'Skip' }).click()
    await expect(welcome(page)).toBeHidden()
    // The old gesture overlay is gone
    await expect(page.getByRole('dialog', { name: 'Touch Gestures' })).toHaveCount(0)
  })
})

test.describe('welcome screen opened on a link', () => {
  test('waits for the next visit', async ({ page }) => {
    await page.goto('/')
    await appReady(page)
    // The pane on screen, as a link from a notification names it
    const hash = await page.evaluate(() => location.hash)
    test.skip(!hash.startsWith('#/s/'), 'the app writes no pane address here')
    const link = page.url()
    await page.evaluate(() => localStorage.clear())
    await page.goto('about:blank')
    await page.goto(link)
    await appReady(page)
    await page.waitForTimeout(500)
    await expect(welcome(page)).toBeHidden()
  })
})
