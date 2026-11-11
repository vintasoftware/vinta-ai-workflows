/**
 * The run coordinator's conversation, where the operator can reach it.
 *
 * It used to be one card of eight in the run view's grid: a third of a row,
 * below the fold on any real run, and absent from the phase view entirely —
 * which is where the operator is standing when the question occurs to them.
 * For the one feature on these screens that answers an arbitrary question
 * about the run, that was the wrong amount of room and the wrong place.
 *
 * So it is a dock. On the run view, a wide window gets it as a column beside
 * the page, sticky and the height of the viewport, open by default and
 * remembered across visits; a narrow window, and the phase view whatever its
 * width, get it as a sheet that slides in over the right edge without taking
 * the page away — the sheet is non-modal, so the operator can read the
 * transcript beside it and ask about what they are reading. One button in
 * the page header opens either, and says so.
 *
 * The conversation itself is `MonitorPanel`, unchanged: it is the journal's,
 * so the dock and the sheet show the same thing, and so does the next tab.
 */
import { MessageSquareTextIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from 'vinta-design-system/ui/sheet'
import type { Client } from './client.ts'
import { MonitorPanel } from './Monitor.tsx'

const OPEN_KEY = 'vinta-ai-maestro-coordinator'
const WIDE = '(min-width: 1440px)'

/** Whether the dock is open — remembered across pages and visits. */
export function useCoordinatorOpen(defaultOpen: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(OPEN_KEY)
      return stored === null ? defaultOpen : stored === 'open'
    } catch {
      return defaultOpen
    }
  })
  return [
    open,
    (next) => {
      setOpen(next)
      try {
        localStorage.setItem(OPEN_KEY, next ? 'open' : 'closed')
      } catch {
        // A browser that refuses storage still gets a dock for this page.
      }
    },
  ]
}

/** Wide enough for a docked column. jsdom has no `matchMedia`, and counts as wide. */
export function useWide(): boolean {
  const [wide, setWide] = useState(() => {
    const query = typeof window.matchMedia === 'function' ? window.matchMedia(WIDE) : null
    return query === null ? true : query.matches
  })
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(WIDE)
    const update = (): void => setWide(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return wide
}

/** The header button: opens the dock, and reads as pressed while it is open. */
export function CoordinatorButton({ open, onToggle }: { readonly open: boolean; readonly onToggle: () => void }) {
  return (
    <Button
      type="button"
      variant={open ? 'secondary' : 'outline'}
      size="sm"
      data-action="coordinator"
      aria-pressed={open}
      onClick={onToggle}
    >
      <MessageSquareTextIcon aria-hidden="true" />
      Coordinator
    </Button>
  )
}

/**
 * The dock itself. `docked` is the run view's column; everything else is the
 * sheet. Returns null when closed, so a caller renders it unconditionally.
 */
export function CoordinatorDock({
  client,
  runId,
  open,
  onOpenChange,
  docked = false,
}: {
  readonly client: Client
  readonly runId: string
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** Offer the column when the window is wide enough; the sheet otherwise. */
  readonly docked?: boolean
}) {
  const wide = useWide()
  if (!open) return null

  if (docked && wide) {
    return (
      // A sidebar, not a card: flush with the page's right edge, from under
      // the top bar (3rem) to the bottom of the window, with the page's own
      // vertical padding (1.5rem each way) pulled back so it meets both. The
      // conversation fills it and the composer sits at the bottom.
      <aside
        className="sticky top-12 -my-6 -mr-5 flex h-[calc(100vh-3rem)] w-[26rem] shrink-0 flex-col self-start"
        data-coordinator-dock="column"
      >
        <MonitorPanel
          client={client}
          runId={runId}
          fill
          className="h-full rounded-none border-0 border-l bg-background shadow-none"
        />
      </aside>
    )
  }

  return (
    <Sheet open modal={false} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-hidden p-0 sm:max-w-xl"
        data-coordinator-dock="sheet"
        // Non-modal so the page stays usable; a click on the page must not
        // close what the operator just opened to ask about it.
        onInteractOutside={(event) => event.preventDefault()}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Coordinator</SheetTitle>
          <SheetDescription>Ask the run coordinator about this run.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          {/* The sheet's own close button sits in the top-right corner, where
              the panel's header puts its fold and expand controls; the header
              gives it that corner. */}
          <MonitorPanel
            client={client}
            runId={runId}
            fill
            className="h-full rounded-none border-0 shadow-none [&_[data-slot=card-header]]:pr-12"
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
