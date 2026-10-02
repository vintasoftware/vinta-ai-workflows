/**
 * Pause and stop, for a whole run (SPEC §9.3).
 *
 * Offered only while the run is `running`: on any other status there is
 * nothing to end, and a button that could only ever refuse does not belong on
 * the page. Both are asks, not acts — the request returns as soon as the run's
 * job has it, and the run ends when its phases reach a boundary. So after a
 * click the buttons stay disabled and say what is happening, and it is the
 * stream's `run_ended`, folded into the run's status, that takes them away.
 *
 * Stop asks twice. It kills live agent turns and makes the run final — nothing
 * can resume it — and a single misplaced click next to Pause should not be
 * able to do that. The confirmation is inline rather than a dialog, because it
 * is one sentence and two buttons, and a modal for that is more page than the
 * decision needs.
 */
import { PauseIcon, SquareIcon } from 'lucide-react'
import type { ReactElement } from 'react'
import { useState } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import type { Client } from './client.ts'
import type { RunStatus } from './projection.ts'

type Requested = 'pause' | 'stop'

const STOP_CLASS =
  'text-tone-error-foreground hover:bg-tone-error-soft hover:text-tone-error-foreground'

export function RunControls({
  client,
  runId,
  status,
}: {
  readonly client: Client
  readonly runId: string
  readonly status: RunStatus
}): ReactElement | null {
  const [requested, setRequested] = useState<Requested | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (status !== 'running') return null

  const send = async (mode: Requested): Promise<void> => {
    setBusy(true)
    setError(null)
    setConfirming(false)
    try {
      await client.halt(runId, mode)
      setRequested(mode)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The request failed.')
    } finally {
      setBusy(false)
    }
  }

  if (requested !== null) {
    return (
      <span className="run-halting text-[13px] text-muted-foreground" data-halting={requested}>
        {requested === 'pause'
          ? 'Pausing — running phases finish their current step first.'
          : 'Stopping…'}
      </span>
    )
  }

  if (confirming) {
    return (
      <span className="run-confirm-stop flex items-center gap-2" role="group" aria-label="Confirm stop">
        <span className="text-[13px]">Stop for good? It cannot be resumed.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={STOP_CLASS}
          data-run-op="stop-confirm"
          disabled={busy}
          onClick={() => void send('stop')}
        >
          Stop run
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-run-op="stop-cancel"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          Keep running
        </Button>
      </span>
    )
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-run-op="pause"
        disabled={busy}
        title="Start nothing new, let running phases finish their current step, then stop. Resumable."
        onClick={() => void send('pause')}
      >
        <PauseIcon />
        Pause
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={STOP_CLASS}
        data-run-op="stop"
        disabled={busy}
        title="Kill every running agent and gate now. Final."
        onClick={() => setConfirming(true)}
      >
        <SquareIcon />
        Stop
      </Button>
      {error !== null && (
        <span role="alert" className="text-[13px] text-tone-error-foreground">
          {error}
        </span>
      )}
    </>
  )
}
