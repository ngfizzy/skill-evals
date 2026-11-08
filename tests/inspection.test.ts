import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readReport } from '../src/report/inspection.ts';
import { run } from '../src/runner/index.ts';
import { candidatePrompt } from '../src/prompts/operator.ts';
import { resultSections } from '../src/display/sections.ts';
import type { Assertion, CaseResult } from '../src/evaluation/index.ts';
import type { Report } from '../src/report/index.ts';

import { temporary, skill, fakeAgent } from './helpers/fixture.ts';

test('plain runs and saved inspection retain passing responses/reasons without dumping the skill; full input is opt-in', async (t) => {
  const root = await temporary(t);
  await skill(root);
  const output = join(root, 'run.json'),
    lines: string[] = [];
  const agent = fakeAgent();
  let reportAtDisplay: Report | undefined;
  assert.equal(
    await run(['--root', root, '--model', 'fixture', '--output', output], {
      out: (line) => {
        if (line.startsWith('PASSED ')) reportAtDisplay = JSON.parse(readFileSync(output, 'utf8'));
        lines.push(line);
      },
      err: assert.fail,
      createAgent: () => agent,
    }),
    0,
  );
  assert.equal(reportAtDisplay?.results[0]?.status, 'passed', 'save the case before displaying it');
  const bytes = await readFile(output, 'utf8');
  const report = await readReport(output),
    result = report.results[0]!;
  assert.equal(result.candidate_input, candidatePrompt(result, result.skill_instructions!));
  assert.equal(result.candidate_input, agent.calls[0]!.prompt);
  assert.ok(lines.join('\n').includes(result.response!));
  assert.ok(lines.join('\n').includes(result.assertions![0]!.reason));
  assert.ok(!lines.join('\n').includes('SKILL INSTRUCTIONS:'));
  for (const full of [false, true]) {
    lines.length = 0;
    assert.equal(
      await run(['--view', output, '--ui', 'plain', ...(full ? ['--full-input'] : [])], {
        out: (line) => lines.push(line),
        err: assert.fail,
        createAgent: () => assert.fail('Inspection must not initialize an agent'),
      }),
      0,
    );
    assert.equal(lines.join('\n').includes('SKILL INSTRUCTIONS:'), full);
    assert.ok(lines.join('\n').includes(result.assertions![0]!.reason));
  }
  assert.equal(await readFile(output, 'utf8'), bytes, 'Inspection must never rewrite the report');
  const {
    skill_instructions: _skill,
    candidate_input: _input,
    context_mode: _mode,
    context_bytes: _bytes,
    ...legacyResult
  } = result;
  const legacyBytes = JSON.stringify({
    ...report,
    evaluation_protocol: 'response-decisions-v3',
    results: [legacyResult],
    summary: { passed: 999 },
    exporter: 'legacy fixture',
  });
  await writeFile(output, legacyBytes);
  const legacy = await readReport(output);
  assert.equal(legacy.evaluation_protocol, 'response-decisions-v3');
  assert.equal(legacy.summary.passed, 1);
  assert.equal(legacy.results[0]?.candidate_input, undefined);
  assert.deepEqual(legacy.results[0]?.assertions, result.assertions);
  assert.equal(await readFile(output, 'utf8'), legacyBytes);
  const section = resultSections(legacy.results[0]!, legacy.results[0]!).find(
    (item) => item.id === 'skill',
  )!;
  assert.match(section.text, /not stored separately/);
  assert.equal(section.collapsed, true);
});

test('inspection rejects malformed/tampered reports and explicit interactive mode fails before agent calls without TTY', async (t) => {
  const root = await temporary(t);
  await skill(root);
  const output = join(root, 'run.json');
  assert.equal(
    await run(['--root', root, '--model', 'fixture', '--output', output], {
      out: () => {},
      err: assert.fail,
      createAgent: () => fakeAgent(),
    }),
    0,
  );
  type EditableResult = Omit<CaseResult, 'assertions'> & { assertions?: Assertion[] };
  const valid: { results: EditableResult[] } = JSON.parse(await readFile(output, 'utf8'));
  for (const alter of [
    (value: typeof valid) => {
      value.results[0]!.skill_instructions = 'tampered';
    },
    (value: typeof valid) => {
      value.results[0]!.status = 'error';
    },
    (value: typeof valid) => {
      value.results[0]!.score = 0;
    },
    (value: typeof valid) => {
      value.results[0]!.assertions![0]!.reason = 42 as unknown as string;
    },
    (value: typeof valid) => {
      value.results[0]!.assertions![0]!.evidence = 'Fabricated quote';
    },
    (value: typeof valid) => {
      value.results[0]!.assertions![0]!.evidence_ids = ['line-999'];
    },
    (value: typeof valid) => {
      value.results[0]!.assertions![0]!.evidence_ids = ['line-1', 'line-1'];
    },
    (value: typeof valid) => {
      value.results[0]!.assertions![0]!.evidence_ids = [];
      value.results[0]!.assertions![0]!.evidence = '';
    },
    (value: typeof valid) => {
      value.results.push(value.results[0]!);
    },
  ]) {
    const broken = structuredClone(valid);
    alter(broken);
    await writeFile(output, JSON.stringify(broken));
    await assert.rejects(readReport(output));
  }
  for (const args of [
    ['--root', root, '--model', 'fixture', '--ui', 'interactive'],
    ['--view', output, '--list'],
  ]) {
    const errors: string[] = [];
    assert.equal(
      await run(args, {
        out: () => {},
        err: (text) => errors.push(text),
        createAgent: () => assert.fail('No agent calls allowed'),
      }),
      2,
    );
    assert.equal(errors.length, 1);
  }
  await assert.rejects(readReport(root), /regular JSON file/);
});
