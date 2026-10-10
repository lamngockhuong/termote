import { expect, type Page, test } from './fixtures'

const waitForTerminal = (page: Page, timeout = 10000) =>
  page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout })

// The header's overflow menu holds the theme, the dialogs and the cache reset
const openMenu = (page: Page) => page.getByRole('button', { name: 'More' }).click()

const openFromMenu = async (page: Page, item: string) => {
  await openMenu(page)
  await page.getByRole('menuitem', { name: item }).click()
}

// On desktop the settings dialog shows one group at a time
const openSettingsGroup = async (page: Page, group: string) => {
  await openFromMenu(page, 'Settings')
  await page
    .getByRole('navigation', { name: 'Settings groups' })
    .getByRole('button', { name: group })
    .click()
}

const storedSettings = async (page: Page) =>
  JSON.parse((await page.evaluate(() => localStorage.getItem('termote-settings')))!)

const reloadFresh = async (page: Page) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await waitForTerminal(page)
}

test.describe('overflow menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForTerminal(page)
  })

  test('opens the menu on click', async ({ page }) => {
    await openMenu(page)
    await expect(page.getByRole('menu', { name: 'More' })).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'About' })).toBeVisible()
  })

  test('closes the menu on click outside', async ({ page }) => {
    await openMenu(page)
    await expect(page.getByRole('menu', { name: 'More' })).toBeVisible()
    await page.click('header', { position: { x: 10, y: 10 } })
    await expect(page.getByRole('menu', { name: 'More' })).toBeHidden()
  })
})

test.describe('theme toggle', () => {
  test.beforeEach(async ({ page }) => {
    await reloadFresh(page)
  })

  const pickTheme = async (page: Page, name: 'Light' | 'Dark') => {
    if (!(await page.getByRole('menu', { name: 'More' }).isVisible())) await openMenu(page)
    await page.getByRole('menuitemradio', { name }).click()
  }

  test('toggles between light and dark theme', async ({ page }) => {
    await pickTheme(page, 'Light')
    await expect(page.locator('html')).toHaveClass(/light/)
    await pickTheme(page, 'Dark')
    await expect(page.locator('html')).toHaveClass(/dark/)
  })

  test('does not reconnect the terminal on theme switch', async ({ page }) => {
    await page.waitForSelector('[aria-label="Connected"]', { timeout: 10000 })
    // Any new stream token or WebSocket means the terminal was reopened
    const reopened: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/mux/stream-token')) reopened.push(req.url())
    })
    page.on('websocket', (ws) => reopened.push(ws.url()))

    await pickTheme(page, 'Light')
    await page.waitForTimeout(500)
    await expect(page.locator('[data-testid="terminal-view"] .xterm')).toBeVisible()
    await pickTheme(page, 'Dark')
    await page.waitForTimeout(500)
    expect(reopened).toHaveLength(0)
  })

  test('persists theme preference', async ({ page }) => {
    await pickTheme(page, 'Dark')
    await page.reload()
    await waitForTerminal(page)
    await expect(page.locator('html')).toHaveClass(/dark/)
  })

  test('applies correct terminal theme after page reload', async ({ page }) => {
    await pickTheme(page, 'Light')
    await page.waitForTimeout(300)
    await page.reload()
    await waitForTerminal(page)

    // xterm.js paints its scroll area with the theme background
    await expect(async () => {
      const bg = await page
        .locator('[data-testid="terminal-view"] .xterm-scrollable-element')
        .evaluate((el) => getComputedStyle(el).backgroundColor)
      // --tm-term-bg of the default (neutral) style in light: #f7f7f8
      expect(bg).toBe('rgb(247, 247, 248)')
    }).toPass({ timeout: 5000 })
  })
})

test.describe('ui style', () => {
  // [style, --tm-bg in dark, --tm-term-bg in dark]
  const styles = [
    ['terminal', 'rgb(15, 17, 16)', 'rgb(15, 17, 16)'],
    ['native', 'rgb(18, 18, 20)', 'rgb(11, 11, 12)'],
    ['neutral', 'rgb(26, 26, 29)', 'rgb(12, 12, 14)'],
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


test.describe('ui style setting', () => {
  test('picking a style in Settings applies at once and survives a reload', async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.clear()
        localStorage.setItem('termote-theme', 'dark')
        sessionStorage.setItem('seeded', '1')
      }
    })
    await page.goto('/')
    await waitForTerminal(page)
    await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'neutral')

    await openSettingsGroup(page, 'Appearance')
    await page
      .getByRole('radiogroup', { name: 'Interface style' })
      .getByRole('radio', { name: 'Terminal' })
      .click()
    await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'terminal')
    expect((await storedSettings(page)).uiStyle).toBe('terminal')

    await page.keyboard.press('Escape')
    await page.reload()
    await waitForTerminal(page)
    await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'terminal')
    // --tm-bg of the terminal style in dark
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      'rgb(15, 17, 16)',
    )
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
    await reloadFresh(page)
  })

  const fontSize = async (page: Page) =>
    Number.parseInt((await page.getByTestId('font-size').textContent()) || '0', 10)

  test('displays current font size', async ({ page }) => {
    // Default font size should be 14
    await expect(page.getByTestId('font-size')).toHaveText('14')
  })

  test('increases font size on A+ click', async ({ page }) => {
    const initialSize = await fontSize(page)
    await page.getByRole('button', { name: 'Increase font size' }).click()
    await expect.poll(() => fontSize(page)).toBeGreaterThan(initialSize)
  })

  test('decreases font size on A- click', async ({ page }) => {
    // First increase to have room to decrease
    await page.getByRole('button', { name: 'Increase font size' }).click()
    await expect.poll(() => fontSize(page)).toBeGreaterThan(14)
    const initialSize = await fontSize(page)
    await page.getByRole('button', { name: 'Decrease font size' }).click()
    await expect.poll(() => fontSize(page)).toBeLessThan(initialSize)
  })

  test('respects minimum font size', async ({ page }) => {
    for (let i = 0; i < 10; i++) {
      await page.getByRole('button', { name: 'Decrease font size' }).click()
    }
    expect(await fontSize(page)).toBeGreaterThanOrEqual(6) // MIN_SIZE = 6
  })

  test('respects maximum font size', async ({ page }) => {
    for (let i = 0; i < 10; i++) {
      await page.getByRole('button', { name: 'Increase font size' }).click()
    }
    expect(await fontSize(page)).toBeLessThanOrEqual(24) // MAX_SIZE = 24
  })
})

test.describe('about sheet', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForTerminal(page)
    await openFromMenu(page, 'About')
  })

  test('opens from the menu', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'About Termote' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Version')
    await expect(dialog).toContainText('Author')
  })

  test('closes on the close button', async ({ page }) => {
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('closes on Escape', async ({ page }) => {
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('contains the expected links', async ({ page }) => {
    const dialog = page.getByRole('dialog')
    for (const name of ['GitHub', 'Changelog', 'Report Issue']) {
      await expect(dialog.getByRole('link', { name })).toBeVisible()
    }
  })
})

test.describe('settings sheet', () => {
  test.beforeEach(async ({ page }) => {
    await reloadFresh(page)
  })

  const imeRadio = (page: Page) => page.getByRole('radio', { name: 'Send + Enter' })

  test('opens from the menu', async ({ page }) => {
    await openFromMenu(page, 'Settings')
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('navigation', { name: 'Settings groups' })).toBeVisible()
  })

  test('changes IME send behavior', async ({ page }) => {
    await openSettingsGroup(page, 'Keyboard')
    await imeRadio(page).click()
    await expect(imeRadio(page)).toHaveAttribute('aria-checked', 'true')
    expect((await storedSettings(page)).imeSendBehavior).toBe('send-enter')
  })

  test('toggles toolbar default expanded', async ({ page }) => {
    await openSettingsGroup(page, 'Keyboard')
    const toggle = page.getByRole('switch', { name: 'Toolbar default expanded' })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect((await storedSettings(page)).toolbarDefaultExpanded).toBe(true)
  })

  test('toggles disable context menu', async ({ page }) => {
    await openSettingsGroup(page, 'Terminal')
    const toggle = page.getByRole('switch', { name: 'Disable right-click menu' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect((await storedSettings(page)).disableContextMenu).toBe(false)
  })

  test('disable context menu setting persists after reload', async ({ page }) => {
    await openSettingsGroup(page, 'Terminal')
    await page.getByRole('switch', { name: 'Disable right-click menu' }).click()
    await page.keyboard.press('Escape')
    await page.reload()
    await waitForTerminal(page)

    await openSettingsGroup(page, 'Terminal')
    await expect(
      page.getByRole('switch', { name: 'Disable right-click menu' }),
    ).toHaveAttribute('aria-checked', 'false')
  })

  test('changes poll interval', async ({ page }) => {
    await openSettingsGroup(page, 'Sessions')
    await page.getByRole('combobox', { name: 'Session poll interval' }).selectOption('30')
    await expect.poll(async () => (await storedSettings(page)).pollInterval).toBe(30)
  })

  test('poll interval persists after reload', async ({ page }) => {
    await openSettingsGroup(page, 'Sessions')
    await page.getByRole('combobox', { name: 'Session poll interval' }).selectOption('60')
    await page.keyboard.press('Escape')
    await page.reload()
    await waitForTerminal(page)

    await openSettingsGroup(page, 'Sessions')
    await expect(page.getByRole('combobox', { name: 'Session poll interval' })).toHaveValue('60')
  })

  test('preferences persist after page reload', async ({ page }) => {
    await openSettingsGroup(page, 'Keyboard')
    await imeRadio(page).click()
    await page.keyboard.press('Escape')
    await page.reload()
    await waitForTerminal(page)

    await openSettingsGroup(page, 'Keyboard')
    await expect(imeRadio(page)).toHaveAttribute('aria-checked', 'true')
  })
})

test.describe('clear cache button', () => {
  test('shows the clear cache item in the menu', async ({ page }) => {
    await page.goto('/')
    await waitForTerminal(page)
    await openMenu(page)
    await expect(page.getByRole('menuitem', { name: 'Clear cache & reload' })).toBeVisible()
  })
})

test.describe('help sheet', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForTerminal(page)
    await openFromMenu(page, 'Help & gestures')
  })

  test('opens the usage guide from the menu', async ({ page }) => {
    await expect(page.getByRole('dialog', { name: 'Usage Guide' })).toBeVisible()
  })

  test('contains gesture and shortcut docs', async ({ page }) => {
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Swipe')
    await expect(dialog).toContainText('Ctrl')
  })

  test('closes on the close button', async ({ page }) => {
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
  })
})

test.describe('sidebar collapse', () => {
  test.beforeEach(async ({ page }) => {
    await reloadFresh(page)
  })

  test('sidebar collapse and expand toggle works', async ({ page }) => {
    const collapseBtn = page.getByRole('button', { name: 'Collapse sidebar' })
    await collapseBtn.click()
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible()
    await page.getByRole('button', { name: 'Expand sidebar' }).click()
    await expect(collapseBtn).toBeVisible()
  })

  test('sidebar collapse state persists after reload', async ({ page }) => {
    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await page.reload()
    await waitForTerminal(page)
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible()
  })
})

test.describe('fullscreen toggle', () => {
  test('fullscreen button visible on desktop', async ({ page }) => {
    await page.goto('/')
    await waitForTerminal(page)
    await expect(page.getByRole('button', { name: 'Enter fullscreen' })).toBeVisible()
  })
})

test.describe('sidebar scroll', () => {
  test.beforeEach(async ({ page }) => {
    await reloadFresh(page)
  })

  test('sidebar scrolls when many sessions added', async ({ page }) => {
    const tag = Date.now()
    for (let i = 0; i < 8; i++) {
      await page.click('button[title="Add new session"]')
      await page.waitForSelector('input[placeholder="Session name"]', { timeout: 3000 })
      await page.fill('input[placeholder="Session name"]', `s${tag}-${i}`)
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await page.waitForTimeout(300)
    }

    const sidebar = page.locator('aside')
    await expect(sidebar).toBeVisible()
    await expect(sidebar).toContainText(`s${tag}-0`)
  })
})

test.describe('mobile layout', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  // Before the redesign the terminal got 674px at 390x844: a header, a key
  // toolbar and a bottom navigation shared the rest.
  const BEFORE_REDESIGN_PX = 674

  for (const style of ['terminal', 'native', 'neutral'] as const) {
    test(`the terminal is taller than before the redesign (${style})`, async ({ page }) => {
      await page.addInitScript((s) => {
        localStorage.setItem(
          'termote-settings',
          JSON.stringify({ uiStyle: s, hasSeenGestureHints: true }),
        )
      }, style)
      await page.goto('/')
      await waitForTerminal(page)
      const height = await page
        .getByTestId('terminal-view')
        .evaluate((el) => el.getBoundingClientRect().height)
      test.info().annotations.push({ type: 'terminal height', description: `${style}: ${height}px` })
      expect(height).toBeGreaterThan(BEFORE_REDESIGN_PX)
    })
  }

  test('the Extra keys button is pinned and opens the expanded rows with Actions', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true }))
    })
    await page.goto('/')
    await waitForTerminal(page)

    const more = page.getByRole('button', { name: 'Extra keys' })
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await more.click()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    const actions = page.getByRole('group', { name: 'Actions' })
    await expect(actions.getByRole('button', { name: 'Clear line' })).toBeVisible()
    await more.click()
    await expect(actions).toBeHidden()

    // The bottom row scrolls under a pinned button that stays on screen; the
    // end still hiding keys fades
    const scroller = page.getByTestId('toolbar-scroller')
    const mask = () =>
      scroller.evaluate((el) => {
        const style = getComputedStyle(el)
        return style.maskImage || style.webkitMaskImage
      })
    // Browsers report transparent as rgba(0, 0, 0, 0)
    const clear = 'rgba\\(0, 0, 0, 0\\)'
    await expect.poll(mask).toMatch(new RegExp(`^linear-gradient\\(to right, rgb\\(0, 0, 0\\).*${clear}\\)$`))
    const before = await more.boundingBox()
    await scroller.evaluate((el) => {
      el.scrollLeft = el.scrollWidth
    })
    const after = await more.boundingBox()
    expect(after).toEqual(before)
    expect(after!.x + after!.width).toBeLessThanOrEqual(390)
    await expect.poll(mask).toMatch(new RegExp(`^linear-gradient\\(to right, ${clear}.*rgb\\(0, 0, 0\\)\\)$`))
  })
})

test.describe('desktop toolbar', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('the bottom row fits, so it does not fade', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true }))
    })
    await page.goto('/')
    await waitForTerminal(page)
    const scroller = page.getByTestId('toolbar-scroller')
    await expect(scroller).toBeVisible()
    const mask = await scroller.evaluate((el) => {
      const style = getComputedStyle(el)
      return style.maskImage || style.webkitMaskImage
    })
    expect(mask).toBe('none')
  })
})
