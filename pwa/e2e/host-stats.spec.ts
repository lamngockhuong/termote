import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// The Host chip and sheet against a real server: the numbers come from the
// machine running it, so only their presence and shape are checked.

async function open(page: Page, settings?: Record<string, unknown>) {
  await page.addInitScript((s) => {
    if (sessionStorage.getItem('e2e-opened')) return
    sessionStorage.setItem('e2e-opened', '1')
    localStorage.clear()
    if (s) localStorage.setItem('termote-settings', JSON.stringify(s))
  }, settings)
  await page.goto('/')
  await page.waitForSelector('[data-testid="terminal-view"] .xterm', {
    timeout: 15000,
  })
}

const chip = (page: Page) =>
  page.getByRole('button', { name: /^Host: .*Open the host details$/ })

test.describe('host stats', () => {
  test('the server answers its sample and history', async ({ request }) => {
    const res = await request.get('/api/mux/system')
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(['host', 'wsl', 'container']).toContain(body.scope)
    expect(Array.isArray(body.history)).toBe(true)
    expect(body.memory?.total ?? 1).toBeGreaterThan(0)
  })

  test('the chip opens the Host sheet with its lines', async ({ page }) => {
    await open(page)
    await expect(chip(page)).toBeVisible({ timeout: 15000 })
    await chip(page).click()
    const sheet = page.getByRole('dialog', { name: 'Host' })
    await expect(sheet).toBeVisible()
    await expect(
      sheet.getByText(/^(This machine|WSL virtual machine|Container)$/),
    ).toBeVisible()
    await expect(sheet.getByRole('img', { name: /^CPU/ })).toBeVisible()
    await expect(sheet.getByRole('img', { name: /^Memory/ })).toBeVisible()
    await expect(sheet.getByRole('meter').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
  })

  test('the setting hides the chip and stops the reads', async ({ page }) => {
    let reads = 0
    page.on('request', (r) => {
      if (r.url().endsWith('/api/mux/system')) reads++
    })
    await open(page, { showHostChip: false })
    // Long enough for the snapshot's reads and a poll of the chip
    await page.waitForTimeout(1500)
    await expect(chip(page)).toHaveCount(0)
    expect(reads).toBe(0)
  })
})
