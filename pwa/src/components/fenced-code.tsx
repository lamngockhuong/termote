import { Copy } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useTheme } from '../contexts/theme-context'
import { useT } from '../i18n/i18n-context'
import { highlightLang, type Token } from '../utils/highlight'
import { type LanguageId, languageForName } from '../utils/highlight-langs'
import { isMermaidInfo, textOf } from '../utils/markdown-links'
import { codeText, splitLines, tokenStyle } from './code-block'
import { type FrameParts, MermaidBlock } from './mermaid-block'
import { IconButton } from './ui/button'

// The fenced code blocks of rendered Markdown, shared by the Markdown preview
// and the Chat view: a bar with the language and Copy, the code highlighted
// in its language, and a Mermaid block drawn as its diagram.

export interface FenceOptions {
  wrap: boolean
  notify: (message: string) => void
  // The scroll box a Mermaid block waits to come near
  scrollRoot: () => Element | null
  // The file name a Mermaid block's image is saved as, from its number
  exportName: (index: number) => string
  // In place of the Copy button that reports through notify
  copyButton?: (text: string) => ReactNode
  // The source is being edited: a diagram is drawn once its source stops
  // changing, its last image shown meanwhile
  live?: boolean
}

// A fenced code block: highlighted in its language once the worker answers,
// plain until then and whenever it does not. A Mermaid block adds its
// buttons, a line under the bar, and its diagram in place of the code.
export function FencedCode({
  text,
  lang,
  label,
  wrap,
  notify,
  copyButton,
  toolbar,
  note,
  body,
  dataLine,
}: {
  text: string
  lang?: LanguageId
  label: string
  // The line of the file the block starts on (a Markdown draft's preview)
  dataLine?: number
} & Pick<FenceOptions, 'wrap' | 'notify' | 'copyButton'> &
  FrameParts) {
  const { t } = useT()
  const { resolvedTheme } = useTheme()
  const lines = useMemo(() => splitLines(text), [text])
  const [tokens, setTokens] = useState<Token[][] | null>(null)

  useEffect(() => {
    // Aborted once the block is gone or shows other text: a request still
    // waiting for the worker is dropped
    const ac = new AbortController()
    setTokens(null)
    highlightLang(text, lang, resolvedTheme, ac.signal).then((found) => {
      if (!ac.signal.aborted) setTokens(found)
    })
    return () => ac.abort()
  }, [text, lang, resolvedTheme])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      notify(t('files.code.copied'))
    } catch {
      notify(t('files.code.copyFailed'))
    }
  }

  return (
    <div
      className="my-3 overflow-hidden rounded-control border border-border bg-bg"
      data-testid="fenced-code"
      data-line={dataLine}
    >
      <div className="flex items-center justify-between border-b border-border bg-surface pl-3 text-[11px] text-fg-muted">
        <span className="truncate font-term">{label}</span>
        <div className="flex shrink-0 items-center">
          {toolbar}
          {copyButton ? (
            copyButton(text)
          ) : (
            <IconButton
              size="sm"
              onClick={copy}
              aria-label={t('files.code.copy')}
              title={t('files.code.copy')}
            >
              <Copy size={14} aria-hidden="true" />
            </IconButton>
          )}
        </div>
      </div>
      {note && (
        <p className="border-b border-border px-3 py-1.5 text-[12px] text-fg-muted">
          {note}
        </p>
      )}
      {body ?? (
        <pre className="overflow-x-auto p-3 font-term text-[12px] leading-[1.6] text-fg">
          <code className={`block ${codeText(wrap)}`}>
            {lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a line is its number
              <span key={i}>
                {tokens?.[i]
                  ? tokens[i].map((t, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one line never move
                      <span key={j} style={tokenStyle(t)}>
                        {t[0]}
                      </span>
                    ))
                  : line}
                {i < lines.length - 1 ? '\n' : ''}
              </span>
            ))}
          </code>
        </pre>
      )}
    </div>
  )
}

interface HastElement {
  type: string
  properties: { className?: string[]; dataMermaidIndex?: number }
  children: HastElement[]
}

// The <pre> of react-markdown: a code block comes as <pre><code
// class="language-x">, the code element always there and always alone. A
// Mermaid block needs rehypeMermaidIndex among the rehype plugins.
export function CodeFence({
  node,
  scrollRoot,
  exportName,
  live,
  dataLine,
  ...opts
}: { node?: unknown; dataLine?: number } & FenceOptions) {
  const code = (node as HastElement).children[0]
  const info =
    (code.properties.className ?? [])
      .find((c) => c.startsWith('language-'))
      ?.slice('language-'.length) ?? ''
  const text = textOf(code).replace(/\n$/, '')
  if (isMermaidInfo(info)) {
    // Set by rehypeMermaidIndex for every Mermaid block
    const index = code.properties.dataMermaidIndex as number
    return (
      <MermaidBlock
        text={text}
        index={index}
        scrollRoot={scrollRoot}
        name={exportName(index)}
        notify={opts.notify}
        live={live}
        dataLine={dataLine}
        frame={(parts) => (
          <FencedCode
            text={text}
            lang={languageForName(info)}
            label={info}
            {...opts}
            {...parts}
          />
        )}
      />
    )
  }
  return (
    <FencedCode
      text={text}
      lang={languageForName(info)}
      label={info || 'text'}
      dataLine={dataLine}
      {...opts}
    />
  )
}
