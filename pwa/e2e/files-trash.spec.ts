import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { expect, type Page, test } from './fixtures'

// The Trash of Files against a pane whose directory is a throwaway repo of
// its own, in a window of the server's tmux (TMUX_SOCKET, TMUX_SESSION), so
// its root is no other spec's. A delete moves the file into the server's
// trash with a rename: the repo has to be on the trash's file system, so it
// is made next to TERMOTE_E2E_CACHE (the server's XDG_CACHE_HOME; not passed
// as XDG_CACHE_HOME, where Playwright looks for its browsers) rather than in
// a /tmp that may be a tmpfs.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const cache = process.env.TERMOTE_E2E_CACHE || path.join(homedir(), '.cache')

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })

test.describe('files trash', () => {
  test.skip(!socket || process.platform !== 'linux', 'needs TMUX_SOCKET of the server under test (Linux)')
  test.describe.configure({ mode: 'serial' })

  let repo = ''
  let windowId = ''
  let link = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    const snap = await (await api.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.files || !snap.caps.trash, 'the server offers no Files or no trash')

    mkdirSync(cache, { recursive: true })
    const parent = process.env.TERMOTE_E2E_CACHE ? path.dirname(cache) : tmpdir()
    repo = mkdtempSync(path.join(parent, 'termote-e2e-trash-'))
    test.skip(
      statSync(repo).dev !== statSync(cache).dev,
      `the repo (${repo}) is on another file system than the trash (${cache}): set TERMOTE_E2E_CACHE to the server's XDG_CACHE_HOME`,
    )
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(path.join(repo, 'README.md'), 'trash spec\n')

    const name = `trash-${Date.now()}`
    windowId = tmux(
      'new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', name, '-c', repo, 'bash',
    ).trim()
    let tab: { id: string } | undefined
    let group: { id: string } | undefined
    await expect(async () => {
      const s = await (await api.get('/api/mux/snapshot')).json()
      group = s.groups.find((g: { tabs: { name: string }[] }) => g.tabs.some((t) => t.name === name))
      tab = group?.tabs.find((t: { name: string }) => t.name === name) as { id: string } | undefined
      expect(tab).toBeDefined()
    }).toPass()
    link = `/#/s/${encodeURIComponent(group!.id)}/${encodeURIComponent(tab!.id)}`
    await api.dispose()
  })

  test.afterAll(() => {
    try {
      if (windowId) tmux('kill-window', '-t', windowId)
    } catch {
      // Already gone
    }
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  // Deletes name from the tree's row menu into the trash
  async function deleteFromTree(page: Page, name: string) {
    const panel = page.getByRole('complementary', { name: 'Files' })
    const row = panel.getByRole('treeitem', { name })
    await row.hover()
    await row.getByRole('button', { name: `Actions for ${name}` }).click()
    await page.getByRole('menuitem', { name: /^Delete/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByText(`Deleted ${name}`, { exact: true })).toBeVisible()
    await expect(row).toHaveCount(0)
  }

  test('desktop: restores a deleted file, and deletes another for good', async ({ page }) => {
    const tag = Date.now().toString(36)
    const kept = `kept-${tag}.txt`
    const gone = `gone-${tag}.txt`
    writeFileSync(path.join(repo, kept), 'keep me\n')
    writeFileSync(path.join(repo, gone), 'remove me\n')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    await expect(panel.getByRole('treeitem', { name: kept })).toBeVisible()

    // Deleted, then restored from the Trash while the toast still shows
    await deleteFromTree(page, kept)
    expect(existsSync(path.join(repo, kept))).toBe(false)
    await panel.getByRole('button', { name: 'Trash' }).click()
    const sheet = page.getByRole('dialog', { name: 'Trash' })
    const items = sheet.getByRole('list', { name: 'Deleted items' })
    await expect(items.getByText(kept, { exact: true })).toBeVisible()
    await items.getByRole('button', { name: `Restore ${kept}` }).click()
    await expect(page.getByText(`Restored ${kept}`)).toBeVisible()
    await expect(items.getByText(kept, { exact: true })).toHaveCount(0)
    expect(readFileSync(path.join(repo, kept), 'utf-8')).toBe('keep me\n')
    await sheet.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(panel.getByRole('treeitem', { name: kept })).toBeVisible()

    // Deleted, then deleted for good from the Trash
    await deleteFromTree(page, gone)
    await panel.getByRole('button', { name: 'Trash' }).click()
    await expect(items.getByText(gone, { exact: true })).toBeVisible()
    await items.getByRole('button', { name: `Delete ${gone} permanently` }).click()
    const ask = page.getByRole('dialog', { name: 'Delete permanently?' })
    await ask.getByRole('button', { name: 'Delete permanently' }).click()
    await expect(page.getByText(`Deleted ${gone} permanently`)).toBeVisible()
    await expect(items.getByText(gone, { exact: true })).toHaveCount(0)
    expect(existsSync(path.join(repo, gone))).toBe(false)
    await sheet.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(panel.getByRole('treeitem', { name: gone })).toHaveCount(0)
  })
})
