import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  answerDecisions,
  appendDecision,
  decision,
  DECISION_TEXT_LIMIT,
  parseDecision,
  readRejections,
  REJECTED_LIMIT,
  selectDecisions,
  SETTLED_LIMIT,
  type Decision,
} from '../src/decisions/index.ts'
import { openJournal } from '../src/journal/journal.ts'
import type { AgentAsk } from '../src/questions/shape.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const ASK: AgentAsk = {
  source: 'report',
  questions: [
    {
      header: 'Storage',
      question: 'Keep invoices in the existing table?',
      multiSelect: false,
      options: [{ label: 'Existing table (Recommended)', description: 'No migration.' }, { label: 'New table' }],
    },
    { header: 'Name', question: 'What is the table called?', multiSelect: false, options: [] },
  ],
}

describe('answerDecisions', () => {
  it('keeps each answered question with the option it got, and its consequence', () => {
    expect(answerDecisions(ASK, [{ selected: [0] }, { selected: [], text: 'invoices_v2' }], 'operator')).toEqual([
      {
        kind: 'answer',
        by: 'operator',
        text: 'Storage — Keep invoices in the existing table?\nAnswer: Existing table (Recommended) (No migration.)',
      },
      { kind: 'answer', by: 'operator', text: 'Name — What is the table called?\nAnswer: invoices_v2' },
    ])
  })

  it('settles nothing for a question left unanswered', () => {
    expect(answerDecisions(ASK, [{ selected: [1] }], 'unattended')).toEqual([
      { kind: 'answer', by: 'unattended', text: 'Storage — Keep invoices in the existing table?\nAnswer: New table' },
    ])
  })
})

describe('readRejections', () => {
  it('reads one finding per REJECTED line, bulleted or quoted', () => {
    const report = [
      'Passes: 3.',
      'REJECTED: Add a null check — every caller validates (src/api.ts:12)',
      '- REJECTED: Rename the table — operator decided to keep it',
      '  * `REJECTED: Cache the lookup — measured at 2ms`',
      'Not REJECTED: this one, mid-line',
      'VERDICT: pass',
    ].join('\n')

    expect(readRejections(report)).toEqual([
      'Add a null check — every caller validates (src/api.ts:12)',
      'Rename the table — operator decided to keep it',
      'Cache the lookup — measured at 2ms',
    ])
  })

  it('reads none from a report that rejected nothing', () => {
    expect(readRejections('All findings fixed.\nVERDICT: pass')).toEqual([])
    expect(readRejections('REJECTED:   \nVERDICT: pass')).toEqual([])
  })
})

describe('the list', () => {
  it('keeps one decision per kind and wording, whatever the spacing or case', () => {
    const list: Decision[] = []
    expect(appendDecision(list, decision('context', 'operator', 'Use the index'))).toBe(true)
    expect(appendDecision(list, decision('context', 'coordinator', '  use the   index '))).toBe(false)
    expect(appendDecision(list, decision('rejected', 'review', 'use the index'))).toBe(true)
    expect(list).toHaveLength(2)
  })

  it('cuts a long decision rather than dropping it', () => {
    const long = decision('context', 'operator', 'x'.repeat(DECISION_TEXT_LIMIT + 50))
    expect(long.text).toHaveLength(DECISION_TEXT_LIMIT + 1)
    expect(long.text.endsWith('…')).toBe(true)
  })

  it('selects the newest of each group, in the order they were made', () => {
    const list: Decision[] = []
    for (let i = 0; i < SETTLED_LIMIT + 2; i += 1) list.push(decision('answer', 'operator', `answer ${i}`))
    for (let i = 0; i < REJECTED_LIMIT + 3; i += 1) list.push(decision('rejected', 'review', `finding ${i}`))
    // A late answer is still shown however many findings came before it.
    list.push(decision('context', 'operator', 'late note'))

    const { shown, omitted } = selectDecisions(list)

    expect(omitted).toBe(3 + 3)
    expect(shown.map((entry) => entry.text)).toEqual([
      ...Array.from({ length: SETTLED_LIMIT - 1 }, (_, i) => `answer ${i + 3}`),
      ...Array.from({ length: REJECTED_LIMIT }, (_, i) => `finding ${i + 3}`),
      'late note',
    ])
  })
})

describe('the journal’s decisions file', () => {
  it('round-trips, skipping lines this build cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-decisions-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const journal = openJournal(dir)
    cleanups.push(() => journal.close())

    expect(journal.decisions('run-1', 'a')).toEqual([])
    journal.appendDecision('run-1', 'a', decision('context', 'operator', 'keep v1'))
    const file = join(dir, '.vinta-ai-maestro', 'runs', 'run-1', 'nodes', 'a', 'decisions.jsonl')
    appendFileSync(file, '{"kind":"verdict","by":"operator","text":"x"}\n{"kind":"context"\n')
    journal.appendDecision('run-1', 'a', decision('rejected', 'review', 'no null check'))

    expect(journal.decisions('run-1', 'a')).toEqual([
      { kind: 'context', by: 'operator', text: 'keep v1' },
      { kind: 'rejected', by: 'review', text: 'no null check' },
    ])
    expect(journal.decisions('run-1', 'b')).toEqual([])
    expect(parseDecision({ kind: 'answer', by: 'nobody', text: 'x' })).toBeNull()
  })
})
