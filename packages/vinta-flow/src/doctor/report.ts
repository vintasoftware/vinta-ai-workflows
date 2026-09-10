/**
 * Rendering for `vinta-flow doctor`.
 *
 * One line per check so the output is scannable at a glance, and a remedy line
 * only under what actually failed — a fix printed beside a passing check is
 * noise that trains the reader to skim past the ones that matter.
 */
import type { CheckResult, CheckStatus, DoctorReport } from './index.ts'

const MARK: Record<CheckStatus, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' }

const line = (check: CheckResult): string[] => {
  const head = `  ${MARK[check.status]}  ${check.label}`
  // Remedies are for what is broken; a passing check needs no instructions.
  return check.status === 'pass' || check.remedy === undefined
    ? [head]
    : [head, `        fix: ${check.remedy}`]
}

const count = (report: DoctorReport, status: CheckStatus): number =>
  report.checks.filter((check) => check.status === status).length

export function formatDoctorReport(report: DoctorReport): string {
  const body = report.checks.flatMap(line)
  const summary =
    `${count(report, 'fail')} failed, ` +
    `${count(report, 'warn')} warned, ` +
    `${count(report, 'pass')} passed`
  const verdict = report.ok
    ? 'A run can start.'
    : 'A run cannot start until every failure above is fixed.'
  return ['vinta-flow doctor', '', ...body, '', summary, verdict, ''].join('\n')
}
