/**
 * The mark beside the name: a V, drawn rather than typed, in the brand blue.
 * Its own file because two pages wear it — the run monitor (`App.tsx`) and
 * the interview page (`Interview.tsx`) — and the second must not have to
 * bundle the first to get it.
 */
export function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-grid size-[18px] place-items-center rounded-[5px] bg-primary text-primary-foreground"
    >
      <svg
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 4l5 8 5-8" />
      </svg>
    </span>
  )
}
