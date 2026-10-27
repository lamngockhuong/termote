import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadFileImage } from '../utils/upload-image'
import {
  fetchFilesTree,
  fetchPlaces,
  filesUrl,
  RequestError,
} from './use-mux-api'

function mockFetch(body: unknown, status = 200) {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify(body), { status })
    }),
  )
  return urls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('files requests of a Place', () => {
  it('filesUrl adds the place to the query, and nothing without one', () => {
    expect(filesUrl({ paneId: '%1' }, 'tree', { path: 'a' })).toBe(
      '/api/mux/panes/%251/files/tree?path=a',
    )
    expect(
      filesUrl({ paneId: '%1', place: 'ab12' }, 'content', {
        path: 'a',
        root: '/n',
      }),
    ).toBe('/api/mux/panes/%251/files/content?path=a&root=%2Fn&place=ab12')
  })

  it('every files helper sends the place', async () => {
    const urls = mockFetch({ root: '/n', path: '', entries: [] })
    await fetchFilesTree({ paneId: '0', place: 'ab12' }, '', '/n')
    expect(urls[0]).toBe('/api/mux/panes/0/files/tree?root=%2Fn&place=ab12')
  })

  it('a pasted image goes to the Place too', async () => {
    const urls = mockFetch({ root: '/n', path: 'p.png' }, 201)
    await uploadFileImage(
      { paneId: '0', place: 'ab12' },
      { root: '/n', dir: '.', reveal: false },
      new Blob([new Uint8Array(4)], { type: 'image/png' }),
    )
    expect(urls[0]).toBe(
      '/api/mux/panes/0/files/image?root=%2Fn&dir=.&place=ab12',
    )
  })

  it('fetchPlaces lists them, none when the server sends none', async () => {
    const urls = mockFetch({
      places: [{ id: 'ab12', name: 'notes', path: '/n' }],
    })
    expect(await fetchPlaces()).toEqual([
      { id: 'ab12', name: 'notes', path: '/n' },
    ])
    expect(urls[0]).toBe('/api/mux/files/places')
    mockFetch({})
    expect(await fetchPlaces()).toEqual([])
    mockFetch({ error: 'x', code: 'view_only' }, 403)
    await expect(fetchPlaces()).rejects.toBeInstanceOf(RequestError)
  })

  // A files URL built by hand would leave the Place out: every one goes
  // through filesUrl
  it('no source file builds a files URL itself', () => {
    const sources = import.meta.glob<string>(
      ['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!./use-mux-api.ts'],
      { query: '?raw', import: 'default', eager: true },
    )
    expect(Object.keys(sources).length).toBeGreaterThan(100)
    const offenders = Object.entries(sources)
      .filter(([, text]) => /\/files\/(?!places)/.test(text))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })
})
