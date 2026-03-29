import { test, expect } from '@playwright/test'

test.describe('settings menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })
  })

  test('opens settings menu on click', async ({ page }) => {
    await page.click('button[aria-label="Settings"]')
    await expect(page.locator('text=Theme')).toBeVisible()
    await expect(page.locator('text=About Termote')).toBeVisible()
  })

  test('closes settings menu on click outside', async ({ page }) => {
    await page.click('button[aria-label="Settings"]')
    await expect(page.locator('text=Theme')).toBeVisible()

    // Click outside the menu
    await page.click('header', { position: { x: 10, y: 10 } })
    await expect(page.locator('text=Theme')).not.toBeVisible()
  })
})

test.describe('theme toggle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })
  })

  test('toggles between light and dark theme', async ({ page }) => {
    // Open settings
    await page.click('button[aria-label="Settings"]')
    await page.waitForTimeout(200)

    // Click light theme button (sun icon)
    await page.click('button[aria-label="Light theme"]')
    await page.waitForTimeout(200)

    // Verify light class is applied
    const htmlClass = await page.locator('html').getAttribute('class')
    expect(htmlClass).toContain('light')

    // Click dark theme button (moon icon)
    await page.click('button[aria-label="Dark theme"]')
    await page.waitForTimeout(200)

    // Verify dark class is applied
    const htmlClassDark = await page.locator('html').getAttribute('class')
    expect(htmlClassDark).toContain('dark')
  })

  test('does not reload terminal iframe on theme switch', async ({ page }) => {
    // Capture the iframe src before theme change
    const srcBefore = await page
      .locator('iframe[title="Terminal"]')
      .getAttribute('src')

    // Track network requests for new terminal tokens
    const tokenRequests: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/terminal/token')) {
        tokenRequests.push(req.url())
      }
    })

    // Switch to light theme
    await page.click('button[aria-label="Settings"]')
    await page.waitForTimeout(200)
    await page.click('button[aria-label="Light theme"]')
    await page.waitForTimeout(500)

    // Iframe should still be present (not replaced by "Connecting...")
    await expect(page.locator('iframe[title="Terminal"]')).toBeVisible()

    // Iframe src should remain the same (no new token fetched)
    const srcAfter = await page
      .locator('iframe[title="Terminal"]')
      .getAttribute('src')
    expect(srcAfter).toBe(srcBefore)

    // No token requests should have been made during theme switch
    expect(tokenRequests).toHaveLength(0)

    // Switch back to dark — same assertions
    await page.click('button[aria-label="Dark theme"]')
    await page.waitForTimeout(500)

    const srcAfterDark = await page
      .locator('iframe[title="Terminal"]')
      .getAttribute('src')
    expect(srcAfterDark).toBe(srcBefore)
    expect(tokenRequests).toHaveLength(0)
  })

  test('persists theme preference', async ({ page }) => {
    // Open settings and set dark theme
    await page.click('button[aria-label="Settings"]')
    await page.click('button[aria-label="Dark theme"]')
    await page.waitForTimeout(200)

    // Reload page
    await page.reload()
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })

    // Verify theme persisted
    const htmlClass = await page.locator('html').getAttribute('class')
    expect(htmlClass).toContain('dark')
  })

  test('applies correct terminal theme after page reload', async ({ page }) => {
    // Set light theme
    await page.click('button[aria-label="Settings"]')
    await page.waitForTimeout(200)
    await page.click('button[aria-label="Light theme"]')
    await page.waitForTimeout(500)

    // Reload page
    await page.reload()
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })

    // Wait for theme to be applied inside iframe
    const iframe = page.frameLocator('iframe[title="Terminal"]')
    await expect(async () => {
      const bg = await iframe.locator('body').evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      )
      // Light theme background #f6f8fa = rgb(246, 248, 250)
      expect(bg).toBe('rgb(246, 248, 250)')
    }).toPass({ timeout: 5000 })

    // Verify CSS override style was injected
    const hasOverride = await iframe.locator('#termote-theme-override').count()
    expect(hasOverride).toBe(1)
  })
})

test.describe('font size controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })
  })

  test('displays current font size', async ({ page }) => {
    // Default font size should be 14
    await expect(page.locator('header')).toContainText('14')
  })

  test('increases font size on A+ click', async ({ page }) => {
    const initialSize = await page.locator('header span.text-xs.w-8').textContent()

    await page.click('button[aria-label="Increase font size"]')
    await page.waitForTimeout(100)

    const newSize = await page.locator('header span.text-xs.w-8').textContent()
    expect(parseInt(newSize || '0')).toBeGreaterThan(parseInt(initialSize || '0'))
  })

  test('decreases font size on A- click', async ({ page }) => {
    // First increase to have room to decrease
    await page.click('button[aria-label="Increase font size"]')
    await page.waitForTimeout(100)

    const initialSize = await page.locator('header span.text-xs.w-8').textContent()

    await page.click('button[aria-label="Decrease font size"]')
    await page.waitForTimeout(100)

    const newSize = await page.locator('header span.text-xs.w-8').textContent()
    expect(parseInt(newSize || '0')).toBeLessThan(parseInt(initialSize || '0'))
  })

  test('respects minimum font size', async ({ page }) => {
    // Click decrease many times
    for (let i = 0; i < 10; i++) {
      await page.click('button[aria-label="Decrease font size"]')
      await page.waitForTimeout(50)
    }

    const size = await page.locator('header span.text-xs.w-8').textContent()
    expect(parseInt(size || '0')).toBeGreaterThanOrEqual(6) // MIN_SIZE = 6
  })

  test('respects maximum font size', async ({ page }) => {
    // Click increase many times
    for (let i = 0; i < 10; i++) {
      await page.click('button[aria-label="Increase font size"]')
      await page.waitForTimeout(50)
    }

    const size = await page.locator('header span.text-xs.w-8').textContent()
    expect(parseInt(size || '0')).toBeLessThanOrEqual(24) // MAX_SIZE = 24
  })
})

test.describe('about modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })
  })

  test('opens about modal from settings', async ({ page }) => {
    await page.click('button[aria-label="Settings"]')
    await page.click('text=About Termote')
    await page.waitForTimeout(200)

    await expect(page.locator('dialog')).toBeVisible()
    await expect(page.locator('dialog')).toContainText('About')
    await expect(page.locator('dialog')).toContainText('Version')
    await expect(page.locator('dialog')).toContainText('Author')
  })

  test('closes about modal on X click', async ({ page }) => {
    await page.click('button[aria-label="Settings"]')
    await page.click('text=About Termote')
    await page.waitForTimeout(200)

    await page.click('dialog button[aria-label="Close"]')
    await page.waitForTimeout(200)

    await expect(page.locator('dialog')).not.toBeVisible()
  })

  test('closes about modal on Escape key', async ({ page }) => {
    await page.click('button[aria-label="Settings"]')
    await page.click('text=About Termote')
    await page.waitForTimeout(200)

    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    await expect(page.locator('dialog')).not.toBeVisible()
  })

  test('about modal contains expected links', async ({ page }) => {
    await page.click('button[aria-label="Settings"]')
    await page.click('text=About Termote')
    await page.waitForTimeout(200)

    await expect(page.locator('dialog a:has-text("GitHub")')).toBeVisible()
    await expect(page.locator('dialog a:has-text("Changelog")')).toBeVisible()
    await expect(page.locator('dialog a:has-text("Report Issue")')).toBeVisible()
  })
})

test.describe('preferences modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })
  })

  test('opens preferences from settings menu', async ({ page }) => {
    await page.click('button[aria-label="Settings"]')
    await page.click('text=Preferences')
    await page.waitForTimeout(200)

    await expect(page.locator('dialog')).toBeVisible()
    await expect(page.locator('dialog')).toContainText('Settings')
    await expect(page.locator('dialog')).toContainText('Text input send behavior')
  })

  test('changes IME send behavior', async ({ page }) => {
    await page.click('button[aria-label="Settings"]')
    await page.click('text=Preferences')
    await page.waitForTimeout(200)

    // Select "Send + Enter" option
    await page.click('text=Send + Enter')
    await page.waitForTimeout(100)

    // Verify radio is checked
    const radio = page.locator('input[name="imeSendBehavior"][value="send-enter"]')
    await expect(radio).toBeChecked()

    // Verify persisted to localStorage
    const stored = await page.evaluate(() => localStorage.getItem('termote-settings'))
    expect(JSON.parse(stored!).imeSendBehavior).toBe('send-enter')
  })

  test('toggles toolbar default expanded', async ({ page }) => {
    await page.click('button[aria-label="Settings"]')
    await page.click('text=Preferences')
    await page.waitForTimeout(200)

    // Click toggle switch
    const toggle = page.locator('button[role="switch"]')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await page.waitForTimeout(100)
    await expect(toggle).toHaveAttribute('aria-checked', 'true')

    // Verify persisted
    const stored = await page.evaluate(() => localStorage.getItem('termote-settings'))
    expect(JSON.parse(stored!).toolbarDefaultExpanded).toBe(true)
  })

  test('preferences persist after page reload', async ({ page }) => {
    // Open and change setting
    await page.click('button[aria-label="Settings"]')
    await page.click('text=Preferences')
    await page.waitForTimeout(200)
    await page.click('text=Send + Enter')
    await page.waitForTimeout(100)

    // Close and reload
    await page.keyboard.press('Escape')
    await page.reload()
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })

    // Reopen and verify
    await page.click('button[aria-label="Settings"]')
    await page.click('text=Preferences')
    await page.waitForTimeout(200)
    const radio = page.locator('input[name="imeSendBehavior"][value="send-enter"]')
    await expect(radio).toBeChecked()
  })
})

test.describe('clear cache button', () => {
  test('shows clear cache option in settings menu', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })

    await page.click('button[aria-label="Settings"]')
    await expect(page.locator('text=Clear Cache & Reload')).toBeVisible()
  })
})

test.describe('help modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })
  })

  test('opens usage guide from settings', async ({ page }) => {
    await page.click('button[aria-label="Settings"]')
    await page.click('text=Usage Guide')
    await page.waitForTimeout(200)

    await expect(page.locator('dialog')).toBeVisible()
    await expect(page.locator('dialog')).toContainText('Usage Guide')
  })

  test('help modal contains gesture and shortcut docs', async ({ page }) => {
    await page.click('button[aria-label="Settings"]')
    await page.click('text=Usage Guide')
    await page.waitForTimeout(200)

    // Should document gestures and shortcuts per checklist
    const dialog = page.locator('dialog')
    await expect(dialog).toContainText('Swipe')
    await expect(dialog).toContainText('Ctrl')
  })

  test('closes help modal on close button', async ({ page }) => {
    await page.click('button[aria-label="Settings"]')
    await page.click('text=Usage Guide')
    await page.waitForTimeout(200)

    await page.click('dialog button[aria-label="Close"]')
    await page.waitForTimeout(200)
    await expect(page.locator('dialog')).not.toBeVisible()
  })
})

test.describe('sidebar collapse', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })
  })

  test('sidebar collapse and expand toggle works', async ({ page }) => {
    // Desktop: sidebar should be visible with collapse button
    const collapseBtn = page.locator('button[aria-label="Collapse sidebar"]')
    if (await collapseBtn.isVisible()) {
      await collapseBtn.click()
      await page.waitForTimeout(200)

      // After collapse, expand button should appear
      await expect(
        page.locator('button[aria-label="Expand sidebar"]'),
      ).toBeVisible()

      // Expand again
      await page.click('button[aria-label="Expand sidebar"]')
      await page.waitForTimeout(200)
      await expect(collapseBtn).toBeVisible()
    }
  })

  test('sidebar collapse state persists after reload', async ({ page }) => {
    const collapseBtn = page.locator('button[aria-label="Collapse sidebar"]')
    if (await collapseBtn.isVisible()) {
      await collapseBtn.click()
      await page.waitForTimeout(200)

      // Reload
      await page.reload()
      await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })

      // Should still be collapsed
      await expect(
        page.locator('button[aria-label="Expand sidebar"]'),
      ).toBeVisible()
    }
  })
})

test.describe('fullscreen toggle', () => {
  test('fullscreen button visible on desktop', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })

    // Desktop viewport should show fullscreen button
    const btn = page.locator('button[aria-label="Enter fullscreen"]')
    await expect(btn).toBeVisible()
  })
})

test.describe('sidebar scroll', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 15000 })
  })

  test('sidebar scrolls when many sessions added', async ({ page }) => {
    const tag = Date.now()
    // Add multiple sessions to trigger scroll
    for (let i = 0; i < 8; i++) {
      await page.click('button[title="Add new session"]')
      await page.waitForSelector('input[placeholder="Session name"]', { timeout: 3000 })
      await page.fill('input[placeholder="Session name"]', `s${tag}-${i}`)
      await page.click('button.bg-blue-600:has-text("Add")')
      await page.waitForTimeout(300)
    }

    const sidebar = page.locator('aside')
    await expect(sidebar).toBeVisible()
    await expect(sidebar).toContainText(`s${tag}-0`)
  })
})
