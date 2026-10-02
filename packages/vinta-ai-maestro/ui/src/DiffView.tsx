/**
 * The whole diff of a phase, full page (§10).
 *
 * Its own route rather than the changes card expanded, for two reasons the
 * card's `expandable` panels do not have. A diff is *linkable* — the
 * question's `diffRef`, a chat message, a note in the plan all want to point
 * at it — and it is *navigable*: a file list on the left that scrolls the
 * reading column to the file, which an overlay over the node view has no room
 * for. The route is also what lets the browser's back button return to the
 * phase, which is where the operator was.
 *
 * The daemon serves the patch once, on request, and this view parses it
 * (`diff.ts`) and highlights it (`Code.tsx`). The per-file counts come off the
 * same response and are authoritative: when the patch was cut to size, the
 * list still names every file, and the ones past the cut say they are not in
 * what was served rather than appearing unchanged.
 *
 * Re-read when the run's stream moves, because a running phase's working tree
 * moves with it — and on a button, for the operator who does not trust that.
 */
import { ChevronLeftIcon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderHeading,
  PageHeaderMeta,
  PageHeaderTitle,
} from 'vinta-design-system/layout'
import { Alert, AlertDescription } from 'vinta-design-system/ui/alert'
import { Button } from 'vinta-design-system/ui/button'
import type { ChangedFile, NodeChanges } from '../../src/daemon/schemas.ts'
import { Chip } from './Chip.tsx'
import type { Client } from './client.ts'
import { ChangeBar, Counts, FileDiffCard, PathName, StatusMark } from './Code.tsx'
import { parsePatch, type FileDiff } from './diff.ts'
import { languageFor } from './highlight.ts'
import { Live } from './Live.tsx'
import { EmptyNote, ErrorNote } from './Panel.tsx'
import { useRun } from './useRun.ts'

export function DiffView({
  client,
  runId,
  nodeId,
  file: wanted,
}: {
  readonly client: Client
  readonly runId: string
  readonly nodeId: string
  /** A file to scroll to on arrival, from the changes card's rows. */
  readonly file: string | null
}) {
  const { projection, connected } = useRun(client, runId)
  const [changes, setChanges] = useState<NodeChanges | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const cursor = projection.cursor

  useEffect(() => {
    let stopped = false
    client.changes(runId, nodeId, { patch: true }).then(
      (next) => {
        if (stopped) return
        setChanges(next)
        setError(null)
      },
      (cause: unknown) => {
        if (!stopped) setError(cause instanceof Error ? cause.message : 'the daemon could not be reached')
      },
    )
    return () => {
      stopped = true
    }
  }, [client, runId, nodeId, cursor, reloads])

  const parsed = useMemo(() => parsePatch(changes?.patch ?? ''), [changes?.patch])
  const byPath = useMemo(() => new Map(parsed.map((file) => [file.path, file])), [parsed])

  // Scroll to the file the card was clicked on, once it is on the page.
  useEffect(() => {
    if (wanted !== null && changes !== null) reveal(wanted)
  }, [wanted, changes])

  const nodeHref = `#/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}`

  if (changes === null) {
    return (
      <section className="diff-view">
        <EmptyNote>{error ?? 'Reading the diff…'}</EmptyNote>
      </section>
    )
  }

  const files = changes.files
  const scale = Math.max(0, ...files.map((file) => (file.additions ?? 0) + (file.deletions ?? 0)))

  return (
    <section className="diff-view flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <a
          href={nodeHref}
          className="inline-flex w-fit items-center gap-1 text-[13px] text-muted-foreground no-underline hover:text-foreground hover:no-underline"
        >
          <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
          Back to {nodeId}
        </a>
        <PageHeader>
          <PageHeaderHeading>
            <PageHeaderTitle>Changes · {nodeId}</PageHeaderTitle>
            <PageHeaderMeta>
              <span data-diff-branch>{changes.branch ?? '—'}</span>
              <span>base {changes.baseBranch ?? '—'}</span>
              <span>{changes.lane ?? 'no lane'}</span>
            </PageHeaderMeta>
          </PageHeaderHeading>
          <PageHeaderActions>
            {changes.source !== 'none' && (
              <Chip tone={changes.source === 'worktree' ? 'active' : 'idle'}>
                {changes.source === 'worktree' ? 'working tree' : 'branch'}
              </Chip>
            )}
            <span className="text-sm text-muted-foreground" data-diff-totals>
              {changes.totals.files} {changes.totals.files === 1 ? 'file' : 'files'}
            </span>
            <Counts additions={changes.totals.additions} deletions={changes.totals.deletions} className="text-sm" />
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-action="refresh-diff"
              onClick={() => setReloads((count) => count + 1)}
            >
              <RefreshCwIcon />
              Refresh
            </Button>
            <Live connected={connected} />
          </PageHeaderActions>
        </PageHeader>
      </div>

      {error !== null && <ErrorNote>{error}</ErrorNote>}

      {changes.truncated && (
        <Alert data-diff-truncated>
          <AlertDescription>
            The patch was cut to fit. Every file is listed with its counts; the ones past the cut
            have no content here.
          </AlertDescription>
        </Alert>
      )}

      {changes.source === 'none' && <EmptyNote>This node has no branch to diff yet.</EmptyNote>}
      {changes.source !== 'none' && files.length === 0 && <EmptyNote>No file has changed yet.</EmptyNote>}

      {files.length > 0 && (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(220px,280px)_minmax(0,1fr)]">
          <nav
            aria-label="Changed files"
            className="flex flex-col gap-0.5 rounded-lg border bg-card p-2 lg:sticky lg:top-16 lg:max-h-[calc(100vh-5rem)] lg:overflow-y-auto"
            data-diff-files
          >
            {files.map((file) => (
              <a
                key={file.path}
                href={`#${anchor(file.path)}`}
                className="flex items-center gap-2 rounded-md px-1.5 py-1 text-foreground no-underline hover:bg-muted hover:no-underline"
                data-file-link={file.path}
                onClick={(event) => {
                  // The hash is the route, so a plain anchor jump would navigate.
                  event.preventDefault()
                  reveal(file.path)
                }}
              >
                <StatusMark status={file.status} />
                <PathName path={file.path} className="flex-1" />
                <ChangeBar additions={file.additions} deletions={file.deletions} scale={scale} />
                <Counts additions={file.additions} deletions={file.deletions} />
              </a>
            ))}
          </nav>

          <div className="flex min-w-0 flex-col gap-4">
            {files.map((file) => (
              <FileSection key={file.path} file={file} diff={byPath.get(file.path) ?? null} />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function FileSection({ file, diff }: { readonly file: ChangedFile; readonly diff: FileDiff | null }) {
  const id = anchor(file.path)
  if (diff === null) {
    return (
      <section id={id} className="scroll-mt-20 rounded-lg border bg-card" data-file={file.path}>
        <header className="flex items-center gap-3 px-3 py-2">
          <StatusMark status={file.status} />
          <PathName path={file.path} className="flex-1 text-[13px]" />
          <Counts additions={file.additions} deletions={file.deletions} />
        </header>
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          {file.status === 'untracked'
            ? 'Untracked and not in the served patch.'
            : 'Not in the served patch.'}
        </p>
      </section>
    )
  }
  return (
    <FileDiffCard
      id={id}
      file={diff}
      lang={languageFor(file.path)}
      counts={file}
      status={file.status}
    />
  )
}

/** An element id for a path — the route owns the hash, so this is for `reveal` only. */
function anchor(path: string): string {
  return `file-${encodeURIComponent(path)}`
}

/** Scrolls a file's card to the top of the window. jsdom has no `scrollIntoView`; it is skipped there. */
function reveal(path: string): void {
  const element = document.getElementById(anchor(path))
  if (element !== null && typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ block: 'start' })
  }
}
