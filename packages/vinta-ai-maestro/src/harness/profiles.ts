/**
 * Operator-level harness profiles: a named binary and environment for one
 * harness, picked per run with `--harness-profile <name>`.
 *
 * **What it is for.** A second account on the same harness — a second Claude
 * seat behind its own `CLAUDE_CONFIG_DIR` and its own `claude` install — used
 * to mean restating `CLAUDE_CONFIG_DIR=… VINTA_AI_MAESTRO_CLAUDE_BIN=…` in
 * front of every `run --resume`, recovered from `ps` output when nobody wrote
 * it down. A profile names that once, on the operator's machine.
 *
 * **The operator's file, never the plan's.** Like `--system-one`, it says
 * which account on this machine is billed and which binary runs, which a
 * committed document must not decide for whoever runs it. The file lives in
 * the operator's config directory, and a run records only the profile's
 * *name* (`runs/<id>/policy.json`), so a resume reads the values from here
 * again and the run directory never holds them.
 *
 * ```yaml
 * harness_profiles:
 *   claude-second:
 *     harness: claude-code
 *     bin: ~/.local/bin/claude
 *     env:
 *       CLAUDE_CONFIG_DIR: ~/.claude-second
 * ```
 *
 * A profile is applied to the job's own environment before the preflight, so
 * the doctor's login check and every adapter the run builds see the same
 * account. `childEnv` still strips each adapter's provider keys after it, so a
 * profile cannot reinstate an API key §2 removes.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

import { HARNESS_IDS, type HarnessId } from '../types.ts'

/** Overrides where the profiles file is read from. */
export const PROFILES_ENV = 'VINTA_AI_MAESTRO_PROFILES'

/** The env var each adapter reads its binary from (`claude-code.ts` and siblings). */
export const BIN_ENV: Readonly<Record<HarnessId, string>> = {
  'claude-code': 'VINTA_AI_MAESTRO_CLAUDE_BIN',
  codex: 'VINTA_AI_MAESTRO_CODEX_BIN',
  opencode: 'VINTA_AI_MAESTRO_OPENCODE_BIN',
}

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name')

const ProfileSchema = z.strictObject({
  harness: z.enum(HARNESS_IDS),
  bin: z.string().min(1).optional(),
  env: z.record(EnvName, z.string()).optional(),
})

const ProfilesFileSchema = z.strictObject({
  harness_profiles: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/), ProfileSchema),
})

export interface HarnessProfile {
  readonly name: string
  readonly harness: HarnessId
  readonly bin?: string
  readonly env: Readonly<Record<string, string>>
}

export class HarnessProfileError extends Error {}

/** `$VINTA_AI_MAESTRO_PROFILES`, else `$XDG_CONFIG_HOME` or `~/.config`, then `vinta-ai-maestro/profiles.yaml`. */
export function profilesPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[PROFILES_ENV]
  if (explicit !== undefined && explicit !== '') return explicit
  const base = env['XDG_CONFIG_HOME'] || join(homedir(), '.config')
  return join(base, 'vinta-ai-maestro', 'profiles.yaml')
}

/**
 * The named profiles, read from the operator's file. Throws a
 * `HarnessProfileError` naming the problem — the file missing, a name it does
 * not define, two profiles for one harness — and never a value from the file.
 */
export function loadHarnessProfiles(
  names: readonly string[],
  path: string = profilesPath(),
): readonly HarnessProfile[] {
  if (names.length === 0) return []
  if (!existsSync(path)) {
    throw new HarnessProfileError(`no profiles file at ${path} (set ${PROFILES_ENV} to read another)`)
  }
  let raw: unknown
  try {
    raw = parseYaml(readFileSync(path, 'utf8'))
  } catch {
    throw new HarnessProfileError(`${path} is not valid YAML`)
  }
  const parsed = ProfilesFileSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new HarnessProfileError(`${path}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'is not valid'}`.trim())
  }
  const profiles: HarnessProfile[] = []
  const harnesses = new Set<HarnessId>()
  for (const name of new Set(names)) {
    const profile = parsed.data.harness_profiles[name]
    if (profile === undefined) {
      const known = Object.keys(parsed.data.harness_profiles)
      throw new HarnessProfileError(
        `no harness profile "${name}" in ${path}${known.length === 0 ? '' : ` (it defines ${known.join(', ')})`}`,
      )
    }
    // One account per harness per run: two profiles for one harness would
    // leave which binary and which config directory won to argument order.
    if (harnesses.has(profile.harness)) {
      throw new HarnessProfileError(`two harness profiles for ${profile.harness}; pick one`)
    }
    harnesses.add(profile.harness)
    profiles.push({
      name,
      harness: profile.harness,
      ...(profile.bin === undefined ? {} : { bin: expandHome(profile.bin) }),
      env: Object.fromEntries(Object.entries(profile.env ?? {}).map(([key, value]) => [key, expandHome(value)])),
    })
  }
  return profiles
}

/** The environment the profiles add: each one's variables, then its binary. */
export function profileEnv(profiles: readonly HarnessProfile[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const profile of profiles) {
    Object.assign(env, profile.env)
    if (profile.bin !== undefined) env[BIN_ENV[profile.harness]] = profile.bin
  }
  return env
}

/** Puts the profiles into this process's environment, which every adapter and probe inherits. */
export function applyHarnessProfiles(profiles: readonly HarnessProfile[]): void {
  Object.assign(process.env, profileEnv(profiles))
}

function expandHome(value: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}
