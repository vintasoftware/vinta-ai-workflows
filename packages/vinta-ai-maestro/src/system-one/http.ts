/**
 * A System One classifier behind an HTTP endpoint.
 *
 * The generic adapter: one POST per question, a documented JSON body in and a
 * documented JSON body out (`wireRequest`, `normalizeScores`). A vendor whose
 * API speaks something else gets a shim in front of it rather than an adapter
 * in here — which is what keeps this package from growing one file per
 * classifier somebody once tried.
 *
 * **The key is the operator's and travels one way.** It is read from the
 * environment variable the operator named, at construction, and sent as a
 * bearer token to the URL the operator configured. It is never read from a
 * workflow document, never written anywhere, and registered for redaction so
 * the daemon log cannot carry it even by accident. This is the one place in
 * the package an API key is used at all; agent harnesses still run on the
 * user's logged-in CLIs (§2, §17.3).
 *
 * **Response bodies are not quoted in refusals.** A classifier that echoes its
 * input in an error would otherwise put a diff into the daemon log.
 */
import { redactValue } from '../log/index.ts'
import {
  normalizeScores,
  questionProblem,
  wireRequest,
  type SystemOneAdapter,
  type SystemOneOutcome,
  type SystemOnePreflight,
  type SystemOneQuestion,
} from './adapter.ts'

export interface HttpSystemOneOptions {
  readonly id?: string
  readonly url: string
  /** The environment variable holding the bearer token. Absent sends none. */
  readonly apiKeyEnv?: string
  readonly timeoutMs?: number
  /** Injected in tests. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Injected in tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch
}

export const DEFAULT_SYSTEM_ONE_TIMEOUT_MS = 10_000

export class HttpSystemOneAdapter implements SystemOneAdapter {
  readonly id: string
  readonly #url: string
  readonly #apiKeyEnv: string | undefined
  readonly #key: string | undefined
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch

  constructor(options: HttpSystemOneOptions) {
    this.id = options.id ?? 'http'
    this.#url = options.url
    this.#apiKeyEnv = options.apiKeyEnv
    const env = options.env ?? process.env
    const key = options.apiKeyEnv === undefined ? undefined : env[options.apiKeyEnv]
    this.#key = key === undefined || key === '' ? undefined : key
    if (this.#key !== undefined) redactValue(this.#key)
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_SYSTEM_ONE_TIMEOUT_MS
    this.#fetch = options.fetch ?? fetch
  }

  async preflight(): Promise<SystemOnePreflight> {
    if (this.#apiKeyEnv !== undefined && this.#key === undefined) {
      return { ready: false, hint: `export ${this.#apiKeyEnv} before starting the daemon` }
    }
    // Valid — an internal classifier may need no key — and the usual cause of
    // an endpoint that answers every question with a 401. Said, not refused.
    if (this.#apiKeyEnv === undefined) {
      return {
        ready: true,
        warning: 'no api_key_env is configured, so requests carry no Authorization header',
      }
    }
    return { ready: true }
  }

  async classify(question: SystemOneQuestion): Promise<SystemOneOutcome> {
    const problem = questionProblem(question)
    if (problem !== null) return { ok: false, kind: 'invalid', message: problem }
    if (this.#apiKeyEnv !== undefined && this.#key === undefined) {
      return { ok: false, kind: 'unavailable', message: `${this.#apiKeyEnv} is not set` }
    }

    const started = Date.now()
    let response: Response
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.#key === undefined ? {} : { authorization: `Bearer ${this.#key}` }),
        },
        body: JSON.stringify(wireRequest(question)),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      return {
        ok: false,
        kind: 'unavailable',
        message: timedOut ? `no answer within ${this.#timeoutMs} ms` : 'request failed',
      }
    }

    if (!response.ok) {
      // Busy and broken servers are worth asking again; a 4xx is a request
      // this adapter will keep getting wrong, the auth pair included.
      const retryable = response.status === 429 || response.status >= 500
      return {
        ok: false,
        kind: retryable ? 'unavailable' : 'invalid',
        message: `classifier answered HTTP ${response.status}`,
      }
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { ok: false, kind: 'invalid', message: 'classifier answered with a body that is not JSON' }
    }
    const normalized = normalizeScores(question.labels, body)
    if (!normalized.ok) return { ok: false, kind: 'invalid', message: normalized.message }
    return { ok: true, scores: normalized.scores, latencyMs: Date.now() - started }
  }
}
