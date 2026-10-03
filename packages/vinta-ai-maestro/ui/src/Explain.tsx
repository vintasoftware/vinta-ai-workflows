/**
 * An info icon that says how a figure was arrived at.
 *
 * Opens on hover for a glance and on click to stay open — a click pins it, so
 * an explanation long enough to need reading does not vanish when the pointer
 * drifts toward it. Escape and an outside click close it either way. It is a
 * popover rather than a tooltip because a tooltip never opens on touch or on a
 * click, and a figure whose provenance only a mouse can reach is not explained.
 */
import { InfoIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from 'vinta-design-system/ui/popover'

/** Long enough to cross the gap from the icon into the popover without it closing. */
const HOVER_CLOSE_MS = 150

export function Explain({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(closing.current), [])

  const hoverIn = (): void => {
    clearTimeout(closing.current)
    setOpen(true)
  }
  const hoverOut = (): void => {
    if (pinned) return
    closing.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setPinned(false)
      }}
    >
      <PopoverTrigger
        aria-label={label}
        data-explain={label}
        className="inline-flex size-4 cursor-help items-center justify-center rounded-full align-[-2px] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
        onClick={(event) => {
          // Radix would toggle here, which closes a popover that hover already
          // opened — the opposite of what a click on an open one should do.
          event.preventDefault()
          clearTimeout(closing.current)
          const next = !pinned
          setPinned(next)
          setOpen(next)
        }}
      >
        <InfoIcon className="size-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="flex w-80 flex-col gap-2 text-xs leading-relaxed"
        data-explanation={label}
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
        // Hover must not pull focus off whatever the operator was doing.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}
