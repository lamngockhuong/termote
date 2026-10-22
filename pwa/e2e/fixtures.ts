import { test as base, expect, type Page } from '@playwright/test'

export * from '@playwright/test'

// Records every Content-Security-Policy violation on the page, from its first
// script on, and every console message the browser logs for one.
export async function watchViolations(page: Page): Promise<string[]> {
  const violations: string[] = []
  page.on('console', (msg) => {
    if (/Content[- ]Security[- ]Policy/i.test(msg.text())) violations.push(msg.text())
  })
  await page.exposeFunction('__cspViolation', (v: string) => violations.push(v))
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      ;(window as unknown as { __cspViolation: (v: string) => void }).__cspViolation(
        `${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`,
      )
    })
  })
  return violations
}

// Every spec runs under the server's policy: a test that triggers a
// violation (a blocked script, style, connection or worker) fails.
export const test = base.extend<{ cspViolations: string[]; noReleaseCheck: void }>({
  cspViolations: [
    async ({ page }, use) => {
      const violations = await watchViolations(page)
      await use(violations)
      expect(violations, 'Content-Security-Policy violations').toEqual([])
    },
    { auto: true },
  ],
  // The app asks GitHub for the newest release when it opens: a fresh kept
  // result (src/hooks/use-update-check.ts) keeps every spec off the network
  // (CI's rate limit, a test that counts the page's requests).
  noReleaseCheck: [
    async ({ page }, use) => {
      await page.addInitScript(() => {
        try {
          localStorage.setItem(
            'termote-update-check',
            JSON.stringify({ version: '1.0.0', url: '', checkedAt: Date.now() }),
          )
        } catch {
          // No storage here (about:blank)
        }
      })
      await use()
    },
    { auto: true },
  ],
})
