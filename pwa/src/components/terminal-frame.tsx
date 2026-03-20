import { forwardRef } from 'react'

interface Props {
  fontSize?: number
}

export const TerminalFrame = forwardRef<HTMLIFrameElement, Props>(
  ({ fontSize = 14 }, ref) => {
    const url = `/terminal/?fontSize=${fontSize}`

    return (
      <iframe
        ref={ref}
        src={url}
        className="flex-1 w-full h-full border-none bg-black"
        title="Terminal"
        allow="clipboard-read; clipboard-write"
      />
    )
  }
)

TerminalFrame.displayName = 'TerminalFrame'
