import { describe, expect, it } from 'vitest'
import { RequestError } from '../hooks/use-mux-api'
import { tFor } from '../i18n/i18n-context'
import { restoreFailure } from './restore-failure'

const en = tFor('en')

const refused = (status: number, code: string, extra = {}) =>
  new RequestError(status, code, 'x', extra)

describe('restoreFailure', () => {
  it('a moved root is followed', () => {
    expect(
      restoreFailure(refused(409, '', { root: '/n' }), 'a.txt', undefined, en),
    ).toEqual({
      message: "The pane's directory changed; a.txt was not restored",
      variant: 'warning',
      root: '/n',
    })
  })

  it('a file in the way is named by its path when the caller has one', () => {
    const err = refused(409, 'exists', { path: 'd/a‮.txt' })
    expect(restoreFailure(err, 'a.txt', 'd/a.txt', en).message).toBe(
      'A file now exists at d/a⟨U+202E⟩.txt; not restored',
    )
    expect(
      restoreFailure(refused(409, 'exists'), 'a.txt', 'd/a.txt', en).message,
    ).toBe('A file now exists at d/a.txt; not restored')
    // Without one (Changes), by its name
    expect(restoreFailure(err, 'a.txt', undefined, en).message).toBe(
      'A file now exists at a.txt; not restored',
    )
  })

  it.each([
    ['changed', 409, 'a.txt changed since; not restored', 'warning'],
    ['not_in_trash', 404, 'a.txt was already restored or removed', 'info'],
    [
      'cross_device',
      409,
      'a.txt is on another file system than the trash; not restored',
      'warning',
    ],
    ['not_allowed', 403, "a.txt can't be restored to that folder", 'warning'],
    ['sensitive', 403, 'a.txt may contain secrets; not restored', 'warning'],
    ['busy', 429, 'Too many writes at once. Try again', 'warning'],
    ['permission', 403, 'Could not restore a.txt', 'danger'],
  ])('%s', (code, status, message, variant) => {
    const fail = restoreFailure(refused(status, code), 'a.txt', undefined, en)
    expect(fail).toMatchObject({ message, variant })
    expect(fail.gone).toBe(code === 'not_in_trash' ? true : undefined)
  })

  it('no answer is a plain failure', () => {
    expect(
      restoreFailure(new TypeError('offline'), 'a.txt', undefined, en),
    ).toEqual({
      message: 'Could not restore a.txt',
      variant: 'danger',
    })
  })
})
