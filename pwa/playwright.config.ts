import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:8080',
    httpCredentials: {
      username: 'admin',
      password: 'admin',
    },
    trace: 'on-first-retry',
    video: 'on-first-retry',
  },
  webServer: {
    command: 'echo "Using existing server"',
    url: 'http://localhost:8080',
    reuseExistingServer: true,
  },
})
