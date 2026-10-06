/**
 * The daemon's own log, on screen.
 *
 * §10's table has a row per *run* surface, and this is not one of those. It is
 * the process behind them: what it bound, what it refused, which node it
 * dispatched, and what threw. It is its own section rather than a panel on the
 * run view for one concrete reason — the records worth reading most are the
 * ones with no run to hang them on. A daemon that would not bind, a start
 * request refused before a run id existed, a crash with three runs in flight:
 * none of those has a run page, and a per-run panel would hide exactly the
 * evidence somebody came looking for.
 *
 * ### It follows rather than polls a snapshot
 *
 * The first read is a tail; every read after it passes the cursor back and
 * gets only what is new. That is why the interval can be short without the
 * cost growing with the length of the run — a quiet daemon answers with an
 * empty array. When the daemon says `more`, the next read is immediate instead
 * of waiting for the tick, so a burst drains at the speed of the network
 * rather than at the speed of the clock.
 *
 * **Following is off the moment you scroll up.** A log that yanks you back to
 * the bottom while you are reading the thing that went wrong is a log you
 * cannot read. Scrolling back to the bottom turns it on again, which is the
 * gesture people already expect from a terminal.
 *
 * ### Filters go to the daemon, not to the list
 *
 * A level or a search typed here changes the query, so narrowing to `error`
 * reads less rather than rendering less — the cursor advances past records the
 * filter rejected, on the daemon's side. Changing a filter starts a fresh tail,
 * because the records that match it are mostly in the past.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PageHeader,
  PageHeaderHeading,
  PageHeaderMeta,
  PageHeaderTitle,
} from 'vinta-design-system/layout'
import { Button } from 'vinta-design-system/ui/button'
import { Card } from 'vinta-design-system/ui/card'
import { Input } from 'vinta-design-system/ui/input'
import { NativeSelect, NativeSelectOption } from 'vinta-design-system/ui/native-select'
import type { LogPage, LogRecordResponse } from '../../src/daemon/schemas.ts'
import { Chip } from './Chip.tsx'
import type { LogsClient } from './logs-client.ts'
import { EmptyNote, ErrorNote, Hint } from './Panel.tsx'
import type { Tone } from './status.ts'

/** How often the view asks for what is new. One small read against localhost. */
const FOLLOW_MS = 1500

/** The opening read, and the ceiling on what the list holds. */
const TAIL = 300

/**
 * Records kept in the DOM.
 *
 * A daemon left up for a day at `debug` produces far more than a browser
 * should hold, and the oldest are exactly the ones nobody scrolls to — the
 * file has them, and `path` below says where it is. Dropping from the front
 * keeps this view's cost flat in the daemon's uptime.
 */
const WINDOW = 2000

/** How close to the bottom still counts as "at the bottom", in pixels. */
const STICK_PX = 40

const LEVEL_TONE: Readonly<Record<string, Tone>> = {
  debug: 'idle',
  info: 'active',
  warn: 'attention',
  error: 'error',
}

export function Logs({ logs }: { readonly logs: LogsClient }) {
  const [records, setRecords] = useState<readonly LogRecordResponse[]>([])
  const [error, setError] = useState<string | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [gap, setGap] = useState(false)
  const [following, setFollowing] = useState(true)
  const [level, setLevel] = useState('')
  const [run, setRun] = useState('')
  const [search, setSearch] = useState('')

  // The cursor is a ref, not state: it changes on every read and nothing
  // renders from it, so putting it in state would be a re-render per poll for
  // a value the screen never shows.
  const cursor = useRef<string | null>(null)
  const list = useRef<HTMLDivElement | null>(null)

  // One object, so the effect below re-subscribes when any of them changes
  // rather than once per filter.
  const filters = useMemo(() => ({ level, run, q: search }), [level, run, search])

  const append = useCallback((page: LogPage, replace: boolean) => {
    cursor.current = page.cursor
    setPath(page.path)
    if (page.reset) setGap(true)
    setRecords((current) => {
      const next = replace ? [...page.records] : [...current, ...page.records]
      return next.length > WINDOW ? next.slice(next.length - WINDOW) : next
    })
  }, [])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    // A filter change invalidates the cursor's meaning for this view — the
    // records that satisfy the new filter are behind it — so every change
    // starts from a fresh tail.
    cursor.current = null
    setRecords([])
    setGap(false)

    const tick = async (): Promise<void> => {
      const at = cursor.current
      const opening = at === null
      try {
        const page = await logs.logs(
          at === null ? { tail: TAIL, ...clean(filters) } : { after: at, ...clean(filters) },
        )
        if (stopped) return
        // The opening read *replaces*; every read after it appends. Without
        // that distinction a filter change would render the new tail under the
        // old one's records.
        append(page, opening)
        setError(null)
        // A burst drains at the speed of the daemon, not of this timer.
        timer = setTimeout(() => void tick(), page.more ? 0 : FOLLOW_MS)
      } catch (cause: unknown) {
        if (stopped) return
        setError(cause instanceof Error ? cause.message : 'the daemon is unreachable')
        timer = setTimeout(() => void tick(), FOLLOW_MS)
      }
    }

    void tick()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [logs, filters, append])

  // Only while following, and only to the bottom. See the module note.
  useEffect(() => {
    if (!following) return
    const element = list.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [records, following])

  return (
    <section className="logs-view flex flex-col gap-5">
      <PageHeader>
        <PageHeaderHeading>
          <PageHeaderTitle>Daemon log</PageHeaderTitle>
          <PageHeaderMeta>
            <span>
              {records.length} {records.length === 1 ? 'record' : 'records'} ·{' '}
              {following ? 'following' : 'paused — scroll to the bottom to follow'}
            </span>
          </PageHeaderMeta>
        </PageHeaderHeading>
      </PageHeader>

      <div className="logs-filters flex flex-wrap items-center gap-2">
        <NativeSelect
          size="sm"
          aria-label="Minimum level"
          data-filter="level"
          value={level}
          onChange={(event) => setLevel(event.currentTarget.value)}
        >
          <NativeSelectOption value="">All levels</NativeSelectOption>
          <NativeSelectOption value="debug">debug and up</NativeSelectOption>
          <NativeSelectOption value="info">info and up</NativeSelectOption>
          <NativeSelectOption value="warn">warn and up</NativeSelectOption>
          <NativeSelectOption value="error">errors only</NativeSelectOption>
        </NativeSelect>
        <Input
          className="h-8 w-48"
          aria-label="Run id"
          data-filter="run"
          placeholder="Run id"
          value={run}
          onChange={(event) => setRun(event.currentTarget.value)}
        />
        <Input
          className="h-8 w-64"
          aria-label="Search events and fields"
          data-filter="q"
          placeholder="Search events and fields"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
        {(level !== '' || run !== '' || search !== '') && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-action="clear-filters"
            onClick={() => {
              setLevel('')
              setRun('')
              setSearch('')
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {error !== null && <ErrorNote>{error}</ErrorNote>}
      {gap && (
        <ErrorNote data-note="gap">
          Older records were rotated away while this view was open. There is a gap above.
        </ErrorNote>
      )}

      <Card className="overflow-hidden py-0">
        <div
          ref={list}
          className="logs max-h-[var(--panel-scroll,60vh)] overflow-y-auto font-mono text-xs"
          onScroll={(event) => {
            const element = event.currentTarget
            const atBottom =
              element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_PX
            setFollowing(atBottom)
          }}
        >
          {records.length === 0 ? (
            <EmptyNote className="p-4">
              Nothing matching yet. The daemon writes here as it works.
            </EmptyNote>
          ) : (
            <ol className="divide-y divide-border">
              {records.map((record) => (
                <Row key={`${record.pid}-${record.seq}-${record.ts}`} record={record} />
              ))}
            </ol>
          )}
        </div>
      </Card>

      {path !== null && (
        <Hint>
          On disk at <span className="font-mono">{path}</span> — NDJSON, one record per line, and
          the same records this view is showing. It rotates at 8 MiB; five rotations are kept.
        </Hint>
      )}
    </section>
  )
}

/**
 * `message` is pulled out of the `key=value` run and given its own line.
 *
 * Everything else in a record is an identifier — short, and readable inline as
 * `node=p1 status=failed`. A message is a sentence, and a sentence of up to two
 * thousand characters set among those reads as a wall that has swallowed the
 * fields on either side of it. Same record, two densities.
 */
const MESSAGE = 'message'

/**
 * Stack frames arrive as `stack_0`, `stack_1`, … — numbered because `Field`
 * admits scalars only (`log/record.ts`). They are grouped out of the inline
 * run for the same reason `message` is, and rendered *after* it: what happened
 * reads before where it happened, and inline they would push the message so
 * far down the row that it read as a footnote to its own stack.
 */
const STACK = /^stack_(\d+)$/

function Row({ record }: { readonly record: LogRecordResponse }) {
  const entries = Object.entries(record.fields)
  const fields = entries.filter(([key]) => key !== MESSAGE && !STACK.test(key))
  const frames = entries
    .filter(([key]) => STACK.test(key))
    .sort(([a], [b]) => Number(STACK.exec(a)?.[1]) - Number(STACK.exec(b)?.[1]))
  const message = record.fields[MESSAGE]
  return (
    <li className="log-row flex gap-3 px-4 py-1.5" data-level={record.level} data-event={record.event}>
      <span className="shrink-0 text-muted-foreground tabular-nums">{clock(record.ts)}</span>
      <span className="shrink-0">
        <Chip tone={LEVEL_TONE[record.level] ?? 'idle'}>{record.level}</Chip>
      </span>
      <span className="min-w-0 flex-1 break-words">
        <span className="font-medium">{record.event}</span>
        {record.runId !== null && (
          <span className="ml-2 text-muted-foreground" data-part="run">
            {record.runId}
            {record.nodeId === null ? '' : `/${record.nodeId}`}
          </span>
        )}
        {fields.length > 0 && (
          <span className="ml-2 text-muted-foreground" data-part="fields">
            {fields.map(([key, value]) => (
              <span key={key} className="mr-2 whitespace-nowrap">
                {key}={value === null ? 'null' : String(value)}
              </span>
            ))}
          </span>
        )}
        {typeof message === 'string' && (
          <span
            className="mt-0.5 block whitespace-pre-wrap break-words text-foreground/90"
            data-part="message"
          >
            {message}
          </span>
        )}
        {frames.length > 0 && (
          <span className="mt-0.5 block text-muted-foreground" data-part="stack">
            {frames.map(([key, value]) => (
              <span key={key} className="block break-all">
                {String(value)}
              </span>
            ))}
          </span>
        )}
      </span>
    </li>
  )
}

/** `14:02:31.184`. The date is the file's business; this is a timeline. */
function clock(ts: number): string {
  const at = new Date(ts)
  const time = at.toTimeString().slice(0, 8)
  return `${time}.${String(at.getMilliseconds()).padStart(3, '0')}`
}

/** Drops the empty strings, so an untouched filter is not sent as `level=`. */
function clean(filters: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== ''))
}
