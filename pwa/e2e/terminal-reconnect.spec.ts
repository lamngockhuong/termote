import { execFileSync } from 'node:child_process'
import net from 'node:net'
import { expect, type Page, test } from './fixtures'

// Opening a stream again. The same stream (the network back, the page shown
// again) keeps its screen until the backend's redraw comes; another tmux
// session clears it as soon as its stream opens, so its keys never go out
// under the old session's screen. Read from xterm's buffer through the test
// probe (utils/terminal-probe.ts), frame by frame, through a proxy that
// delays every chunk so the gap between open and output is wide.
const socket = process.env.TMUX_SOCKET
const port = Number(process.env.TERMOTE_PORT || 7680)
const DELAY_MS = 80

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' }).trim()

// A TCP proxy to the server that holds every chunk DELAY_MS in each
// direction, in order. Only this spec's connections are slowed.
function delayProxy(): Promise<{ port: number; close: () => void }> {
  const relay = (from: net.Socket, to: net.Socket) => {
    let last = 0
    from.on('data', (chunk) => {
      const due = Math.max(Date.now() + DELAY_MS, last)
      last = due
      setTimeout(() => {
        if (!to.destroyed) to.write(chunk)
      }, due - Date.now())
    })
    from.on('end', () => setTimeout(() => to.end(), Math.max(0, last - Date.now()) + 1))
    from.on('error', () => to.destroy())
  }
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    const upstream = net.connect(port, '127.0.0.1')
    for (const s of [client, upstream]) {
      s.setNoDelay(true)
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
    }
    relay(client, upstream)
    relay(upstream, client)
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => {
          for (const s of sockets) s.destroy()
          server.close()
        },
      })
    })
  })
}

type Probe = { lines: () => string[] }
type Wrapped = { ws: WebSocket; openedAt?: number; output?: boolean }
type W = { __termoteE2E: boolean; __termoteTerms?: Probe[]; __streams: Wrapped[] }

// The test flag, and a record of every stream socket: when it opened and
// whether output came.
async function watchStreams(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as W
    w.__termoteE2E = true
    w.__streams = []
    const Real = window.WebSocket
    class Watched extends Real {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (!String(url).includes('/stream?')) return
        const entry: Wrapped = { ws: this }
        w.__streams.push(entry)
        // Registered before the app's onopen, so it runs first
        this.addEventListener('open', () => {
          entry.openedAt = performance.now()
        })
        this.addEventListener('message', (ev) => {
          if (typeof ev.data !== 'string') entry.output = true
        })
      }
    }
    window.WebSocket = Watched as typeof WebSocket
  })
}

const screenText = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__termoteTerms?.[0]?.lines().join('\n') ?? '')

test.describe('a stream opened again', () => {
  test.skip(!socket, 'needs TMUX_SOCKET, the tmux socket of the server under test')

  const id = Math.random().toString(36).slice(2, 8)
  const one = `rc-a-${id}`
  const two = `rc-b-${id}`
  let proxy: { port: number; close: () => void }

  test.beforeAll(async () => {
    proxy = await delayProxy()
    // Each session fills its screen with lines naming it
    for (const name of [one, two]) {
      tmux('new-session', '-d', '-s', name, '-c', '/tmp', '-n', `${name}-win`, '-x', '120', '-y', '40')
      tmux('send-keys', '-t', `=${name}:`, `clear; for i in $(seq 1 30); do echo ${name}-$i; done`, 'Enter')
    }
  })

  test.afterAll(() => {
    proxy?.close()
    for (const name of [one, two]) {
      try {
        tmux('kill-session', '-t', `=${name}`)
      } catch {
        // Already gone
      }
    }
  })

  const pick = (page: Page, name: string) =>
    page.locator(`aside section[aria-label="${name}"]`).getByText(`${name}-win`).click()

  test('the same stream keeps its screen until the redraw', async ({ page }) => {
    await watchStreams(page)
    await page.goto(`http://127.0.0.1:${proxy.port}/`)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await pick(page, one)
    await expect.poll(() => screenText(page), { timeout: 15000 }).toContain(`${one}-30`)

    for (let round = 0; round < 3; round++) {
      const result = await page.evaluate(() => {
        const w = window as unknown as W
        const probe = w.__termoteTerms![0]
        const before = w.__streams.length
        w.__streams[before - 1].ws.close()
        let blank = 0
        return new Promise<{ blank: number; reopened: boolean }>((done) => {
          const started = performance.now()
          const frame = () => {
            const lines = probe.lines()
            if (lines.every((l) => !l.trim())) blank++
            const next = w.__streams[w.__streams.length - 1]
            const reopened = w.__streams.length > before && !!next.output
            // Output came and was drawn
            if ((reopened && lines.some((l) => l.trim())) || performance.now() - started > 15000) {
              done({ blank, reopened })
              return
            }
            requestAnimationFrame(frame)
          }
          requestAnimationFrame(frame)
        })
      })
      expect(result.reopened, 'the stream opened again').toBe(true)
      expect(result.blank, 'frames with an empty screen').toBe(0)
      await expect.poll(() => screenText(page), { timeout: 10000 }).toContain(`${one}-30`)
    }
  })

  test("another session never shows the old session's screen once its stream is open", async ({ page }) => {
    await watchStreams(page)
    await page.goto(`http://127.0.0.1:${proxy.port}/`)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await pick(page, one)
    await expect.poll(() => screenText(page), { timeout: 15000 }).toContain(`${one}-30`)

    for (const [from, to] of [
      [one, two],
      [two, one],
    ]) {
      // Frames drawn after the new stream opened that still show the old
      // session
      const watching = page.evaluate(
        ({ from, to }) => {
          const w = window as unknown as W
          const probe = w.__termoteTerms![0]
          const before = w.__streams.length
          let stale = 0
          return new Promise<{ stale: number; shown: boolean }>((done) => {
            const started = performance.now()
            const frame = () => {
              const opened = w.__streams.length > before && w.__streams[w.__streams.length - 1].openedAt !== undefined
              const text = probe.lines().join('\n')
              if (opened && text.includes(`${from}-`)) stale++
              if (text.includes(`${to}-30`) || performance.now() - started > 15000) {
                done({ stale, shown: text.includes(`${to}-30`) })
                return
              }
              requestAnimationFrame(frame)
            }
            requestAnimationFrame(frame)
          })
        },
        { from, to },
      )
      await pick(page, to)
      const result = await watching
      expect(result.shown, `${to} is shown`).toBe(true)
      expect(result.stale, `frames showing ${from} after ${to}'s stream opened`).toBe(0)
    }
  })
})
