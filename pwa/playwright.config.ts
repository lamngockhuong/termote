import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { defineConfig } from '@playwright/test'

function getCredentials(): { username: string; password: string } {
  const user = process.env.TERMOTE_USER || 'admin'

  if (process.env.TERMOTE_PASS) {
    return { username: user, password: process.env.TERMOTE_PASS }
  }

  // Decrypt saved password from ~/.termote/config (same key derivation as termote.sh)
  try {
    const configPath = path.join(homedir(), '.termote', 'config')
    const config = readFileSync(configPath, 'utf-8')

    if (config.match(/TERMOTE_NO_AUTH="true"/)) {
      return { username: '', password: '' }
    }

    const encPass = config.match(/TERMOTE_SAVED_PASS="([A-Za-z0-9+/=]+)"/)?.[1]
    if (encPass) {
      const key = execSync(
        'printf "%s" "$(hostname)-$(whoami)-termote" | openssl dgst -sha256 -r | cut -d\' \' -f1',
        { encoding: 'utf-8' },
      ).trim()
      const pass = execSync(
        `printf '%s' '${encPass}' | openssl enc -aes-256-cbc -a -A -d -salt -pbkdf2 -pass pass:${key}`,
        { encoding: 'utf-8' },
      ).trim()
      if (pass) return { username: user, password: pass }
    }
  } catch {
    // Config not found or decrypt failed
  }

  return { username: user, password: 'admin' }
}

const credentials = getCredentials()

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: `http://localhost:${process.env.TERMOTE_PORT || '7680'}`,
    ...(credentials.password ? { httpCredentials: credentials } : {}),
    trace: 'on-first-retry',
    video: 'on-first-retry',
  },
})
