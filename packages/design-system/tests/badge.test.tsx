import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { Badge, BadgeDot, TONE_VARIANTS } from '../src/ui/badge.tsx'

afterEach(cleanup)

test('a tone variant is named on the element and paints with that tone', () => {
  for (const tone of TONE_VARIANTS) {
    const { container } = render(<Badge variant={tone}>{tone}</Badge>)
    const badge = container.querySelector('[data-slot="badge"]')
    expect(badge?.getAttribute('data-variant')).toBe(tone)
    expect(badge?.className).toContain(`bg-tone-${tone}-soft`)
    expect(badge?.className).toContain(`text-tone-${tone}-foreground`)
    cleanup()
  }
})

test('a caller’s class and data attributes survive, so a consumer can keep its own hooks', () => {
  const { container } = render(
    <Badge variant="wait" className="chip" data-tone="wait">
      waiting
    </Badge>,
  )
  const badge = container.querySelector('.chip')
  expect(badge?.getAttribute('data-tone')).toBe('wait')
  expect(badge?.textContent).toBe('waiting')
})

test('the dot takes the current colour unless given a tone of its own', () => {
  const { container } = render(
    <>
      <BadgeDot />
      <BadgeDot className="bg-tone-ok" />
    </>,
  )
  const [plain, toned] = container.querySelectorAll('[data-slot="badge-dot"]')
  expect(plain?.className).toContain('bg-current')
  // tailwind-merge drops the default so the two backgrounds cannot fight.
  expect(toned?.className).toContain('bg-tone-ok')
  expect(toned?.className).not.toContain('bg-current')
})
