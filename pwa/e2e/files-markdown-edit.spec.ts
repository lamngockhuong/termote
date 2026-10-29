import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, type Page, test } from './fixtures'

// Editing a Markdown file beside its preview: the layouts and how they are
// kept, the preview following the text, the two sides scrolling together,
// an image pasted next to the file, and Back after a link of the preview.

const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' })

// A 4×3 PNG
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGO4o6EBRww4OQAa3g4RLYR9sQAAAABJRU5ErkJggg=='

// Long enough to scroll: sections each with a heading and a paragraph
const GUIDE = [
  '# Guide',
  '',
  'See [the other file](other.md).',
  '',
  ...Array.from({ length: 40 }, (_, i) => [`## Section ${i + 1}`, '', `Text of section ${i + 1}.`, '']).flat(),
].join('\n')

// The desktop editor is CodeMirror: typed over all at once (see
// files-changes.spec.ts), read back line by line
async function typeInEditor(box: Locator, text: string) {
  await box.click()
  await box.page().keyboard.press('ControlOrMeta+A')
  await box.page().keyboard.insertText(text)
}

const layoutOf = (panel: Locator) => panel.locator('[data-layout]')

test.describe('editing Markdown beside its preview', () => {
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

    repo = mkdtempSync(path.join(tmpdir(), 'termote-e2e-md-'))
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'e2e@example.com')
    git(repo, 'config', 'user.name', 'e2e')
    mkdirSync(path.join(repo, 'docs'))
    writeFileSync(path.join(repo, 'docs/guide.md'), `${GUIDE}\n`)
    writeFileSync(path.join(repo, 'docs/other.md'), '# Other\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')

    const name = `md-${Date.now()}`
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

  // The Files panel wide enough for both sides (side by side from 768px of
  // the viewer itself); set once, so a layout chosen survives a reload
  async function openGuide(page: Page) {
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.addInitScript(() => {
      if (!localStorage.getItem('termote-settings'))
        localStorage.setItem('termote-settings', JSON.stringify({ sidePanelWidth: 1200 }))
    })
    await page.goto(`${link}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    await panel.getByRole('treeitem', { name: 'docs' }).click()
    await panel.getByRole('treeitem', { name: 'guide.md' }).click()
    await expect(panel.getByRole('heading', { name: 'Guide', exact: true })).toBeVisible()
    return panel
  }

  test('edits beside a preview that follows the text; the layout is kept and undo survives it', async ({ page }) => {
    const panel = await openGuide(page)
    await panel.getByRole('button', { name: 'Edit', exact: true }).click()
    const box = panel.getByRole('textbox', { name: 'Text of docs/guide.md' })
    await expect(box).toBeVisible()
    await expect(layoutOf(panel)).toHaveAttribute('data-layout', 'split')
    const preview = panel.getByTestId('markdown-preview')
    await expect(preview.getByRole('heading', { name: 'Section 40' })).toBeAttached()

    await typeInEditor(box, '# Live heading\n\nNew text.\n')
    await expect(preview.getByRole('heading', { name: 'Live heading' })).toBeVisible()
    await expect(preview.getByRole('heading', { name: 'Guide', exact: true })).toHaveCount(0)

    // Preview alone, then the source: the editor was kept, so undo still
    // brings the file's text back
    await panel.getByRole('button', { name: 'Switch to preview', exact: true }).click()
    await expect(layoutOf(panel)).toHaveAttribute('data-layout', 'preview')
    await expect(box).toBeHidden()
    await panel.getByRole('button', { name: 'Switch to source', exact: true }).click()
    await expect(layoutOf(panel)).toHaveAttribute('data-layout', 'source')
    await box.click()
    await page.keyboard.press('ControlOrMeta+Z')
    await page.keyboard.press('ControlOrMeta+Home')
    await expect(box.locator('.cm-line').first()).toHaveText('# Guide')

    // Kept on this device: a reload opens the draft in the same layout
    await typeInEditor(box, '# Kept\n')
    await panel.getByRole('button', { name: 'Switch to source and preview', exact: true }).click()
    await panel.getByRole('button', { name: 'Switch to preview', exact: true }).click()
    await page.reload()
    await expect(layoutOf(panel)).toHaveAttribute('data-layout', 'preview')
    await panel.getByRole('button', { name: 'Switch to source', exact: true }).click()
    await panel.getByRole('button', { name: 'Switch to source and preview', exact: true }).click()
    await expect(layoutOf(panel)).toHaveAttribute('data-layout', 'split')
    await panel.getByRole('button', { name: 'Cancel editing' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click()
  })

  test('the editor and the preview scroll together', async ({ page }) => {
    const panel = await openGuide(page)
    await panel.getByRole('button', { name: 'Edit', exact: true }).click()
    const box = panel.getByRole('textbox', { name: 'Text of docs/guide.md' })
    await expect(box).toBeVisible()
    const preview = panel.getByTestId('markdown-preview')
    const scroller = panel.locator('.cm-scroller')
    // The editor halfway down: the section at its top comes to the top of
    // the preview (CodeMirror draws only the lines in view)
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight / 2
    })
    const topSection = () =>
      scroller.evaluate((el) => {
        const top = el.getBoundingClientRect().top
        const line = Array.from(el.querySelectorAll('.cm-line')).find(
          (l) => l.getBoundingClientRect().bottom > top && /^## Section \d+$/.test(l.textContent ?? ''),
        )
        return Number(line?.textContent?.replace('## Section ', '') ?? 0)
      })
    // CodeMirror draws the lines scrolled to in a frame after the scroll
    await expect.poll(topSection).toBeGreaterThan(5)
    const n = await topSection()
    const heading = preview.getByRole('heading', { name: `Section ${n}`, exact: true })
    await expect(async () => {
      const [h, p] = await Promise.all([heading.boundingBox(), preview.boundingBox()])
      expect(h).not.toBeNull()
      expect(p).not.toBeNull()
      expect(Math.abs((h as { y: number }).y - (p as { y: number }).y)).toBeLessThan(120)
    }).toPass()
    // And back: the preview to the top, the editor follows
    await preview.evaluate((el) => {
      el.scrollTop = 0
    })
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeLessThan(30)
    await panel.getByRole('button', { name: 'Cancel editing' }).click()
  })

  test('an image pasted is saved next to the file and linked where the cursor was', async ({ page }) => {
    const panel = await openGuide(page)
    await panel.getByRole('button', { name: 'Edit', exact: true }).click()
    const box = panel.getByRole('textbox', { name: 'Text of docs/guide.md' })
    await typeInEditor(box, 'Before\n')
    await page.keyboard.press('ControlOrMeta+End')
    await box.evaluate((el, png) => {
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], 'shot.png', { type: 'image/png' }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, RED_PNG)
    await expect(box).toContainText(/!\[pasted-\d{8}-\d{6}\]\(pasted-\d{8}-\d{6}\.png\)/)
    const saved = readdirSync(path.join(repo, 'docs')).filter((n) => /^pasted-.*\.png$/.test(n))
    expect(saved).toHaveLength(1)
    expect(readFileSync(path.join(repo, 'docs', saved[0])).toString('base64')).toBe(RED_PNG)
    // Undo takes the link out
    await page.keyboard.press('ControlOrMeta+Z')
    await expect(box).not.toContainText('pasted-')
    await panel.getByRole('button', { name: 'Cancel editing' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click()
  })

  test('Back after a link of the preview returns to where the editor was', async ({ page }) => {
    const panel = await openGuide(page)
    await panel.getByRole('button', { name: 'Edit', exact: true }).click()
    const box = panel.getByRole('textbox', { name: 'Text of docs/guide.md' })
    await expect(box).toBeVisible()
    const scroller = panel.locator('.cm-scroller')
    await scroller.evaluate((el) => {
      el.scrollTop = 600
    })
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(500)
    // The preview alone (the editor kept where it is), the link followed
    await panel.getByRole('button', { name: 'Switch to preview', exact: true }).click()
    await panel.getByTestId('markdown-preview').getByRole('button', { name: 'the other file' }).click()
    await expect(panel.getByRole('heading', { name: 'Other' })).toBeVisible()
    await panel.getByRole('button', { name: 'Back to guide.md' }).click()
    // Back with the draft: the editor, shown again, is where it was left
    await panel.getByRole('button', { name: 'Switch to source', exact: true }).click()
    await expect(box).toBeVisible()
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(500)
  })
})
