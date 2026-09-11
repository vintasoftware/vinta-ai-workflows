/**
 * Guard evaluation — a deliberately tiny expression language.
 *
 * A guard is author-supplied *data*: it arrives inside a workflow JSON that a
 * planning agent emitted and a human edited in a graphical editor. The daemon
 * runs with the developer's full permissions, so handing that string to `eval`
 * or `new Function` would turn "someone edited my plan" into "someone ran code
 * on my laptop". Nothing here can reach host scope, and the reason is
 * structural rather than defensive: the grammar has no call syntax, no member
 * access on values, and no way to name anything outside the guard context.
 *
 * Three rules make that airtight:
 *
 * - **Root allowlist, enforced at parse time.** The only identifiers that may
 *   begin a path are the six documented context roots (§5.2). `globalThis`,
 *   `process`, `require` and `constructor` are rejected before evaluation ever
 *   starts, so a malicious guard fails while it is still a string.
 * - **`Object.hasOwn` at every step.** Path lookup never consults a prototype,
 *   so `node.constructor` resolves to nothing rather than to `Function`.
 * - **No calls, ever.** `(` is only a grouping token. `f(x)` is a parse error,
 *   which is what makes the prototype-chain question moot in the first place.
 *
 * Unparseable guards raise `GuardError` with an offset. Silently defaulting to
 * `true` would run effects the author never authorized; silently defaulting to
 * `false` would strand a run in a state with no explanation. Both hide a
 * typo — so neither is on offer.
 */

/** The scalar leaves a guard can compare. Objects are namespaces, not values. */
export type ContextValue = string | number | boolean | null

/**
 * The documented guard context (§5.2). Every root is optional because guards
 * are evaluated speculatively — a run in `review` asks about `review.verdict`
 * before any reviewer has spoken.
 */
export interface GuardContext {
  readonly review?: Readonly<Record<string, ContextValue>>
  readonly gate?: Readonly<Record<string, ContextValue>>
  readonly human?: Readonly<Record<string, ContextValue>>
  readonly node?: Readonly<Record<string, ContextValue>>
  readonly run?: Readonly<Record<string, ContextValue>>
  /** Host-maintained fix counter. The interpreter reads it and never writes it. */
  readonly fix_rounds?: number
}

/** The only identifiers a path may start with. Anything else is a parse error. */
export const GUARD_CONTEXT_ROOTS = ['review', 'gate', 'human', 'node', 'run', 'fix_rounds'] as const

const ROOTS: ReadonlySet<string> = new Set(GUARD_CONTEXT_ROOTS)

/** A guard that could not be parsed or could not be meaningfully evaluated. */
export class GuardError extends Error {
  /** The guard source. Plan text the author wrote — never repository content. */
  readonly expression: string
  /** Character offset into `expression` where the problem is. */
  readonly offset: number

  constructor(message: string, expression: string, offset: number) {
    super(`${message} (at offset ${offset} in \`${expression}\`)`)
    this.name = 'GuardError'
    this.expression = expression
    this.offset = offset
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type TokenKind = 'ident' | 'string' | 'number' | 'op' | 'end'

interface Token {
  readonly kind: TokenKind
  readonly text: string
  readonly offset: number
}

const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '(', ')'] as const

const COMPARISONS = ['==', '!=', '<=', '>=', '<', '>'] as const
type CompareOp = (typeof COMPARISONS)[number]

function tokenize(expression: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < expression.length) {
    const ch = expression[i] as string

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1
      continue
    }

    if (ch === "'" || ch === '"') {
      // No escape sequences: guards compare short enum-like words, and every
      // escape rule is another thing a plan author can get subtly wrong.
      const end = expression.indexOf(ch, i + 1)
      if (end === -1) throw new GuardError('unterminated string literal', expression, i)
      tokens.push({ kind: 'string', text: expression.slice(i + 1, end), offset: i })
      i = end + 1
      continue
    }

    if (ch >= '0' && ch <= '9') {
      const match = /^\d+(\.\d+)?/.exec(expression.slice(i))
      const text = (match as RegExpExecArray)[0]
      tokens.push({ kind: 'number', text, offset: i })
      i += text.length
      continue
    }

    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(expression.slice(i))
      const text = (match as RegExpExecArray)[0]
      tokens.push({ kind: 'ident', text, offset: i })
      i += text.length
      continue
    }

    const op = OPERATORS.find((candidate) => expression.startsWith(candidate, i))
    if (op === undefined) {
      throw new GuardError(`unexpected character "${ch}"`, expression, i)
    }
    tokens.push({ kind: 'op', text: op, offset: i })
    i += op.length
  }

  tokens.push({ kind: 'end', text: '', offset: expression.length })
  return tokens
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type Operand =
  | { readonly kind: 'literal'; readonly value: ContextValue; readonly offset: number }
  | { readonly kind: 'path'; readonly segments: readonly string[]; readonly offset: number }

type Expr =
  | { readonly kind: 'or' | 'and'; readonly left: Expr; readonly right: Expr; readonly offset: number }
  | { readonly kind: 'not'; readonly operand: Expr; readonly offset: number }
  | {
      readonly kind: 'compare'
      readonly op: CompareOp
      readonly left: Operand
      readonly right: Operand
      readonly offset: number
    }
  | { readonly kind: 'operand'; readonly operand: Operand }

/** A parsed guard. Opaque: parse once at load, evaluate many times per run. */
export interface Guard {
  readonly expression: string
  readonly ast: Expr
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Grammar, in full:
 *
 *   or         := and ( '||' and )*
 *   and        := not ( '&&' not )*
 *   not        := '!' not | comparison
 *   comparison := '(' or ')' | operand ( ('=='|'!='|'<='|'>='|'<'|'>') operand )?
 *   operand    := path | string | number | 'true' | 'false' | 'null'
 *   path       := root ( '.' ident )*
 *
 * `!` binds looser than comparison — `!review.verdict == 'x'` negates the whole
 * comparison — because the alternative (negating a bare string) is never what a
 * plan author means. Parenthesize when in doubt.
 */
export function parseGuard(expression: string): Guard {
  const tokens = tokenize(expression)
  let pos = 0

  const peek = (): Token => tokens[pos] as Token
  const isOp = (text: string): boolean => {
    const token = peek()
    return token.kind === 'op' && token.text === text
  }

  function parseOr(): Expr {
    let left = parseAnd()
    while (isOp('||')) {
      const { offset } = peek()
      pos += 1
      left = { kind: 'or', left, right: parseAnd(), offset }
    }
    return left
  }

  function parseAnd(): Expr {
    let left = parseNot()
    while (isOp('&&')) {
      const { offset } = peek()
      pos += 1
      left = { kind: 'and', left, right: parseNot(), offset }
    }
    return left
  }

  function parseNot(): Expr {
    if (isOp('!')) {
      const { offset } = peek()
      pos += 1
      return { kind: 'not', operand: parseNot(), offset }
    }
    return parseComparison()
  }

  function parseComparison(): Expr {
    if (isOp('(')) {
      pos += 1
      const inner = parseOr()
      if (!isOp(')')) throw new GuardError('expected ")"', expression, peek().offset)
      pos += 1
      return inner
    }

    const left = parseOperand()
    const token = peek()
    if (token.kind === 'op') {
      const op = COMPARISONS.find((candidate) => candidate === token.text)
      if (op !== undefined) {
        pos += 1
        return { kind: 'compare', op, left, right: parseOperand(), offset: token.offset }
      }
    }
    return { kind: 'operand', operand: left }
  }

  function parseOperand(): Operand {
    const token = peek()
    pos += 1

    switch (token.kind) {
      case 'string':
        return { kind: 'literal', value: token.text, offset: token.offset }
      case 'number':
        return { kind: 'literal', value: Number(token.text), offset: token.offset }
      case 'ident': {
        if (token.text === 'true' || token.text === 'false') {
          return { kind: 'literal', value: token.text === 'true', offset: token.offset }
        }
        if (token.text === 'null') return { kind: 'literal', value: null, offset: token.offset }

        const segments = token.text.split('.')
        const root = segments[0] as string
        // The allowlist lives here, at parse time, so a guard reaching for the
        // host is rejected while it is still an inert string.
        if (!ROOTS.has(root)) {
          throw new GuardError(`unknown guard context root "${root}"`, expression, token.offset)
        }
        return { kind: 'path', segments, offset: token.offset }
      }
      default:
        throw new GuardError(
          token.kind === 'end' ? 'unexpected end of guard' : `unexpected token "${token.text}"`,
          expression,
          token.offset,
        )
    }
  }

  const ast = parseOr()
  const trailing = peek()
  if (trailing.kind !== 'end') {
    throw new GuardError(`unexpected token "${trailing.text}"`, expression, trailing.offset)
  }
  return { expression, ast }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Walks a path with own-property lookups only, so no prototype is reachable.
 * Returns `undefined` for anything missing or non-scalar.
 */
function resolvePath(segments: readonly string[], context: GuardContext): ContextValue | undefined {
  let current: unknown = context
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  const type = typeof current
  if (type === 'string' || type === 'number' || type === 'boolean' || current === null) {
    return current as ContextValue
  }
  return undefined
}

function resolveOperand(operand: Operand, context: GuardContext): ContextValue | undefined {
  return operand.kind === 'literal' ? operand.value : resolvePath(operand.segments, context)
}

function compare(
  op: CompareOp,
  left: ContextValue,
  right: ContextValue,
  guard: Guard,
  offset: number,
): boolean {
  if (op === '==') return typeof left === typeof right && left === right
  if (op === '!=') return typeof left !== typeof right || left !== right

  if (typeof left !== 'number' || typeof right !== 'number') {
    throw new GuardError(`"${op}" needs numbers on both sides`, guard.expression, offset)
  }
  switch (op) {
    case '<':
      return left < right
    case '<=':
      return left <= right
    case '>':
      return left > right
    default:
      return left >= right
  }
}

function requireBoolean(value: ContextValue | undefined, guard: Guard, offset: number): boolean {
  if (typeof value !== 'boolean') {
    throw new GuardError('expected a boolean here', guard.expression, offset)
  }
  return value
}

function evaluate(node: Expr, context: GuardContext, guard: Guard): ContextValue | undefined {
  switch (node.kind) {
    case 'or': {
      if (requireBoolean(evaluate(node.left, context, guard), guard, node.offset)) return true
      return requireBoolean(evaluate(node.right, context, guard), guard, node.offset)
    }
    case 'and': {
      if (!requireBoolean(evaluate(node.left, context, guard), guard, node.offset)) return false
      return requireBoolean(evaluate(node.right, context, guard), guard, node.offset)
    }
    case 'not':
      return !requireBoolean(evaluate(node.operand, context, guard), guard, node.offset)
    case 'compare': {
      const left = resolveOperand(node.left, context)
      const right = resolveOperand(node.right, context)
      // An unresolved fact makes *every* comparison false, `!=` included. A run
      // that has not heard from the gate yet must not satisfy
      // `gate.exit_code != 0` and take the failure branch on silence. The cost
      // is that `!=` is not the strict negation of `==` while a path is
      // missing, which is the trade we want: no fact, no transition.
      if (left === undefined || right === undefined) return false
      return compare(node.op, left, right, guard, node.offset)
    }
    default:
      return resolveOperand(node.operand, context)
  }
}

/** Evaluates a parsed guard. Throws `GuardError` rather than guessing. */
export function evaluateGuard(guard: Guard, context: GuardContext): boolean {
  const result = evaluate(guard.ast, context, guard)
  if (typeof result !== 'boolean') {
    throw new GuardError('guard must evaluate to a boolean', guard.expression, 0)
  }
  return result
}

/** Parse-and-evaluate, for callers that hold no compiled guard. */
export function evaluateGuardExpression(expression: string, context: GuardContext): boolean {
  return evaluateGuard(parseGuard(expression), context)
}
