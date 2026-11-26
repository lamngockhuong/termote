import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, type Locator, type Page, test } from './fixtures'
import { libraryJson, obsidianMarkdown, pngWithScene, RECT, sceneJson, svgWithScene, TEXT } from './fixtures/drawings'

// Excalidraw files in Files, shown and changed in Excalidraw itself, against
// a pane whose directory is a throwaway folder in a window of the server's
// tmux (as document-preview.spec). The fixture fails a test on any CSP
// violation: the editor, its fonts and its workers must all keep to the
// page's policy, and no request may leave this origin.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'

const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })

test.describe('Excalidraw files', () => {
  test.skip(!socket || process.platform !== 'linux', 'needs TMUX_SOCKET of the server under test (Linux)')
  test.describe.configure({ mode: 'serial' })
  // The editor's chunk loads the first time
  test.setTimeout(60_000)

  let dir = ''
  let windowId = ''
  let link = ''
  const file = (name: string) => path.join(dir, name)

  test.beforeAll(async ({ playwright }, testInfo) => {
    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      httpCredentials: testInfo.project.use.httpCredentials,
    })
    const snap = await (await api.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.files, 'the backend reports no pane directory')

    dir = mkdtempSync(path.join(tmpdir(), 'termote-e2e-drawing-'))
    writeFileSync(file('plan.excalidraw'), sceneJson())
    writeFileSync(file('cancel.excalidraw'), sceneJson())
    writeFileSync(file('shapes.excalidrawlib'), libraryJson())
    writeFileSync(file('flow.excalidraw.svg'), svgWithScene())
    writeFileSync(file('flow.excalidraw.png'), pngWithScene())
    writeFileSync(file('Drawing.excalidraw.md'), obsidianMarkdown())
    writeFileSync(file('broken.excalidraw'), '{ not a drawing')
    // A text linked to a note as Obsidian links them
    writeFileSync(file('links.excalidraw'), sceneJson([RECT, { ...TEXT, link: '[[Note A]]' }]))
    writeFileSync(file('Note A.md'), '# Note A\n\nThe drawing links here.\n')

    const name = `drawing-${Date.now()}`
    windowId = tmux(
      'new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', name, '-c', dir, 'bash',
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
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  // Files open at the folder, desktop size; every request stays on this
  // origin, and the fonts Excalidraw fetches are found
  async function openFile(page: Page, name: string) {
    const host = new URL(test.info().project.use.baseURL as string).host
    const foreign: string[] = []
    const fonts: number[] = []
    page.on('request', (r) => {
      const u = new URL(r.url())
      // blob: and data: URLs are the page's own
      if (['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) && u.host !== host) foreign.push(r.url())
    })
    page.on('response', (r) => {
      if (r.url().includes('/assets/drawing/excalidraw-')) fonts.push(r.status())
    })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    await panel.getByRole('treeitem', { name }).click()
    return { panel, foreign, fonts }
  }

  // The drawing's canvas, once Excalidraw shows it
  async function canvasOf(panel: Locator) {
    const drawing = panel.getByTestId('drawing')
    await expect(drawing.locator('canvas.interactive')).toBeVisible({ timeout: 20_000 })
    return drawing
  }

  // A rectangle drawn with the tool's key, from (x, y), as fractions of the
  // canvas, to 80 by 60 pixels further
  async function drawRectangle(page: Page, drawing: Locator, x = 0.2, y = 0.6) {
    const box = (await drawing.boundingBox())!
    await page.mouse.click(box.x + 20, box.y + box.height - 120)
    await page.keyboard.press('r')
    const from = { x: box.x + box.width * x, y: box.y + box.height * y }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 80, from.y + 60, { steps: 5 })
    await page.mouse.up()
  }

  const count = (text: string, type: string) => (text.match(new RegExp(`"type":\\s*"${type}"`, 'g')) ?? []).length

  test('a scene: drawn, changed and saved as the file, its fonts from this origin', async ({ page }) => {
    const { panel, foreign, fonts } = await openFile(page, 'plan.excalidraw')
    const drawing = await canvasOf(panel)
    await expect(panel.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
    // Nothing changed yet: no Save, no Edit of the source
    await expect(panel.getByRole('button', { name: 'Save' })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Edit' })).toHaveCount(0)

    await drawRectangle(page, drawing)
    const save = panel.getByRole('button', { name: 'Save' })
    await expect(save).toBeEnabled()
    await save.click()
    await expect(page.getByText('Saved')).toBeVisible()
    await expect(save).toHaveCount(0)
    const saved = readFileSync(file('plan.excalidraw'), 'utf8')
    expect(count(saved, 'rectangle')).toBe(2)
    // The file keeps its own source, never this server's address
    expect(saved).toContain('"source": "https://excalidraw.com"')
    expect(saved).not.toContain(new URL(test.info().project.use.baseURL as string).host)
    expect(count(saved, 'text')).toBe(1)
    // The drawing stays as it was drawn: one more change saves with Ctrl+S
    await drawRectangle(page, drawing, 0.5, 0.75)
    await expect(panel.getByRole('button', { name: 'Save' })).toBeEnabled()
    await page.keyboard.press('Control+s')
    await expect(panel.getByRole('button', { name: 'Save' })).toHaveCount(0)
    expect(count(readFileSync(file('plan.excalidraw'), 'utf8'), 'rectangle')).toBe(3)

    expect(fonts.length).toBeGreaterThan(0)
    expect(fonts.every((s) => s === 200)).toBe(true)
    expect(foreign).toEqual([])
  })

  test('Preview off shows the source; a change cancelled leaves the file', async ({ page }) => {
    const before = readFileSync(file('cancel.excalidraw'), 'utf8')
    const { panel } = await openFile(page, 'cancel.excalidraw')
    const drawing = await canvasOf(panel)
    await drawRectangle(page, drawing)
    await panel.getByRole('button', { name: 'Cancel editing' }).click()
    await page.getByRole('button', { name: 'Discard' }).click()
    await expect(panel.getByRole('button', { name: 'Save' })).toHaveCount(0)
    await canvasOf(panel)
    expect(readFileSync(file('cancel.excalidraw'), 'utf8')).toBe(before)

    await panel.getByRole('button', { name: 'Preview' }).click()
    await expect(panel.getByTestId('drawing')).toHaveCount(0)
    await expect(panel.getByText('"rectangle"').first()).toBeVisible()
    // Turned on again for the next tests (kept on this device)
    await panel.getByRole('button', { name: 'Preview' }).click()
    await canvasOf(panel)
  })

  test('a library: its items beside the canvas', async ({ page }) => {
    const { panel, foreign } = await openFile(page, 'shapes.excalidrawlib')
    await canvasOf(panel)
    await expect(panel.getByText('Only the library is saved')).toBeVisible()
    await expect(panel.locator('.library-unit')).toHaveCount(1)
    // Nothing that leads to Excalidraw's library site
    await expect(panel.locator('.library-menu-browse-button')).toBeHidden()
    expect(foreign).toEqual([])
  })

  test('an SVG with the scene: changed and saved as an SVG holding it', async ({ page }) => {
    const { panel, foreign } = await openFile(page, 'flow.excalidraw.svg')
    const drawing = await canvasOf(panel)
    // Its drawing, not the image
    await expect(panel.getByRole('button', { name: 'Image' })).toHaveCount(0)
    await drawRectangle(page, drawing)
    await panel.getByRole('button', { name: 'Save' }).click()
    await expect(panel.getByRole('button', { name: 'Save' })).toHaveCount(0)
    const saved = readFileSync(file('flow.excalidraw.svg'), 'utf8')
    expect(saved.startsWith('<svg')).toBe(true)
    expect(saved).toContain('payload-type:application/vnd.excalidraw+json')
    expect(saved).toContain('<!-- payload-start -->')
    // The SVG written opens as a drawing again
    await panel.getByRole('button', { name: 'Preview' }).click()
    await panel.getByRole('button', { name: 'Preview' }).click()
    await canvasOf(panel)
    await expect(panel.getByText('This file holds no drawing')).toHaveCount(0)
    expect(foreign).toEqual([])
  })

  test('a PNG with the scene: shown only', async ({ page }) => {
    const { panel, foreign } = await openFile(page, 'flow.excalidraw.png')
    await canvasOf(panel)
    await expect(panel.getByText('A PNG drawing is shown only')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Save' })).toHaveCount(0)
    // Preview off: the image
    await panel.getByRole('button', { name: 'Preview' }).click()
    await expect(panel.getByRole('img', { name: /flow\.excalidraw\.png/ })).toBeVisible()
    await panel.getByRole('button', { name: 'Preview' }).click()
    await canvasOf(panel)
    expect(foreign).toEqual([])
  })

  test("an Obsidian drawing: saved in its Markdown, the texts listed", async ({ page }) => {
    const { panel } = await openFile(page, 'Drawing.excalidraw.md')
    const drawing = await canvasOf(panel)
    await drawRectangle(page, drawing)
    await panel.getByRole('button', { name: 'Save' }).click()
    await expect(panel.getByRole('button', { name: 'Save' })).toHaveCount(0)
    const saved = readFileSync(file('Drawing.excalidraw.md'), 'utf8')
    expect(saved.startsWith('---\n\nexcalidraw-plugin: parsed\n')).toBe(true)
    // The text left as it was keeps its line, link and all
    expect(saved).toContain('## Text Elements\nHello [[drawing]] ^text1\n\n%%\n## Drawing\n```compressed-json\n')
    expect(saved.endsWith('```\n%%\n')).toBe(true)
    await panel.getByRole('button', { name: 'Preview' }).click()
    await panel.getByRole('button', { name: 'Preview' }).click()
    await canvasOf(panel)
    await expect(panel.getByText('This file holds no drawing')).toHaveCount(0)
  })

  test("an element's wiki link opens the note in Files, never a page of this site", async ({ page }) => {
    const { panel } = await openFile(page, 'links.excalidraw')
    const drawing = await canvasOf(panel)
    const before = new URL(page.url()).pathname
    // The linked text (at 120, 260 of the scene, which opens unscrolled):
    // selected, its link shows in a popup
    const box = (await drawing.boundingBox())!
    await page.mouse.click(box.x + 150, box.y + 272)
    const link = panel.locator('.excalidraw-hyperlinkContainer-link')
    await expect(link).toBeVisible()
    await link.click()
    await expect(panel.getByText('The drawing links here.')).toBeVisible()
    expect(new URL(page.url()).pathname).toBe(before)
  })

  test("the menu and Help keep no link to Excalidraw's sites", async ({ page }) => {
    const { panel } = await openFile(page, 'plan.excalidraw')
    await canvasOf(panel)
    await panel.getByTestId('main-menu-trigger').click()
    const help = panel.getByRole('button', { name: 'Help' })
    await expect(help).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Reset the canvas' })).toBeVisible()
    for (const name of ['GitHub', 'Follow us', 'Discord chat', 'Excalidraw links'])
      await expect(panel.getByText(name)).toHaveCount(0)
    await help.click()
    // Its shortcuts, outside the drawing's element, without the links atop
    await expect(page.locator('.HelpDialog')).toBeVisible()
    await expect(page.getByText('Keep selected tool active after drawing')).toBeVisible()
    await expect(page.getByRole('link', { name: /Documentation|blog|Found an issue|YouTube/ })).toHaveCount(0)
  })

  test('a file that holds no drawing says so', async ({ page }) => {
    const { panel } = await openFile(page, 'broken.excalidraw')
    await expect(panel.getByText('This file holds no drawing Excalidraw can read')).toBeVisible({ timeout: 20_000 })
  })
})
