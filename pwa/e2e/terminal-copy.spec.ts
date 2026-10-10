import { expect, type Page, test } from './fixtures'

// Copying from the terminal: Ctrl+Shift+C on a mouse selection (desktop),
// and the Select text sheet with the pane's history (phone). The clipboard
// is read back through the page, so only Chromium runs it; the server is
// tmux in the main E2E job, Herdr in the Herdr job (TERMOTE_E2E_HERDR=1).
test.skip(({ browserName }) => browserName !== 'chromium', 'reads the clipboard through Chromium permissions')

const marker = () => `copy-${Math.random().toString(36).slice(2, 8)}`

const rows = (page: Page) => page.locator('[data-testid="terminal-view"] .xterm-rows')

async function openTerminal(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true }))
  })
  await page.goto('/')
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
  // Keys typed before the stream opens are dropped: wait for the prompt
  await expect(rows(page)).toHaveText(/\S/, { timeout: 15000 })
}

// Types a command through xterm's own input, so it works under the phone's
// gesture layer too.
async function run(page: Page, command: string) {
  await page.locator('[data-testid="terminal-view"] .xterm-helper-textarea').focus()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

test.describe('desktop copy', () => {
  test.skip(!!process.env.TERMOTE_E2E_HERDR, 'tmux job only: the same keys on Herdr')

  test('Ctrl+Shift+C copies the selected word and sends nothing', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openTerminal(page)
    const word = marker()
    // The output line holds only the word, so a double click selects it
    await run(page, `clear; echo ${word.replace('-', '""-')}`)
    const line = rows(page).locator('div', { hasText: new RegExp(`^${word}\\s*$`) })
    await expect(line).toHaveCount(1, { timeout: 10000 })
    // Half a command at the prompt: a ^C reaching the shell would drop it
    await page.keyboard.type('echo kept-')
    const box = (await line.boundingBox())!
    await page.mouse.dblclick(box.x + 4, box.y + box.height / 2)

    await page.keyboard.press('Control+Shift+C')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(word)
    await expect(page.getByText('Copied')).toBeVisible()

    await page.locator('[data-testid="terminal-view"] .xterm-helper-textarea').focus()
    await page.keyboard.type('$((2+3))')
    await page.keyboard.press('Enter')
    await expect(rows(page)).toContainText('kept-5', { timeout: 10000 })
  })
})

test.describe('Select text on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('shows the history and copies all of it', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openTerminal(page)
    const word = marker()
    // Far more lines than the screen holds: the first ones are history
    await run(page, `clear; seq -f 'line-%g' 1 200; echo ${word.replace('-', '""-')}`)
    await expect(rows(page)).toContainText(word, { timeout: 10000 })

    await page.getByRole('button', { name: 'Select text' }).click()
    const sheet = page.getByRole('dialog', { name: 'Select text' })
    const text = sheet.getByTestId('select-text')
    await expect(text).toContainText(word, { timeout: 10000 })
    await expect(text).toContainText('line-1\n')
    await expect(sheet.getByText(/Only what the terminal/)).toHaveCount(0)

    await sheet.getByRole('button', { name: 'Copy all' }).click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toMatch(new RegExp(`line-1\\n[^]*line-200\\n${word}`))
    await sheet.getByRole('button', { name: 'Close' }).click()
    await expect(sheet).toHaveCount(0)
  })

  // A page opened over plain HTTP on the LAN has no Clipboard API for
  // writes: the copy goes through execCommand inside the modal sheet.
  test('copies without a secure context', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.addInitScript(() => {
      Object.defineProperty(window, 'isSecureContext', { value: false })
    })
    await openTerminal(page)
    const word = marker()
    await run(page, `clear; echo ${word.replace('-', '""-')}`)
    await expect(rows(page)).toContainText(word, { timeout: 10000 })

    await page.getByRole('button', { name: 'Select text' }).click()
    const sheet = page.getByRole('dialog', { name: 'Select text' })
    await expect(sheet.getByTestId('select-text')).toContainText(word, { timeout: 10000 })
    await sheet.getByRole('button', { name: 'Copy all' }).click()
    await expect(page.getByText('Copied')).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain(word)
  })
})
