import { describe, expect, it } from 'vitest'
import casesJson from '../../../server/testdata/template-hidden-chars.json?raw'
import { tFor } from '../i18n/i18n-context'
import {
  exportFile,
  fillTemplate,
  firstLine,
  hiddenChars,
  MAX_TEMPLATE_NAME,
  MAX_TEMPLATE_TEXT,
  MAX_TEMPLATES,
  matchTemplates,
  normalizeText,
  parseImport,
  templateBytes,
  templateErrorText,
  templateProblem,
  templateVariables,
} from './prompt-templates'

const tEn = tFor('en')

describe('templateVariables', () => {
  it('lists each known variable once, in order', () => {
    expect(
      templateVariables(
        '{{input}} on {{branch}}: {{file}} {{input}} {{other}} {{ file }}',
      ),
    ).toEqual(['input', 'branch', 'file'])
    expect(templateVariables('plain')).toEqual([])
  })
})

describe('fillTemplate', () => {
  it('takes values as they are', () => {
    expect(
      fillTemplate('Review {{file}} on {{branch}}: {{input}} {{x}}', {
        file: '$&.ts',
        branch: "$'",
        input: '{{file}}',
      }),
    ).toBe("Review $&.ts on $': {{file}} {{x}}")
  })

  it('a missing value is empty, a repeated variable filled each time', () => {
    expect(fillTemplate('{{selection}}|{{selection}}', {})).toBe('|')
    expect(fillTemplate('{{input}}{{input}}', { input: 'a' })).toBe('aa')
  })
})

describe('hiddenChars', () => {
  // The cases the server's validateTemplate reads too
  const { cases } = JSON.parse(casesJson) as {
    cases: {
      codePoint: string
      inName: boolean
      inText: boolean
      why: string
    }[]
  }

  it.each(cases)('U+$codePoint ($why)', ({ codePoint, inName, inText }) => {
    const s = `a${String.fromCodePoint(Number.parseInt(codePoint, 16))}b`
    expect(hiddenChars(s, false).length === 0).toBe(inName)
    expect(hiddenChars(s).length === 0).toBe(inText)
    expect(templateProblem(s, 'x', tEn) === null).toBe(inName)
    expect(templateProblem('x', s, tEn) === null).toBe(inText)
  })

  it('says where and which', () => {
    expect(hiddenChars('😀b\u202ec\u{E0041}')).toEqual([
      { index: 2, codePoint: 'U+202E' },
      { index: 4, codePoint: 'U+E0041' },
    ])
  })
})

describe('templateProblem', () => {
  it('checks the name', () => {
    expect(templateProblem('  ', 'x', tEn)?.field).toBe('name')
    expect(templateProblem('é'.repeat(MAX_TEMPLATE_NAME), 'x', tEn)).toBeNull()
    expect(templateProblem('😀'.repeat(MAX_TEMPLATE_NAME), 'x', tEn)).toBeNull()
    expect(
      templateProblem('é'.repeat(MAX_TEMPLATE_NAME + 1), 'x', tEn),
    ).toEqual({
      field: 'name',
      message: 'The name is longer than 64 characters',
    })
    expect(templateProblem('a\tb', 'x', tEn)?.message).toMatch(/U\+0009/)
  })

  it('trims the name as the server does', () => {
    expect(templateProblem('\u0085 a  ', 'x', tEn)).toBeNull()
    expect(templateProblem('﻿a', 'x', tEn)?.message).toMatch(/U\+FEFF/)
    expect(
      parseImport('{"v":1,"templates":[{"name":"\\u2003a ","text":"x"}]}', tEn),
    ).toEqual({ ok: true, templates: [{ name: 'a', text: 'x' }] })
  })

  it('checks the text in bytes, line breaks as stored', () => {
    expect(templateProblem('a', '', tEn)?.message).toBe('The template is empty')
    expect(
      templateProblem('a', 'é'.repeat(MAX_TEMPLATE_TEXT / 2), tEn),
    ).toBeNull()
    expect(
      templateProblem('a', `é${'é'.repeat(MAX_TEMPLATE_TEXT / 2)}`, tEn)
        ?.message,
    ).toBe('The template is larger than 16 KB')
    expect(
      templateProblem('a', '\r\n'.repeat(MAX_TEMPLATE_TEXT), tEn),
    ).toBeNull()
    expect(templateProblem('a', 'x\u200by', tEn)?.message).toBe(
      'The template contains hidden characters (U+200B at character 2)',
    )
  })

  it('counts bytes and normalizes line breaks', () => {
    expect(templateBytes('é')).toBe(2)
    expect(normalizeText('a\r\nb\rc\n')).toBe('a\nb\nc\n')
  })
})

describe('export and import', () => {
  it('names the file by day and keeps only names and texts', () => {
    const f = exportFile(
      [{ name: 'a', text: 'b', id: 'x', updated: 'u' } as never],
      new Date(2026, 0, 5),
    )
    expect(f.name).toBe('termote-templates-2026-01-05.json')
    expect(f.text).toBe('{"v":1,"templates":[{"name":"a","text":"b"}]}')
  })

  it('round-trips 100 templates of the largest size', () => {
    const list = Array.from({ length: MAX_TEMPLATES }, (_, i) => ({
      name: `${String(i).padStart(3, '0')}${'"'.repeat(MAX_TEMPLATE_NAME - 3)}`,
      text: '\\\n"\t'.repeat(MAX_TEMPLATE_TEXT / 4),
    }))
    const { text } = exportFile(list)
    expect(text.length).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(parseImport(text, tEn)).toEqual({ ok: true, templates: list })
  })

  it('trims names and stores line breaks as the server does', () => {
    expect(
      parseImport(
        '{"v":1,"templates":[{"name":" a ","text":"x\\r\\ny"}]}',
        tEn,
      ),
    ).toEqual({ ok: true, templates: [{ name: 'a', text: 'x\ny' }] })
  })

  it.each([
    ['{', 'This is not a JSON file'],
    ['null', 'This is not a templates file'],
    ['[]', 'This is not a templates file'],
    ['{"v":2,"templates":[]}', 'This file was made by another version'],
    ['{"v":1}', 'This is not a templates file'],
    ['{"v":1,"templates":[]}', 'The file has no templates'],
    ['{"v":1,"templates":[null]}', 'Template 1 has no name or text'],
    ['{"v":1,"templates":[{"name":"a"}]}', 'Template 1 has no name or text'],
    [
      '{"v":1,"templates":[{"name":"a","text":"x"},{"name":"b","text":"\\u202e"}]}',
      'Template 2: The template contains hidden characters',
    ],
    [
      '{"v":1,"templates":[{"name":"Ab","text":"x"},{"name":"aB","text":"y"}]}',
      'Template 2: another template has this name',
    ],
    [
      JSON.stringify({
        v: 1,
        templates: Array.from({ length: MAX_TEMPLATES + 1 }, (_, i) => ({
          name: `t${i}`,
          text: 'x',
        })),
      }),
      'The file has 101 templates: up to 100',
    ],
  ])('refuses %s', (json, error) => {
    const r = parseImport(json, tEn)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(error)
  })
})

describe('matchTemplates', () => {
  const list = [
    { name: 'Code review' },
    { name: 'bug-report' },
    { name: 'Deploy' },
  ]
  const names = (q: string) => matchTemplates(list, q).map((t) => t.name)

  it('finds a name by the start of any word, or without its spaces', () => {
    expect(names('')).toEqual(['Code review', 'bug-report', 'Deploy'])
    expect(names('REV')).toEqual(['Code review'])
    expect(names('codere')).toEqual(['Code review'])
    expect(names('rep')).toEqual(['bug-report'])
    expect(names('de')).toEqual(['Deploy'])
    expect(names('view')).toEqual([])
  })

  it('finds a name typed with its spaces, in full or in part', () => {
    expect(names('code r')).toEqual(['Code review'])
    expect(names('Code review')).toEqual(['Code review'])
    expect(names('  code  review ')).toEqual(['Code review'])
    expect(names('code w')).toEqual([])
  })
})

describe('firstLine', () => {
  it('is the first line, cut with an ellipsis, never inside a character', () => {
    expect(firstLine('a\nb')).toBe('a')
    expect(firstLine('abcdef', 4)).toBe('abc…')
    expect(firstLine('abcd', 4)).toBe('abcd')
    expect(firstLine('😀😀😀😀😀', 4)).toBe('😀😀😀…')
  })
})

describe('templateErrorText', () => {
  it.each([
    ['name_taken', 'A template with this name exists'],
    ['too_many', 'Up to 100 templates'],
    ['duplicate_name', 'Two templates in the file have the same name'],
    ['conflict', 'Changed on another device'],
    ['not_found', 'Deleted on another device'],
    ['newer_format', 'Saved by a newer Termote; update it to change templates'],
    ['view_only', 'This device is view only'],
    ['templates_unavailable', 'Templates are not available on this server'],
    ['busy', 'The templates are being changed elsewhere; try again'],
    ['too_large', 'Too large to save'],
    ['import_changed', 'The templates changed since the check; check again'],
    ['other', 'Could not save the templates'],
  ])('%s', (code, text) => {
    expect(templateErrorText({ code }, tEn)).toBe(text)
  })

  it('names what is invalid, and anything else could not save', () => {
    expect(
      templateErrorText(
        {
          code: 'invalid_template',
          message: 'the text is empty',
        },
        tEn,
      ),
    ).toBe('Not saved: the text is empty')
    // A refusal without its reason never shows "undefined"
    expect(templateErrorText({ code: 'invalid_template' }, tEn)).toBe(
      'Not saved: ',
    )
    expect(templateErrorText(null, tEn)).toBe('Could not save the templates')
  })
})
