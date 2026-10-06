/**
 * Following: a scroller that opens at its newest row and stays there.
 *
 * Shared by the two views that hold a conversation, for the same reason
 * `Entries.tsx` is. A top-anchored box opens a live agent's transcript at the
 * oldest of sixty rows, so the thing the operator came to read — what it is
 * doing *now* — is below the fold, and every new entry pushes it further down.
 *
 * Sticking is conditional: an operator who has scrolled up is reading, and
 * yanking them back to the bottom mid-sentence is worse than the problem it
 * fixes. And because an implicit rule needs an explicit escape, `following`
 * is reported back so the view can offer a way to start again — rather than a
 * 60px band at the bottom of a scroller being the only route into it.
 *
 * Two things here were each a bug in the transcript before this module existed,
 * and the monitor panel — which had none of this — was the second one shipped
 * on its own.
 *
 * - **Stick from a layout effect keyed on the entry count**, not on how many
 *   rows are shown. A windowed list shows `min(entries, window)`, which stops
 *   changing the moment the conversation outgrows one window, so an effect
 *   keyed on it follows perfectly up to entry sixty and then silently never
 *   again. `stick` is stable, so it costs a caller nothing to depend on.
 * - **Reapply the position whenever an element arrives**, because these lists
 *   do not merely change — they are *replaced*. Expanding a panel moves the
 *   subtree through a portal (`Panel.tsx`), which unmounts it and builds it
 *   again in `document.body`: a new `ol`, scrolled to the top, with no render
 *   of the owning component to accompany it. The observer is rebound at the
 *   same moment, which catches the *other* thing a full-page panel does —
 *   swapping `--panel-scroll` from a few hundred pixels to most of the window,
 *   moving the newest row off the screen with no render either. Resizing the
 *   window does the same thing more slowly.
 *
 * `ResizeObserver` is guarded because jsdom has none. Nothing in the suite
 * asserts that path; what it protects is a real browser, where the only
 * alternative is polling a height.
 */
import { useCallback, useRef, useState } from 'react'

/**
 * Treat the view as "at the bottom" within this much of it.
 *
 * Wider than an exact test on purpose: a row arriving mid-scroll, or a
 * fractional device pixel, must not read as "the operator has scrolled away"
 * and silently stop the following.
 */
const STICK_MARGIN = 60

export interface Following {
  /** The `ol`'s ref. A callback, because the element is replaced, not mutated. */
  readonly listRef: (element: HTMLOListElement | null) => void
  /** The `ol`'s `onScroll`. Decides whether the reader is still at the bottom. */
  readonly onScroll: (event: React.UIEvent<HTMLOListElement>) => void
  /** Whether the view is stuck to the newest row. For rendering the escape. */
  readonly following: boolean
  /** Go back to the newest row and follow it again. */
  readonly jump: () => void
  /**
   * Stick to the bottom if the reader has not scrolled away, reporting whether
   * it did. Call from a layout effect — before paint, so a row is never briefly
   * visible at the wrong offset — keyed on the entry count.
   */
  readonly stick: () => boolean
  /** The element itself, for a caller that needs to measure it. */
  readonly list: React.RefObject<HTMLOListElement | null>
}

export function useFollowing(): Following {
  const list = useRef<HTMLOListElement | null>(null)
  // Truth for the layout effect and the callback ref, both of which read it
  // during a commit that the state below may not have caused. The state exists
  // only so a button can render.
  const following = useRef(true)
  const [followingNow, setFollowingNow] = useState(true)
  // Where a reader who is not following was last looking, so it survives the
  // list being rebuilt underneath them.
  const resting = useRef(0)
  const resize = useRef<ResizeObserver | null>(null)

  const stick = useCallback((): boolean => {
    const element = list.current
    if (element === null || !following.current) return false
    element.scrollTop = element.scrollHeight
    return true
  }, [])

  const jump = useCallback((): void => {
    following.current = true
    setFollowingNow(true)
    const element = list.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [])

  const listRef = useCallback((element: HTMLOListElement | null) => {
    resize.current?.disconnect()
    resize.current = null
    list.current = element
    if (element === null) return

    const hold = (): void => {
      if (following.current) element.scrollTop = element.scrollHeight
    }
    if (following.current) hold()
    else element.scrollTop = resting.current

    if (typeof ResizeObserver === 'undefined') return
    resize.current = new ResizeObserver(hold)
    resize.current.observe(element)
  }, [])

  const onScroll = useCallback((event: React.UIEvent<HTMLOListElement>) => {
    const box = event.currentTarget
    resting.current = box.scrollTop
    const at = box.scrollHeight - box.scrollTop - box.clientHeight <= STICK_MARGIN
    following.current = at
    setFollowingNow(at)
  }, [])

  return { listRef, onScroll, following: followingNow, jump, stick, list }
}
