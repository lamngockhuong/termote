import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadWebgl,
  MAX_WEBGL_TERMINALS,
  resetWebglForTest,
  webglInUse,
} from './terminal-webgl'

const { FakeAddon } = vi.hoisted(() => {
  class FakeAddon {
    static made: FakeAddon[] = []
    static throwOnNew = false
    static throwOnDispose = false
    lossCb: () => void = () => {}
    dispose = vi.fn(() => {
      if (FakeAddon.throwOnDispose) throw new Error('gone')
    })
    onContextLoss = vi.fn((cb: () => void) => {
      this.lossCb = cb
      return { dispose: vi.fn() }
    })
    constructor() {
      if (FakeAddon.throwOnNew) throw new Error('no webgl2')
      FakeAddon.made.push(this)
    }
  }
  return { FakeAddon }
})
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: FakeAddon }))

type Mod = { WebglAddon: typeof FakeAddon }
const mod = (): Promise<Mod> => Promise.resolve({ WebglAddon: FakeAddon })

function fakeTerm() {
  const element = document.createElement('div')
  return {
    element,
    loadAddon: vi.fn(),
  }
}
type FakeTerm = ReturnType<typeof fakeTerm>
const asTerm = (t: FakeTerm) => t as unknown as Terminal
// The injected import is typed for the real addon
type Importer = NonNullable<Parameters<typeof loadWebgl>[1]>
const load = (t: FakeTerm, imp: () => Promise<unknown> = mod) =>
  loadWebgl(asTerm(t), imp as Importer)
const settle = () => new Promise((r) => setTimeout(r, 0))

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  resetWebglForTest()
  FakeAddon.made = []
  FakeAddon.throwOnNew = false
  FakeAddon.throwOnDispose = false
  setVisibility('visible')
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadWebgl', () => {
  it('loads the addon once its chunk is in, and unloads it on dispose', async () => {
    const term = fakeTerm()
    const handle = load(term)
    expect(handle.active()).toBe(false)
    expect(term.loadAddon).not.toHaveBeenCalled()
    await settle()
    const addon = FakeAddon.made[0]
    expect(term.loadAddon).toHaveBeenCalledWith(addon)
    expect(handle.active()).toBe(true)
    expect(webglInUse()).toBe(1)
    handle.dispose()
    expect(addon.dispose).toHaveBeenCalledTimes(1)
    expect(handle.active()).toBe(false)
    expect(webglInUse()).toBe(0)
    // A second dispose does nothing more
    handle.dispose()
    expect(addon.dispose).toHaveBeenCalledTimes(1)
    expect(webglInUse()).toBe(0)
  })

  it('imports the real module by default', async () => {
    const term = fakeTerm()
    const handle = loadWebgl(asTerm(term))
    await vi.waitFor(() => expect(handle.active()).toBe(true))
    handle.dispose()
  })

  it('keeps the DOM renderer when the import fails', async () => {
    const term = fakeTerm()
    const handle = load(term, () => Promise.reject(new Error('offline')))
    await settle()
    expect(handle.active()).toBe(false)
    expect(webglInUse()).toBe(0)
    handle.dispose()
  })

  it('keeps the DOM renderer and gives the slot back when the addon cannot start', async () => {
    FakeAddon.throwOnNew = true
    const term = fakeTerm()
    const handle = load(term)
    await settle()
    expect(handle.active()).toBe(false)
    expect(webglInUse()).toBe(0)

    FakeAddon.throwOnNew = false
    const term2 = fakeTerm()
    term2.loadAddon.mockImplementation(() => {
      throw new Error('disposed')
    })
    const handle2 = load(term2)
    await settle()
    expect(handle2.active()).toBe(false)
    expect(webglInUse()).toBe(0)
    // The addon half started is freed, even when that throws too
    expect(FakeAddon.made[0].dispose).toHaveBeenCalledTimes(1)
    const term3 = fakeTerm()
    term3.loadAddon.mockImplementation(() => {
      throw new Error('disposed')
    })
    FakeAddon.throwOnDispose = true
    const handle3 = load(term3)
    await settle()
    expect(handle3.active()).toBe(false)
    expect(webglInUse()).toBe(0)
    handle3.dispose()
    handle.dispose()
    handle2.dispose()
  })

  it('loads nothing when disposed before the chunk came', async () => {
    const term = fakeTerm()
    const handle = load(term)
    handle.dispose()
    await settle()
    expect(term.loadAddon).not.toHaveBeenCalled()
    expect(FakeAddon.made).toHaveLength(0)
    expect(webglInUse()).toBe(0)
  })

  it('swallows an addon that throws while disposed', async () => {
    const term = fakeTerm()
    const handle = load(term)
    await settle()
    FakeAddon.made[0].dispose.mockImplementation(() => {
      throw new Error('terminal gone')
    })
    expect(() => handle.dispose()).not.toThrow()
    expect(webglInUse()).toBe(0)
  })

  it(`draws at most ${MAX_WEBGL_TERMINALS} terminals with WebGL; a freed slot goes to the next one`, async () => {
    const handles = Array.from({ length: MAX_WEBGL_TERMINALS + 1 }, () =>
      load(fakeTerm()),
    )
    await settle()
    expect(handles.filter((h) => h.active())).toHaveLength(MAX_WEBGL_TERMINALS)
    expect(handles[MAX_WEBGL_TERMINALS].active()).toBe(false)
    expect(webglInUse()).toBe(MAX_WEBGL_TERMINALS)
    handles[0].dispose()
    expect(webglInUse()).toBe(MAX_WEBGL_TERMINALS - 1)
    const next = load(fakeTerm())
    await settle()
    expect(next.active()).toBe(true)
    for (const h of [...handles, next]) h.dispose()
    expect(webglInUse()).toBe(0)
  })

  it('unloads the addon when its context is lost, and loads a new one when the page is shown again', async () => {
    const term = fakeTerm()
    const handle = load(term)
    await settle()
    const first = FakeAddon.made[0]
    first.lossCb()
    expect(first.dispose).toHaveBeenCalled()
    expect(handle.active()).toBe(false)
    expect(webglInUse()).toBe(0)
    // A loss reported by an addon already replaced changes nothing
    first.lossCb()
    setVisibility('hidden')
    expect(FakeAddon.made).toHaveLength(1)
    setVisibility('visible')
    expect(FakeAddon.made).toHaveLength(2)
    expect(handle.active()).toBe(true)
    expect(webglInUse()).toBe(1)
    // Shown again with nothing lost: the addon stays
    setVisibility('visible')
    expect(FakeAddon.made).toHaveLength(2)
    handle.dispose()
  })

  it('replaces the addon at once when the page is shown with its context lost in the background', async () => {
    const term = fakeTerm()
    const handle = load(term)
    await settle()
    const first = FakeAddon.made[0]
    setVisibility('hidden')
    term.element.dispatchEvent(new Event('webglcontextlost'))
    setVisibility('visible')
    expect(first.dispose).toHaveBeenCalled()
    expect(FakeAddon.made).toHaveLength(2)
    expect(handle.active()).toBe(true)
    expect(webglInUse()).toBe(1)
    handle.dispose()
  })

  it('keeps the addon when the browser restored its context', async () => {
    const term = fakeTerm()
    const handle = load(term)
    await settle()
    const canvas = document.createElement('canvas')
    term.element.appendChild(canvas)
    // Lost and restored on the addon's own canvas, inside the terminal
    canvas.dispatchEvent(new Event('webglcontextlost'))
    canvas.dispatchEvent(new Event('webglcontextrestored'))
    setVisibility('visible')
    expect(FakeAddon.made).toHaveLength(1)
    expect(FakeAddon.made[0].dispose).not.toHaveBeenCalled()
    handle.dispose()
    // Listeners are gone after dispose
    term.element.dispatchEvent(new Event('webglcontextlost'))
    setVisibility('visible')
    expect(FakeAddon.made).toHaveLength(1)
  })

  it('waits for the chunk when the page is shown before it came', async () => {
    const term = fakeTerm()
    let arrive: (m: Mod) => void = () => {}
    const handle = load(term, () => new Promise<Mod>((r) => (arrive = r)))
    term.element.dispatchEvent(new Event('webglcontextlost'))
    setVisibility('visible')
    expect(FakeAddon.made).toHaveLength(0)
    arrive({ WebglAddon: FakeAddon })
    await settle()
    expect(handle.active()).toBe(true)
    handle.dispose()
  })

  it('works for a terminal without an element', async () => {
    const term = { loadAddon: vi.fn() }
    const handle = loadWebgl(
      term as unknown as Terminal,
      mod as unknown as Importer,
    )
    await settle()
    expect(handle.active()).toBe(true)
    handle.dispose()
  })
})
