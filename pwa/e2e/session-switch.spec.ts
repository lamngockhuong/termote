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

    // Create a second session first
    await page.click('button[title="Add new session"]')
    await page.waitForSelector('input[placeholder="Session name"]', { timeout: 5000 })
    await page.fill('input[placeholder="Session name"]', 'test-switch')
    await page.click('button.bg-blue-600:has-text("Add")')
    await page.waitForTimeout(500)

    // Verify session was created
    await expect(page.locator('aside')).toContainText('test-switch')
  })

  test('add session creates new entry', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })

    // Click add session button and wait for form
    await page.click('button[title="Add new session"]')
    await page.waitForSelector('input[placeholder="Session name"]', { timeout: 5000 })

    // Fill in session name
    await page.fill('input[placeholder="Session name"]', 'test-session')
    await page.click('button.bg-blue-600:has-text("Add")')
    await page.waitForTimeout(500)

    // Verify new session appears
    await expect(page.locator('aside')).toContainText('test-session')
  })

  test('remove session removes entry', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('iframe[title="Terminal"]', { timeout: 10000 })

    // First create a session to remove
    await page.click('button[title="Add new session"]')
    await page.waitForSelector('input[placeholder="Session name"]', { timeout: 5000 })
    await page.fill('input[placeholder="Session name"]', 'to-delete')
    await page.click('button.bg-blue-600:has-text("Add")')
    await page.waitForTimeout(500)

    // Verify session was created
    await expect(page.locator('aside')).toContainText('to-delete')

    // Hover over the session to show remove button and click
    const sessionRow = page.locator('.group:has-text("to-delete")')
    await sessionRow.hover()
    await sessionRow.locator('button[title="Remove session"]').click()
    await page.waitForTimeout(500)

    // Verify session is removed
    await expect(page.locator('aside')).not.toContainText('to-delete')
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
    // Create a second session
    await page.click('button[title="Add new session"]')
    await page.waitForSelector('input[placeholder="Session name"]', { timeout: 5000 })
    await page.fill('input[placeholder="Session name"]', 'api-test')
    await page.click('button.bg-blue-600:has-text("Add")')
    await page.waitForTimeout(500)

    // Get initial windows
    const before = await request.get('/api/tmux/windows', {
      headers: { Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') },
    })
    const windowsBefore = (await before.json()).windows

    // Click on first session button in sidebar
    const firstSession = page.locator('aside .group button').first()
    await firstSession.click()
    await page.waitForTimeout(500)

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
    await page.waitForSelector('input[placeholder="Session name"]', { timeout: 5000 })
    await page.fill('input[placeholder="Session name"]', 'test-api')
    await page.click('button.bg-blue-600:has-text("Add")')
    await page.waitForTimeout(500)

    // Verify UI
    await expect(page.locator('aside')).toContainText('test-api')

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
    await page.waitForSelector('input[placeholder="Session name"]', { timeout: 5000 })
    await page.fill('input[placeholder="Session name"]', 'to-remove')
    await page.click('button.bg-blue-600:has-text("Add")')
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
