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
  // One queue per direction, drained by a single timer: chunks leave in the
  // order they came (timers of different lengths may fire out of order).
  const relay = (from: net.Socket, to: net.Socket) => {
    const queue: { due: number; chunk?: Buffer }[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    const drain = () => {
      timer = null
      while (queue.length && queue[0].due <= Date.now()) {
        const { chunk } = queue.shift()!
        if (to.destroyed) continue
        if (chunk) to.write(chunk)
        else to.end()
      }
      if (queue.length) timer = setTimeout(drain, queue[0].due - Date.now())
    }
    const push = (chunk?: Buffer) => {
      queue.push({ due: Date.now() + DELAY_MS, chunk })
      if (!timer) timer = setTimeout(drain, DELAY_MS)
    }
    from.on('data', (chunk) => push(chunk))
    from.on('end', () => push())
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
type Wrapped = { ws: WebSocket; madeAt: number; openedAt?: number; output?: boolean }
type W = {
  __termoteE2E: boolean
  __termoteTerms?: Probe[]
  __streams: Wrapped[]
  // When each stream-token request was sent, and when its reply came
  __tokens: { sentAt: number; doneAt?: number }[]
}

// The test flag, and a record of every stream socket: when it opened and
// whether output came.
async function watchStreams(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as W
    w.__termoteE2E = true
    w.__streams = []
    w.__tokens = []
    const realFetch = window.fetch
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.includes('/stream-token')) return realFetch(input, init)
      const entry: W['__tokens'][number] = { sentAt: performance.now() }
      w.__tokens.push(entry)
      return realFetch(input, init).finally(() => {
        entry.doneAt = performance.now()
      })
    }
    const Real = window.WebSocket
    class Watched extends Real {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (!String(url).includes('/stream?')) return
        const entry: Wrapped = { ws: this, madeAt: performance.now() }
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

// Opens the app at origin with a fresh local state. With sign-in on (the
// sign-in job), through the server's form: Basic credentials reach the API,
// not the page.
async function openApp(page: Page, origin: string) {
  await watchStreams(page)
  const secret = process.env.TERMOTE_PASS
  if (secret && process.env.TERMOTE_NO_AUTH !== 'true') {
    await page.goto(`${origin}/login`)
    await page.getByLabel('Username').fill(process.env.TERMOTE_USER || 'admin')
    await page.getByLabel('Password').fill(secret)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForSelector('[data-testid="terminal-view"] .xterm', { timeout: 15000 })
  } else {
    await page.goto(`${origin}/`)
  }
  await page.evaluate(() => localStorage.clear())
  await page.reload()
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
    await openApp(page, `http://127.0.0.1:${proxy.port}`)
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
    await openApp(page, `http://127.0.0.1:${proxy.port}`)
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

  // A full client keeps one token fetched after a stream opens: the next
  // session's stream needs none first. Only a signed-in client has a role
  // (caps.role): CI runs this in the sign-in job (TERMOTE_E2E_AUTH=1).
  test('a session switch right after a stream opened sends no token request before its socket', async ({ page }) => {
    test.skip(!process.env.TERMOTE_E2E_AUTH, 'needs a server with sign-in, where the client has the full role')
    await openApp(page, `http://127.0.0.1:${port}`)
    await pick(page, one)
    await expect.poll(() => screenText(page), { timeout: 15000 }).toContain(`${one}-30`)
    // The spare asked for after that stream opened has come back
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const w = window as unknown as W
            const opened = w.__streams[w.__streams.length - 1].openedAt ?? Infinity
            return w.__tokens.some((t) => t.sentAt > opened && t.doneAt !== undefined)
          }),
        { timeout: 10000 },
      )
      .toBe(true)

    const clickAt = await page.evaluate(() => performance.now())
    const before = await page.evaluate(() => (window as unknown as W).__streams.length)
    await pick(page, two)
    await expect.poll(() => screenText(page), { timeout: 15000 }).toContain(`${two}-30`)
    const between = await page.evaluate(
      ({ clickAt, before }) => {
        const w = window as unknown as W
        const made = w.__streams[before].madeAt
        return w.__tokens.filter((t) => t.sentAt >= clickAt && t.sentAt <= made).length
      },
      { clickAt, before },
    )
    expect(between, 'stream-token requests between the click and the new socket').toBe(0)
  })
})
