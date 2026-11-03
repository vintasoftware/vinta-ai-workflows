/**
 * A Mermaid fence, drawn.
 *
 * Plans, specs and interview rounds describe flows and state machines in
 * Mermaid because the skills ask for it, and until this existed the page
 * showed the fence as a block of source. The library is loaded on first use
 * — it is the largest thing in the bundle by a distance, and most pages never
 * need it — and drawn with `securityLevel: 'strict'`, under which Mermaid
 * sanitises the SVG it emits and runs nothing from the source. That is the
 * one place this app sets `innerHTML` from text it did not write, and the
 * text is the agent's diagram, not repository content (§11).
 *
 * While it loads, and whenever it cannot draw the source, the fence is shown
 * as the code it is, so a diagram that fails to render still says what it
 * meant to show.
 */
import { useEffect, useState } from 'react'
import { cn } from 'vinta-design-system/lib/utils'
import { CodeBlock } from './Code.tsx'
import { useResolvedTheme } from './theme.tsx'

let sequence = 0

export function Mermaid({ source, className }: { readonly source: string; readonly className?: string }) {
  const theme = useResolvedTheme()
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let stopped = false
    setFailed(false)
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: theme === 'dark' ? 'dark' : 'neutral',
        })
        sequence += 1
        const drawn = await mermaid.render(`mermaid-${sequence}`, source)
        if (!stopped) setSvg(drawn.svg)
      } catch {
        if (!stopped) {
          setSvg(null)
          setFailed(true)
        }
      }
    })()
    return () => {
      stopped = true
    }
  }, [source, theme])

  if (svg === null) {
    return (
      <div className={cn('flex flex-col gap-1', className)} data-mermaid={failed ? 'failed' : 'loading'}>
        <CodeBlock code={source} lang={null} />
        {failed && <p className="text-[13px] text-muted-foreground">This diagram could not be drawn; its source is above.</p>}
      </div>
    )
  }
  return (
    <div
      className={cn('mermaid overflow-x-auto rounded-lg border bg-card p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full', className)}
      data-mermaid="drawn"
      // Mermaid's own sanitised output; see the note above.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
