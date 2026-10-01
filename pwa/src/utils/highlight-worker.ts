/// <reference lib="webworker" />
// Highlights a file off the main thread: a grammar's regular expressions can
// backtrack for seconds on hostile input, and the terminal shares the main
// thread. highlight.ts gives up after a timeout and ends this worker.
import type { HighlighterCore, LanguageRegistration } from 'shiki/core'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { LanguageId } from './highlight-langs'

export type Token = [content: string, color?: string, fontStyle?: number]

export interface HighlightRequest {
  id: number
  text: string
  lang: LanguageId
  theme: 'light' | 'dark'
}

export interface HighlightReply {
  id: number
  // null: not highlighted (the grammar failed); the text is shown plain
  lines: Token[][] | null
}

// Sent once the grammar is loaded, as tokenizing starts: the timeout counts
// from here, so a slow download is not taken for a stuck grammar.
export interface HighlightStarted {
  id: number
  started: true
}

type Grammar = () => Promise<{ default: LanguageRegistration[] }>

// Each one is its own chunk, fetched the first time a file needs it.
export const GRAMMARS: Record<LanguageId, Grammar> = {
  bat: () => import('shiki/langs/bat.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  dotenv: () => import('shiki/langs/dotenv.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  hcl: () => import('shiki/langs/hcl.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  makefile: () => import('shiki/langs/makefile.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  proto: () => import('shiki/langs/proto.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
}

let highlighter: Promise<HighlighterCore> | undefined

// One highlighter per worker, with no grammar until a file asks for one.
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [
      import('shiki/themes/github-light.mjs'),
      import('shiki/themes/github-dark.mjs'),
    ],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  })
  return highlighter
}

export async function tokenize(
  text: string,
  lang: LanguageId,
  theme: 'light' | 'dark',
  onStart: () => void = () => {},
): Promise<Token[][]> {
  const h = await getHighlighter()
  if (!h.getLoadedLanguages().includes(lang)) {
    await h.loadLanguage(GRAMMARS[lang]())
  }
  onStart()
  const { tokens } = h.codeToTokens(text, {
    lang,
    theme: theme === 'dark' ? 'github-dark' : 'github-light',
  })
  return tokens.map((line) =>
    line.map((t): Token => [t.content, t.color, t.fontStyle]),
  )
}

export async function handleRequest(
  req: HighlightRequest,
  onStart?: () => void,
): Promise<HighlightReply> {
  try {
    return {
      id: req.id,
      lines: await tokenize(req.text, req.lang, req.theme, onStart),
    }
  } catch {
    // A grammar the JavaScript engine cannot run: plain text
    return { id: req.id, lines: null }
  }
}

self.onmessage = async (e: MessageEvent<HighlightRequest>) => {
  const started: HighlightStarted = { id: e.data.id, started: true }
  self.postMessage(await handleRequest(e.data, () => self.postMessage(started)))
}
