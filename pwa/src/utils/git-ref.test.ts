import { describe, expect, it } from 'vitest'
import { validBranchName } from './git-ref'

// The same table as the server's TestValidBranchName.
describe('validBranchName', () => {
  it.each(['feat/x', 'a.b', '日本', 'main', 'a-b_c', 'x/y/z', 'a'.repeat(255)])(
    'accepts %j',
    (s) => {
      expect(validBranchName(s)).toBe(true)
    },
  )

  it.each([
    '',
    '-x',
    'HEAD',
    '@',
    'a..b',
    'a@{1}',
    '.x',
    'x/.y',
    'x.lock',
    'x/y.lock/z',
    'x/',
    '/x',
    'x.',
    'a//b',
    'a b',
    'a~1',
    'a^',
    'a:b',
    'a?',
    'a*',
    'a[',
    'a\\b',
    'a‮b',
    'a​b',
    'a\u0085b',
    'x y',
    'a\tb',
    'a\u007fb',
    'a\ud800b',
    'a'.repeat(256),
    '日'.repeat(86),
  ])('refuses %j', (s) => {
    expect(validBranchName(s)).toBe(false)
  })
})
