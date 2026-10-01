import { SquareTerminal } from 'lucide-react'
import type { ViewProps } from '../app-views'
import { TERMINAL_VIEW_ID } from '../view-ids'
import { Button } from './ui/button'

// The way out of any view to the pane's terminal, where every screen can be
// answered.
export function OpenTerminalButton({ showView }: Pick<ViewProps, 'showView'>) {
  return (
    <Button size="sm" onClick={() => showView(TERMINAL_VIEW_ID)}>
      <SquareTerminal size={14} aria-hidden="true" />
      Open terminal
    </Button>
  )
}
