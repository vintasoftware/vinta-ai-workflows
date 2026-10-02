/**
 * §16.3's review ledger: the fixer's block, and what later prompts are told.
 *
 * The block and its parser are one definition (`src/prompts/ledger.ts`), so
 * these tests hold the parser to the shape the fixer prompt asks for and to
 * the one direction it may fail in — a block it cannot read gates nothing.
 */
import { describe, expect, it } from 'vitest'
import {
  LEDGER_FENCE,
  parseLedger,
  readFixerReport,
  viewLedger,
} from '../src/prompts/index.ts'

const gated = {
  id: 'g1',
  trigger: 'unreachable',
  finding: 'Handle a folder whose parent was deleted mid-request.',
  evidence: 'api/folders.py:41 — parent_id is a non-null FK with ON DELETE CASCADE.',
  reviewer_recommendation: 'Add a 404 branch.',
  recommendation: 'Reject: the cascade makes the state unreachable.',
  default: 'reject the finding',
}

const block = (value: unknown): string =>
  ['Status: SUCCESS', '', '```' + LEDGER_FENCE, JSON.stringify(value), '```'].join('\n')

describe('readFixerReport', () => {
  it('reads the block the fixer prompt asks for', () => {
    const report = readFixerReport(
      block({
        rejected: [{ finding: 'Validate parent_id', counter_evidence: 'schemas.py:12 validates it' }],
        gated: [gated],
      }),
    )

    expect(report?.rejected).toEqual([
      { finding: 'Validate parent_id', counter_evidence: 'schemas.py:12 validates it' },
    ])
    expect(report?.gated).toEqual([gated])
  })

  it('takes an omitted list as empty', () => {
    expect(readFixerReport(block({ gated: [gated] }))?.rejected).toEqual([])
  })

  it('reads the last block, so a report quoting the template is not read as it', () => {
    const text = [block({ rejected: [], gated: [gated] }), block({ rejected: [], gated: [] })].join(
      '\n\n',
    )
    expect(readFixerReport(text)?.gated).toEqual([])
  })

  it('reads nothing from a report with no block, or one that does not parse', () => {
    expect(readFixerReport('Status: SUCCESS. Fixed everything.')).toBeUndefined()
    expect(readFixerReport('```' + LEDGER_FENCE + '\n{not json\n```')).toBeUndefined()
    // A trigger outside the closed four is not a gate item anybody can answer.
    expect(readFixerReport(block({ gated: [{ ...gated, trigger: 'vibes' }] }))).toBeUndefined()
  })
})

describe('viewLedger', () => {
  const report = (items: readonly unknown[], rejected: readonly unknown[] = []) => ({
    kind: 'report',
    at: '2026-10-01T10:00:00.000Z',
    rejected,
    gated: items,
  })
  const decision = (answer: string | null, unattended = false) => ({
    kind: 'decision',
    at: '2026-10-01T11:00:00.000Z',
    answer,
    unattended,
  })

  it('pairs a decision with the batch it answered and keeps every rejection', () => {
    const view = viewLedger(
      parseLedger([
        report([gated], [{ finding: 'A', counter_evidence: 'a.py:1' }]),
        decision('g1: reject'),
        report([], [{ finding: 'B', counter_evidence: 'b.py:2' }]),
      ]),
    )

    expect(view.settled).toEqual([
      { at: '2026-10-01T11:00:00.000Z', items: [gated], answer: 'g1: reject', unattended: false },
    ])
    expect(view.rejected.map((item) => item.finding)).toEqual(['A', 'B'])
  })

  it('pairs each decision with the latest batch, never an older one', () => {
    const second = { ...gated, id: 'g2' }
    const view = viewLedger(
      parseLedger([report([gated]), decision('first'), report([second]), decision(null, true)]),
    )
    expect(view.settled.map((entry) => entry.items.map((item) => item.id))).toEqual([['g1'], ['g2']])
    expect(view.settled[1]).toMatchObject({ answer: null, unattended: true })
  })

  it('drops a decision that answered no batch, and a line that does not parse', () => {
    const view = viewLedger(parseLedger([decision('orphan'), { kind: 'gossip' }, report([])]))
    expect(view).toEqual({ rejected: [], settled: [] })
  })
})
