/**
 * The platform seam, asserted on both branches from whichever machine is
 * running.
 *
 * This suite exists because of a constraint the package cannot escape: the
 * Windows behaviour was written on a Mac, and "it looks right" is not a test.
 * Everything in `src/platform/platform.ts` therefore takes the platform as a
 * parameter, and everything below decides the Windows answer by passing
 * `'win32'` rather than by running there. What that buys is real but bounded —
 * it proves the *decision*, never the syscall. Whether `taskkill /t` ends the
 * tree, and whether `cmd.exe` parses the command line we built the way
 * `CommandLineToArgvW` will, is what the `windows-latest` CI job is for.
 *
 * The static handler's traversal guard is here rather than in `daemon.test.ts`
 * for the same reason. It is the one piece of platform-conditional code where
 * being wrong is a security bug rather than a portability bug, so it is tested
 * under *both* sets of path rules — injected — instead of only the host's.
 */
import { win32, posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStaticHandler } from '../src/daemon/static.ts'
import { agentSpawn } from '../src/harness/shared.ts'
import { planDatabase, planTemplate } from '../src/lanes/database.ts'
import {
  UnquotableArgumentError,
  commandInvocation,
  copyFileCommand,
  isWindows,
  killTree,
  killTreePlan,
  ownProcessGroup,
  removeFileCommand,
  shellInvocation,
  shellQuote,
  spawnOptionsFor,
} from '../src/platform/platform.ts'

// ---------------------------------------------------------------------------
// Running a project command line
// ---------------------------------------------------------------------------

describe('the shell a project command line runs under', () => {
  it('is `sh -c` on POSIX and cmd.exe on Windows, with the command untouched', () => {
    // A gate's `cmd` is the project's own text. Whatever the shell, it arrives
    // verbatim — escaping it would break the operators its author wrote.
    const command = 'pnpm test && pnpm run lint'

    expect(shellInvocation(command, 'darwin')).toEqual({
      file: '/bin/sh',
      args: ['-c', command],
      windowsVerbatimArguments: false,
    })
    expect(shellInvocation(command, 'linux').file).toBe('/bin/sh')

    const windows = shellInvocation(command, 'win32')
    expect(windows.file).toBe('cmd.exe')
    // `/d` skips the registry's AutoRun, so a gate never inherits a developer's
    // shell profile; `/s` is what makes one outer pair of quotes safe.
    expect(windows.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(windows.args[3]).toBe(`"${command}"`)
    expect(windows.windowsVerbatimArguments).toBe(true)
  })

  it('asks Node to re-quote nothing only on the branch that quoted for itself', () => {
    expect(spawnOptionsFor(shellInvocation('x', 'darwin'))).toEqual({})
    expect(spawnOptionsFor(shellInvocation('x', 'win32'))).toEqual({
      windowsVerbatimArguments: true,
    })
  })
})

// ---------------------------------------------------------------------------
// Invoking an executable
// ---------------------------------------------------------------------------

describe('reaching a harness binary', () => {
  it('passes file and args straight through on POSIX', () => {
    expect(commandInvocation('claude', ['-p', '--model', 'sonnet'], 'darwin')).toEqual({
      file: 'claude',
      args: ['-p', '--model', 'sonnet'],
      windowsVerbatimArguments: false,
    })
  })

  it('goes through cmd.exe on Windows, because the CLI is a .cmd shim', () => {
    // `claude` is `claude.cmd` on Windows: CreateProcess cannot run it, Node
    // refuses to try, and a bare name only reaches it through PATHEXT.
    const invocation = commandInvocation('claude', ['-p', '--model', 'sonnet'], 'win32')
    expect(invocation.file).toBe('cmd.exe')
    expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(invocation.args[3]).toBe('""claude" "-p" "--model" "sonnet""')
    expect(invocation.windowsVerbatimArguments).toBe(true)
  })

  it('quotes every token, so a space or a shell metacharacter stays literal', () => {
    // `C:\Program Files (x86)\…` is the ordinary case, and its parentheses are
    // cmd metacharacters. Unconditional quoting is what makes them inert.
    const line = commandInvocation('C:\\Program Files (x86)\\codex\\codex.cmd', [], 'win32').args[3]
    expect(line).toBe('""C:\\Program Files (x86)\\codex\\codex.cmd""')

    const risky = commandInvocation('codex', ['--resume', 'a & del /q *'], 'win32').args[3]
    expect(risky).toBe('""codex" "--resume" "a & del /q *""')
  })

  it('is what every adapter spawns through, group and quoting together', () => {
    // The three adapters call `agentSpawn` rather than assembling this
    // themselves, so this is the assertion that their spawn path — not just
    // the seam under it — is the platform-correct one.
    expect(agentSpawn('claude', ['-p'], 'darwin')).toEqual({
      file: 'claude',
      args: ['-p'],
      options: { detached: true },
    })
    expect(agentSpawn('claude', ['-p'], 'win32')).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', '""claude" "-p""'],
      // No `detached` on Windows: DETACHED_PROCESS gives no tree and takes the
      // console away. `taskkill /t` is what reaches the tree there.
      options: { detached: false, windowsVerbatimArguments: true },
    })
  })

  it('doubles a trailing backslash, which would otherwise escape its own quote', () => {
    // A lane path ends in a separator often enough to matter, and
    // CommandLineToArgvW reads `dir\"` as an escaped quote, not a closed one.
    const line = commandInvocation('claude', ['--cwd', 'C:\\lanes\\run-1\\'], 'win32').args[3]
    expect(line).toBe('""claude" "--cwd" "C:\\lanes\\run-1\\\\""')
  })

  it('refuses the three characters quoting cannot make safe, naming no value', () => {
    // `"` ends the quoted region, `%` is still expanded inside one, and a
    // newline ends the command line. Refusing beats escaping cleverly.
    for (const bad of ['a"b', '%PATH%', 'a\nb', 'a\rb', 'a\u0000b']) {
      expect(() => commandInvocation('claude', ['--model', bad], 'win32')).toThrow(
        UnquotableArgumentError,
      )
    }
    // §11: the argument is a path or a session id, so the message names the
    // position and never the value.
    try {
      commandInvocation('claude', ['%SECRET%'], 'win32')
      expect.unreachable('should have refused')
    } catch (error) {
      expect(String(error)).not.toContain('SECRET')
      expect((error as UnquotableArgumentError).index).toBe(1)
    }
    // POSIX carries all of them without complaint — nothing is quoted there.
    expect(commandInvocation('claude', ['a"b'], 'darwin').args).toEqual(['a"b'])
  })
})

// ---------------------------------------------------------------------------
// Command lines recorded as data: the lane's database plan
// ---------------------------------------------------------------------------

describe('the command lines a lane summary records', () => {
  it('quotes a value for the shell that will actually re-run it', () => {
    expect(shellQuote("it's", 'darwin')).toBe(`'it'\\''s'`)
    // Double quotes on Windows, inside which `&`, `|`, `<`, `>` and `^` are
    // all literal — the same reason `commandInvocation` quotes unconditionally.
    expect(shellQuote('app_wt_lane_1', 'win32')).toBe('"app_wt_lane_1"')
    expect(shellQuote('C:\\lanes\\run-1\\db.sqlite3', 'win32')).toBe('"C:\\lanes\\run-1\\db.sqlite3"')
    expect(() => shellQuote('%APPDATA%', 'win32')).toThrow(UnquotableArgumentError)
  })

  it('deletes and copies a database file with the verbs the platform has', () => {
    expect(removeFileCommand('/tmp/t/dev-db.sqlite3', 'linux')).toBe(
      "rm -f '/tmp/t/dev-db.sqlite3'",
    )
    // `rm -f` tolerates a missing file and `del` does not, so Windows asks
    // first: this is the setup step before every template build, and it has to
    // be idempotent.
    expect(removeFileCommand('C:\\t\\dev-db.sqlite3', 'win32')).toBe(
      'if exist "C:\\t\\dev-db.sqlite3" del /f /q "C:\\t\\dev-db.sqlite3"',
    )

    expect(copyFileCommand('/t/a', '/l/b', 'linux')).toBe("cp '/t/a' '/l/b'")
    expect(copyFileCommand('C:\\t\\a', 'C:\\l\\b', 'win32')).toBe('copy /y "C:\\t\\a" "C:\\l\\b"')
  })

  it('plans a sqlite lane with commands the machine can run', () => {
    const spec = {
      engine: 'sqlite',
      delivery: 'file',
      path: 'db.sqlite3',
      connectionUrlVar: 'DATABASE_URL',
    } as const
    const ctx = { laneName: 'r1-lane-1', lanePath: '/pool/r1-lane-1', templatesDir: '/pool/.t' }

    expect(planTemplate('dev', spec, '/pool/.t', 'linux')?.setupCmd).toBe(
      "rm -f '/pool/.t/dev-db.sqlite3'",
    )
    expect(planTemplate('dev', spec, 'C:\\pool\\.t', 'win32')?.setupCmd).toContain('del /f /q')

    // The clone and the reset are the same copy — a lane returns to the
    // template by being overwritten with it — on both platforms.
    const posixPlan = planDatabase('dev', spec, ctx, 'linux')
    expect(posixPlan.cloneCmd).toBe(posixPlan.resetCmd)
    expect(posixPlan.cloneCmd).toBe("cp '/pool/.t/dev-db.sqlite3' '/pool/r1-lane-1/db.sqlite3'")

    const windowsPlan = planDatabase('dev', spec, ctx, 'win32')
    expect(windowsPlan.cloneCmd).toBe(windowsPlan.resetCmd)
    expect(windowsPlan.cloneCmd?.startsWith('copy /y ')).toBe(true)
    // A single-use lane is single-use on both: `resetCmd` null is the pool's
    // signal to re-provision, and nothing about the platform changes it.
    expect(windowsPlan.resetCmd).not.toBeNull()
  })

  it('plans a postgres lane with the same verbs and different quotes', () => {
    const spec = {
      engine: 'postgres',
      delivery: 'external',
      name: 'app',
      serverUrl: 'postgres://localhost',
      connectionUrlVar: 'DATABASE_URL',
    } as const
    const ctx = { laneName: 'r1-lane-1', lanePath: '/pool/r1-lane-1', templatesDir: '/pool/.t' }

    // `createdb`/`dropdb` are real programs on both platforms and `&&` means
    // the same thing in both shells, so only the quoting moves.
    expect(planDatabase('dev', spec, ctx, 'linux').cloneCmd).toBe(
      "createdb -T 'app_wt_template' 'app_wt_r1_lane_1'",
    )
    expect(planDatabase('dev', spec, ctx, 'win32').cloneCmd).toBe(
      'createdb -T "app_wt_template" "app_wt_r1_lane_1"',
    )
    expect(planDatabase('dev', spec, ctx, 'win32').resetCmd).toBe(
      'dropdb --if-exists "app_wt_r1_lane_1" && createdb -T "app_wt_template" "app_wt_r1_lane_1"',
    )
  })
})

// ---------------------------------------------------------------------------
// Process groups and killing trees
// ---------------------------------------------------------------------------

describe('ending a process tree', () => {
  it('asks for a process group only where the platform has them', () => {
    expect(ownProcessGroup('darwin')).toBe(true)
    expect(ownProcessGroup('linux')).toBe(true)
    // `detached` on Windows means DETACHED_PROCESS — a child with no console
    // at all. It buys no tree and costs whatever the CLI does with one.
    expect(ownProcessGroup('win32')).toBe(false)
  })

  it('signals the group on POSIX', () => {
    expect(killTreePlan(4321, 'SIGKILL', 'linux')).toEqual({
      kind: 'group',
      pid: 4321,
      signal: 'SIGKILL',
    })
  })

  it('walks the process table with taskkill on Windows, forcing only the deadline', () => {
    const args = (signal: NodeJS.Signals): readonly string[] => {
      const plan = killTreePlan(4321, signal, 'win32')
      // Windows has no group signal, so the plan is never the POSIX shape.
      expect(plan.kind).toBe('command')
      return plan.kind === 'command' ? plan.args : []
    }

    // The two-stage teardown every caller has — be polite, then insist — has to
    // survive the translation. `/f` is the second stage and only the second.
    expect(killTreePlan(4321, 'SIGHUP', 'win32')).toEqual({
      kind: 'command',
      file: 'taskkill',
      args: ['/pid', '4321', '/t'],
    })
    expect(args('SIGINT')).toEqual(['/pid', '4321', '/t'])
    expect(args('SIGKILL')).toEqual(['/pid', '4321', '/t', '/f'])
    // `/t` is the whole point: a leaf kill leaves the grandchild holding the
    // stdout pipe, and `close` never fires.
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
      expect(args(signal)).toContain('/t')
    }
  })

  it('never throws on a pid that is already gone', () => {
    // A dead session is not an error, on either branch — and the boolean is
    // what tells `signalGroup` to fall back to the direct child.
    expect(killTree(0x7ffffff0, 'SIGKILL', 'linux')).toBe(false)
  })

  it('agrees with the host it is actually running on', () => {
    expect(isWindows()).toBe(process.platform === 'win32')
    expect(ownProcessGroup()).toBe(process.platform !== 'win32')
  })
})

// ---------------------------------------------------------------------------
// The traversal guard, under both sets of path rules
// ---------------------------------------------------------------------------

/**
 * A root that does not exist, on purpose. What is being asserted is the
 * *verdict*, and the three outcomes are distinguishable without a filesystem:
 * 403 refused the path, 400 rejected its shape, and 503 means it was allowed
 * through to a bundle that was never built.
 */
const ALLOWED = 503

const handlers = [
  { flavour: 'posix', handler: createStaticHandler('/srv/dist/ui', { path: posix }) },
  { flavour: 'win32', handler: createStaticHandler('C:\\srv\\dist\\ui', { path: win32 }) },
] as const

const statuses = (pathname: string): Record<string, number> =>
  Object.fromEntries(handlers.map(({ flavour, handler }) => [flavour, handler(pathname, 'GET').status]))

describe('the static handler refuses the same paths on every platform', () => {
  it('lets an ordinary asset path through under both', () => {
    expect(statuses('/assets/index-a1b2c3.js')).toEqual({ posix: ALLOWED, win32: ALLOWED })
    expect(statuses('/')).toEqual({ posix: ALLOWED, win32: ALLOWED })
  })

  it('refuses a `../` escape as a traversal, not as a malformed path', () => {
    // The distinction is worth keeping: 403 is the refusal worth seeing, and
    // collapsing it into 400 would hide it.
    for (const pathname of [
      '/%2e%2e%2foutside.txt',
      '/assets/%2e%2e%2f%2e%2e%2foutside.txt',
      '/..%2f..%2fpackage.json',
    ]) {
      expect([pathname, statuses(pathname)]).toEqual([pathname, { posix: 403, win32: 403 }])
    }
  })

  it('refuses a backslash under POSIX too, so the verdict is not the host', () => {
    // This is the case the guard was quietly platform-dependent on. `\` is a
    // separator on Windows and a filename character on POSIX, so the same
    // request used to be a traversal on one host and a 404 on the other.
    // Refusing the character makes one request mean one thing everywhere.
    for (const pathname of [
      '/%5c..%5c..%5cWindows%5cwin.ini',
      '/assets%5c..%5c..%5csecret',
      '/a%5cb.js',
    ]) {
      expect([pathname, statuses(pathname)]).toEqual([pathname, { posix: 400, win32: 400 }])
    }
  })

  it('refuses the second spellings Windows would resolve to one file', () => {
    // An NTFS alternate data stream and a drive letter both name a file the
    // extension check above them cannot see; a trailing dot or space is
    // trimmed by the filesystem. Each is one file under two names, and the
    // content type is read from the name.
    for (const pathname of [
      '/index.html::$DATA',
      '/C:/Windows/win.ini',
      '/index.html.',
      '/index.html%20',
      '/assets%20/app.js',
    ]) {
      expect([pathname, statuses(pathname)]).toEqual([pathname, { posix: 400, win32: 400 }])
    }
  })

  it('still refuses a NUL, which truncates the path for the syscall only', () => {
    expect(statuses('/index.html%00.png')).toEqual({ posix: 400, win32: 400 })
  })

  it('refuses a method it does not serve before it looks at the path at all', () => {
    for (const { handler } of handlers) expect(handler('/', 'DELETE').status).toBe(405)
  })
})
