import { test as base } from '@playwright/test'
import { expect, test, watchViolations } from './fixtures'

// The server sends a Content-Security-Policy on every response. Every spec
// fails on a violation (./fixtures); this one checks the headers, the app's
// first run, and that a violation is caught at all.

test.describe('content security policy', () => {
  test('every page response carries the policy and the other headers', async ({ request }) => {
    for (const path of ['/', '/sw.js', '/manifest.webmanifest', '/some/spa/route']) {
      const res = await request.get(path)
      const csp = res.headers()['content-security-policy'] ?? ''
      expect(csp, path).toContain("default-src 'self'")
      expect(csp, path).toContain("frame-ancestors 'none'")
      expect(csp, path).toContain("object-src 'none'")
      expect(csp, path).not.toMatch(/script-src[^;]*'unsafe-inline'/)
      expect(res.headers()['x-content-type-options'], path).toBe('nosniff')
      expect(res.headers()['referrer-policy'], path).toBe('no-referrer')
    }
    // The inline theme script is allowed by its hash, and only it.
    const csp = (await request.get('/')).headers()['content-security-policy']
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/]+=*'(;|$)/)
  })

  test('the app runs without a violation', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('termote-theme', 'dark'))
    await page.goto('/')
    // The inline theme script ran before the app.
    await expect(page.locator('html')).toHaveClass(/dark/)
    // The terminal streams over the WebSocket.
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 10000 })
    await expect(page.locator('[data-testid="terminal-view"] .xterm-rows')).not.toBeEmpty({ timeout: 10000 })
    await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('menuitem', { name: 'Settings' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    // The service worker registers under the policy.
    await expect
      .poll(() => page.evaluate(async () => !!(await navigator.serviceWorker?.getRegistration())), { timeout: 10000 })
      .toBe(true)
  })
})

// Without the fixture, which would fail it: the violation must be seen.
base('an injected inline script is blocked and reported', async ({ page }) => {
  const violations = await watchViolations(page)
  await page.goto('/')
  const ran = await page.evaluate(() => {
    const s = document.createElement('script')
    s.textContent = 'window.__injected = true'
    document.head.append(s)
    return (window as unknown as { __injected?: boolean }).__injected === true
  })
  expect(ran).toBe(false)
  await expect.poll(() => violations.some((v) => v.includes('script-src'))).toBe(true)
})
