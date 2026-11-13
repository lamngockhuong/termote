import { expect, type Page, test } from './fixtures'

// The terminal drawn by WebGL2 (the gpuRenderer setting, on by default; every
// other spec turns it off in fixtures.ts). The canvas has no text, so the
// screen is read from xterm's buffer through the test probe
// (utils/terminal-probe.ts), never from the DOM. Chromium headless draws
// WebGL2 with SwiftShader, which Playwright enables: the app keeps the DOM
// renderer on a renderer drawing on the CPU unless the page asks
// (__termoteSoftwareWebgl, honoured only with the test flag).
test.skip(({ browserName }) => browserName !== 'chromium', 'reads the clipboard through Chromium permissions')
test.use({ gpuRenderer: true })

type Probe = { lines: () => string[]; webgl: () => boolean }
type ProbeWindow = { __termoteE2E?: boolean; __termoteSoftwareWebgl?: boolean; __termoteTerms?: Probe[] }

const marker = () => `gl-${Math.random().toString(36).slice(2, 8)}`
const textarea = (page: Page) => page.locator('[data-testid="terminal-view"] .xterm-helper-textarea')
const lines = (page: Page) =>
  page.evaluate(() => (window as unknown as ProbeWindow).__termoteTerms?.[0]?.lines().join('\n') ?? '')
const drawnByWebgl = (page: Page) =>
  page.evaluate(() => !!(window as unknown as ProbeWindow).__termoteTerms?.[0]?.webgl())

async function openTerminal(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as ProbeWindow
    w.__termoteE2E = true
    w.__termoteSoftwareWebgl = true
  })
  await page.goto('/')
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
  // Keys typed before the stream opens are dropped: wait for the prompt
  await expect.poll(() => lines(page), { timeout: 15000 }).toMatch(/\S/)
}

async function run(page: Page, command: string) {
  await textarea(page).focus()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

test('the browser has WebGL2', async ({ page }) => {
  await page.goto('/')
  const has = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))
  expect(has, 'Chromium has no WebGL2 here: the WebGL specs below cannot say anything').toBe(true)
})

test('draws with WebGL, shows the output, and copies a selection', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openTerminal(page)
  // The addon is its own chunk: it takes over once that is in
  await expect.poll(() => drawnByWebgl(page), { timeout: 10000 }).toBe(true)
  await expect(page.locator('[data-testid="terminal-view"] .xterm-screen canvas').first()).toBeAttached()
  await expect(page.locator('[data-testid="terminal-view"] .xterm-rows')).toHaveCount(0)

  const word = marker()
  // The output line holds only the word, so a double click selects it
  await run(page, `clear; echo ${word.replace('-', '""-')}`)
  await expect.poll(() => lines(page), { timeout: 10000 }).toMatch(new RegExp(`^${word}$`, 'm'))

  // Where that row is drawn: the screen's height split in rows
  const row = await page.evaluate(
    (w) =>
      (window as unknown as ProbeWindow)
        .__termoteTerms![0].lines()
        .findIndex((l) => l === w),
    word,
  )
  const screen = (await page.locator('[data-testid="terminal-view"] .xterm-screen').boundingBox())!
  const rowCount = (await lines(page)).split('\n').length
  const rowHeight = screen.height / rowCount
  await page.mouse.dblclick(screen.x + 4, screen.y + rowHeight * (row + 0.5))
  await page.keyboard.press('Control+Shift+C')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(word)
})

test('draws a Nerd Font icon once its font is in', async ({ page }) => {
  await openTerminal(page)
  await expect.poll(() => drawnByWebgl(page), { timeout: 10000 }).toBe(true)
  // U+F07B (a folder) is in the icon font's unicode-range: printing it is what
  // makes the browser fetch that font, after the first glyphs were drawn
  await run(page, `clear; printf 'icon:\\xef\\x81\\xbb:end\\n'`)
  await expect.poll(() => lines(page), { timeout: 10000 }).toContain('icon::end')
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          [...document.fonts].some((f) => f.family.includes('Symbols Nerd Font') && f.status === 'loaded'),
        ),
      { timeout: 10000 },
    )
    .toBe(true)
  // Still drawn by WebGL after the atlas was redrawn for the new font
  expect(await drawnByWebgl(page)).toBe(true)
})

test('turning the setting off gives the DOM renderer back, and typing still works', async ({ page }) => {
  await openTerminal(page)
  await expect.poll(() => drawnByWebgl(page), { timeout: 10000 }).toBe(true)

  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await page.getByRole('navigation', { name: 'Settings groups' }).getByRole('button', { name: 'Terminal' }).click()
  const sw = page.getByRole('switch', { name: 'Draw the terminal with the GPU' })
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('Escape')

  await expect(page.locator('[data-testid="terminal-view"] .xterm-rows')).toHaveCount(1)
  expect(await drawnByWebgl(page)).toBe(false)
  const word = marker()
  await run(page, `echo ${word.replace('-', '""-')}`)
  await expect(page.locator('[data-testid="terminal-view"] .xterm-rows')).toContainText(word, { timeout: 10000 })
})

test('a theme picked while open keeps the WebGL renderer and redraws in its colours', async ({ page }) => {
  await openTerminal(page)
  await expect.poll(() => drawnByWebgl(page), { timeout: 10000 }).toBe(true)
  // Headless Chromium prefers light: the page starts light
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  const shot = async () => (await page.locator('[data-testid="terminal-view"] .xterm-screen').screenshot()).toString('base64')
  const before = await shot()
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('html')).toHaveClass(/dark/)
  // The canvas is drawn again in the dark colours
  await expect.poll(shot, { timeout: 5000 }).not.toBe(before)
  expect(await drawnByWebgl(page)).toBe(true)
})

test('keeps the DOM renderer where WebGL draws on the CPU', async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as ProbeWindow).__termoteE2E = true
  })
  await page.goto('/')
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
  })
  test.skip(!/swiftshader|llvmpipe|softpipe|software/i.test(renderer), `WebGL here runs on a GPU (${renderer})`)
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
  await expect.poll(() => lines(page), { timeout: 15000 }).toMatch(/\S/)
  // Long enough for the addon's chunk, had it been fetched
  await page.waitForTimeout(1000)
  expect(await drawnByWebgl(page)).toBe(false)
  await expect(page.locator('[data-testid="terminal-view"] .xterm-rows')).toHaveCount(1)
})
