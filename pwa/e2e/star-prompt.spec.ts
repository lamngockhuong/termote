import { expect, type Page, test } from './fixtures'

const waitForTerminal = (page: Page) =>
  page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })

const openUpdates = async (page: Page) => {
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await page
    .getByRole('navigation', { name: 'Settings groups' })
    .getByRole('button', { name: 'Updates' })
    .click()
  return page.getByRole('dialog', { name: 'Settings' })
}

test.describe('star prompt after an update', () => {
  test('asks once after the page version rose, and never after No thanks', async ({ page }) => {
    // An older version kept by this browser: the page then starts as an
    // update. Only while nothing is kept, so a reload keeps what the page wrote.
    await page.addInitScript(() => {
      if (!localStorage.getItem('termote-seen-version')) {
        localStorage.setItem('termote-seen-version', '1.0.0')
      }
    })
    await page.goto('/')
    await waitForTerminal(page)

    const dialog = await openUpdates(page)
    await expect(dialog.getByText(/Updated to v\d+\.\d+\.\d+/)).toBeVisible()
    const link = dialog.getByRole('link', { name: /^Star on GitHub/ })
    await expect(link).toHaveAttribute('href', 'https://github.com/lamngockhuong/termote')
    await expect(link).toHaveAttribute('target', '_blank')

    await dialog.getByRole('button', { name: 'No thanks' }).click()
    await expect(dialog.getByText(/Updated to v/)).toBeHidden()

    await page.reload()
    await waitForTerminal(page)
    const again = await openUpdates(page)
    await expect(again.getByRole('button', { name: 'Check for updates' })).toBeVisible()
    await expect(again.getByText(/Updated to v/)).toBeHidden()
  })

  test('does not ask on a first visit', async ({ page }) => {
    await page.goto('/')
    await waitForTerminal(page)
    const dialog = await openUpdates(page)
    await expect(dialog.getByRole('button', { name: 'Check for updates' })).toBeVisible()
    await expect(dialog.getByText(/Updated to v/)).toBeHidden()
  })
})
