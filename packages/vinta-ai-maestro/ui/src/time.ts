import { useEffect, useState } from 'react'

/** Epoch ms, re-read every `everyMs`. Elapsed times are the only live clock here. */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

/** `1h 04m 09s`, `4m 09s`, `9s`. Negative clock skew reads as zero. */
export function elapsed(fromMs: number, toMs: number): string {
  const total = Math.max(0, Math.floor((toMs - fromMs) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`
  return `${seconds}s`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * A measured duration, in the same vocabulary `elapsed` uses.
 *
 * Sub-minute durations keep one decimal — `0s` and `1s` are the two readings
 * a gate panel produces most often and they are not the same answer, and
 * "did the cache serve this" is exactly the question a bare `0s` leaves open.
 * Past a minute the tenth is noise and the shape matches the live clock
 * ticking beside it.
 */
export function duration(ms: number): string {
  if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`
  return elapsed(0, ms)
}

/**
 * `just now`, `40s ago`, `12m ago`, `3h ago`, `2d ago` — how far back a row
 * is, at the precision a glance wants. The exact moment belongs on hover.
 */
export function ago(atMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - atMs) / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}
