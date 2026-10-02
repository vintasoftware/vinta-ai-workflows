/**
 * A System One classifier run as a local process.
 *
 * One process per question: the question goes in on stdin as `wireRequest`'s
 * JSON, the answer comes out on stdout in the shape `normalizeScores` reads.
 * It exists for the case the HTTP adapter cannot serve — a classifier that
 * must not see repository content leave the machine. A local model behind a
 * ten-line script answers the same questions with nothing crossing a network.
 *
 * Spawned without a shell, from an argv the operator configured. A question is
 * never interpolated into a command line; it reaches the child only as stdin.
 *
 * stderr is read and discarded. It is the child's to fill with whatever it
 * likes — including the input — and a refusal here only ever names the exit
 * code or the timeout.
 */
import { spawn } from 'node:child_process'
import { commandInvocation } from '../platform/platform.ts'
import {
  normalizeScores,
  questionProblem,
  wireRequest,
  type SystemOneAdapter,
  type SystemOneOutcome,
  type SystemOnePreflight,
  type SystemOneQuestion,
} from './adapter.ts'
import { DEFAULT_SYSTEM_ONE_TIMEOUT_MS } from './http.ts'

export interface CommandSystemOneOptions {
  readonly id?: string
  /** The program and its arguments. Never passed through a shell. */
  readonly argv: readonly [string, ...string[]]
  readonly timeoutMs?: number
}

/** Stdout beyond this is not an answer, it is a runaway. */
const MAX_STDOUT_BYTES = 64 * 1024

export class CommandSystemOneAdapter implements SystemOneAdapter {
  readonly id: string
  readonly #argv: readonly [string, ...string[]]
  readonly #timeoutMs: number

  constructor(options: CommandSystemOneOptions) {
    this.id = options.id ?? 'command'
    this.#argv = options.argv
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_SYSTEM_ONE_TIMEOUT_MS
  }

  async preflight(): Promise<SystemOnePreflight> {
    return { ready: true }
  }

  async classify(question: SystemOneQuestion): Promise<SystemOneOutcome> {
    const problem = questionProblem(question)
    if (problem !== null) return { ok: false, kind: 'invalid', message: problem }

    const started = Date.now()
    const [file, ...args] = this.#argv
    const invocation = commandInvocation(file, args)
    const result = await new Promise<
      { readonly code: number | null; readonly stdout: string; readonly timedOut: boolean } | null
    >((resolve) => {
      let child
      try {
        child = spawn(invocation.file, [...invocation.args], {
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        })
      } catch {
        resolve(null)
        return
      }
      let stdout = ''
      let overflow = false
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, this.#timeoutMs)
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        if (stdout.length + chunk.length > MAX_STDOUT_BYTES) {
          overflow = true
          child.kill('SIGKILL')
          return
        }
        stdout += chunk
      })
      child.stdin?.on('error', () => {})
      child.on('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: overflow ? -1 : code, stdout, timedOut })
      })
      child.stdin?.end(`${JSON.stringify(wireRequest(question))}\n`)
    })

    if (result === null) return { ok: false, kind: 'unavailable', message: 'classifier command could not be started' }
    if (result.timedOut) return { ok: false, kind: 'unavailable', message: `no answer within ${this.#timeoutMs} ms` }
    if (result.code !== 0) return { ok: false, kind: 'unavailable', message: `classifier command exited ${String(result.code)}` }

    let body: unknown
    try {
      body = JSON.parse(result.stdout)
    } catch {
      return { ok: false, kind: 'invalid', message: 'classifier command printed something that is not JSON' }
    }
    const normalized = normalizeScores(question.labels, body)
    if (!normalized.ok) return { ok: false, kind: 'invalid', message: normalized.message }
    return { ok: true, scores: normalized.scores, latencyMs: Date.now() - started }
  }
}
