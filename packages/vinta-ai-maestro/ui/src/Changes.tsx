/**
 * What the phase changed, on the node view (§10): the files, their line
 * counts, and the way to the whole diff.
 *
 * This card replaced a panel that printed `git diff base...branch` for the
 * operator to paste into a terminal. It was honest — the daemon served a
 * reference, not a rendering — and it answered none of the questions an
 * operator opens a phase with: did it touch the migration, how big is it, is
 * it still going. So the daemon describes the change now
 * (`integration/changes.ts`) and this card shows the description: every file
 * up to ten, the rest as a count, and one button to the full diff.
 *
 * **It polls the cheap half, slowly.** The daemon runs git for this on every
 * read — and in a lane with files not yet added, once more per such file —
 * so the card asks for the counts and never the patch, and asks when the
 * run's stream moves plus on a tick several times slower than the transcript's.
 * A working tree does not change faster than an agent types, and the counts
 * are a glance, not a feed.
 *
 * **It degrades to the reference.** A daemon older than this browser answers
 * 404, and a node with no branch yet has nothing to describe. Both say so in
 * words, and the ref — branch, base, lane — stays on the card either way,
 * because it is what the operator needs to look for themselves.
 */
import { FileDiffIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import type { NodeChanges, NodeDetail } from '../../src/daemon/schemas.ts'
import type { Client } from './client.ts'
import { ChangeBar, Counts, PathName, StatusMark } from './Code.tsx'
import { EmptyNote, Hint, Panel } from './Panel.tsx'
import { useNow } from './time.ts'

/** How many files the card lists before it counts the rest. */
export const CHANGES_SHOWN = 5

/** The slow clock. Five times the transcript's, for the reason the header gives. */
const REFRESH_MS = 10_000

type Loaded = { readonly kind: 'loaded'; readonly changes: NodeChanges }
type State =
  | { readonly kind: 'loading' }
  | Loaded
  /** The daemon answered, but not with this endpoint: an older build. */
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed' }

export function Changes({
  client,
  runId,
  nodeId,
  ref,
  cursor,
  pullRequest,
}: {
  readonly client: Client
  readonly runId: string
  readonly nodeId: string
  /** The node detail's reference, which is on screen before the counts are. */
  readonly ref: NodeDetail['diff']
  /** The run stream's cursor: a frame means something moved, and the counts are re-read. */
  readonly cursor: number
  /** The phase's own PR, once `open_pr` ran. Null before then. */
  readonly pullRequest: NodeDetail['pullRequest']
}) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const tick = useNow(REFRESH_MS)

  useEffect(() => {
    let stopped = false
    client.changes(runId, nodeId, { patch: false }).then(
      (changes) => {
        if (!stopped) setState({ kind: 'loaded', changes })
      },
      (cause: unknown) => {
        if (stopped) return
        // A previous read stands until a new one lands, so a hiccup does not
        // blank a list the operator was reading.
        setState((current) =>
          current.kind === 'loaded' ? current : is404(cause) ? { kind: 'unsupported' } : { kind: 'failed' },
        )
      },
    )
    return () => {
      stopped = true
    }
  }, [client, runId, nodeId, cursor, tick])

  const href = `#/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/changes`
  const loaded = state.kind === 'loaded' ? state.changes : null
  const files = loaded?.files ?? []
  const shown = files.slice(0, CHANGES_SHOWN)
  const rest = files.length - shown.length
  const scale = Math.max(0, ...files.map((file) => (file.additions ?? 0) + (file.deletions ?? 0)))

  return (
    <Panel
      title="Changes"
      data-changes
      description={<span data-changes-summary>{summary(state, ref)}</span>}
      action={
        loaded !== null && loaded.totals.files > 0 ? (
          <Counts additions={loaded.totals.additions} deletions={loaded.totals.deletions} />
        ) : undefined
      }
    >
      {state.kind === 'loading' && <EmptyNote>Reading the branch…</EmptyNote>}
      {state.kind === 'failed' && <EmptyNote>The daemon could not describe this branch.</EmptyNote>}
      {state.kind === 'unsupported' && (
        <EmptyNote>This daemon does not describe changes. Diff the branch yourself:</EmptyNote>
      )}
      {loaded !== null && loaded.source === 'none' && (
        <EmptyNote>
          {ref.branch === null ? 'This node has no branch yet.' : 'Nothing on this branch yet.'}
        </EmptyNote>
      )}
      {loaded !== null && loaded.source !== 'none' && files.length === 0 && (
        <EmptyNote>No file has changed yet.</EmptyNote>
      )}

      {shown.length > 0 && (
        <ul className="changes -mx-1 flex flex-col" data-changed-files>
          {shown.map((file) => (
            <li key={file.path} data-file={file.path}>
              <a
                href={`${href}?file=${encodeURIComponent(file.path)}`}
                className="flex items-center gap-2 rounded-md px-1 py-1 text-foreground no-underline hover:bg-muted hover:no-underline"
              >
                <StatusMark status={file.status} />
                <PathName path={file.path} className="flex-1" />
                <ChangeBar additions={file.additions} deletions={file.deletions} scale={scale} />
                <Counts additions={file.additions} deletions={file.deletions} className="w-20 justify-end" />
              </a>
            </li>
          ))}
        </ul>
      )}
      {rest > 0 && (
        <Hint className="muted" data-changes-rest>
          and {rest} more {rest === 1 ? 'file' : 'files'}
        </Hint>
      )}

      {loaded !== null && loaded.source !== 'none' && (
        <Button asChild size="sm" className="w-fit" data-action="view-diff">
          <a href={href}>
            <FileDiffIcon />
            View full diff
          </a>
        </Button>
      )}

      {/* The reference, always: it is what the operator reaches for when the
          card cannot help, and what the older panel was. */}
      <Ref diff={ref} />
      {pullRequest !== null && <PullRequestLine pullRequest={pullRequest} />}
    </Panel>
  )
}

/** The phase PR as a link, or why there is none. */
function PullRequestLine({
  pullRequest,
}: {
  readonly pullRequest: NonNullable<NodeDetail['pullRequest']>
}) {
  return (
    <p className="m-0 font-mono text-[11px] text-muted-foreground" data-diff-pr>
      PR{' '}
      {pullRequest.url === null ? (
        pullRequest.reason === 'unavailable' ? (
          'not opened — gh is not installed'
        ) : (
          'not opened — gh failed'
        )
      ) : (
        // The page URL carries the daemon token, so the forge must not be
        // sent it as a referrer.
        <a href={pullRequest.url} target="_blank" rel="noreferrer noopener">
          {pullRequest.number === null ? pullRequest.url : `#${pullRequest.number}`}
        </a>
      )}
    </p>
  )
}

function summary(state: State, ref: NodeDetail['diff']): string {
  if (state.kind !== 'loaded') return ref.branch === null ? 'No branch yet.' : `On ${ref.branch}.`
  const { totals, source } = state.changes
  if (source === 'none') return ref.branch === null ? 'No branch yet.' : `${ref.branch} has nothing yet.`
  const files = `${totals.files} ${totals.files === 1 ? 'file' : 'files'} changed`
  const where = source === 'worktree' ? 'in the lane’s working tree, uncommitted work included' : 'on the branch'
  return `${files} ${where}.`
}

/** Branch, base and lane, one line, in mono. Wraps: two branch names are wider than this card. */
function Ref({ diff }: { readonly diff: NodeDetail['diff'] }) {
  return (
    <p className="m-0 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
      <span data-diff-branch>{diff.branch ?? '—'}</span>
      <span>
        ← <span data-diff-base>{diff.baseBranch ?? '—'}</span>
      </span>
      <span>
        lane <span data-diff-lane>{diff.lane ?? '—'}</span>
      </span>
    </p>
  )
}

/** `client.ts` names the endpoint and the status, and nothing else; the status is what this reads. */
function is404(cause: unknown): boolean {
  return cause instanceof Error && / 404$/.test(cause.message)
}
