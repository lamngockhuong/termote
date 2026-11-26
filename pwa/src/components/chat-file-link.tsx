import { createContext, type ReactNode, useContext } from 'react'
import { useT } from '../i18n/i18n-context'
import { formatMarks, type LineMark } from '../utils/file-position'

// A file path the agent wrote in the Chat view, opened in the pane's Files
// view on a click. The Chat view gives the opener; without one (a pane with
// no Files view) the path is plain text. A tool card and a message both
// read it, hence a file of its own (they import each other's parts).
export const ChatFileLinkContext = createContext<
  | ((path: string, line?: number, marks?: LineMark[]) => Promise<void>)
  | undefined
>(undefined)

export function FileRef({
  path,
  line,
  marks,
  className = '',
  plainClassName = '',
  title = path,
  children,
}: {
  // None: plain text (a path the server shortened)
  path?: string
  line?: number
  // The lines marked from line: a range, a list of lines
  marks?: LineMark[]
  className?: string
  // Only on the plain text: a colour the link's would clash with
  plainClassName?: string
  // The plain text's title: the path, unless the card says more
  title?: string
  children: ReactNode
}) {
  const open = useContext(ChatFileLinkContext)
  const { t } = useT()
  if (!open || !path) {
    return (
      <span className={`${className} ${plainClassName}`} title={title}>
        {children}
      </span>
    )
  }
  const where = marks?.length
    ? `${path}:${formatMarks(marks)}`
    : line
      ? `${path}:${line}`
      : path
  return (
    <button
      type="button"
      data-file-ref={where}
      title={t('chat.fileLink.open', { where })}
      onClick={() => void open(path, line, marks)}
      className={`${className} cursor-pointer text-left text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid`}
    >
      {children}
    </button>
  )
}
