import { execFileSync } from 'node:child_process'
import { closeSync, copyFileSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from './fixtures'
import { bigWorkbook, docx, image, PNG, p, workbook } from './fixtures/docs/office'

// PDF, .xlsx and .docx previews in Files, against a pane whose directory is a
// throwaway git repo in a window of the server's tmux (as files-changes.spec).
// Every file is parsed in a worker; the fixture fails a test on any CSP
// violation, the page's or a worker's.
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'
const docs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/docs')

const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })

// The word document: a heading, a merged cell, links that must not survive
// (javascript:, an anchor) and one that must, an image
const MEMO = docx(
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Release memo</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${p('merged cell')}</w:tc></w:tr><w:tr><w:tc>${p('left')}</w:tc><w:tc>${p('right')}</w:tc></w:tr></w:tbl>
<w:p><w:hyperlink r:id="rBad"><w:r><w:t>bad link</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> </w:t></w:r><w:hyperlink w:anchor="top"><w:r><w:t>anchor link</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> </w:t></w:r><w:hyperlink r:id="rGood"><w:r><w:t>good link</w:t></w:r></w:hyperlink></w:p>
${image('rImg0')}`,
  { 'image1.png': PNG },
)

test.describe('document previews', () => {
  test.skip(!socket || process.platform !== 'linux', 'needs TMUX_SOCKET of the server under test (Linux)')
  test.describe.configure({ mode: 'serial' })
  // The viewers' chunks load the first time
  test.setTimeout(60_000)

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

    repo = mkdtempSync(path.join(tmpdir(), 'termote-e2e-docs-'))
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'])
    for (const f of ['pages.pdf', 'japanese.pdf', 'jpx.pdf']) copyFileSync(path.join(docs, f), path.join(repo, f))
    copyFileSync(path.join(docs, 'pages.pdf'), path.join(repo, 'secrets.pdf'))
    writeFileSync(path.join(repo, 'cases.xlsx'), Buffer.from(workbook()))
    writeFileSync(path.join(repo, 'big.xlsx'), Buffer.from(bigWorkbook()))
    writeFileSync(path.join(repo, 'memo.docx'), Buffer.from(MEMO))
    // Saved with a password: an OLE compound file, not a zip
    writeFileSync(
      path.join(repo, 'locked.xlsx'),
      Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(512)]),
    )
    // Over 30 MiB, sparse: refused by its size, never read
    const fd = openSync(path.join(repo, 'huge.pdf'), 'w')
    ftruncateSync(fd, 31 << 20)
    closeSync(fd)
    writeFileSync(path.join(repo, 'notes.txt'), 'plain text\n')

    const name = `docs-${Date.now()}`
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

  // Files open at the repo, desktop size; every request stays on this origin
  async function openFiles(page: Page) {
    const host = new URL(test.info().project.use.baseURL as string).host
    const foreign: string[] = []
    page.on('request', (r) => {
      const u = new URL(r.url())
      // blob: and data: URLs are the page's own
      if (['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) && u.host !== host) foreign.push(r.url())
    })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${link}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    await expect(panel.getByRole('treeitem', { name: 'pages.pdf' })).toBeVisible()
    return { panel, foreign }
  }

  test('a PDF: pages, find on page 3, zoom', async ({ page }) => {
    const { panel, foreign } = await openFiles(page)
    await panel.getByRole('treeitem', { name: 'pages.pdf' }).click()
    const pdf = panel.getByRole('toolbar', { name: 'PDF' })
    await expect(pdf.getByText('Page 1 of 3')).toBeVisible({ timeout: 20_000 })
    await expect(panel.locator('.textLayer').first()).toContainText('Page one of the spec')

    await pdf.getByRole('button', { name: 'Find' }).click()
    await panel.getByRole('textbox', { name: 'Find' }).fill('zebra')
    await expect(panel.getByText('1 of 1')).toBeVisible()
    await expect(panel.locator('.textLayer').filter({ hasText: 'zebra crossing' })).toBeVisible()
    await expect(pdf.getByText('Page 3 of 3')).toBeVisible()

    const zoom = pdf.getByText(/^\d+%$/)
    const before = await zoom.textContent()
    await pdf.getByRole('button', { name: 'Zoom in' }).click()
    await expect(zoom).not.toHaveText(before as string)
    expect(foreign).toEqual([])
  })

  test('a PDF in Japanese and one with a JPEG 2000 image', async ({ page }) => {
    const { panel } = await openFiles(page)
    await panel.getByRole('treeitem', { name: 'japanese.pdf' }).click()
    await expect(panel.locator('.textLayer').first()).toContainText('日本語のテスト', { timeout: 20_000 })

    await panel.getByRole('treeitem', { name: 'jpx.pdf' }).click()
    const canvas = panel.locator('.pdfViewer canvas').first()
    // The middle of the page is the image: red, not blank
    await expect
      .poll(
        () =>
          canvas.evaluate((c: HTMLCanvasElement) => {
            const d = c.getContext('2d')?.getImageData(Math.floor(c.width * 0.4), Math.floor(c.height * 0.4), 1, 1).data
            return d ? d[0] > 150 && d[1] < 100 : false
          }),
        { timeout: 20_000 },
      )
      .toBe(true)
  })

  test('closing a PDF ends its worker', async ({ page }) => {
    const { panel } = await openFiles(page)
    const pdfWorkers = () => page.workers().filter((w) => w.url().includes('pdf.worker')).length
    for (let i = 0; i < 3; i++) {
      await panel.getByRole('treeitem', { name: 'pages.pdf' }).click()
      await expect(panel.getByText('Page 1 of 3')).toBeVisible({ timeout: 20_000 })
      await panel.getByRole('treeitem', { name: 'notes.txt' }).click()
      await expect(panel.getByTestId('code-block')).toContainText('plain text')
      await expect.poll(pdfWorkers).toBe(0)
    }
  })

  test('a workbook: sheet tabs, formula values, find', async ({ page }) => {
    const { panel } = await openFiles(page)
    await panel.getByRole('treeitem', { name: 'cases.xlsx' }).click()
    const tabs = panel.getByRole('tablist', { name: 'Sheets' })
    await expect(tabs.getByRole('tab')).toHaveText(['Cases', 'Notes'], { timeout: 20_000 })
    await expect(panel.getByText('1 hidden sheet')).toBeVisible()
    const grid = panel.getByRole('grid')
    await expect(grid).toContainText('TC-001')
    // The formula's value as last saved
    await expect(grid).toContainText('42')

    await grid.getByText('TC-001').click()
    await page.keyboard.press('ControlOrMeta+F')
    await panel.getByRole('textbox', { name: 'Find' }).fill('TC-001')
    await expect(panel.getByText('1 of 1')).toBeVisible()

    await tabs.getByRole('tab', { name: 'Notes' }).click()
    await expect(panel.getByRole('grid')).toContainText('QA team')
  })

  test('a sheet larger than the table view takes is cut, with Download', async ({ page }) => {
    const { panel } = await openFiles(page)
    await panel.getByRole('treeitem', { name: 'big.xlsx' }).click()
    await expect(panel.getByText(/^Showing the first \d+ rows of 30000/)).toBeVisible({ timeout: 30_000 })
    await expect(panel.getByRole('button', { name: 'Download' }).last()).toBeVisible()
  })

  test('a Word document: table and image, no unsafe link', async ({ page }) => {
    const { panel } = await openFiles(page)
    const hash = await page.evaluate(() => location.hash)
    await panel.getByRole('treeitem', { name: 'memo.docx' }).click()
    const article = panel.locator('article')
    await expect(article.getByRole('heading', { name: 'Release memo' })).toBeVisible({ timeout: 20_000 })
    await expect(article.getByRole('cell', { name: 'merged cell' })).toHaveAttribute('colspan', '2')
    await expect(article.locator('img[src^="data:image/png;base64,"]')).toHaveCount(1)
    await expect(article.getByRole('link')).toHaveCount(1)
    await expect(article.getByRole('link', { name: 'good link' })).toHaveAttribute('target', '_blank')
    await expect(article.locator('a[href^="javascript:"], a[href^="#"], [id]')).toHaveCount(0)
    await article.getByText('anchor link').click()
    expect(await page.evaluate(() => location.hash)).toBe(hash)
  })

  test('a file too large or encrypted says why, with Download', async ({ page }) => {
    const { panel } = await openFiles(page)
    await panel.getByRole('treeitem', { name: 'huge.pdf' }).click()
    await expect(panel.getByText('Larger than 30 MiB (31.0 MiB)')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Download' }).last()).toBeVisible()

    await panel.getByRole('treeitem', { name: 'locked.xlsx' }).click()
    await expect(panel.getByText('Password-protected or encrypted file')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Download' }).last()).toBeVisible()
  })

  test('a document with a sensitive name asks first', async ({ page }) => {
    const { panel } = await openFiles(page)
    await panel.getByRole('treeitem', { name: /^secrets\.pdf/ }).click()
    await expect(page.getByText(/This file may contain secrets/).first()).toBeVisible()
    await expect(panel.getByRole('toolbar', { name: 'PDF' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Show', exact: true }).click()
    await expect(panel.getByText('Page 1 of 3')).toBeVisible({ timeout: 20_000 })
  })
})
