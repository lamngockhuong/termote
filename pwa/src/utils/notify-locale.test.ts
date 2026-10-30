import { afterEach, describe, expect, it, vi } from 'vitest'
import { keepNotifyLocale, LOCALE_CACHE, LOCALE_URL } from './notify-locale'

// Cache Storage with its caches in a Map, enough for put and match
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>()
  const open = vi.fn(async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map())
    const store = stores.get(name) as Map<string, Response>
    return {
      put: async (url: string, res: Response) => {
        store.set(url, res)
      },
    }
  })
  const match = async (url: string, opts?: MultiCacheQueryOptions) =>
    stores
      .get(opts?.cacheName ?? '')
      ?.get(url)
      ?.clone()
  vi.stubGlobal('caches', { open, match })
  return { open, match }
}

describe('keepNotifyLocale', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the locale where the worker reads it', async () => {
    const { open, match } = fakeCaches()
    await keepNotifyLocale('vi')
    expect(open).toHaveBeenCalledWith(LOCALE_CACHE)
    const res = await match(LOCALE_URL, { cacheName: 'termote-prefs' })
    expect(await res?.text()).toBe('vi')
    // A later choice replaces it
    await keepNotifyLocale('en')
    expect(
      await (await match('/__locale', { cacheName: LOCALE_CACHE }))?.text(),
    ).toBe('en')
  })

  it('does nothing without Cache Storage, or when it is refused', async () => {
    vi.stubGlobal('caches', undefined)
    await expect(keepNotifyLocale('vi')).resolves.toBeUndefined()
    vi.stubGlobal('caches', {
      open: vi.fn().mockRejectedValue(new DOMException('no', 'SecurityError')),
    })
    await expect(keepNotifyLocale('vi')).resolves.toBeUndefined()
  })
})
