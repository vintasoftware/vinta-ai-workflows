/**
 * The editor's half of the wire: the three workflow endpoints.
 *
 * Separate from `client.ts` because it is a different resource with a
 * different lifetime — `client.ts` reads a *run*, which is live and frozen,
 * and this reads a *document*, which is neither. It follows the same three
 * rules as its neighbour: the daemon's own zod schemas are the contract in
 * both directions, the token rides in a header and never becomes text, and a
 * failure carries a code rather than a body.
 *
 * One thing it adds. A refused save comes back with the daemon's validation
 * issues, and those are the point of the refusal, so they are carried on the
 * thrown error instead of being flattened into a message. They are the
 * validator's own paths and messages — never the workflow's contents.
 */
import {
  ErrorResponseSchema,
  OkResponseSchema,
  WorkflowListResponseSchema,
  WorkflowResponseSchema,
  type Issue,
} from '../../src/daemon/schemas.ts'
import type { Workflow } from '../../src/types.ts'
import type { z } from 'zod'

/** Mirrors `main.tsx`: the token is in the page's query string and read once. */
const TOKEN_QUERY = 'token'

/** A refusal the daemon explained. `issues` are validator paths, never values. */
export class WorkflowRefused extends Error {
  readonly code: string
  readonly issues: readonly Issue[]

  constructor(code: string, issues: readonly Issue[]) {
    super(`workflow request refused: ${code}`)
    this.name = 'WorkflowRefused'
    this.code = code
    this.issues = issues
  }
}

export interface WorkflowClient {
  readonly list: () => Promise<readonly string[]>
  readonly load: (id: string) => Promise<Workflow>
  readonly save: (id: string, workflow: Workflow) => Promise<void>
}

export function createWorkflowClient(origin: string, token: string): WorkflowClient {
  return {
    async list() {
      const body = await get('/api/workflows', WorkflowListResponseSchema)
      return body.workflows.map((entry) => entry.id)
    },

    async load(id) {
      const body = await get(`/api/workflows/${encodeURIComponent(id)}`, WorkflowResponseSchema)
      return body.workflow
    },

    async save(id, workflow) {
      const path = `/api/workflows/${encodeURIComponent(id)}`
      const response = await fetch(`${origin}${path}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(workflow),
      })
      if (!response.ok) throw await refusal(response)
      if (!OkResponseSchema.safeParse(await response.json()).success) {
        throw new Error(`${path}: response did not match the daemon schema`)
      }
    },
  }

  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await fetch(`${origin}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw await refusal(response)
    const parsed = schema.safeParse(await response.json())
    if (!parsed.success) throw new Error(`${path}: response did not match the daemon schema`)
    return parsed.data
  }
}

/** The page's own origin and the token the daemon put in the URL (§10). */
export function pageWorkflowClient(): WorkflowClient {
  return createWorkflowClient(
    location.origin,
    new URLSearchParams(location.search).get(TOKEN_QUERY) ?? '',
  )
}

/** The daemon's error body, or the bare status when it did not send one. */
async function refusal(response: Response): Promise<WorkflowRefused> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return new WorkflowRefused(`http_${response.status}`, [])
  }
  const parsed = ErrorResponseSchema.safeParse(body)
  if (!parsed.success) return new WorkflowRefused(`http_${response.status}`, [])
  return new WorkflowRefused(parsed.data.error, parsed.data.issues ?? [])
}
