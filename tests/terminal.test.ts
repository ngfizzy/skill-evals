import test from 'node:test';
import assert from 'node:assert/strict';

import { formatCaseResult } from '../src/display/output.ts';
import { withSummary } from '../src/report/index.ts';
import { TerminalRenderer } from '../src/display/terminal.ts';
import type { CaseResult, EvaluationCase } from '../src/evaluation/index.ts';
import type { Options } from '../src/runner/index.ts';
import type { TerminalCapabilities, TerminalIO } from '../src/display/index.ts';

import { reportFixture } from './helpers/fixture.ts';

const criterion = { id: 'assertion-1', text: 'Keeps uncertainty.', required: true };
const result: CaseResult = {
  key: 'caution/one',
  skill: 'caution',
  id: 'one',
  title: 'Preserves uncertainty',
  prompt: 'Simplify an uncertain explanation.',
  criteria: [criterion],
  source: 'fixture',
  source_sha256: 'fixture',
  skill_sha256: 'fixture',
  candidate_input:
    'Apply the skill.\nSKILL: Keep uncertainty.\nSCENARIO: Simplify this explanation.\nPAYLOAD-END',
  response: 'The cause might be a loose cable. We need to check it.',
  status: 'passed',
  score: 1,
  assertions: [
    {
      ...criterion,
      passed: true,
      reason: 'The response keeps the claim uncertain.',
      evidence_ids: ['line-1'],
      evidence: 'The cause might be a loose cable. We need to check it.',
    },
  ],
};
const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

function capture(overrides: Partial<TerminalCapabilities> = {}, options: Partial<Options> = {}) {
  const out: string[] = [],
    err: string[] = [],
    status: string[] = [];
  const io: TerminalIO = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    terminal: {
      stdoutTTY: true,
      stderrTTY: true,
      columns: 80,
      environment: { TERM: 'xterm-256color' },
      writeStatus: (text) => status.push(text),
      ...overrides,
    },
  };
  const renderer = new TerminalRenderer(io, { color: 'auto', progress: 'auto', ...options });
  const initial = withSummary(reportFixture(2));
  const report = withSummary({ ...initial, results: [result] });
  return { renderer, out, err, status, initial, report };
}

test('color styles only owned labels; full payload, response and evidence survive narrow wrapping', () => {
  assert.equal(
    strip(formatCaseResult(result, true).join('\n')),
    formatCaseResult(result).join('\n'),
  );
  for (const width of [20, 40, 80]) {
    const lines = formatCaseResult(result, true, width, true).map(strip);
    assert.ok(lines.every((line) => Bun.stringWidth(line) <= width));
    assert.ok(lines.join('').replaceAll(' ', '').includes('PAYLOAD-END'));
    assert.ok(lines.join('').replaceAll(' ', '').includes(result.response!.replaceAll(' ', '')));
  }
  const text = formatCaseResult(result, true).join('\n');
  assert.ok(text.includes('\n    ' + result.response + '\n'));
  assert.ok(text.includes('\n      > ' + result.assertions![0]!.evidence));
  const ownLabels = formatCaseResult(
    { ...result, response: 'Reason: raw text\nEvidence: raw text' },
    true,
  ).join('\n');
  assert.ok(ownLabels.includes('\n    Reason: raw text\n    Evidence: raw text\n'));
});

test('TTY progress tracks actual operator/grader phases, clears around permanent output and stops its timer', async () => {
  const c = capture();
  const earlier = { ...result, key: 'caution/earlier' };
  const initial = withSummary({ ...c.initial, selected_cases: 3, results: [earlier] });
  const saved = withSummary({ ...initial, results: [earlier, result] });
  c.renderer.start(initial, 'report.json');
  c.renderer.phase(result, 'candidate');
  assert.match(strip(c.status.at(-1)!), /1\/3 complete · case 2\/3/);
  c.renderer.phase(result, 'judge');
  assert.ok(c.status.some((text) => text.includes('operator running')));
  assert.ok(c.status.some((text) => text.includes('grader running')));
  assert.ok(c.status.every((text) => text.startsWith('\r\u001b[2K')));
  c.renderer.caseSaved(result, saved);
  c.renderer.phase({ ...result, key: 'caution/two' }, 'candidate');
  assert.match(strip(c.status.at(-1)!), /2\/3 complete · case 3\/3/);
  c.renderer.finish(saved);
  const writes = c.status.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(c.status.length, writes);
  assert.equal(c.err.length, 0);
  assert.ok(c.out.join('\n').includes(result.response!));
  assert.ok(c.out.join('\n').includes(result.assertions![0]!.reason));
  assert.ok(!c.out.join('\n').includes('PAYLOAD-END'));
});

test('redirected output is append-only plain text with phase lines, and forced color never enables cursor motion', () => {
  for (const color of ['auto', 'always'] as const) {
    const c = capture({ stdoutTTY: false, stderrTTY: false }, { color });
    c.renderer.start(c.initial, 'report.json');
    c.renderer.phase(result, 'candidate');
    c.renderer.phase(result, 'judge');
    c.renderer.caseSaved(result, c.report);
    c.renderer.finish(c.report);
    assert.equal(c.status.length, 0);
    assert.equal(c.err.length, 2);
    assert.doesNotMatch(c.err.join('\n'), /\u001b|\r/);
    if (color === 'auto') assert.doesNotMatch(c.out.join('\n'), /\u001b|\r/);
    else assert.match(c.out.join('\n'), /\u001b\[32m/);
  }
});

test('NO_COLOR and dumb terminals disable automatic styling, and progress none produces no updates', () => {
  for (const environment of [{ TERM: 'xterm', NO_COLOR: '1' }, { TERM: 'dumb' }]) {
    const c = capture({ environment }, { progress: 'none' });
    c.renderer.start(c.initial, 'report.json');
    c.renderer.phase(result, 'candidate');
    c.renderer.caseSaved(result, c.report);
    c.renderer.finish(c.report);
    assert.doesNotMatch(c.out.join('\n'), /\u001b/);
    assert.equal(c.status.length, 0);
    assert.equal(c.err.length, 0);
  }
});

test('error and interruption presentation preserves unscored errors and raw model text safely', () => {
  const failed: CaseResult = {
    ...result,
    status: 'error',
    score: null,
    error_stage: 'grading',
    error: 'Invalid JSON\u001b[2J',
    judgment: '{"assertions":\u202e',
  };
  delete failed.assertions;
  const text = formatCaseResult(failed, true, 40).join('\n');
  assert.match(strip(text), /score=unscored/);
  assert.match(strip(text), /Raw judgment \(unvalidated\)/);
  assert.ok(text.includes('\\u202e'));
  assert.doesNotMatch(text, /\u001b\[2J|\u202e|PASS assertion-/);
  const c = capture();
  const initial = withSummary(reportFixture());
  const report = withSummary({ ...initial, interrupted: true, results: [failed] });
  c.renderer.start(initial, 'report.json');
  c.renderer.caseSaved(failed, report);
  c.renderer.finish(report);
  assert.match(strip(c.out.join('\n')), /INTERRUPTED/);
  assert.match(
    strip(c.out.join('\n')),
    /0 passed, 0 failed, 1 errors, 0 pending; assertion score=unscored/,
  );
});

test('small TTY uses a bounded status line while long case identifiers stay complete in permanent output', () => {
  const c = capture({ columns: 20 });
  const entry: EvaluationCase = { ...result, key: 'caution/' + 'long'.repeat(50) };
  c.renderer.start(c.initial, 'report.json');
  c.renderer.phase(entry, 'candidate');
  for (const value of c.status)
    assert.ok(Bun.stringWidth(strip(value.replace(/^\r\u001b\[2K/, ''))) < 20);
  c.renderer.dispose();
});
