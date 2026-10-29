import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures'

// A folder outside the pane, allowed on the host (TERMOTE_PLACES in CI's
// own server for this spec): Files lists it under Places, and it is
// browsed, searched, edited and pasted into like the pane's folder, while a
// symlink out of it leads nowhere. TERMOTE_E2E_PLACES names that folder:
// set, the spec fails (never skips) when the server offers no Place.

const placeDir = process.env.TERMOTE_E2E_PLACES

// A 4×3 PNG
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGO4o6EBRww4OQAa3g4RLYR9sQAAAABJRU5ErkJggg=='

// The desktop editor is CodeMirror: typed over all at once
async function typeInEditor(box: Locator, text: string) {
  await box.click()
  await box.page().keyboard.press('ControlOrMeta+A')
  await box.page().keyboard.insertText(text)
}

test.describe('Places in Files', () => {
  test.skip(!placeDir, 'needs TERMOTE_E2E_PLACES and a server with that Place')
  test.describe.configure({ mode: 'serial' })

  let link = ''
  let place = { id: '', name: '', path: '' }
  let outside = ''

  test.beforeAll(async ({ playwright }, testInfo) => {
    const dir = placeDir as string
    // Again from the start on a run after another
    for (const n of readdirSync(dir)) rmSync(path.join(dir, n), { recursive: true, force: true })
    writeFileSync(path.join(dir, 'todo.md'), '# Todo\n\nBuy milk.\n')
    mkdirSync(path.join(dir, 'sub'), { recursive: true })
    writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'a needle here\n')
    outside = mkdtempSync(path.join(tmpdir(), 'termote-e2e-outside-'))
    writeFileSync(path.join(outside, 'secret.txt'), 'NOT-IN-THE-PLACE\n')
    symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'out'))

    const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })
    const snap = await (await api.get('/api/mux/snapshot')).json()
    expect(snap.caps.files, 'the backend reports no pane directory').toBe(true)
    expect(snap.caps.places, 'the server offers no Place').toBe(true)
    const listed = await (await api.get('/api/mux/files/places', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).json()
    expect(listed.places).toHaveLength(1)
    place = listed.places[0]
    const group = snap.groups[0]
    link = `/#/s/${encodeURIComponent(group.id)}/${encodeURIComponent(group.tabs[0].id)}`

    // A symlink out of the Place is refused, never read
    const res = await api.get(
      `/api/mux/panes/${encodeURIComponent(group.tabs[0].id)}/files/content?path=out&place=${place.id}`,
      { headers: { 'Sec-Fetch-Site': 'same-origin' } },
    )
    expect(res.status()).toBe(400)
    expect(await res.text()).not.toContain('NOT-IN-THE-PLACE')
    await api.dispose()
  })

  test.afterAll(() => {
    if (outside) rmSync(outside, { recursive: true, force: true })
  })

  test('browse, edit, find, search and paste in a Place; a reload keeps it', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.addInitScript(() => {
      if (!localStorage.getItem('termote-settings'))
        localStorage.setItem('termote-settings', JSON.stringify({ sidePanelWidth: 1000 }))
    })
    await page.goto(`${link}?view=files`)
    const panel = page.getByRole('complementary', { name: 'Files' })
    const root = panel.getByTestId('pane-root')

    await panel.getByRole('button', { name: 'Places', exact: true }).click()
    await page.getByRole('menuitemradio', { name: place.name }).click()
    await expect(root).toHaveAttribute('title', place.path)
    // The symlink out of it shows no target
    await expect(panel.getByRole('treeitem', { name: /^out/ })).toBeVisible()

    // Edit and save: the file on disk changes
    await panel.getByRole('treeitem', { name: 'todo.md' }).click()
    await panel.getByRole('button', { name: 'Edit', exact: true }).click()
    const box = panel.getByRole('textbox', { name: 'Text of todo.md' })
    await typeInEditor(box, '# Todo\n\nBuy bread.\n')
    await panel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => readFileSync(path.join(placeDir as string, 'todo.md'), 'utf-8')).toBe('# Todo\n\nBuy bread.\n')

    // An image pasted lands in the Place, next to the file
    await panel.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.keyboard.press('ControlOrMeta+End')
    await box.evaluate((el, png) => {
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], 'shot.png', { type: 'image/png' }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, RED_PNG)
    await expect(box).toContainText(/!\[pasted-\d{8}-\d{6}\]\(pasted-\d{8}-\d{6}\.png\)/)
    const pasted = readdirSync(placeDir as string).filter((n) => /^pasted-.*\.png$/.test(n))
    expect(pasted).toHaveLength(1)
    expect(readFileSync(path.join(placeDir as string, pasted[0])).toString('base64')).toBe(RED_PNG)
    await panel.getByRole('button', { name: 'Cancel editing' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click()
    await panel.getByRole('button', { name: 'Back to files' }).click()

    // Find by name, then by content
    await panel.getByRole('searchbox', { name: 'Find a file' }).fill('deep')
    await expect(panel.getByRole('list', { name: 'Matching files' })).toContainText('deep.txt')
    await panel.getByRole('searchbox', { name: 'Find a file' }).fill('')
    await panel.getByRole('radio', { name: 'Search' }).click()
    await panel.getByRole('searchbox', { name: 'Search file contents' }).fill('needle')
    await expect(panel.getByText('1 line in 1 file')).toBeVisible()

    // A reload keeps the Place, in the Files panel the pane was left on
    // (clicking Files would close it again)
    await page.reload()
    await expect(root).toHaveAttribute('title', place.path, { timeout: 15000 })
    await expect(panel.getByRole('button', { name: `Places: ${place.name}` })).toBeVisible()
  })
})
