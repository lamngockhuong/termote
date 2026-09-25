import { test, expect } from '@playwright/test'

test.describe('session management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
  })

  test('switch session updates UI', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })

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
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })

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
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })

    // First create a session to remove
    await page.click('button[title="Add new session"]')
    await page.waitForSelector('input[placeholder="Session name"]', { timeout: 5000 })
    await page.fill('input[placeholder="Session name"]', 'to-delete')
    await page.click('button.bg-blue-600:has-text("Add")')
    await page.waitForTimeout(500)

    // Verify session was created
    await expect(page.locator('aside')).toContainText('to-delete')

    // Hover over the session to show remove button and click
    // Scope to the sidebar: desktop session tabs also render a `.group` button
    const sessionRow = page.locator('aside .group:has-text("to-delete")')
    await sessionRow.hover()
    await sessionRow.locator('button[title="Remove session"]').click()
    await page.waitForTimeout(500)

    // Verify session is removed
    await expect(page.locator('aside')).not.toContainText('to-delete')
  })
})

const tabCount = (snap: { groups: Array<{ tabs: unknown[] }> }) =>
  snap.groups[0].tabs.length

test.describe('mux API integration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
    await page.waitForTimeout(1000)
  })

  test('API health check', async ({ request }) => {
    const res = await request.get('/api/mux/health')
    expect(res.ok()).toBe(true)
    const data = await res.json()
    expect(data.status).toBe('ok')
    expect(data.apiVersion).toBe(1)
    expect(data.backend).toBe('tmux')
  })

  test('snapshot returns groups with tabs', async ({ request }) => {
    const res = await request.get('/api/mux/snapshot')
    expect(res.ok()).toBe(true)
    expect(res.headers()['content-type']).toBe('application/json')
    const data = await res.json()
    expect(Array.isArray(data.groups)).toBe(true)
    expect(Array.isArray(data.groups[0].tabs)).toBe(true)
  })

  test('removed /api/tmux routes answer JSON 404', async ({ request }) => {
    const res = await request.get('/api/tmux/windows')
    expect(res.status()).toBe(404)
    expect((await res.json()).error).toBe('not found')
  })

  test('cross-site write is rejected', async ({ request }) => {
    const res = await request.post('/api/mux/tabs', {
      headers: { 'Content-Type': 'text/plain' },
      data: '{"name":"csrf"}',
    })
    expect(res.status()).toBe(415)
  })

  test('tmux shows the flat 0.x list: no group header, no pane strip', async ({ page }) => {
    await expect(page.locator('aside section')).toHaveCount(0)
    await expect(page.getByRole('group', { name: 'Panes' })).toHaveCount(0)
  })

  test('switch session selects the tmux window on the server', async ({ page, request }) => {
    // Create a second session; tmux makes the new window current
    await page.click('button[title="Add new session"]')
    await page.waitForSelector('input[placeholder="Session name"]', { timeout: 5000 })
    await page.fill('input[placeholder="Session name"]', 'api-test')
    await page.click('button.bg-blue-600:has-text("Add")')
    await page.waitForTimeout(500)

    const before = await request.get('/api/mux/snapshot')
    const first = (await before.json()).groups[0].tabs[0]

    // tmux shares the current window between clients, so picking a tab here
    // moves the server's active window (herdr would not)
    await page.locator(`aside .group:has-text("${first.name}") button`).first().click()
    await expect
      .poll(async () => {
        const after = await request.get('/api/mux/snapshot')
        const tabs = (await after.json()).groups[0].tabs
        return tabs.find((t: { active: boolean }) => t.active)?.id
      })
      .toBe(first.id)
  })

  test('add session creates tmux window', async ({ page, request }) => {
    const before = await request.get('/api/mux/snapshot')
    const countBefore = tabCount(await before.json())

    await page.click('button[title="Add new session"]')
    await page.waitForSelector('input[placeholder="Session name"]', { timeout: 5000 })
    await page.fill('input[placeholder="Session name"]', 'test-api')
    await page.click('button.bg-blue-600:has-text("Add")')
    await page.waitForTimeout(500)

    await expect(page.locator('aside')).toContainText('test-api')

    const after = await request.get('/api/mux/snapshot')
    const countAfter = tabCount(await after.json())
    expect(countAfter).toBeGreaterThanOrEqual(countBefore)
  })

  test('remove session kills tmux window', async ({ page, request }) => {
    // Use unique name to avoid conflicts with leftover sessions
    const name = `rm-${Date.now()}`
    await page.click('button[title="Add new session"]')
    await page.waitForSelector('input[placeholder="Session name"]', { timeout: 5000 })
    await page.fill('input[placeholder="Session name"]', name)
    await page.click('button.bg-blue-600:has-text("Add")')
    await page.waitForTimeout(500)

    const before = await request.get('/api/mux/snapshot')
    const countBefore = tabCount(await before.json())

    // Use .first() to avoid strict mode violation if duplicates exist
    const sessionRow = page.locator(`.group:has-text("${name}")`).first()
    await sessionRow.hover()
    await sessionRow.locator('button[title="Remove session"]').click()
    await page.waitForTimeout(500)

    await expect(page.locator('aside')).not.toContainText(name)

    const after = await request.get('/api/mux/snapshot')
    const countAfter = tabCount(await after.json())
    expect(countAfter).toBeLessThanOrEqual(countBefore)
  })
})
