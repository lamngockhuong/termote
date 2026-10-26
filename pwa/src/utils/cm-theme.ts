import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

// The colors come from the app's tokens, so the editor follows the light and
// dark modes and the UI style without a theme of its own. Inline styles
// only (style-mod): the CSP allows them, never a script.
export const baseTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--tm-bg)',
    color: 'var(--tm-fg)',
    fontSize: '13px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-term)', lineHeight: '1.625' },
  '.cm-content': { caretColor: 'var(--tm-fg)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--tm-fg)' },
  '.cm-gutters': {
    backgroundColor: 'var(--tm-bg)',
    color: 'var(--tm-fg-subtle)',
    borderRight: '1px solid var(--tm-border)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--tm-accent-soft)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--tm-accent-soft)',
    color: 'var(--tm-fg)',
  },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
    {
      backgroundColor: 'color-mix(in srgb, var(--tm-accent) 25%, transparent)',
    },
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--tm-accent) 12%, transparent)',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--tm-accent) 20%, transparent)',
    outline: '1px solid var(--tm-border-strong)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--tm-warning) 25%, transparent)',
  },
  '.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--tm-warning) 45%, transparent)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--tm-surface)',
    color: 'var(--tm-fg)',
  },
  '.cm-panels-top': { borderBottom: '1px solid var(--tm-border)' },
  '.cm-panel input, .cm-panel button': { fontSize: '12px' },
  '.cm-textfield': {
    backgroundColor: 'var(--tm-bg)',
    color: 'var(--tm-fg)',
    border: '1px solid var(--tm-border-strong)',
    borderRadius: 'var(--tm-radius-control)',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--tm-surface-raised)',
    color: 'var(--tm-fg)',
    border: '1px solid var(--tm-border-strong)',
    borderRadius: 'var(--tm-radius-control)',
  },
})

// The colors of the code, as GitHub's light and dark themes give them, so a
// file reads the same in the editor as in the viewer (Shiki)
function codeColors(c: {
  keyword: string
  string: string
  comment: string
  constant: string
  fn: string
  type: string
  tag: string
  deleted: string
  inserted: string
  invalid: string
}): Extension {
  return syntaxHighlighting(
    HighlightStyle.define([
      {
        tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword],
        color: c.keyword,
      },
      {
        tag: [t.string, t.special(t.string), t.regexp, t.character],
        color: c.string,
      },
      { tag: [t.comment, t.meta], color: c.comment },
      {
        tag: [
          t.number,
          t.bool,
          t.null,
          t.atom,
          t.constant(t.name),
          t.propertyName,
          t.attributeName,
          t.url,
        ],
        color: c.constant,
      },
      {
        tag: [
          t.function(t.variableName),
          t.function(t.propertyName),
          t.macroName,
        ],
        color: c.fn,
      },
      {
        tag: [t.typeName, t.className, t.namespace, t.labelName],
        color: c.type,
      },
      { tag: [t.tagName, t.angleBracket], color: c.tag },
      { tag: t.heading, color: c.constant, fontWeight: 'bold' },
      { tag: t.strong, fontWeight: 'bold' },
      { tag: t.emphasis, fontStyle: 'italic' },
      { tag: t.link, color: c.string, textDecoration: 'underline' },
      { tag: t.strikethrough, textDecoration: 'line-through' },
      { tag: t.deleted, color: c.deleted },
      { tag: t.inserted, color: c.inserted },
      { tag: t.invalid, color: c.invalid },
    ]),
  )
}

export const lightCode = codeColors({
  keyword: '#cf222e',
  string: '#0a3069',
  comment: '#6e7781',
  constant: '#0550ae',
  fn: '#8250df',
  type: '#953800',
  tag: '#116329',
  deleted: '#82071e',
  inserted: '#116329',
  invalid: '#82071e',
})

export const darkCode = codeColors({
  keyword: '#ff7b72',
  string: '#a5d6ff',
  comment: '#8b949e',
  constant: '#79c0ff',
  fn: '#d2a8ff',
  type: '#ffa657',
  tag: '#7ee787',
  deleted: '#ffa198',
  inserted: '#aff5b4',
  invalid: '#ffa198',
})
