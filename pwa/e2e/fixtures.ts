import { test as base, expect, type Page } from '@playwright/test'
import { WELCOME_VERSION } from '../src/utils/welcome'

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
export const test = base.extend<{
  cspViolations: string[]
  noReleaseCheck: void
  firstRunSeen: boolean
  welcomeSeen: void
}>({
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
  // The welcome screen opens on a device's first visit, which is every
  // spec's: each one starts as a device that saw it. Its version goes into
  // every write of the settings, since many specs write their own settings
  // whole. welcome.spec.ts turns it off with test.use({ firstRunSeen: false }).
  firstRunSeen: [true, { option: true }],
  welcomeSeen: [
    async ({ page, firstRunSeen }, use) => {
      if (firstRunSeen) {
        await page.addInitScript((version) => {
          const KEY = 'termote-settings'
          const setItem = Storage.prototype.setItem
          const seen = (value: string) => {
            try {
              const settings = JSON.parse(value)
              if (settings && typeof settings === 'object' && !('welcomeSeenVersion' in settings)) {
                settings.welcomeSeenVersion = version
              }
              return JSON.stringify(settings)
            } catch {
              return value
            }
          }
          Storage.prototype.setItem = function (key: string, value: string) {
            setItem.call(this, key, key === KEY ? seen(String(value)) : value)
          }
          // Written once the page is parsed: after every spec's own init
          // script (one that seeds the settings only when there are none
          // still sees none, one that clears the storage is undone), before
          // the app's module runs
          document.addEventListener('readystatechange', () => {
            if (document.readyState !== 'interactive') return
            try {
              localStorage.setItem(KEY, localStorage.getItem(KEY) ?? '{}')
            } catch {
              // No storage here (about:blank)
            }
          })
        }, WELCOME_VERSION)
      }
      await use()
    },
    { auto: true },
  ],
})
