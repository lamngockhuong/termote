import { describe, expect, it } from 'vitest'
import { isDocumentPath } from './document-path'

describe('document paths', () => {
  it.each([
    ['a.pdf', 'pdf'],
    ['dir/B.PDF', 'pdf'],
    ['cases.Xlsx', 'xlsx'],
    ['memo.docx', 'docx'],
  ])('%s is a %s', (p, kind) => {
    expect(isDocumentPath(p)).toBe(kind)
  })

  it.each(['a.xls', 'a.doc', 'a.pptx', 'a.pdf.txt', 'pdf', 'a.png'])(
    '%s is not',
    (p) => {
      expect(isDocumentPath(p)).toBeUndefined()
    },
  )
})
