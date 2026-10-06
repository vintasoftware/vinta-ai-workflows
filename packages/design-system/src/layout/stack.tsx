import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '../lib/utils.ts'

/**
 * Flex rows and columns with `gap`, so sibling groups — buttons, chips, meta
 * facts, toolbar items — are spaced by the container and not by margins on
 * each child. `<HStack gap={2}>` over `<div className="flex gap-2">`: the
 * intent is in the tag, and the gap is on the 4px scale by construction.
 *
 * Tailwind only generates classes it can see as literals, which is why the
 * scale is a lookup table rather than a template string.
 */
const GAP = {
  0: 'gap-0',
  1: 'gap-1',
  2: 'gap-2',
  3: 'gap-3',
  4: 'gap-4',
  5: 'gap-5',
  6: 'gap-6',
  8: 'gap-8',
  10: 'gap-10',
  12: 'gap-12',
} as const

export type Space = keyof typeof GAP

const stackVariants = cva('flex', {
  variants: {
    direction: {
      row: 'flex-row',
      column: 'flex-col',
    },
    align: {
      start: 'items-start',
      center: 'items-center',
      end: 'items-end',
      stretch: 'items-stretch',
      baseline: 'items-baseline',
    },
    justify: {
      start: 'justify-start',
      center: 'justify-center',
      end: 'justify-end',
      between: 'justify-between',
    },
    wrap: {
      true: 'flex-wrap',
      false: 'flex-nowrap',
    },
  },
  defaultVariants: {
    direction: 'column',
    align: 'stretch',
    justify: 'start',
    wrap: false,
  },
})

export interface StackProps
  extends React.ComponentProps<'div'>,
    VariantProps<typeof stackVariants> {
  readonly gap?: Space
}

function Stack({ className, direction, align, justify, wrap, gap = 2, ...props }: StackProps) {
  return (
    <div
      data-slot="stack"
      className={cn(stackVariants({ direction, align, justify, wrap }), GAP[gap], className)}
      {...props}
    />
  )
}

/** A row. Items centre on the cross axis unless told otherwise. */
function HStack({ align = 'center', ...props }: Omit<StackProps, 'direction'>) {
  return <Stack direction="row" align={align} {...props} />
}

/** A column. */
function VStack(props: Omit<StackProps, 'direction'>) {
  return <Stack direction="column" {...props} />
}

export { HStack, Stack, stackVariants, VStack }
