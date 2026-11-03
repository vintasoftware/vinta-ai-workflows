/**
 * The interview server, as the page sees it (`src/interview/server.ts`).
 *
 * The same three rules as the run client's: the server's zod schemas are the
 * contract in both directions, the token rides in a header, and a failure
 * carries a code rather than a body. Two exceptions to the header, both
 * because a browser cannot set one there: the event stream's URL, and a
 * document's URL when it is the `src` of an iframe or an image. Both are
 * built, used and never rendered as text.
 */
import type { z } from 'zod'
import {
  InterviewAnswersSchema,
  InterviewRoundSchema,
  type InterviewAnswers,
  type InterviewRound,
} from '../../src/interview/document.ts'
import {
  InterviewErrorSchema,
  InterviewStateSchema,
  SubmittedResponseSchema,
  type InterviewState,
} from '../../src/interview/wire.ts'

/** Mirrors `daemon/auth.ts`'s `TOKEN_QUERY` and `interview/server.ts`'s prefix; both are Node-only. */
const TOKEN_QUERY = 'token'
const API = '/api/interview'

/** A refusal the server explained, by code. Never the text that was refused. */
export class InterviewRefused extends Error {
  readonly code: string
  constructor(code: string) {
    super(`interview request refused: ${code}`)
    this.name = 'InterviewRefused'
    this.code = code
  }
}

export interface InterviewClient {
  readonly state: () => Promise<InterviewState>
  readonly round: (n: number) => Promise<InterviewRound>
  readonly answers: (n: number) => Promise<InterviewAnswers>
  /** Resolves to where the server wrote the answers. */
  readonly submit: (n: number, answers: InterviewAnswers) => Promise<string>
  /** A Markdown document under the interview's `docs/`, as text. */
  readonly doc: (path: string) => Promise<string>
  /** A document's URL for an iframe or an image: the one place the token is in a URL. */
  readonly docUrl: (path: string) => string
  /**
   * Server-sent state. Absent where the browser has no `EventSource` (the
   * test environment), and then the page polls alone. Returns the unsubscribe.
   */
  readonly events?: (onState: (state: InterviewState) => void) => () => void
}

/** `docs/foo.md` and `foo.md` both name the same file; the server strips the prefix too. */
const docSegments = (path: string): string =>
  path
    .replace(/^docs\//, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/')

export function createInterviewClient(origin: string, token: string): InterviewClient {
  const client: InterviewClient = {
    state: () => call('GET', `${API}/state`, InterviewStateSchema),
    round: (n) => call('GET', `${API}/rounds/${n}`, InterviewRoundSchema),
    answers: (n) => call('GET', `${API}/answers/${n}`, InterviewAnswersSchema),
    submit: async (n, answers) =>
      (await call('POST', `${API}/answers/${n}`, SubmittedResponseSchema, answers)).path,
    doc: async (path) => {
      const response = await fetch(`${origin}${API}/docs/${docSegments(path)}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!response.ok) throw await refusal(response)
      return await response.text()
    },
    docUrl: (path) =>
      `${origin}${API}/docs/${docSegments(path)}?${TOKEN_QUERY}=${encodeURIComponent(token)}`,
  }
  if (typeof EventSource === 'undefined') return client

  return {
    ...client,
    events: (onState) => {
      const source = new EventSource(`${origin}${API}/events?${TOKEN_QUERY}=${encodeURIComponent(token)}`)
      source.addEventListener('state', (event) => {
        try {
          const parsed = InterviewStateSchema.safeParse(JSON.parse((event as MessageEvent<string>).data))
          if (parsed.success) onState(parsed.data)
        } catch {
          // A frame this client cannot read is dropped; the next poll catches up.
        }
      })
      // `EventSource` reconnects on its own after an error.
      return () => source.close()
    },
  }

  async function call<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw await refusal(response)
    const parsed = schema.safeParse(await response.json())
    if (!parsed.success) throw new Error(`${path}: response did not match the interview schema`)
    return parsed.data
  }
}

async function refusal(response: Response): Promise<InterviewRefused> {
  try {
    const parsed = InterviewErrorSchema.safeParse(await response.json())
    return new InterviewRefused(parsed.success ? parsed.data.error : `http_${response.status}`)
  } catch {
    return new InterviewRefused(`http_${response.status}`)
  }
}
