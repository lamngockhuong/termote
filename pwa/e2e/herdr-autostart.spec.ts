import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'

// termote starts Herdr when a page opens and nothing answers its socket.
// Runs only in the e2e-herdr CI job (TERMOTE_E2E_HERDR=1), against the
// job's own Herdr on its own socket (HERDR_SOCKET_PATH), never a
// developer's: it stops that Herdr. The server there has run for longer
// than its 15 s grace period by the time this spec runs.
const enabled = process.env.TERMOTE_E2E_HERDR === '1'
const socket = process.env.HERDR_SOCKET_PATH ?? ''
const SOURCE = 'e2e-repo'

const herdr = (...args: string[]) =>
  execFileSync('herdr', args, {
    encoding: 'utf-8',
    env: { ...process.env, HERDR_SOCKET_PATH: socket },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

const running = () => {
  try {
    return /status: running/.test(herdr('status', 'server'))
  } catch {
    return false
  }
}

test.describe('Herdr autostart', () => {
  test.skip(!enabled, 'needs TERMOTE_E2E_HERDR=1: a Herdr of its own (the e2e-herdr job)')

  test('opening the page starts a stopped Herdr and restores its workspaces', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    expect(socket, 'HERDR_SOCKET_PATH').not.toBe('')
    herdr('server', 'stop')
    await expect.poll(running, { timeout: 10_000 }).toBe(false)

    await page.goto('/')
    // The first snapshot answers with an error and starts Herdr; the page
    // polls every 5 s until the restored workspace is back.
    await expect(page.getByRole('button', { name: `Actions for workspace ${SOURCE}` })).toBeVisible({
      timeout: 60_000,
    })
    expect(running(), 'herdr status server').toBe(true)

    // The restored workspace has new ids: read them again.
    const snap = await (await request.get('/api/mux/snapshot')).json()
    const names = (snap.groups ?? []).map((g: { name: string }) => g.name)
    expect(names).toContain(SOURCE)
  })
})
