import { defineConfig } from '@playwright/test'

// The interactive demo (src/demo): the built demo (pnpm build:demo) served
// by vite preview at /demo/, as the website serves it. No Termote server:
// the page answers its own requests.
const PORT = 7689

export default defineConfig({
  testDir: './e2e',
  testMatch: 'demo.spec.ts',
  timeout: 30000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}/demo/`,
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite preview --mode demo --outDir dist-demo --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/demo/`,
    reuseExistingServer: !process.env.CI,
  },
})
