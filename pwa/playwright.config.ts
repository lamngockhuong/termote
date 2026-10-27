import { execFileSync } from 'node:child_process'
import { defineConfig } from '@playwright/test'

// Credentials of the server under test: TERMOTE_NO_AUTH=true for a server
// started without auth (CI), TERMOTE_PASS, else what `termote show-password`
// prints for the saved config.
function getCredentials(): { username: string; password: string } | null {
  if (process.env.TERMOTE_NO_AUTH === 'true') return null
  const user = process.env.TERMOTE_USER || 'admin'
  if (process.env.TERMOTE_PASS) {
    return { username: user, password: process.env.TERMOTE_PASS }
  }
  try {
    const out = execFileSync('termote', ['show-password'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    const username = out.match(/^Username: (.*)$/m)?.[1]
    const password = out.match(/^Password: (.*)$/m)?.[1]
    if (username && password) return { username, password }
  } catch {
    // No installed command or no saved config
  }
  // Auth disabled in the saved config, or nothing to read it from
  return null
}

const credentials = getCredentials()

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    // 127.0.0.1, as `termote url` prints: through localhost the page shows
    // a notice, and the browser tries ::1 first on every connection
    baseURL: `http://127.0.0.1:${process.env.TERMOTE_PORT || '7680'}`,
    ...(credentials ? { httpCredentials: credentials } : {}),
    // There are no retries: a trace kept on failure is the only record of
    // what the page saw when a test fails now and then on CI
    trace: 'retain-on-failure',
    video: 'on-first-retry',
  },
})
