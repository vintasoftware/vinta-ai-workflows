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
