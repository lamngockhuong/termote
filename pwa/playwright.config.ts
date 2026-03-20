import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:7680',
    httpCredentials: {
      username: 'admin',
      password: 'admin',
    },
    trace: 'on-first-retry',
    video: 'on-first-retry',
  },
})
