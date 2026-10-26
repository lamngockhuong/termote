import { StreamLanguage, type StreamParser } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import type { LanguageId } from './highlight-langs'

type Loader = () => Promise<Extension>

// A legacy (stream) mode, wrapped as a language
async function stream(parser: Promise<StreamParser<unknown>>) {
  return StreamLanguage.define(await parser)
}

// How the editor colors each language Files knows (highlight-langs.ts): a
// chunk of its own per language, imported the first time a file of it is
// edited. Only the language (its parser, colors and indentation), not what
// its package adds around it: no completion, no closing tag typed for you.
// null: edited as plain text.
const LOADERS: Record<LanguageId, Loader | null> = {
  bat: null,
  c: async () => (await import('@codemirror/lang-cpp')).cpp().language,
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp().language,
  csharp: () =>
    stream(import('@codemirror/legacy-modes/mode/clike').then((m) => m.csharp)),
  css: async () => (await import('@codemirror/lang-css')).css().language,
  dart: () =>
    stream(import('@codemirror/legacy-modes/mode/clike').then((m) => m.dart)),
  diff: () =>
    stream(import('@codemirror/legacy-modes/mode/diff').then((m) => m.diff)),
  docker: () =>
    stream(
      import('@codemirror/legacy-modes/mode/dockerfile').then(
        (m) => m.dockerFile,
      ),
    ),
  dotenv: () =>
    stream(
      import('@codemirror/legacy-modes/mode/properties').then(
        (m) => m.properties,
      ),
    ),
  go: async () => (await import('@codemirror/lang-go')).go().language,
  graphql: null,
  hcl: null,
  html: async () => (await import('@codemirror/lang-html')).html().language,
  ini: () =>
    stream(
      import('@codemirror/legacy-modes/mode/properties').then(
        (m) => m.properties,
      ),
    ),
  java: async () => (await import('@codemirror/lang-java')).java().language,
  javascript: async () =>
    (await import('@codemirror/lang-javascript')).javascript().language,
  json: async () => (await import('@codemirror/lang-json')).json().language,
  jsonc: async () => (await import('@codemirror/lang-json')).json().language,
  jsx: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ jsx: true })
      .language,
  kotlin: () =>
    stream(import('@codemirror/legacy-modes/mode/clike').then((m) => m.kotlin)),
  lua: () =>
    stream(import('@codemirror/legacy-modes/mode/lua').then((m) => m.lua)),
  makefile: null,
  markdown: async () =>
    (await import('@codemirror/lang-markdown')).markdown().language,
  php: async () => (await import('@codemirror/lang-php')).php().language,
  powershell: () =>
    stream(
      import('@codemirror/legacy-modes/mode/powershell').then(
        (m) => m.powerShell,
      ),
    ),
  proto: () =>
    stream(
      import('@codemirror/legacy-modes/mode/protobuf').then((m) => m.protobuf),
    ),
  python: async () =>
    (await import('@codemirror/lang-python')).python().language,
  ruby: () =>
    stream(import('@codemirror/legacy-modes/mode/ruby').then((m) => m.ruby)),
  rust: async () => (await import('@codemirror/lang-rust')).rust().language,
  scss: async () => (await import('@codemirror/lang-sass')).sass().language,
  shellscript: () =>
    stream(import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell)),
  sql: async () => (await import('@codemirror/lang-sql')).sql().language,
  svelte: async () => (await import('@codemirror/lang-html')).html().language,
  swift: () =>
    stream(import('@codemirror/legacy-modes/mode/swift').then((m) => m.swift)),
  toml: () =>
    stream(import('@codemirror/legacy-modes/mode/toml').then((m) => m.toml)),
  tsx: async () =>
    (await import('@codemirror/lang-javascript')).javascript({
      jsx: true,
      typescript: true,
    }).language,
  typescript: async () =>
    (await import('@codemirror/lang-javascript')).javascript({
      typescript: true,
    }).language,
  vue: async () => (await import('@codemirror/lang-vue')).vue().language,
  xml: async () => (await import('@codemirror/lang-xml')).xml().language,
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml().language,
}

const loaded = new Map<LanguageId, Promise<Extension | null>>()

// The editor's support for a language, or null when it has none or its chunk
// failed to load (then the next file of it tries again)
export function loadLanguage(id: LanguageId | undefined) {
  const load = id && LOADERS[id]
  if (!load) return Promise.resolve(null)
  let p = loaded.get(id)
  if (!p) {
    p = load().catch(() => {
      loaded.delete(id)
      return null
    })
    loaded.set(id, p)
  }
  return p
}
