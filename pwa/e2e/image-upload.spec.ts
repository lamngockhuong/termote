import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'

// Images go to the host through /api/mux/uploads and reach the pane as a
// path. The terminal test needs the server's tmux (TMUX_SOCKET, TMUX_SESSION).
const socket = process.env.TMUX_SOCKET
const tmuxSession = process.env.TMUX_SESSION || 'main'

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })

// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

test.describe('image uploads', () => {
  test.beforeEach(async ({ request }) => {
    const snap = await (await request.get('/api/mux/snapshot')).json()
    test.skip(!snap.caps.uploads, 'the server has no upload dir')
  })

  test('the page uploads a raw image; the server refuses a form post', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async (bytes) => {
      const post = (body: BodyInit, type?: string) =>
        fetch('/api/mux/uploads', {
          method: 'POST',
          headers: type ? { 'Content-Type': type } : {},
          body,
        })
      const png = new Uint8Array(bytes)
      const ok = await post(new Blob([png], { type: 'image/png' }), 'image/png')
      const form = new FormData()
      form.append('file', new Blob([png], { type: 'image/png' }), 'a.png')
      const multipart = await post(form)
      const lie = await post(new Blob(['not an image']), 'image/png')
      return {
        ok: { status: ok.status, body: await ok.json() },
        multipart: multipart.status,
        lie: { status: lie.status, body: await lie.json() },
      }
    }, [...PNG])
    expect(result.ok.status).toBe(200)
    expect(result.ok.body.id).toMatch(/^[0-9a-f]{32}$/)
    expect(result.ok.body.path).toMatch(/[0-9a-f]{32}\.png$/)
    expect(result.multipart).toBe(415)
    expect(result.lie).toEqual({ status: 415, body: expect.objectContaining({ code: 'unsupported_image' }) })
  })

  test.describe('terminal', () => {
    test.skip(!socket || process.platform !== 'linux', 'needs TMUX_SOCKET of the server under test (Linux)')
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

    let windowId = ''
    test.afterEach(() => {
      try {
        if (windowId) tmux('kill-window', '-t', windowId)
      } catch {
        // Already gone
      }
    })

    test('the Attach key types the uploaded path into the pane', async ({ page, request }) => {
      // cat echoes what is typed, with no prompt to tell apart
      const name = `upload-${Date.now()}`
      windowId = tmux(
        'new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`, '-n', name, 'cat',
      ).trim()
      let link = ''
      await expect(async () => {
        const s = await (await request.get('/api/mux/snapshot')).json()
        const group = s.groups.find((g: { tabs: { name: string }[] }) => g.tabs.some((t) => t.name === name))
        const tab = group?.tabs.find((t: { name: string }) => t.name === name)
        expect(tab).toBeDefined()
        link = `/#/s/${encodeURIComponent(group.id)}/${encodeURIComponent(tab.id)}`
      }).toPass()
      // The stream shows the session's active window
      tmux('select-window', '-t', windowId)
      // The first-visit gesture tour would cover the toolbar
      await page.addInitScript(() =>
        localStorage.setItem('termote-settings', JSON.stringify({ hasSeenGestureHints: true })),
      )
      await page.goto(link)
      await expect(page.getByTestId('terminal-view')).toBeVisible()

      const chooser = page.waitForEvent('filechooser')
      // Attach image sits in the expanded rows
      await page.getByRole('button', { name: 'Extra keys' }).click()
      await page.getByRole('button', { name: 'Attach image' }).click()
      await (await chooser).setFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG })

      // -J joins the lines a narrow pane wraps and keeps trailing spaces
      await expect(async () => {
        expect(tmux('capture-pane', '-p', '-J', '-t', windowId)).toMatch(/\/termote\/uploads\/[0-9a-f]{32}\.png /)
      }).toPass()
    })
  })
})
