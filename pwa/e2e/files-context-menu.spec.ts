import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, type Page, test } from './fixtures'

// The menus a right click opens in Files, against a pane whose directory is a
// throwaway repo of its own, in a window of the server's tmux (TMUX_SOCKET,
// TMUX_SESSION), so its root is no other spec's.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })

test.describe('files context menu', () => {
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
    test.skip(!snap.caps.files, 'the backend reports no pane directory')

    // The root the server reports is the resolved one
    repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'termote-e2e-menu-')))
    git(repo, 'init', '-q', '-b', 'main')
    mkdirSync(path.join(repo, 'src'))
    writeFileSync(path.join(repo, 'src', 'app.ts'), 'export {}\n')
    writeFileSync(path.join(repo, 'README.md'), 'menu spec\n')

    const name = `menu-${Date.now()}`
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

  // The Files panel of the repo's pane, on a desktop
  async function openFiles(page: Page) {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    await expect(panel.getByRole('treeitem', { name: 'README.md' })).toBeVisible()
    return panel
  }

  test('copies the relative and the absolute path of a file', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const panel = await openFiles(page)
    const row = panel.getByRole('treeitem', { name: 'README.md' })
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy relative path' }).click()
    await expect(page.getByText('Path copied')).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('README.md')
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy absolute path' }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(path.join(repo, 'README.md'))
  })

  test('makes a file and a folder in the folder right clicked', async ({ page }) => {
    const tag = Date.now().toString(36)
    const panel = await openFiles(page)
    const src = panel.getByRole('treeitem', { name: 'src' })

    await src.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'New file' }).click()
    const box = page.getByRole('dialog', { name: 'New file' }).getByRole('textbox')
    await expect(box).toHaveValue('src/')
    await box.fill(`src/note-${tag}.md`)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect.poll(() => existsSync(path.join(repo, 'src', `note-${tag}.md`))).toBe(true)

    // The new file opened in its tab: back to the tree
    await panel.getByRole('tab', { name: 'Files' }).click()
    await src.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'New folder' }).click()
    const folderBox = page.getByRole('dialog', { name: 'New folder' }).getByRole('textbox')
    await expect(folderBox).toHaveValue('src/')
    await folderBox.fill(`src/dir-${tag}`)
    await page.getByRole('button', { name: 'Create' }).click()
    const made = panel.getByRole('treeitem', { name: `dir-${tag}` })
    await expect(made).toBeVisible()
    await expect(made).toHaveAttribute('aria-expanded', 'true')
    expect(statSync(path.join(repo, 'src', `dir-${tag}`)).isDirectory()).toBe(true)
  })

  test("the tree's empty area collapses every folder", async ({ page }) => {
    const panel = await openFiles(page)
    const src = panel.getByRole('treeitem', { name: 'src' })
    if ((await src.getAttribute('aria-expanded')) !== 'true') await src.click()
    await expect(src).toHaveAttribute('aria-expanded', 'true')
    const tree = panel.getByRole('tree', { name: 'Files' })
    const box = (await tree.boundingBox())!
    // Below the last row
    await tree.click({ button: 'right', position: { x: 20, y: box.height - 10 } })
    await page.getByRole('menuitem', { name: 'Collapse all' }).click()
    await expect(src).toHaveAttribute('aria-expanded', 'false')
  })

  test("types a file's @path into the pane, without Enter", async ({ page }) => {
    const panel = await openFiles(page)
    const src = panel.getByRole('treeitem', { name: 'src' })
    if ((await src.getAttribute('aria-expanded')) !== 'true') await src.click()
    await panel.getByRole('treeitem', { name: 'app.ts' }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Insert @path in terminal' }).click()
    await expect.poll(() => tmux('capture-pane', '-p', '-t', windowId)).toContain('@src/app.ts')
    // Never run: the line is still being typed
    expect(tmux('capture-pane', '-p', '-t', windowId)).not.toContain('command not found')
    tmux('send-keys', '-t', windowId, 'C-u')
  })
})
