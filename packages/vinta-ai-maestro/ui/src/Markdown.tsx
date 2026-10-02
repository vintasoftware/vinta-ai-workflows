/**
 * An agent's prose, rendered as the markdown it is.
 *
 * Agents write markdown — headings, lists, fenced code, a table of what they
 * found — and the transcript used to show it as a paragraph of asterisks and
 * backticks. This renders it, with two rules carried over from everywhere else
 * on the page: fenced code goes through the same highlighter the diff uses, so
 * a block of TypeScript an agent quoted looks like the TypeScript in the diff
 * beside it; and raw HTML in the text is text, never markup. react-markdown
 * builds elements rather than a string, so there is no `innerHTML` here for
 * repository content to reach (§11), and its default of not rendering HTML
 * nodes is kept.
 *
 * Links open in a new tab and carry `rel="noopener"`: the transcript is the
 * reading position, and an agent's link must not be able to reach back to it.
 */
import type { ComponentProps } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from 'vinta-design-system/lib/utils'
import { CodeBlock } from './Code.tsx'
import { supported } from './highlight.ts'

const PLUGINS = [remarkGfm]

/** A fenced block's language, from the class remark gives its `code`. */
const LANGUAGE = /(?:^|\s)language-([\w+-]+)/

/** The text under a hast node, for a `pre` that wants its code as a string. */
function textOf(node: NonNullable<ExtraProps['node']>['children'][number] | undefined): string {
  if (node === undefined) return ''
  if (node.type === 'text') return node.value
  if ('children' in node) return node.children.map((child) => textOf(child)).join('')
  return ''
}

const COMPONENTS: Components = {
  // A fenced block, highlighted. The `pre` has the `code` as its only child,
  // and that child's class names the language — so the block is rebuilt from
  // the hast node rather than from React children, which are already elements.
  pre({ node }) {
    const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code')
    const className = code !== undefined && code.type === 'element' ? code.properties['className'] : undefined
    const classes = Array.isArray(className) ? className.join(' ') : String(className ?? '')
    const lang = LANGUAGE.exec(classes)?.[1] ?? null
    const text = textOf(code).replace(/\n$/, '')
    return <CodeBlock code={text} lang={lang !== null && supported(lang) ? lang : null} className="my-2" />
  },
  // Inline code: `pre` above never renders its child, so anything reaching
  // here is inline.
  code({ className, children, ...props }: ComponentProps<'code'> & ExtraProps) {
    return (
      <code
        className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]', className)}
        {...props}
      >
        {children}
      </code>
    )
  },
  a({ children, href, ...props }: ComponentProps<'a'> & ExtraProps) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    )
  },
  // A wide table scrolls inside its own box rather than widening the row.
  table({ children, ...props }: ComponentProps<'table'> & ExtraProps) {
    return (
      <div className="my-2 overflow-x-auto">
        <table {...props}>{children}</table>
      </div>
    )
  },
}

export function Prose({ text, className }: { readonly text: string; readonly className?: string }) {
  return (
    <div className={cn('markdown', className)}>
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
