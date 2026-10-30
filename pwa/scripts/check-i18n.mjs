// Finds the interface text written straight into the PWA's source, outside
// t(), and fails on any: text goes through src/i18n.
//
//   node scripts/check-i18n.mjs [file...]
//
// With files (the pre-commit hook passes the staged ones), only those are
// checked. What counts, per line of a .ts/.tsx file under src that is not a
// test and not a message catalog:
//   - JSX text: >Words< on one line, or a line of words alone after a line
//     ending in a tag
//   - a literal in aria-label, title, placeholder, alt, label or desc/
//     description, as a JSX attribute or an object key
// A line with `i18n-ignore` in it, or under a line with it, is not counted.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Two letters in a row: a word, not a symbol or a number
const WORD = /\p{L}{2}/u
// Code, not prose, between a > or } and a < or {: an operator, a keyword,
// a template literal, a condition's closing parenthesis (if (a > b) {), a
// type after a destructured parameter (}: Omit<Props, 'x'>), or the rest of
// a call or a signature after a generic or an object (Translate<K>): T {,
// f(t('a', { n }), 'warning', {)
const CODE =
  /[=;&|$`]|\b(?:return|const|else|if|while|catch|finally|case)\b|\)$|^[:)]/
// After a tag's > (not after = or -: an arrow, a generic's end in a type:
// `=> Promise<`) or a value's } ({count} files selected)
const JSX_TEXT = /(?:(?<![=-])>|\})([^<>{}]+)[<{]/g
// &amp; and the like are text, not the & operator
const ENTITY = /&\w+;/g
// A message's key (title: 'tour.chipTitle', label: 'shell.agent.done'),
// read through t() elsewhere
const MESSAGE_KEY = /^[a-z]+(?:\.\w+)+$/
const PROSE_LINE = /^[\p{L}\p{N}][\p{L}\p{N}\s.,!?'’:()&;/-]*$/u
const ATTR =
  /\b(?:aria-label|title|placeholder|alt|label|desc|description)\s*(?:=|:)\s*(['"])((?:(?!\1).)*)\1/g

// A line that ends a JSX tag: the tag whole (<p className="x">, <br />), a
// lone >, or the last attribute of one (onClick={go}>, title="x">); not a
// type's end (NonNullable<X['y']>) nor an arrow
const endsTag = (line) =>
  line.endsWith('>') &&
  !line.endsWith('=>') &&
  (line.startsWith('<') || line === '>' || /["}]>$/.test(line))

// Whether path is one the check reads
export function checked(path) {
  return (
    /\.(ts|tsx)$/.test(path) &&
    !/\.test\.(ts|tsx)$/.test(path) &&
    !path.endsWith('.d.ts') &&
    !path.split(/[\\/]/).includes('messages') &&
    !/[\\/]test-utils\.tsx?$/.test(path)
  )
}

// How many strings of interface text source holds
// jsx: the source is a .tsx file, where text can sit between tags
export function countText(source, jsx = true) {
  const lines = source.split('\n')
  let count = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes('i18n-ignore') || lines[i - 1]?.includes('i18n-ignore'))
      continue
    const trimmed = line.trim()
    if (/^(\/\/|\/\*|\*\/|\*( |$))/.test(trimmed)) continue
    for (const m of jsx ? line.matchAll(JSX_TEXT) : []) {
      const text = m[1].replace(ENTITY, ' ').trim()
      if (WORD.test(text) && !CODE.test(text)) count++
    }
    for (const m of line.matchAll(ATTR)) {
      if (WORD.test(m[2]) && !m[2].includes('${') && !MESSAGE_KEY.test(m[2]))
        count++
    }
    // Words alone on a line, under a tag that ends the line above
    const above = lines[i - 1]?.trim() ?? ''
    if (
      jsx &&
      endsTag(above) &&
      PROSE_LINE.test(trimmed) &&
      WORD.test(trimmed)
    )
      count++
  }
  return count
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  )
}

// A file's name in the report: from the package root, with /
const key = (file) => relative(ROOT, file).split(sep).join('/')

// The counts of files (every checked file under src when none are given)
export function countFiles(files) {
  const counts = {}
  for (const file of files ?? walk(join(ROOT, 'src'))) {
    const name = key(file)
    if (!name.startsWith('src/') || !checked(name)) continue
    const n = countText(readFileSync(file, 'utf8'), name.endsWith('.tsx'))
    if (n > 0) counts[name] = n
  }
  return counts
}

// 1 when a checked file (of args, or all of src) holds interface text
export function main(args) {
  const counts = countFiles(
    args.length ? args.map((f) => join(process.cwd(), f)) : undefined,
  )
  for (const [name, n] of Object.entries(counts).sort()) {
    console.error(`${name}: ${n} interface strings outside t()`)
  }
  if (Object.keys(counts).length) {
    console.error(
      'check-i18n: put interface text in src/i18n/messages and read it with t() ' +
        '(docs/code-standards.md), or mark a line that is not interface text // i18n-ignore',
    )
    return 1
  }
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2))
}
