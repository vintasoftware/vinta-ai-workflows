/**
 * Select text, comment on it.
 *
 * The review page's most precise comment is one that quotes what it is about:
 * "this sentence of the brief" rather than "Phase 2". Wrapping a block in this
 * offers a small button beside any selection made inside it, and hands the
 * selected text to the caller as the comment's quote.
 *
 * The button is positioned against the viewport (`fixed`) from the selection's
 * own rectangle, so it lands next to the words whatever scrolled them there.
 */
import { MessageSquarePlusIcon } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import { MAX_QUOTE } from '../../src/review/document.ts'

interface Offer {
  readonly text: string
  readonly top: number
  readonly left: number
}

export function Quotable({
  onQuote,
  label = 'Comment on selection',
  className,
  children,
}: {
  readonly onQuote: (quote: string) => void
  readonly label?: string
  readonly className?: string
  readonly children: ReactNode
}) {
  const box = useRef<HTMLDivElement | null>(null)
  const [offer, setOffer] = useState<Offer | null>(null)

  const read = useCallback(() => {
    const selection = window.getSelection()
    const container = box.current
    if (selection === null || selection.isCollapsed || container === null) {
      setOffer(null)
      return
    }
    const range = selection.getRangeAt(0)
    if (!container.contains(range.commonAncestorContainer)) {
      setOffer(null)
      return
    }
    const text = selection.toString().trim()
    if (text === '') {
      setOffer(null)
      return
    }
    // jsdom has no layout; a zero rect still yields a usable button.
    const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null
    setOffer({
      text: text.slice(0, MAX_QUOTE),
      top: (rect?.bottom ?? 0) + 6,
      left: Math.max(8, (rect?.left ?? 0) + (rect?.width ?? 0) / 2 - 80),
    })
  }, [])

  // A selection cleared by a click elsewhere takes the button with it.
  useEffect(() => {
    if (offer === null) return
    const clear = (): void => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed) setOffer(null)
    }
    document.addEventListener('selectionchange', clear)
    return () => document.removeEventListener('selectionchange', clear)
  }, [offer])

  return (
    <div ref={box} className={className} onMouseUp={read} onKeyUp={read} data-quotable>
      {children}
      {offer !== null && (
        <Button
          type="button"
          size="xs"
          className="fixed z-40 shadow-md"
          style={{ top: offer.top, left: offer.left }}
          data-action="quote"
          // Keep the selection alive through the click: a mousedown would
          // otherwise collapse it before the handler reads it.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onQuote(offer.text)
            setOffer(null)
            window.getSelection()?.removeAllRanges()
          }}
        >
          <MessageSquarePlusIcon aria-hidden="true" />
          {label}
        </Button>
      )}
    </div>
  )
}
