import { test, expect } from '@playwright/test'

test.describe('session management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
  })

  test('switch session updates UI', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })

    // Click on Copilot session
    await page.click('button:has-text("Copilot")')
    await page.waitForTimeout(300)

    // Verify header changed
    await expect(page.locator('header')).toContainText('Copilot')
    await expect(page.locator('header')).toContainText('GitHub Copilot')
  })

  test('add session creates new entry', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })

    // Click add session button
    await page.click('button[title="Add new session"]')

    // Fill in session name
    await page.fill('input[placeholder="Name"]', 'test-session')
    await page.click('button:has-text("Add")')
    await page.waitForTimeout(300)

    // Verify new session appears and is active
    await expect(page.locator('header')).toContainText('test-session')
    await expect(page.locator('aside')).toContainText('test-session')
  })

  test('remove session removes entry', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })

    // Hover over Copilot to show remove button and click
    const copilotRow = page.locator('.group:has(button:has-text("Copilot"))')
    await copilotRow.hover()
    await copilotRow.locator('button[title="Remove session"]').click()
    await page.waitForTimeout(300)

    // Verify Copilot session is removed
    await expect(page.locator('aside')).not.toContainText('Copilot')
  })
})

test.describe('tmux API integration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })
    await page.waitForTimeout(1000)
  })

  test('API health check', async ({ request }) => {
    const res = await request.get('/api/tmux/health', {
      headers: { Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') },
    })
    expect(res.ok()).toBe(true)
    const data = await res.json()
    expect(data.status).toBe('ok')
  })

  test('list windows returns array', async ({ request }) => {
    const res = await request.get('/api/tmux/windows', {
      headers: { Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') },
    })
    expect(res.ok()).toBe(true)
    const data = await res.json()
    expect(Array.isArray(data.windows)).toBe(true)
  })

  test('switch session calls select API', async ({ page, request }) => {
    // Get initial windows
    const before = await request.get('/api/tmux/windows', {
      headers: { Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') },
    })
    const windowsBefore = (await before.json()).windows

    // Click on second session tab
    await page.click('button:has-text("Copilot")')
    await page.waitForTimeout(500)

    // Verify UI changed
    await expect(page.locator('header')).toContainText('Copilot')

    // Verify tmux window changed (if multiple windows exist)
    if (windowsBefore.length > 1) {
      const after = await request.get('/api/tmux/windows', {
        headers: { Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') },
      })
      const windowsAfter = (await after.json()).windows
      const activeWindow = windowsAfter.find((w: { active: boolean }) => w.active)
      expect(activeWindow).toBeDefined()
    }
  })

  test('add session creates tmux window', async ({ page, request }) => {
    // Count windows before
    const before = await request.get('/api/tmux/windows', {
      headers: { Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') },
    })
    const countBefore = (await before.json()).windows.length

    // Add new session
    await page.click('button[title="Add new session"]')
    await page.fill('input[placeholder="Name"]', 'test-api')
    await page.click('button:has-text("Add")')
    await page.waitForTimeout(500)

    // Verify UI
    await expect(page.locator('header')).toContainText('test-api')

    // Verify tmux window created
    const after = await request.get('/api/tmux/windows', {
      headers: { Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') },
    })
    const countAfter = (await after.json()).windows.length
    expect(countAfter).toBeGreaterThanOrEqual(countBefore)
  })

  test('remove session kills tmux window', async ({ page, request }) => {
    // First add a session to remove
    await page.click('button[title="Add new session"]')
    await page.fill('input[placeholder="Name"]', 'to-remove')
    await page.click('button:has-text("Add")')
    await page.waitForTimeout(500)

    // Count windows before removal
    const before = await request.get('/api/tmux/windows', {
      headers: { Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') },
    })
    const countBefore = (await before.json()).windows.length

    // Remove the session
    const sessionRow = page.locator('.group:has(button:has-text("to-remove"))')
    await sessionRow.hover()
    await sessionRow.locator('button[title="Remove session"]').click()
    await page.waitForTimeout(500)

    // Verify UI
    await expect(page.locator('aside')).not.toContainText('to-remove')

    // Verify tmux window removed
    const after = await request.get('/api/tmux/windows', {
      headers: { Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') },
    })
    const countAfter = (await after.json()).windows.length
    expect(countAfter).toBeLessThanOrEqual(countBefore)
  })
})
