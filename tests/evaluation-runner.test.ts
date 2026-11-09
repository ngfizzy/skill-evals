import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

import {
  EvaluationOrchestrator,
  EvaluationRunner,
  type PreparedCase,
} from '../src/evaluation/index.ts';
import { Judge } from '../src/judge/index.ts';
import { Operator } from '../src/operator/index.ts';
import { withSummary } from '../src/report/index.ts';
import type { ReportCheckpoint } from '../src/report/index.ts';
import type { Agent } from '../src/adaptors/index.ts';

import { loadLocalCatalog, fakeAgent, reportFixture, skill, temporary } from './helpers/fixture.ts';

const models = {
  operator: { model: 'operator-fixture', effort: 'medium' },
  grader: { model: 'grader-fixture', effort: 'high' },
};

function createOrchestrator(adapter: Agent): EvaluationOrchestrator {
  return new EvaluationOrchestrator({
    operator: new Operator(adapter, models.operator),
    judge: new Judge(adapter, models.grader),
  });
}

async function prepareFixture(t: TestContext): Promise<PreparedCase[]> {
  const root = await temporary(t);
  await skill(root);
  const entry = (await loadLocalCatalog([root])).cases[0]!;
  const bundle = 'Skill instructions';
  const first: PreparedCase = {
    entry,
    bundle,
    contextMetadata: { context_mode: 'full', context_bytes: Buffer.byteLength(bundle) },
  };
  const second = { ...first, entry: { ...entry, id: 'second', key: 'routing/second' } };
  return [first, second];
}

test('a failed checkpoint prevents result notification and further model calls', async (t) => {
  const cases = await prepareFixture(t);
  const report = withSummary(reportFixture(2));
  const agent = fakeAgent();
  const failure = new Error('Checkpoint failed');
  let writes = 0;
  const evaluator = new EvaluationRunner({
    orchestrator: createOrchestrator(agent),
    writer: {
      async write(checkpoint) {
        writes += 1;
        assert.equal(checkpoint.summary.passed, 1);
        assert.equal(checkpoint.summary.pending, 1);
        assert.equal(checkpoint.results[0]?.context_mode, cases[0]?.contextMetadata.context_mode);
        assert.equal(checkpoint.results[0]?.context_bytes, cases[0]?.contextMetadata.context_bytes);
        throw failure;
      },
    },
    display: {
      phase() {},
      caseSaved: () => assert.fail('Failed checkpoint must not notify the display'),
    },
  });
  await assert.rejects(
    evaluator.run({
      cases,
      initialCheckpoint: report,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(
    agent.calls.map(({ model, effort }) => ({ model, effort })),
    [models.operator, models.grader],
  );
  assert.equal(writes, 1);
});

test('the display receives each saved checkpoint and earlier snapshots stay stable', async (t) => {
  const cases = await prepareFixture(t);
  const initialCheckpoint = withSummary(reportFixture(cases.length));
  const written: ReportCheckpoint[] = [];
  const displayed: ReportCheckpoint[] = [];
  const evaluator = new EvaluationRunner({
    orchestrator: createOrchestrator(fakeAgent()),
    writer: {
      async write(checkpoint) {
        await Promise.resolve();
        written.push(checkpoint);
      },
    },
    display: {
      phase() {},
      caseSaved(result, checkpoint) {
        assert.equal(checkpoint, written.at(-1));
        assert.equal(result, checkpoint.results.at(-1));
        displayed.push(checkpoint);
      },
    },
  });
  const finalCheckpoint = await evaluator.run({
    cases,
    initialCheckpoint,
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    [initialCheckpoint, ...displayed].map((report) => report.results.length),
    [0, 1, 2],
  );
  assert.deepEqual(
    [initialCheckpoint, ...displayed].map((report) => report.summary.pending),
    [2, 1, 0],
  );
  assert.equal(displayed[1]?.finished_at, undefined);
  assert.ok(finalCheckpoint.finished_at);
  assert.equal(finalCheckpoint, written.at(-1));
});
