/**
 * The review page's half of the wire: plans that have not run (§19).
 *
 * Its own client for the reason `editor-client.ts` is: a plan under review is
 * a document, not a run, and has neither a run's socket nor its lifetime. Same
 * three rules as its neighbours — the daemon's zod schemas are the contract in
 * both directions, the token rides in a header, and a failure carries a code.
 */
import type { z } from 'zod'
import {
  ErrorResponseSchema,
  PlanListResponseSchema,
  PlanReviewResponseSchema,
  PlanScheduleResponseSchema,
  PlanViewResponseSchema,
  type PlanListResponse,
  type PlanReviewResponse,
  type PlanScheduleResponse,
  type PlanViewResponse,
} from '../../src/daemon/schemas.ts'
import type { Anchor, CommentStatus } from '../../src/review/document.ts'

const TOKEN_QUERY = 'token'

/** A refusal the daemon explained, by code. Never the text that was refused. */
export class PlanRefused extends Error {
  readonly code: string
  constructor(code: string) {
    super(`plan request refused: ${code}`)
    this.name = 'PlanRefused'
    this.code = code
  }
}

export interface NewCommentInput {
  readonly anchor: Anchor
  readonly body: string
  readonly quote?: string
}

export interface PlansClient {
  readonly list: () => Promise<PlanListResponse['plans']>
  readonly view: (id: string) => Promise<PlanViewResponse>
  readonly review: (id: string) => Promise<PlanReviewResponse>
  readonly schedule: (id: string) => Promise<PlanScheduleResponse>
  readonly comment: (id: string, input: NewCommentInput) => Promise<PlanReviewResponse>
  readonly reply: (id: string, commentId: string, body: string) => Promise<PlanReviewResponse>
  readonly setStatus: (
    id: string,
    commentId: string,
    status: CommentStatus,
  ) => Promise<PlanReviewResponse>
  readonly discard: (id: string, commentId: string) => Promise<PlanReviewResponse>
  readonly message: (
    id: string,
    body: string,
    send: 'unsent' | 'none',
  ) => Promise<PlanReviewResponse>
  readonly approve: (id: string) => Promise<PlanReviewResponse>
}

export function createPlansClient(origin: string, token: string): PlansClient {
  const base = (id: string): string => `/api/plans/${encodeURIComponent(id)}`
  const comment = (id: string, commentId: string): string =>
    `${base(id)}/comments/${encodeURIComponent(commentId)}`

  return {
    list: async () => (await call('GET', '/api/plans', PlanListResponseSchema)).plans,
    view: (id) => call('GET', base(id), PlanViewResponseSchema),
    review: (id) => call('GET', `${base(id)}/review`, PlanReviewResponseSchema),
    schedule: (id) => call('GET', `${base(id)}/schedule`, PlanScheduleResponseSchema),
    comment: (id, input) =>
      call('POST', `${base(id)}/comments`, PlanReviewResponseSchema, {
        anchor: input.anchor,
        body: input.body,
        ...(input.quote === undefined || input.quote === '' ? {} : { quote: input.quote }),
      }),
    reply: (id, commentId, body) =>
      call('POST', `${comment(id, commentId)}/replies`, PlanReviewResponseSchema, { body }),
    setStatus: (id, commentId, status) =>
      call('PUT', `${comment(id, commentId)}/status`, PlanReviewResponseSchema, { status }),
    discard: (id, commentId) => call('DELETE', comment(id, commentId), PlanReviewResponseSchema),
    message: (id, body, send) =>
      call('POST', `${base(id)}/messages`, PlanReviewResponseSchema, { body, send }),
    approve: (id) => call('POST', `${base(id)}/approve`, PlanReviewResponseSchema, {}),
  }

  async function call<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
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
    if (!parsed.success) throw new Error(`${path}: response did not match the daemon schema`)
    return parsed.data
  }
}

/** The page's own origin and the token the daemon put in the URL (§10). */
export function pagePlansClient(): PlansClient {
  return createPlansClient(
    location.origin,
    new URLSearchParams(location.search).get(TOKEN_QUERY) ?? '',
  )
}

async function refusal(response: Response): Promise<PlanRefused> {
  try {
    const parsed = ErrorResponseSchema.safeParse(await response.json())
    return new PlanRefused(parsed.success ? parsed.data.error : `http_${response.status}`)
  } catch {
    return new PlanRefused(`http_${response.status}`)
  }
}
