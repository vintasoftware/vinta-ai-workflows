import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Class names, merged the shadcn way: `clsx` for the conditionals, then
 * `tailwind-merge` so a caller's `p-2` actually beats a component's `p-4`
 * instead of both landing in the attribute and the stylesheet's order deciding.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
