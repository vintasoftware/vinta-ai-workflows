import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type * as React from 'react'
import { cn } from '../lib/utils.ts'

/**
 * shadcn's badge, plus the six **tone** variants.
 *
 * A tone variant is a soft tint with dark text of the same hue — a badge that
 * can sit in a table row or a heading a dozen times without shouting. The
 * solid variants (`default`, `destructive`) are for the one thing on a screen
 * that must be seen first. The meaning of each tone is `tokens.css`'s, not
 * this file's: `wait` is patience and `error` is a stop, and no consumer may
 * paint the first with the second.
 */
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        destructive:
          'bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90',
        outline:
          'border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        ghost: '[a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 [a&]:hover:underline',
        // Tones. Same hue for the tint and the text, so each reads as one colour.
        idle: 'bg-tone-idle-soft text-tone-idle-foreground',
        active: 'bg-tone-active-soft text-tone-active-foreground',
        wait: 'bg-tone-wait-soft text-tone-wait-foreground',
        attention: 'bg-tone-attention-soft text-tone-attention-foreground',
        ok: 'bg-tone-ok-soft text-tone-ok-foreground',
        error: 'bg-tone-error-soft text-tone-error-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>

/** The variants that are tones, for a consumer mapping its own status axis onto them. */
const TONE_VARIANTS = ['idle', 'active', 'wait', 'attention', 'ok', 'error'] as const
type ToneVariant = (typeof TONE_VARIANTS)[number]

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span'

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

/**
 * The tone with no word in it: a dot for a row whose own text already says
 * what happened. `bg-current` by default so it takes the colour of the text
 * beside it; pass a `bg-tone-*` class to give it a tone of its own.
 */
function BadgeDot({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="badge-dot"
      className={cn('inline-block size-2 shrink-0 rounded-full bg-current', className)}
      {...props}
    />
  )
}

export type { BadgeVariant, ToneVariant }
export { Badge, BadgeDot, badgeVariants, TONE_VARIANTS }
