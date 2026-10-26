import { test as base, expect, type Page } from '@playwright/test'

export * from '@playwright/test'

const CSP_MESSAGE = /Content[- ]Security[- ]Policy/i

// Records every Content-Security-Policy violation on the page, from its first
// script on, and every console message the browser logs for one, the page's
// and each of its workers' (a worker has a policy of its own, from its
// script's response: the document viewers parse in workers).
export async function watchViolations(page: Page): Promise<string[]> {
  const violations: string[] = []
  page.on('console', (msg) => {
    if (CSP_MESSAGE.test(msg.text())) violations.push(msg.text())
  })
  page.on('worker', (worker) => {
    worker.on('console', (msg) => {
      if (CSP_MESSAGE.test(msg.text())) violations.push(`worker ${worker.url()}: ${msg.text()}`)
    })
    // A violation the browser does not log is still an event in the worker:
    // logged there, so the listener above sees it
    worker
      .evaluate(() => {
        self.addEventListener('securitypolicyviolation', (e) => {
          console.error(`Content-Security-Policy violation: ${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`)
        })
      })
      .catch(() => {
        // The worker ended first
      })
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
