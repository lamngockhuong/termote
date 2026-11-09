import { spawnSync } from 'node:child_process'
import { type Browser, expect, type Page, test } from './fixtures'
import { WELCOME_VERSION } from '../src/utils/welcome'

// An agent proposes settings with the CLI (termote settings propose), which
// reaches only the server's local socket: a native server started from a
// saved config, in its own HOME and XDG dirs (the CI job's settings server).
// TERMOTE_E2E_SETTINGS_CLI is its binary and TERMOTE_E2E_SETTINGS_ROOT the
// dir holding its home, config and state; without them the spec skips.
const cli = process.env.TERMOTE_E2E_SETTINGS_CLI
const root = process.env.TERMOTE_E2E_SETTINGS_ROOT

function propose(json: string) {
  const env: NodeJS.ProcessEnv = {}
  // The saved config names the port: no TERMOTE_* of the runner's servers
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TERMOTE_')) env[k] = v
  Object.assign(env, {
    HOME: `${root}/home`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_STATE_HOME: `${root}/state`,
    XDG_CACHE_HOME: `${root}/cache`,
    XDG_DATA_HOME: `${root}/data`,
  })
  return spawnSync(cli as string, ['settings', 'propose', json], { env, encoding: 'utf-8' })
}

// Another browser, as the fixtures set one up: the welcome screen seen, no
// release check, light mode
async function openBrowser(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, colorScheme: 'light' })
  await context.addInitScript((version) => {
    if (!localStorage.getItem('termote-settings'))
      localStorage.setItem('termote-settings', JSON.stringify({ welcomeSeenVersion: version }))
    localStorage.setItem(
      'termote-update-check',
      JSON.stringify({ version: '1.0.0', url: '', checkedAt: Date.now() }),
    )
  }, WELCOME_VERSION)
  return context
}

const bar = (page: Page) => page.getByRole('status').filter({ hasText: /An agent proposes \d+ settings change/ })

const stored = (page: Page) =>
  page.evaluate(() => ({
    settings: JSON.parse(localStorage.getItem('termote-settings') ?? '{}'),
    theme: localStorage.getItem('termote-theme'),
  }))

async function openTransfer(page: Page) {
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await page
    .getByRole('navigation', { name: 'Settings groups' })
    .getByRole('button', { name: 'Export & import' })
    .click()
}

test.describe('settings proposed by an agent', () => {
  test.skip(!cli || !root, 'needs TERMOTE_E2E_SETTINGS_CLI and TERMOTE_E2E_SETTINGS_ROOT (a native server)')
  test.describe.configure({ mode: 'serial' })

  test('the CLI refuses a value the schema does not take', () => {
    const r = propose('{"editorFontSize":99,"nope":1}')
    expect(r.status, r.stderr).toBe(1)
    expect(r.stderr).toContain('editorFontSize: must be one of')
    expect(r.stderr).toContain('nope: unknown setting')
  })

  test('each browser applies or dismisses it for itself', async ({ browser, baseURL }) => {
    // Three pages, a few snapshot polls and an export and import
    test.setTimeout(90_000)
    const a = await openBrowser(browser, baseURL)
    const b = await openBrowser(browser, baseURL)
    const pageA = await a.newPage()
    const pageA2 = await a.newPage()
    const pageB = await b.newPage()
    for (const p of [pageA, pageA2, pageB]) await p.goto('/')
    await expect(pageA.locator('html')).not.toHaveClass(/dark/)

    const r = propose('{"editorVim":true,"theme":"dark"}')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Proposed 2 changes')
    // Within a poll of the snapshot (5 s by default)
    for (const p of [pageA, pageA2, pageB]) await expect(bar(p)).toBeVisible({ timeout: 15000 })

    await bar(pageA).getByRole('button', { name: 'Review' }).click()
    const dialog = pageA.getByRole('dialog', { name: 'Settings an agent proposes' })
    await expect(dialog.getByRole('rowheader', { name: 'Theme' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Apply' }).click()
    // At once, without a reload, in both tabs of A
    await expect(pageA.locator('html')).toHaveClass(/dark/)
    await expect(pageA2.locator('html')).toHaveClass(/dark/)
    await expect(bar(pageA)).toBeHidden()
    await expect(bar(pageA2)).toBeHidden()
    expect((await stored(pageA)).settings.editorVim).toBe(true)

    // B is another browser: unchanged until it decides
    await expect(pageB.locator('html')).not.toHaveClass(/dark/)
    expect((await stored(pageB)).settings.editorVim).not.toBe(true)
    await expect(bar(pageB)).toBeVisible()
    await bar(pageB).getByRole('button', { name: 'Dismiss' }).click()
    await expect(bar(pageB)).toBeHidden()
    await pageB.reload()
    // Two snapshot reads later, still nothing
    for (let i = 0; i < 2; i++)
      await pageB.waitForResponse((res) => res.url().includes('/api/mux/snapshot'), { timeout: 15000 })
    await expect(bar(pageB)).toBeHidden()
    expect((await stored(pageB)).theme).toBeNull()

    // Export in A, import in B: B gets A's settings, not A's own
    await openTransfer(pageA)
    const download = pageA.waitForEvent('download')
    await pageA.getByRole('button', { name: 'Save to a file' }).click()
    const file = await (await download).path()
    await openTransfer(pageB)
    await pageB.getByLabel('Settings file to import').setInputFiles(file)
    await pageB
      .getByRole('dialog', { name: 'Import settings' })
      .getByRole('button', { name: 'Apply' })
      .click()
    await expect(pageB.locator('html')).toHaveClass(/dark/)
    const [fromA, inB] = [await stored(pageA), await stored(pageB)]
    expect(inB.theme).toBe('dark')
    expect(inB.settings.editorVim).toBe(true)
    // Device-only settings stay each browser's
    expect(inB.settings.welcomeSeenVersion).toBe(fromA.settings.welcomeSeenVersion)
    await a.close()
    await b.close()
  })
})
