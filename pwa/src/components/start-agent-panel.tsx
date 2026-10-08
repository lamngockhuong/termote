import { LoaderCircle } from 'lucide-react'
import { agentLabel } from '../chat-agents'
import type { StartAgentKind } from '../hooks/use-mux-api'
import type { StartRecord } from '../hooks/use-start-agent'
import { Button } from './ui/button'

const KINDS: StartAgentKind[] = ['claude', 'codex']

interface StartAgentPanelProps {
  // This pane's start, if one was made from this page
  record?: StartRecord
  onStart: (kind: StartAgentKind) => void
}

// The Chat view of a pane that shows only its shell: starts Claude Code or
// Codex there, says why a start was refused.
export function StartAgentPanel({ record, onStart }: StartAgentPanelProps) {
  const busy = record?.phase === 'sending' || record?.phase === 'starting'
  return (
    <>
      <p>Start an agent in this pane</p>
      <div className="flex flex-wrap justify-center gap-2">
        {KINDS.map((kind) => (
          <Button
            key={kind}
            variant="secondary"
            disabled={busy}
            onClick={() => onStart(kind)}
          >
            {agentLabel(kind)}
          </Button>
        ))}
      </div>
      {busy && (
        <p className="flex items-center gap-2" role="status">
          <LoaderCircle
            size={16}
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
          Starting {agentLabel(record.kind)}…
        </p>
      )}
      {record?.phase === 'failed' && (
        <p role="alert" className="text-danger">
          {record.error}
        </p>
      )}
    </>
  )
}
