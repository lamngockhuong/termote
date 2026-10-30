import { en } from '../src/i18n/messages/en'
import { vi } from '../src/i18n/messages/vi'
import { expect, type Locator, type Page, test } from './fixtures'

// The tour, started from Settings: a step per part of the app, lit where it
// really is, on a phone and on desktop, in English and Vietnamese.

async function openApp(page: Page) {
  await page.goto('/')
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
}

// The tour starts in Settings, in the app's language
async function startTour(page: Page, words: typeof en | typeof vi = en) {
  await page.getByRole('button', { name: words['shell.menu.more'] }).click()
  await page.getByRole('menuitem', { name: words['common.settings'] }).click()
  const data = page.getByRole('button', { name: words['settings.group.data'] })
  // Desktop picks the group in a rail; a phone stacks every group
  if (await data.isVisible()) await data.click()
  await page.getByRole('button', { name: words['settings.takeTour'] }).click()
  await expect(page.getByTestId('tour')).toBeVisible()
}

// The lit area holds the anchor, PAD (4px) around it, within 2px (polled:
// the area glides from one step to the next)
async function expectLit(page: Page, anchor: Locator) {
  await expect
    .poll(async () => {
      const lit = await page.getByTestId('tour-spotlight').boundingBox()
      const box = await anchor.boundingBox()
      if (!lit || !box) return Number.POSITIVE_INFINITY
      return Math.max(
        Math.abs(lit.x + 4 - box.x),
        Math.abs(lit.y + 4 - box.y),
        Math.abs(lit.width - 8 - box.width),
        Math.abs(lit.height - 8 - box.height),
      )
    })
    .toBeLessThanOrEqual(2)
}

// The bubble is on screen whole, 16px from each edge
async function expectInViewport(page: Page) {
  const bubble = await page.getByRole('dialog').boundingBox()
  const vp = page.viewportSize()
  expect(bubble && vp).toBeTruthy()
  if (!bubble || !vp) return
  expect(bubble.x).toBeGreaterThanOrEqual(15)
  expect(bubble.y).toBeGreaterThanOrEqual(15)
  expect(bubble.x + bubble.width).toBeLessThanOrEqual(vp.width - 15)
  expect(bubble.y + bubble.height).toBeLessThanOrEqual(vp.height - 15)
}

test.describe('tour on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('lights the session chip, the view menu, the keys and the terminal', async ({ page }) => {
    await openApp(page)
    await startTour(page)
    const bubble = page.getByRole('dialog')
    await expect(bubble).toHaveAccessibleName('Sessions and windows')
    // Focused, so a screen reader reads the step and keys reach it
    await expect(bubble).toBeFocused()
    await expectLit(page, page.locator('[data-tour="session-chip"]'))
    await expectInViewport(page)
    await bubble.getByRole('button', { name: 'Next' }).click()
    await expect(bubble).toHaveAccessibleName('One pane, five views')
    await expectLit(page, page.locator('[data-tour="view-menu"]'))
    // Only lit: the menu stays shut
    await expect(page.getByRole('menu')).toHaveCount(0)
    await bubble.getByRole('button', { name: 'Next' }).click()
    await expect(bubble).toHaveAccessibleName('Keys your phone lacks')
    await expectLit(page, page.locator('[data-tour="keyboard-toolbar"]'))
    await expectInViewport(page)
    await bubble.getByRole('button', { name: 'Next' }).click()
    await expect(bubble).toHaveAccessibleName('Gestures on the terminal')
    await expect(bubble).toContainText('4 / 4')
    await bubble.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByTestId('tour')).toBeHidden()
  })

  test('keeps the lit area on its element when the phone turns', async ({ page }) => {
    await openApp(page)
    await startTour(page)
    // Landscape on a small phone: still the phone layout (under 768px)
    await page.setViewportSize({ width: 667, height: 375 })
    await expectLit(page, page.locator('[data-tour="session-chip"]'))
    await expectInViewport(page)
  })
})

test.describe('tour on a phone in Vietnamese', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'vi-VN' })

  test('speaks Vietnamese', async ({ page }) => {
    await openApp(page)
    await startTour(page, vi)
    const bubble = page.getByRole('dialog')
    await expect(bubble).toHaveAccessibleName('Phiên và cửa sổ')
    await bubble.getByRole('button', { name: 'Tiếp' }).click()
    await expect(bubble).toHaveAccessibleName('Một pane, năm cách xem')
    await bubble.getByRole('button', { name: 'Bỏ qua' }).click()
    await expect(page.getByTestId('tour')).toBeHidden()
  })
})

test.describe('tour on desktop in Vietnamese', () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: 'vi-VN' })

  test('speaks Vietnamese', async ({ page }) => {
    await openApp(page)
    await startTour(page, vi)
    const bubble = page.getByRole('dialog')
    await expect(bubble).toHaveAccessibleName('Các phiên của bạn')
    await page.keyboard.press('ArrowRight')
    await expect(bubble).toHaveAccessibleName('Các cách xem và panel bên cạnh')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('tour')).toBeHidden()
  })
})

test.describe('tour on desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('goes by the keys and lights the views and the palette', async ({ page }) => {
    await openApp(page)
    await startTour(page)
    const bubble = page.getByRole('dialog')
    await expect(bubble).toHaveAccessibleName('Your sessions')
    await expectLit(page, page.locator('[data-tour="sidebar"]'))
    await page.keyboard.press('ArrowRight')
    await expect(bubble).toHaveAccessibleName('Views and the side panel')
    await page.keyboard.press('ArrowLeft')
    await expect(bubble).toHaveAccessibleName('Your sessions')
    await page.keyboard.press('Enter')
    await expect(bubble).toHaveAccessibleName('Views and the side panel')
    // The pane strip shows only with two panes: its step may be left out
    await page.keyboard.press('ArrowRight')
    if ((await bubble.textContent())?.includes('Windows and panes')) {
      await expectLit(page, page.locator('[data-tour="pane-strip"]'))
      await page.keyboard.press('ArrowRight')
    }
    await expect(bubble).toHaveAccessibleName('Everything, by name')
    await expectLit(page, page.locator('[data-tour="palette"]'))
    await expect(bubble).toContainText('Ctrl+Shift+P')
    await expectInViewport(page)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('tour')).toBeHidden()
  })

  test('leaves out the sidebar when it is collapsed', async ({ page }) => {
    await openApp(page)
    await page.getByRole('button', { name: /collapse sidebar/i }).click()
    await startTour(page)
    await expect(page.getByRole('dialog')).toHaveAccessibleName('Views and the side panel')
    await expect(page.getByRole('dialog')).toContainText('1 /')
  })
})
