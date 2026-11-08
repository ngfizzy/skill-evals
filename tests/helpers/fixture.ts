import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';

import type { Agent, AgentRequest } from '../../src/adaptors/index.ts';
import type { Criterion } from '../../src/evaluation/index.ts';
import type { Report } from '../../src/report/index.ts';

export async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skill-evals-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
export async function skill(
  root: string,
  name = 'routing',
  doc: unknown = jsonCase(),
  format = 'json',
): Promise<string> {
  const path = join(root, 'skills', name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), `# ${name}\nUse Routine. Keep this bounded.\n`);
  if (format === 'json') {
    await mkdir(join(path, 'evals'), { recursive: true });
    await writeFile(join(path, 'evals', 'evals.json'), JSON.stringify(doc));
  } else {
    if (typeof doc !== 'string') throw new Error('YAML fixture must be text');
    await writeFile(join(path, 'eval.yaml'), doc);
  }
  return path;
}
export function jsonCase(id = 'small'): FixtureDocument {
  return {
    skill_name: 'routing',
    evals: [
      {
        id,
        prompt: 'Choose a review route.',
        expected_output: 'Selects Routine.',
        assertions: ['Keeps scope bounded.'],
      },
    ],
  };
}
export const yamlCase = `skill: negative
requires: [routing]
behaviors:
  - name: Avoid unsupported claims
    given: An uncertain cause.
    must: [Hedges the answer]
    must_not: [Claims certainty]
`;
export function fakeAgent(mode = 'pass'): FakeAgent {
  return {
    version: 'fixture',
    calls: [],
    async preflight() {},
    async call(prompt, request) {
      this.calls.push({ prompt, ...request });
      if (request.signal?.aborted) throw new Error('Evaluation interrupted');
      if (!request.schema) return 'Routine. Keep this bounded.';
      if (mode === 'invalid') return 'not JSON';
      const data: { criteria: Criterion[] } = JSON.parse(prompt.split('EVALUATION DATA:\n')[1]!);
      return JSON.stringify({
        assertions: data.criteria.map((criterion) => ({
          id: criterion.id,
          passed: mode !== 'fail',
          reason: 'Observed',
          evidence_ids: ['line-1'],
        })),
      });
    },
  };
}

export function reportFixture(selected_cases = 1): Report {
  return {
    version: 1,
    mode: 'response-only',
    evaluation_protocol: 'response-decisions-v4',
    started_at: '2026-01-01T00:00:00Z',
    agent_version: 'fixture',
    model: 'candidate',
    judge_model: 'judge',
    context: 'full',
    reasoning_effort: 'low',
    judge_reasoning_effort: 'low',
    timeout_seconds: 1,
    selected_cases,
    results: [],
  };
}

export interface CapturedCall extends AgentRequest {
  prompt: string;
}
export interface FakeAgent extends Agent {
  calls: CapturedCall[];
}
export interface FixtureCase {
  id: string;
  prompt: string;
  expected_output: string;
  assertions: string[];
  references?: string[];
  criteria?: { must: string[]; must_not?: string[] };
}
export interface FixtureDocument {
  skill_name: string;
  evals: [FixtureCase, ...FixtureCase[]];
}
