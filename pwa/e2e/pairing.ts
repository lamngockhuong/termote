import { type APIRequestContext, type Browser, expect, type Page } from './fixtures'

// Pairing new browsers against a server with sign-in on, shared by the
// specs that need a paired device (devices, prompt templates).

export interface Code {
  code: string
  url: string
}

// A code made the way the CLI makes one: Basic auth, JSON, no Origin.
export async function makeCode(request: APIRequestContext, role: 'view' | 'full', name: string) {
  const res = await request.post('/api/mux/devices/pair', { data: { role, name } })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()) as Code
}

export async function deviceId(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.get('/api/mux/devices')
  expect(res.status()).toBe(200)
  const { devices } = (await res.json()) as { devices: { id: string; name: string }[] }
  const id = devices.find((d) => d.name === name)?.id
  expect(id, `device ${name} listed`).toBeTruthy()
  return id as string
}

// A browser that never had the password: no Basic credentials, no cookie.
// setup runs on the page before it loads anything (watchViolations).
export async function stranger(
  browser: Browser,
  baseURL: string | undefined,
  setup?: (page: Page) => Promise<unknown>,
): Promise<Page> {
  const context = await browser.newContext({ baseURL })
  // The first-visit gesture tour would cover the page on a phone
  await context.addInitScript(() => {
    localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true }))
  })
  const page = await context.newPage()
  await setup?.(page)
  return page
}

// Pairs a new browser with code, from the link the QR code carries.
export async function pairStranger(
  browser: Browser,
  baseURL: string | undefined,
  code: string,
  setup?: (page: Page) => Promise<unknown>,
) {
  const page = await stranger(browser, baseURL, setup)
  await page.goto(`/pair?code=${encodeURIComponent(code)}`)
  await page.getByRole('button', { name: 'Pair' }).click()
  await expect(page).toHaveURL(/\/(#.*)?$/)
  return page
}

