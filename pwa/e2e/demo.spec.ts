import { expect, type Page, test } from './fixtures'

// The interactive demo (pnpm build:demo, served at /demo/ by
// playwright.demo.config.ts): the real app, with no server behind it. Each
// test walks part of it on a phone and on a desktop, with no console error
// (a request the demo cannot answer logs one: "demo: unhandled") and no
// Content-Security-Policy violation (the fixture).

const errors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
  const list: string[] = []
  errors.set(page, list)
  page.on('console', (msg) => {
    if (msg.type() === 'error') list.push(msg.text())
  })
  page.on('pageerror', (err) => list.push(err.message))
})

test.afterEach(async ({ page }) => {
  expect(errors.get(page), 'console errors').toEqual([])
})

// A pane's view, by deep link (utils/deep-link.ts)
async function open(page: Page, hash = '') {
  await page.goto(`./${hash}`)
  await expect(page.getByText('Demo with fake data')).toBeVisible()
}

const acmeClaude = '#/s/w1/w1%3At1/w1%3Ap1'
const terminal = (page: Page) =>
  page.locator('[data-testid="terminal-view"] .xterm-rows').first()

for (const [device, viewport] of [
  ['phone', { width: 390, height: 844 }],
  ['desktop', { width: 1280, height: 800 }],
] as const) {
  test.describe(`demo on a ${device}`, () => {
    test.use({ viewport, ...(device === 'phone' ? { isMobile: true, hasTouch: true } : {}) })

    test('shows the overview of the agents', async ({ page }) => {
      await open(page, '#/overview')
      const overview = page.getByRole('region', { name: 'Agents' })
      await expect(overview).toContainText('acme-api')
      await expect(overview).toContainText('rate limited')
    })

    test('replays Claude Code in the terminal', async ({ page }) => {
      await open(page, acmeClaude)
      await expect(terminal(page)).toContainText('All auth tests pass.')
      await expect(terminal(page)).toContainText('Yes, run the auth tests', { timeout: 15000 })
    })

    test('chats with the agent and answers its question', async ({ page }) => {
      await open(page, `${acmeClaude}?view=chat`)
      const conversation = page.getByRole('region', { name: 'Conversation' })
      await expect(conversation).toContainText('Want me to run the tests?')
      await page.getByRole('textbox', { name: /^Message to/ }).fill('Yes, run the auth tests')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      const dialog = page.getByRole('alertdialog', { name: 'Bash command' })
      await expect(dialog).toContainText('go test ./auth/...', { timeout: 15000 })
      await dialog.getByRole('button', { name: '1. Yes' }).click()
      await expect(conversation).toContainText('both tests pass', { timeout: 15000 })
    })

    test('opens a file and a diff', async ({ page }) => {
      await open(page, `${acmeClaude}?view=files&file=README.md`)
      await expect(page.getByRole('heading', { name: 'acme-api' })).toBeVisible()
      // Drawn in the Mermaid sandbox page, under /demo/ like every asset
      await expect(page.getByTestId('mermaid-block').locator('img').first()).toBeVisible({ timeout: 20000 })
      await open(page, `${acmeClaude}?view=changes&file=auth/ratelimit.go`)
      await expect(page.getByText('func newLimiter').first()).toBeVisible()
    })

    test('lists the tasks of the repo', async ({ page }) => {
      await open(page, `${acmeClaude}?view=tasks`)
      await expect(page.getByText('go test ./...').first()).toBeVisible()
      await expect(page.getByText('migrate').first()).toBeVisible()
    })

    test('renames a pane', async ({ page }) => {
      await open(page, '#/s/w1/w1%3At1/w1%3Ap2')
      await page.getByRole('button', { name: 'Pane', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Rename pane' }).click()
      await page.getByRole('textbox', { name: 'Name' }).fill('dev server')
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByRole('group', { name: 'Panes' })).toContainText('dev server')
    })

    test('links to the install guide', async ({ page }) => {
      await open(page)
      // The policy GitHub Pages cannot send as a header
      await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
        'content',
        /script-src 'self' 'sha256-/,
      )
      await expect(page.getByRole('link', { name: 'Install Termote' })).toHaveAttribute(
        'href',
        'https://termote.ohnice.app/getting-started/',
      )
      await page.getByRole('button', { name: 'Hide the demo notice' }).click()
      await expect(page.getByText('Demo with fake data')).toBeHidden()
    })
  })
}

test.describe('demo on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('finds a file with the command palette', async ({ page }) => {
    await open(page, acmeClaude)
    await expect(terminal(page)).toContainText('Claude Code')
    // Keys typed in the terminal go to the pane: from the header, as a
    // person reaching for the palette would
    await page.getByRole('button', { name: 'Command palette' }).focus()
    await page.keyboard.press('Control+P')
    const palette = page.getByRole('dialog').filter({ has: page.getByRole('combobox') })
    await expect(palette.getByRole('combobox')).toBeFocused()
    await page.keyboard.type('ratelimit')
    await expect(palette.getByRole('option', { name: /ratelimit\.go/ })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByText('func newLimiter').first()).toBeVisible()
  })

  test('switches theme and language', async ({ page }) => {
    await open(page, acmeClaude)
    const html = page.locator('html')
    const dark = (await html.getAttribute('class'))?.includes('dark')
    await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('menuitemradio', { name: dark ? 'Light' : 'Dark' }).click()
    await expect(html).toHaveClass(dark ? /light/ : /dark/)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('menuitem', { name: 'Settings' }).click()
    await page.getByRole('radio', { name: 'Tiếng Việt' }).click()
    await expect(page.getByText('Bản demo, dữ liệu giả')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Cài Termote' })).toHaveAttribute(
      'href',
      'https://termote.ohnice.app/vi/getting-started/',
    )
  })
})
