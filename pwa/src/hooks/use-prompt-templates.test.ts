import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFilesPersist, signedOut } from '../utils/files-persist'
import type { PromptTemplate } from './use-mux-api'
import {
  refreshTemplates,
  resetPromptTemplates,
  setTemplatesServer,
  templateById,
  usePromptTemplates,
} from './use-prompt-templates'

const api = vi.hoisted(() => ({
  fetchTemplates: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  previewTemplateImport: vi.fn(),
  importTemplates: vi.fn(),
}))
vi.mock('./use-mux-api', () => api)

const tpl = (id: string, name: string, updated = 'u'): PromptTemplate => ({
  id,
  name,
  text: 't',
  updated,
})

// A read the test answers when it chooses
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('usePromptTemplates', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    resetPromptTemplates()
    setTemplatesServer('i1', true)
  })
  afterEach(() => resetFilesPersist())

  it('reads them once for every caller at the same time', async () => {
    const read = deferred<unknown>()
    api.fetchTemplates.mockReturnValue(read.promise)
    const { result } = renderHook(() => usePromptTemplates())
    expect(result.current).toMatchObject({ loaded: false, templates: [] })
    act(() => {
      void result.current.refresh()
      void refreshTemplates()
    })
    expect(api.fetchTemplates).toHaveBeenCalledTimes(1)
    expect(result.current.loading).toBe(true)
    await act(async () => {
      read.resolve({ templates: [tpl('1', 'a')], readOnly: true })
      await read.promise
    })
    expect(result.current).toMatchObject({
      loaded: true,
      loading: false,
      error: false,
      readOnly: true,
      templates: [tpl('1', 'a')],
    })
    expect(templateById('1')).toEqual(tpl('1', 'a'))
    expect(templateById('2')).toBeNull()
  })

  it('gives the same refresh at every render, so an effect reads once', () => {
    api.fetchTemplates.mockReturnValue(new Promise(() => {}))
    const { result, rerender } = renderHook(() => usePromptTemplates())
    const first = result.current.refresh
    rerender()
    expect(result.current.refresh).toBe(first)
  })

  it('a failed read says so and keeps what it had', async () => {
    api.fetchTemplates.mockResolvedValueOnce({
      templates: [tpl('1', 'a')],
      readOnly: false,
    })
    const { result } = renderHook(() => usePromptTemplates())
    await act(() => result.current.refresh())
    api.fetchTemplates.mockRejectedValueOnce(new Error('x'))
    await act(() => result.current.refresh())
    expect(result.current).toMatchObject({
      error: true,
      loading: false,
      templates: [tpl('1', 'a')],
    })
  })

  it("never shows another server's templates", async () => {
    const read = deferred<unknown>()
    api.fetchTemplates.mockReturnValueOnce(read.promise)
    const { result } = renderHook(() => usePromptTemplates())
    act(() => {
      void result.current.refresh()
    })
    // The same server again changes nothing
    act(() => setTemplatesServer('i1', true))
    expect(result.current.loading).toBe(true)
    act(() => setTemplatesServer('i2', true))
    await act(async () => {
      read.resolve({ templates: [tpl('1', 'old server')], readOnly: false })
      await read.promise
    })
    expect(result.current).toMatchObject({ loaded: false, templates: [] })
    // A read that fails late lands nowhere either
    const late = deferred<unknown>()
    api.fetchTemplates.mockReturnValueOnce(late.promise)
    act(() => {
      void result.current.refresh()
    })
    act(() => setTemplatesServer('i3', true))
    await act(async () => {
      late.reject(new Error('x'))
      await late.promise.catch(() => {})
    })
    expect(result.current.error).toBe(false)
    // Templates turned off: nothing is read
    act(() => setTemplatesServer('i3', false))
    await act(() => result.current.refresh())
    expect(api.fetchTemplates).toHaveBeenCalledTimes(2)
  })

  it('a write updates the copy at once, then reads them again', async () => {
    api.fetchTemplates.mockResolvedValue({
      templates: [tpl('1', 'b'), tpl('2', 'C')],
      readOnly: false,
    })
    const { result } = renderHook(() => usePromptTemplates())
    await act(() => result.current.refresh())
    api.fetchTemplates.mockReturnValue(new Promise(() => {}))

    api.createTemplate.mockResolvedValue(tpl('3', 'a'))
    await act(async () => {
      expect(await result.current.create({ name: 'a', text: 't' })).toEqual(
        tpl('3', 'a'),
      )
    })
    expect(result.current.templates.map((t) => t.name)).toEqual(['a', 'b', 'C'])
    expect(api.fetchTemplates).toHaveBeenCalledTimes(2)

    api.updateTemplate.mockResolvedValue(tpl('1', 'B', 'u2'))
    await act(() =>
      result.current.update('1', { name: 'B', text: 't', updated: 'u' }),
    )
    expect(api.updateTemplate).toHaveBeenCalledWith('1', {
      name: 'B',
      text: 't',
      updated: 'u',
    })
    expect(result.current.templates.map((t) => t.name)).toEqual(['a', 'B', 'C'])

    await act(() => result.current.remove(tpl('2', 'C', 'u9')))
    expect(api.deleteTemplate).toHaveBeenCalledWith('2', 'u9')
    expect(result.current.templates.map((t) => t.id)).toEqual(['3', '1'])
  })

  it('names that differ only in case keep a stable order', async () => {
    api.fetchTemplates.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => usePromptTemplates())
    api.createTemplate
      .mockResolvedValueOnce(tpl('1', 'a'))
      .mockResolvedValueOnce(tpl('2', 'A'))
    await act(() => result.current.create({ name: 'a', text: 't' }))
    await act(() => result.current.create({ name: 'A', text: 't' }))
    // Same name but for case: by the name as written, as the server does
    expect(result.current.templates.map((t) => t.name)).toEqual(['A', 'a'])
  })

  it('a read begun before a write never undoes it', async () => {
    const old = deferred<unknown>()
    api.fetchTemplates.mockReturnValueOnce(old.promise)
    api.fetchTemplates.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => usePromptTemplates())
    act(() => {
      void result.current.refresh()
    })
    api.createTemplate.mockResolvedValue(tpl('1', 'new'))
    await act(() => result.current.create({ name: 'new', text: 't' }))
    // The write read them again, apart from the one under way
    expect(api.fetchTemplates).toHaveBeenCalledTimes(2)
    await act(async () => {
      old.resolve({ templates: [], readOnly: false })
      await old.promise
    })
    expect(result.current.templates.map((t) => t.name)).toEqual(['new'])
    expect(result.current.loading).toBe(true)
  })

  it('a write that ends after a sign-out or another server lands nowhere', async () => {
    api.fetchTemplates.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => usePromptTemplates())
    for (const [i, write] of [
      () => result.current.create({ name: 'a', text: 't' }),
      () => result.current.update('1', { name: 'a', text: 't', updated: 'u' }),
      () => result.current.remove(tpl('1', 'a')),
    ].entries()) {
      const answer = deferred<unknown>()
      api.createTemplate.mockReturnValueOnce(answer.promise)
      api.updateTemplate.mockReturnValueOnce(answer.promise)
      api.deleteTemplate.mockReturnValueOnce(answer.promise)
      let done!: Promise<unknown>
      act(() => {
        done = write()
      })
      act(() => setTemplatesServer(`other${i}`, true))
      await act(async () => {
        answer.resolve(tpl('1', 'a'))
        await done
      })
      expect(result.current.templates).toEqual([])
    }
    expect(api.fetchTemplates).not.toHaveBeenCalled()
  })

  it('a write that is refused changes nothing', async () => {
    const { result } = renderHook(() => usePromptTemplates())
    api.createTemplate.mockRejectedValue(new Error('name_taken'))
    await expect(
      act(() => result.current.create({ name: 'a', text: 't' })),
    ).rejects.toThrow('name_taken')
    expect(result.current.templates).toEqual([])
    expect(api.fetchTemplates).not.toHaveBeenCalled()
  })

  it('previews and imports through the server', async () => {
    api.fetchTemplates.mockReturnValue(new Promise(() => {}))
    api.previewTemplateImport.mockResolvedValue({ added: ['a'], replaced: [] })
    api.importTemplates.mockResolvedValue({ added: 1, replaced: 0 })
    const { result } = renderHook(() => usePromptTemplates())
    const list = [{ name: 'a', text: 't' }]
    expect(await result.current.previewImport(list)).toEqual({
      added: ['a'],
      replaced: [],
    })
    await act(async () => {
      expect(await result.current.importAll(list, ['x'])).toEqual({
        added: 1,
        replaced: 0,
      })
    })
    expect(api.importTemplates).toHaveBeenCalledWith(list, ['x'])
    expect(api.fetchTemplates).toHaveBeenCalledTimes(1)
  })

  it('a sign-out forgets them', async () => {
    api.fetchTemplates.mockResolvedValue({
      templates: [tpl('1', 'a')],
      readOnly: false,
    })
    const { result } = renderHook(() => usePromptTemplates())
    await act(() => result.current.refresh())
    act(() => signedOut())
    expect(result.current).toMatchObject({ loaded: false, templates: [] })
    // Not read again until a snapshot names the server
    await act(() => result.current.refresh())
    expect(api.fetchTemplates).toHaveBeenCalledTimes(1)
  })
})
