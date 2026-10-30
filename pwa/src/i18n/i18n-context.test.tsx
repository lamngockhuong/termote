import { act, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSettings } from '../hooks/use-settings'
import { I18nProvider, tFor, useT, useTourT } from './i18n-context'

function Show() {
  const app = useT()
  const tour = useTourT()
  return (
    <p>
      {app.locale}:{app.t('common.next')} {tour.locale}:{tour.t('common.next')}
    </p>
  )
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider>{children}</I18nProvider>
)

describe('I18nProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    document.documentElement.lang = 'en'
  })

  it('is English without a provider', () => {
    render(<Show />)
    expect(screen.getByText('en:Next en:Next')).toBeInTheDocument()
  })

  it('auto: the app and the tour follow a Vietnamese browser', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['vi-VN'])
    render(<Show />, { wrapper })
    expect(screen.getByText('vi:Tiếp vi:Tiếp')).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('vi')
  })

  it("keeps the app's language for the push worker", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const open = vi.fn().mockResolvedValue({ put })
    vi.stubGlobal('caches', { open })
    render(<Show />, { wrapper })
    await vi.waitFor(() => expect(put).toHaveBeenCalled())
    expect(open).toHaveBeenCalledWith('termote-prefs')
    expect(put.mock.calls[0][0]).toBe('/__locale')
    expect(await put.mock.calls[0][1].text()).toBe('en')
    vi.unstubAllGlobals()
  })

  it('follows the language picked in Settings at once, the app with the tour', () => {
    const { result } = renderHook(
      () => ({ s: useSettings(), t: useTourT(), app: useT() }),
      { wrapper },
    )
    expect(result.current.t.locale).toBe('en')
    expect(result.current.app.locale).toBe('en')
    act(() => result.current.s.updateSetting('language', 'vi'))
    expect(result.current.t.locale).toBe('vi')
    expect(result.current.t.t('common.skip')).toBe('Bỏ qua')
    expect(result.current.app.locale).toBe('vi')
    expect(result.current.app.t('common.skip')).toBe('Bỏ qua')
    expect(document.documentElement.lang).toBe('vi')
    act(() => result.current.s.updateSetting('language', 'en'))
    expect(document.documentElement.lang).toBe('en')
  })

  it('tFor gives the locale its t', () => {
    expect(tFor('vi')('common.done')).toBe('Xong')
    expect(tFor('en')('common.done')).toBe('Done')
  })
})
