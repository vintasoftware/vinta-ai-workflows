/**
 * Model fallbacks: what a spawn runs on once the model it asked for is out of
 * quota (`defaults.model_fallbacks`, §6.1).
 *
 * A `quota` refusal normally parks the whole harness, because on a seat plan
 * the usage window is the account's and every model on it is refused alike.
 * Some models carry their own, much smaller allowance — a frontier tier sold
 * as credits on top of the plan — and running out of those says nothing about
 * the rest of the harness. Parking on it would stall every node behind a model
 * the run does not need, for a reset that may never come within the run.
 *
 * So a model with a fallback is retried on the fallback instead. Admission
 * control owns the full rule (it remembers which models are out, per harness);
 * this module holds the part every spawner shares, so the two that bypass
 * admission — the monitor and the conflict fixer — fall back the same way.
 */
import type { AgentTask, HarnessAdapter, SpawnOutcome } from './adapter.ts'

/** Model id → the model to run instead once it is out of quota. */
export type ModelFallbacks = Readonly<Record<string, string>>

/**
 * The next model to try after `model`, skipping any `skip` says is out too.
 * Follows chains, and stops at a cycle rather than looping on one.
 */
export function nextFallback(
  model: string,
  fallbacks: ModelFallbacks | undefined,
  skip: (model: string) => boolean = () => false,
): string | undefined {
  if (fallbacks === undefined) return undefined
  const seen = new Set([model])
  let next = fallbacks[model]
  while (next !== undefined && !seen.has(next)) {
    if (!skip(next)) return next
    seen.add(next)
    next = fallbacks[next]
  }
  return undefined
}

/**
 * `adapter.spawn`, retried down the fallback chain while each model is refused
 * for `quota`. Returns the last outcome and the model it was for.
 *
 * For the spawners outside admission control, which have no harness state to
 * remember an exhaustion in; the caller keeps `model` if it should stick.
 */
export async function spawnWithFallbacks(
  adapter: HarnessAdapter,
  task: AgentTask,
  fallbacks: ModelFallbacks | undefined,
): Promise<{ readonly outcome: SpawnOutcome; readonly model: string }> {
  const tried = new Set<string>()
  let current = task
  for (;;) {
    tried.add(current.model)
    const outcome = await adapter.spawn(current)
    if (outcome.ok || outcome.kind !== 'quota') return { outcome, model: current.model }
    const next = nextFallback(current.model, fallbacks, (model) => tried.has(model))
    if (next === undefined) return { outcome, model: current.model }
    current = { ...current, model: next }
  }
}
