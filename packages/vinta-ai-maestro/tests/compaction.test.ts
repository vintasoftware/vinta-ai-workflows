/**
 * Auto-compaction: that every session gets it, and that no machine can quietly
 * take it away.
 *
 * Worth its own file for the same reason `permissions.test.ts` is: the failure
 * it guards against is invisible until it is expensive. A phase that fills its
 * context window dies at whatever hour it happens to reach that point, having
 * done most of its work, and nothing in the invocation looks wrong afterwards —
 * the flag that would have saved it is one that was never passed, and the
 * variable that killed it was inherited from a shell nobody was thinking about.
 *
 * The premise the whole feature rests on is that **all three vendors already
 * compact by default**, so these tests assert a guard rather than a switch.
 * Each vendor's kill switches were read off the shipped binaries and the
 * published config schema, not out of memory: claude-code 2.1.236 carries
 * `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT` and `autoCompactEnabled`; codex
 * 0.147.0 carries no compaction switch at all, and `--strict-config` rejects
 * every spelling of one but `model_auto_compact_token_limit`, which is a
 * threshold; opencode documents `compaction.auto` and
 * `OPENCODE_DISABLE_AUTOCOMPACT`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import type { AgentTask } from '../src/harness/adapter.ts'
import { ClaudeCodeAdapter, mapCliEvent } from '../src/harness/claude-code.ts'
import { CodexAdapter } from '../src/harness/codex.ts'
import { OpencodeAdapter, OpencodeEventMapper } from '../src/harness/opencode.ts'
import { MockAdapter } from '../src/harness/mock.ts'
import {
  CLAUDE_CODE_COMPACTION_ENV,
  CLAUDE_CODE_COMPACTION_SETTINGS,
  OPENCODE_COMPACTION_ENV,
} from '../src/harness/compaction.ts'
import { AGENT_PERMISSIONS } from '../src/harness/permissions.ts'
import { fakeCliFromSource } from './support/fake-cli.ts'

const VERSION = '1.2.3 (Claude Code)'

const temps: string[] = []

const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-compaction-'))
  temps.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

const task = (cwd: string): AgentTask => ({
  nodeId: 'phase-1',
  cwd,
  prompt: 'implement the widget model',
  model: 'haiku',
})

interface Settings {
  readonly permissions: { allow?: string[]; deny?: string[] }
  readonly autoCompactEnabled?: boolean
}

/**
 * A fake CLI that records both halves of its invocation — the argv it was given
 * and the environment it was given it in.
 *
 * The environment is the half that matters here and the half an argv-only fake
 * cannot see. A variable that disables compaction is not an argument; it
 * arrives invisibly, and the only place to catch it is in the child.
 */
function recordingCli(dir: string, name: string, out: string): string {
  return fakeCliFromSource(
    dir,
    name,
    `import { writeFileSync } from 'node:fs'
if (process.argv.includes('--version')) { console.log(${JSON.stringify(VERSION)}); process.exit(0) }
writeFileSync(${JSON.stringify(join(dir, out))}, JSON.stringify({
  argv: process.argv.slice(2),
  env: process.env,
}))
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-compaction' }))
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }))
`,
  )
}

function recorded(dir: string, out: string): { argv: string[]; env: Record<string, string> } {
  return JSON.parse(readFileSync(join(dir, out), 'utf8')) as {
    argv: string[]
    env: Record<string, string>
  }
}

/** Set a variable for one spawn and put the environment back afterwards. */
async function withEnv(vars: Record<string, string>, body: () => Promise<void>): Promise<void> {
  const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]))
  Object.assign(process.env, vars)
  try {
    await body()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('the capability every adapter declares', () => {
  /**
   * All three ship it, which is the finding rather than the design: no adapter
   * here had to build compaction, only to stop inheriting a machine's decision
   * to switch it off.
   */
  it('is true for all three shipped harnesses', () => {
    expect(new ClaudeCodeAdapter().capabilities.autoCompact).toBe(true)
    expect(new CodexAdapter().capabilities.autoCompact).toBe(true)
    expect(new OpencodeAdapter().capabilities.autoCompact).toBe(true)
  })

  /**
   * And false somewhere, or the `false` branch of every caller is dead code
   * that first runs in production. A scripted double compacts nothing, so this
   * is the honest value as well as the useful one.
   */
  it('is false for an adapter that does not compact, and spawns it unchanged', async () => {
    const adapter = new MockAdapter()
    expect(adapter.capabilities.autoCompact).toBe(false)

    // "Unchanged" is the load-bearing half: declaring the capability absent
    // must not also mean the adapter quietly grew a flag it cannot honour.
    const outcome = await adapter.spawn(task(makeTemp()))
    expect(outcome.ok).toBe(true)
  })
})

describe('claude-code', () => {
  /**
   * The settings file is the only thing this adapter layers over the user's own
   * `settings.json`, so it is the only place an `autoCompactEnabled: false`
   * sitting in a home directory can be overridden.
   *
   * Asserted for every permission mode because the file used not to exist in
   * two of the three — `full` got no policy at all, and `ask` with no read
   * roots had nothing to say. Compaction is not a permission and belongs in all
   * three, and a mode-shaped hole here is exactly the kind that goes unnoticed.
   */
  it('asserts compaction in the settings file under every permission mode', async () => {
    for (const permission of AGENT_PERMISSIONS) {
      const dir = makeTemp()
      const lane = join(dir, 'lanes', 'mine')
      mkdirSync(lane, { recursive: true })
      const bin = recordingCli(dir, `claude-${permission}`, `${permission}.json`)

      const outcome = await new ClaudeCodeAdapter({
        bin,
        permission,
        settingsDir: join(dir, 'settings'),
      }).spawn(task(lane))
      expect(outcome.ok, permission).toBe(true)
      if (!outcome.ok) return
      for await (const _event of outcome.session.events) void _event

      const { argv } = recorded(dir, `${permission}.json`)
      const path = argv[argv.indexOf('--settings') + 1] as string
      const settings = JSON.parse(readFileSync(path, 'utf8')) as Settings
      expect(settings.autoCompactEnabled, permission).toBe(true)
    }
  })

  /**
   * The variable the daemon must not pass on. Both of them: `DISABLE_COMPACT`
   * is the one a reader forgets, and it is the broader of the two — it disables
   * the manual `/compact` as well, which a headless turn has nobody to type
   * anyway.
   */
  it('does not hand a child the kill switches it inherited', async () => {
    const dir = makeTemp()
    const lane = join(dir, 'lanes', 'mine')
    mkdirSync(lane, { recursive: true })
    const bin = recordingCli(dir, 'claude-env', 'env.json')

    await withEnv({ DISABLE_AUTO_COMPACT: '1', DISABLE_COMPACT: '1' }, async () => {
      const outcome = await new ClaudeCodeAdapter({
        bin,
        settingsDir: join(dir, 'settings'),
      }).spawn(task(lane))
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      for await (const _event of outcome.session.events) void _event
    })

    const { env } = recorded(dir, 'env.json')
    for (const key of CLAUDE_CODE_COMPACTION_ENV) expect(env[key], key).toBeUndefined()
  })

  /**
   * A lane's own environment is project configuration and must not be able to
   * reinstate what the strip list removes — `childEnv` deletes after the
   * overlay for exactly this reason, and a regression there would silently
   * reopen the hole for every lane at once.
   */
  it('does not let a lane environment put a kill switch back', async () => {
    const dir = makeTemp()
    const lane = join(dir, 'lanes', 'mine')
    mkdirSync(lane, { recursive: true })
    const bin = recordingCli(dir, 'claude-lane-env', 'lane-env.json')

    const outcome = await new ClaudeCodeAdapter({
      bin,
      settingsDir: join(dir, 'settings'),
    }).spawn({ ...task(lane), env: { DISABLE_AUTO_COMPACT: '1' } })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    for await (const _event of outcome.session.events) void _event

    expect(recorded(dir, 'lane-env.json').env['DISABLE_AUTO_COMPACT']).toBeUndefined()
  })

  /**
   * No threshold is passed, and that is a decision rather than an omission: a
   * token count written into this repository would not track the context window
   * of whichever model the workflow named.
   */
  it('passes no compaction window on the command line', async () => {
    const dir = makeTemp()
    const lane = join(dir, 'lanes', 'mine')
    mkdirSync(lane, { recursive: true })
    const bin = recordingCli(dir, 'claude-window', 'window.json')

    const outcome = await new ClaudeCodeAdapter({
      bin,
      settingsDir: join(dir, 'settings'),
    }).spawn(task(lane))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    for await (const _event of outcome.session.events) void _event

    expect(recorded(dir, 'window.json').argv).not.toContain('--autocompact')
  })

  /**
   * `{"type":"system","subtype":"compact_boundary", …}` — the frame the CLI
   * emits when it replaces the history with a summary, and the only outward
   * sign it happened.
   */
  it('maps a compaction boundary to the normalized event, counts and all', () => {
    expect(
      mapCliEvent({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 183_000, post_tokens: 24_000 },
      }),
    ).toEqual([
      { type: 'context_compacted', trigger: 'auto', preTokens: 183_000, postTokens: 24_000 },
    ])
  })

  /** A person at a takeover terminal typing `/compact` is not a full window. */
  it('keeps the two triggers apart', () => {
    expect(
      mapCliEvent({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual' },
      }),
    ).toEqual([{ type: 'context_compacted', trigger: 'manual' }])
  })

  /**
   * A trigger this build does not know produces nothing, rather than being read
   * as `auto`. `trigger` is the vendor's field and the vendor may grow it, and
   * guessing would put a claim in the transcript that the harness never made.
   */
  it('says nothing about a boundary it cannot describe', () => {
    expect(
      mapCliEvent({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'microcompaction' },
      }),
    ).toEqual([])
    expect(mapCliEvent({ type: 'system', subtype: 'compact_boundary' })).toEqual([])
  })
})

describe('codex', () => {
  /**
   * Nothing is passed, because codex offers nothing to pass: no flag, no
   * environment variable, and a config key that sets a threshold rather than a
   * switch. The assertion is that the adapter did not invent one — a flag that
   * does not exist is either ignored in silence or fails the spawn, and both
   * are worse than the default that was already correct.
   *
   * Spelled out as a token sweep rather than a single `not.toContain`, so a
   * future edit that reaches for any of the plausible spellings trips here.
   */
  it('spawns unchanged, because there is nothing to turn on', async () => {
    const dir = makeTemp()
    const bin = fakeCliFromSource(
      dir,
      'codex-compaction',
      `import { writeFileSync } from 'node:fs'
if (process.argv.includes('--version')) { console.log('codex-cli 0.0.0'); process.exit(0) }
writeFileSync(${JSON.stringify(join(dir, 'codex.json'))}, JSON.stringify(process.argv.slice(2)))
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'th-1' }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`,
    )

    const outcome = await new CodexAdapter({ bin }).spawn(task(makeTemp()))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    for await (const _event of outcome.session.events) void _event

    const argv = (JSON.parse(readFileSync(join(dir, 'codex.json'), 'utf8')) as string[]).join(' ')
    for (const token of [
      'compact',
      'auto_compact_token_limit',
      'model_auto_compact_token_limit',
    ]) {
      expect(argv, token).not.toContain(token)
    }
  })
})

describe('opencode', () => {
  /**
   * Stripped from the *server's* environment, which is the level that decides
   * it: one server hosts every lane on a worktree, so a single inherited
   * variable would disable compaction for all of them at once.
   */
  it('names its kill switch so the server never inherits one', () => {
    expect([...OPENCODE_COMPACTION_ENV]).toEqual(['OPENCODE_DISABLE_AUTOCOMPACT'])
  })

  /**
   * The bus event carries `{ sessionID }` and nothing more, so the normalized
   * event carries no counts rather than zeroes — a session that lost nothing is
   * the opposite of what happened.
   */
  it('maps the bus event for its own session', () => {
    expect(new OpencodeEventMapper('s1').map({
      type: 'session.compacted',
      properties: { sessionID: 's1' },
    })).toEqual([{ type: 'context_compacted', trigger: 'auto' }])
  })

  /**
   * Every lane on a worktree shares one server and therefore one bus. An
   * unfiltered compaction would record some *other* lane's session as having
   * forgotten its brief — the same trap `session.error` and `session.idle` are
   * already filtered for.
   */
  it('ignores a compaction belonging to another lane on the same server', () => {
    expect(new OpencodeEventMapper('s1').map({
      type: 'session.compacted',
      properties: { sessionID: 's2' },
    })).toEqual([])
  })
})

describe('the assertion itself', () => {
  /**
   * A boolean, not a window. A user who narrowed their own window compacts
   * *earlier*, which cannot cause the failure this guards against — so
   * overriding that choice would cost them something and buy nothing.
   */
  it('turns compaction on without touching the threshold', () => {
    expect(CLAUDE_CODE_COMPACTION_SETTINGS).toEqual({ autoCompactEnabled: true })
  })
})
