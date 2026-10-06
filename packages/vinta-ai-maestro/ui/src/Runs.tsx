/**
 * The runs list (§10): what exists, what it is doing, and how long it has been
 * doing it.
 *
 * §10's row also names resume and purge. The daemon serves neither — its
 * command surface is the five per-node operations of §9 — so the only action
 * offered here is opening the run. An action the API cannot perform does not
 * belong on a button.
 *
 * There is no stream for the list itself, so it re-reads on the same tick that
 * advances the elapsed clocks: one interval, both jobs.
 */
import { ChevronRightIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { PageHeader, PageHeaderHeading, PageHeaderMeta, PageHeaderTitle } from 'vinta-design-system/layout'
import { Button } from 'vinta-design-system/ui/button'
import { Card } from 'vinta-design-system/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from 'vinta-design-system/ui/table'
import type { RunSummary } from '../../src/daemon/schemas.ts'
import { Chip } from './Chip.tsx'
import type { Client } from './client.ts'
import { EmptyNote, ErrorNote } from './Panel.tsx'
import { runTone } from './status.ts'
import { elapsed, useNow } from './time.ts'

const REFRESH_MS = 2000

export function Runs({ client }: { readonly client: Client }) {
  const now = useNow(REFRESH_MS)
  const [runs, setRuns] = useState<readonly RunSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false
    client.runs().then(
      (next) => {
        if (stopped) return
        setRuns(next)
        setError(null)
      },
      (cause: unknown) => {
        if (!stopped) setError(cause instanceof Error ? cause.message : 'the daemon is unreachable')
      },
    )
    return () => {
      stopped = true
    }
  }, [client, now])

  return (
    <section className="runs-view flex flex-col gap-5">
      <PageHeader>
        <PageHeaderHeading>
          <PageHeaderTitle>Runs</PageHeaderTitle>
          <PageHeaderMeta>
            {runs === null ? (
              <span>Reading the journal…</span>
            ) : (
              <span>
                {runs.length} {runs.length === 1 ? 'run' : 'runs'} on record · refreshes every 2s
              </span>
            )}
          </PageHeaderMeta>
        </PageHeaderHeading>
      </PageHeader>

      {error !== null && <ErrorNote>{error}</ErrorNote>}
      {error === null && runs === null && <EmptyNote>Loading runs…</EmptyNote>}
      {error === null && runs !== null && runs.length === 0 && <EmptyNote>No runs yet.</EmptyNote>}

      {error === null && runs !== null && runs.length > 0 && (
        <Card className="overflow-hidden py-0">
          <Table className="runs">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Workflow</TableHead>
                <TableHead>Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Elapsed</TableHead>
                <TableHead className="w-px pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.runId} data-run={run.runId}>
                  <TableCell className="pl-4 font-medium">{run.workflowId}</TableCell>
                  <TableCell className="muted font-mono text-xs text-muted-foreground">
                    {run.runId}
                  </TableCell>
                  <TableCell>
                    <Chip tone={runTone(run.status)}>{run.status}</Chip>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {elapsed(run.startedAt, run.endedAt ?? now)}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    {/* A fragment, so the token in the page's query string is neither
                        copied into the link nor dropped from the address bar. */}
                    <Button asChild variant="ghost" size="sm">
                      <a href={`#/runs/${encodeURIComponent(run.runId)}`}>
                        Open
                        <ChevronRightIcon />
                      </a>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </section>
  )
}
