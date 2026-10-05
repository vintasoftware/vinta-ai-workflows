/**
 * The plan, as written, with a comment affordance on every section (§19).
 *
 * The markdown is the contract a reviewer is approving — the graph and the
 * prompts are derived from it — so it is shown whole rather than summarised,
 * cut at its headings so each section can carry its own comments. An outline
 * beside it is the plan's table of contents, with a count on every section
 * somebody has said something about.
 */
import { GitBranchIcon, MessageSquarePlusIcon } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import { cn } from 'vinta-design-system/lib/utils'
import type { Anchor, PlanReview } from '../../src/review/document.ts'
import { Prose } from './Markdown.tsx'
import { Quotable } from './Quotable.tsx'
import { commentsAt, type PlanSection, type SplitPlan } from './plan-model.ts'

export const SECTION_ID_PREFIX = 'plan-section-'

export function PlanDocument({
  planRef,
  split,
  review,
  sectionToNode,
  focus,
  onComment,
  onShowPhase,
}: {
  readonly planRef: string
  readonly split: SplitPlan
  readonly review: PlanReview | null
  /** Section id → the phase whose brief it is. */
  readonly sectionToNode: ReadonlyMap<string, string>
  /** A section to scroll to when the tab opens — a comment's "show me". */
  readonly focus: string | null
  readonly onComment: (anchor: Anchor, quote?: string) => void
  readonly onShowPhase: (nodeId: string) => void
}) {
  useEffect(() => {
    if (focus === null) return
    document.getElementById(`${SECTION_ID_PREFIX}${focus}`)?.scrollIntoView?.({ block: 'start' })
  }, [focus])

  const openCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const section of split.sections) {
      const anchor: Anchor = { kind: 'section', section: section.id }
      counts.set(section.id, commentsAt(review, anchor).filter((c) => c.status === 'open').length)
    }
    return counts
  }, [split, review])

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[220px_minmax(0,1fr)]" data-plan-document>
      <nav
        aria-label="Plan outline"
        className="hidden max-h-[calc(100vh-8rem)] overflow-y-auto xl:sticky xl:top-16 xl:block"
      >
        <p className="mb-2 truncate font-mono text-[11px] text-muted-foreground" title={planRef}>
          {planRef}
        </p>
        <ul className="flex flex-col gap-0.5 text-[13px]">
          {split.sections.map((section) => (
            <li key={section.id}>
              <a
                href={`#${SECTION_ID_PREFIX}${section.id}`}
                onClick={(event) => {
                  // The fragment is the app's route; an in-page jump must not
                  // replace it, so this scrolls instead of navigating.
                  event.preventDefault()
                  document
                    .getElementById(`${SECTION_ID_PREFIX}${section.id}`)
                    ?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
                }}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted',
                  section.depth >= 3 && 'pl-5 text-muted-foreground',
                  section.depth === 1 && 'font-medium',
                )}
              >
                <span className="truncate">{section.title}</span>
                {(openCounts.get(section.id) ?? 0) > 0 && (
                  <span className="rounded-full bg-tone-attention-soft px-1.5 font-mono text-[11px] text-tone-attention-foreground">
                    {openCounts.get(section.id)}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <article className="flex min-w-0 flex-col gap-1 rounded-xl border bg-card px-6 py-5 shadow-xs">
        {split.preamble !== '' && <Prose text={split.preamble} className="plan-prose" />}
        {split.sections.map((section) => (
          <Section
            key={section.id}
            section={section}
            open={openCounts.get(section.id) ?? 0}
            phase={sectionToNode.get(section.id) ?? null}
            focused={focus === section.id}
            onComment={(quote) =>
              onComment({ kind: 'section', section: section.id, heading: section.title }, quote)
            }
            onShowPhase={onShowPhase}
          />
        ))}
      </article>
    </div>
  )
}

function Section({
  section,
  open,
  phase,
  focused,
  onComment,
  onShowPhase,
}: {
  readonly section: PlanSection
  readonly open: number
  readonly phase: string | null
  readonly focused: boolean
  readonly onComment: (quote?: string) => void
  readonly onShowPhase: (nodeId: string) => void
}) {
  return (
    <section
      id={`${SECTION_ID_PREFIX}${section.id}`}
      data-section={section.id}
      className={cn(
        'group/section relative -mx-3 scroll-mt-20 rounded-lg px-3 py-1 transition-colors',
        open > 0 && 'border-l-2 border-tone-attention bg-tone-attention-soft/30',
        focused && 'ring-2 ring-ring/40',
      )}
    >
      <div className="absolute top-1.5 right-2 flex items-center gap-1 opacity-60 transition-opacity group-hover/section:opacity-100 focus-within:opacity-100">
        {phase !== null && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-action="show-phase"
            onClick={() => onShowPhase(phase)}
            title="Show this phase on the graph"
          >
            <GitBranchIcon aria-hidden="true" />
            {phase}
          </Button>
        )}
        <Button
          type="button"
          variant={open > 0 ? 'secondary' : 'ghost'}
          size="xs"
          data-action="comment-section"
          aria-label={`Comment on ${section.title}`}
          onClick={() => onComment()}
        >
          <MessageSquarePlusIcon aria-hidden="true" />
          {open > 0 ? open : null}
        </Button>
      </div>
      <Quotable onQuote={(quote) => onComment(quote)}>
        <Prose text={section.markdown} className="plan-prose pr-28" />
      </Quotable>
    </section>
  )
}
