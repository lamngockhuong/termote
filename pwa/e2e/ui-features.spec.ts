import { test, expect } from '@playwright/test'

test.describe('settings menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
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
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
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

  test('does not reconnect the terminal on theme switch', async ({ page }) => {
    await page.waitForSelector('[aria-label="Connected"]', { timeout: 10000 })
    // Any new stream token or WebSocket means the terminal was reopened
    const reopened: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/mux/stream-token')) reopened.push(req.url())
    })
    page.on('websocket', (ws) => reopened.push(ws.url()))

    await page.click('button[aria-label="Settings"]')
    await page.waitForTimeout(200)
    await page.click('button[aria-label="Light theme"]')
    await page.waitForTimeout(500)
    await expect(page.locator('[data-testid="terminal-view"] .xterm')).toBeVisible()

    await page.click('button[aria-label="Dark theme"]')
    await page.waitForTimeout(500)
    expect(reopened).toHaveLength(0)
  })

  test('persists theme preference', async ({ page }) => {
    // Open settings and set dark theme
    await page.click('button[aria-label="Settings"]')
    await page.click('button[aria-label="Dark theme"]')
    await page.waitForTimeout(200)

    // Reload page
    await page.reload()
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })

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
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })

    // xterm.js paints its scroll area with the theme background
    await expect(async () => {
      const bg = await page
        .locator('[data-testid="terminal-view"] .xterm-scrollable-element')
        .evaluate((el) => getComputedStyle(el).backgroundColor)
      // --tm-term-bg of the default (neutral) style in light: #fcfcfd
      expect(bg).toBe('rgb(252, 252, 253)')
    }).toPass({ timeout: 5000 })
  })
})

test.describe('ui style', () => {
  // [style, --tm-bg in dark, --tm-term-bg in dark]
  const styles = [
    ['terminal', 'rgb(12, 14, 13)', 'rgb(12, 14, 13)'],
    ['native', 'rgb(0, 0, 0)', 'rgb(11, 11, 12)'],
    ['neutral', 'rgb(9, 9, 11)', 'rgb(12, 12, 14)'],
  ] as const

  for (const [style, bg, termBg] of styles) {
    test(`applies the saved ${style} style before the app runs`, async ({ page }) => {
      await page.addInitScript((s) => {
        localStorage.setItem('termote-theme', 'dark')
        localStorage.setItem('termote-settings', JSON.stringify({ uiStyle: s }))
      }, style)
      // With every app script blocked, only the inline script in index.html can set the style.
      await page.route('**/*', (route) =>
        route.request().resourceType() === 'script' ? route.abort() : route.continue(),
      )
      await page.goto('/')
      await expect(page.locator('html')).toHaveAttribute('data-ui-style', style)
    })

    test(`paints the chrome, terminal and theme-color in the ${style} style`, async ({ page }) => {
      await page.addInitScript((s) => {
        localStorage.setItem('termote-theme', 'dark')
        localStorage.setItem('termote-settings', JSON.stringify({ uiStyle: s }))
      }, style)
      await page.goto('/')
      await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(bg)
      await expect(async () => {
        const term = await page
          .locator('[data-testid="terminal-view"] .xterm-scrollable-element')
          .evaluate((el) => getComputedStyle(el).backgroundColor)
        expect(term).toBe(termBg)
      }).toPass({ timeout: 5000 })
      const themeColor = await page.locator('meta[name="theme-color"]').first().getAttribute('content')
      expect(themeColor).toBe(
        await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tm-bg').trim()),
      )
    })
  }

  test('opens a config without uiStyle in the neutral style', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('termote-settings', JSON.stringify({ pollInterval: 5 }))
    })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'neutral')
  })
})

test.describe('terminal stream', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', {
      timeout: 10000,
    })
    // Keys typed before the stream opens are dropped; ConPTY attaches slower
    await page.waitForSelector('[aria-label="Connected"]', { timeout: 15000 })
  })

  const rows = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="terminal-view"] .xterm-rows')

  test('runs a typed command and shows its output', async ({ page }) => {
    await page.locator('[data-testid="terminal-view"] .xterm').click()
    await page.keyboard.type('echo termote-$((40+2))')
    await page.keyboard.press('Enter')
    await expect(rows(page)).toContainText('termote-42', { timeout: 10000 })
  })

  test('reconnects after the network comes back', async ({ page, context }) => {
    await page.waitForSelector('[aria-label="Connected"]', { timeout: 10000 })
    await context.setOffline(true)
    await expect(page.locator('[aria-label="Connected"]')).toHaveCount(0, {
      timeout: 10000,
    })
    await context.setOffline(false)
    await page.waitForSelector('[aria-label="Connected"]', { timeout: 15000 })

    await page.locator('[data-testid="terminal-view"] .xterm').click()
    await page.keyboard.type('echo back-$((1+1))')
    await page.keyboard.press('Enter')
    await expect(rows(page)).toContainText('back-2', { timeout: 10000 })
  })

  test('resizing the window sends the new size to the server', async ({ page }) => {
    // Other workers attach to the same shared tmux window and its size follows
    // the latest client, so the check reads what this client sends; the Go
    // stream tests cover the server applying it to the PTY.
    const sizes: number[] = []
    page.on('websocket', (ws) => {
      // The opening size travels in the URL, later ones as resize messages
      const cols = new URL(ws.url()).searchParams.get('cols')
      if (cols) sizes.push(Number(cols))
      ws.on('framesent', ({ payload }) => {
        if (typeof payload !== 'string') return
        try {
          const msg = JSON.parse(payload)
          if (msg.type === 'resize') sizes.push(msg.cols)
        } catch {
          // terminal input, not a control message
        }
      })
    })
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.reload()
    await page.waitForSelector('[aria-label="Connected"]', { timeout: 15000 })
    await expect.poll(() => sizes.length, { timeout: 10000 }).toBeGreaterThan(0)
    const wide = sizes[sizes.length - 1]

    await page.setViewportSize({ width: 700, height: 720 })
    await expect.poll(() => sizes[sizes.length - 1], { timeout: 10000 }).toBeLessThan(wide)
  })

  test('prompt has no leaked terminal query replies', async ({ page }) => {
    // Give tmux time to query the terminal and draw the prompt
    await page.waitForTimeout(1500)
    const text = await rows(page).innerText()
    expect(text).not.toMatch(/\d+;\d+(;\d+)*c|\[\?\d/)
  })
})

test.describe('font size controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
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
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
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
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
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

    // Click the first toggle switch (toolbar default expanded)
    const toggle = page.locator('button[role="switch"]').first()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await page.waitForTimeout(100)
    await expect(toggle).toHaveAttribute('aria-checked', 'true')

    // Verify persisted
    const stored = await page.evaluate(() => localStorage.getItem('termote-settings'))
    expect(JSON.parse(stored!).toolbarDefaultExpanded).toBe(true)
  })

  test('toggles disable context menu', async ({ page }) => {
    await page.click('button[aria-label="Settings"]')
    await page.click('text=Preferences')
    await page.waitForTimeout(200)

    // Second toggle is "Disable right-click menu" (default: true)
    const toggle = page.locator('button[role="switch"]').nth(1)
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await page.waitForTimeout(100)
    await expect(toggle).toHaveAttribute('aria-checked', 'false')

    // Verify persisted
    const stored = await page.evaluate(() => localStorage.getItem('termote-settings'))
    expect(JSON.parse(stored!).disableContextMenu).toBe(false)
  })

  test('disable context menu setting persists after reload', async ({ page }) => {
    // Disable context menu blocking
    await page.click('button[aria-label="Settings"]')
    await page.click('text=Preferences')
    await page.waitForTimeout(200)
    const toggle = page.locator('button[role="switch"]').nth(1)
    await toggle.click()
    await page.waitForTimeout(100)

    // Reload
    await page.keyboard.press('Escape')
    await page.reload()
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })

    // Reopen and verify
    await page.click('button[aria-label="Settings"]')
    await page.click('text=Preferences')
    await page.waitForTimeout(200)
    const toggleAfter = page.locator('button[role="switch"]').nth(1)
    await expect(toggleAfter).toHaveAttribute('aria-checked', 'false')
  })

  test('changes poll interval', async ({ page }) => {
    await page.click('button[aria-label="Settings"]')
    await page.click('text=Preferences')
    await page.waitForTimeout(200)

    // Change poll interval to 30s
    const select = page.locator('select')
    await select.selectOption('30')
    await page.waitForTimeout(100)

    // Verify persisted to localStorage
    const stored = await page.evaluate(() => localStorage.getItem('termote-settings'))
    expect(JSON.parse(stored!).pollInterval).toBe(30)
  })

  test('poll interval persists after reload', async ({ page }) => {
    await page.click('button[aria-label="Settings"]')
    await page.click('text=Preferences')
    await page.waitForTimeout(200)

    // Set to 60 (1m)
    await page.locator('select').selectOption('60')
    await page.waitForTimeout(100)

    // Reload
    await page.keyboard.press('Escape')
    await page.reload()
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })

    // Reopen and verify
    await page.click('button[aria-label="Settings"]')
    await page.click('text=Preferences')
    await page.waitForTimeout(200)
    await expect(page.locator('select')).toHaveValue('60')
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
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })

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
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })

    await page.click('button[aria-label="Settings"]')
    await expect(page.locator('text=Clear Cache & Reload')).toBeVisible()
  })
})

test.describe('help modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
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
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
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
      await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })

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
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })

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
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
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
