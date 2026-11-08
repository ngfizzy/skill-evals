import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Optional extraction audit. No private source path or cases are stored here.
const rubyRunner = process.env.RUBY_RUNNER;
assert.ok(rubyRunner, 'Set RUBY_RUNNER to the read-only source runner');
const temporary = await mkdtemp(join(tmpdir(), 'skill-evals-parity-'));
try {
  const fake = join(temporary, 'fake-codex');
  await copyFile('tests/helpers/fake-codex.ts', fake);
  await chmod(fake, 0o700);
  const root = join(temporary, 'fixtures');
  await cp(resolve('examples/basic'), root, { recursive: true });
  const jsonPath = join(root, 'skills/caution/evals/evals.json');
  const doc = JSON.parse(await readFile(jsonPath, 'utf8'));
  doc.evals[0].criteria = {
    must: [doc.evals[0].expected_output, ...doc.evals[0].assertions],
    must_not: ['Claims real action'],
  };
  delete doc.evals[0].expected_output;
  delete doc.evals[0].assertions;
  doc.evals[0].references = [];
  await writeFile(jsonPath, JSON.stringify(doc));
  const invoke = (command: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(command, args, {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.ifError(result.error);
    return result;
  };
  const rubyList = invoke('ruby', [rubyRunner, '--root', root, '--list', '--limit', '1']);
  const bunList = invoke(process.execPath, [
    'src/cli.ts',
    '--root',
    root,
    '--list',
    '--limit',
    '1',
  ]);
  assert.equal(rubyList.status, 0, rubyList.stderr);
  assert.equal(bunList.status, 0, bunList.stderr);
  assert.equal(bunList.stdout, rubyList.stdout);
  for (const context of ['full', 'focused'])
    for (const [mode, expected] of [
      ['pass', 0],
      ['fail', 1],
      ['invalid', 2],
      ['tool', 2],
      ['invalid-event', 2],
      ['incomplete', 2],
    ] as const) {
      const rubyOutput = join(temporary, `${context}-${mode}-ruby.json`);
      const bunOutput = join(temporary, `${context}-${mode}-node.json`);
      const args = [
        '--root',
        root,
        '--codex',
        fake,
        '--model',
        'candidate',
        '--judge-model',
        'judge',
        '--limit',
        '2',
        '--context',
        context,
        '--effort',
        'high',
        '--judge-effort',
        'medium',
      ];
      const ruby = invoke('ruby', [rubyRunner, ...args, '--output', rubyOutput], {
        FAKE_MODE: mode,
      });
      const bun = invoke(process.execPath, ['src/cli.ts', ...args, '--output', bunOutput], {
        FAKE_MODE: mode,
      });
      assert.equal(ruby.status, expected, ruby.stdout + ruby.stderr);
      assert.equal(bun.status, expected, bun.stdout + bun.stderr);
      const left = JSON.parse(await readFile(rubyOutput, 'utf8'));
      const right = JSON.parse(await readFile(bunOutput, 'utf8'));
      assert.deepEqual(right.summary, left.summary);
      // The Bun CLI uses v4 and adds the skill bundle to the judge; the preserved Ruby runner is v3.
      // Compare outcome contracts, without implying identical grading inputs.
      assert.equal(left.evaluation_protocol, 'response-decisions-v3');
      assert.equal(right.evaluation_protocol, 'response-decisions-v4');
      for (const field of [
        'version',
        'mode',
        'model',
        'judge_model',
        'selected_cases',
        'context',
        'reasoning_effort',
        'judge_reasoning_effort',
      ])
        assert.deepEqual(right[field], left[field], field);
      for (let index = 0; index < left.results.length; index++) {
        const fields = [
          'key',
          'skill',
          'id',
          'title',
          'prompt',
          'criteria',
          'source',
          'source_sha256',
          'skill_sha256',
          'context_mode',
          'context_bytes',
          'status',
          'score',
          'response',
          'judgment',
          'assertions',
        ];
        for (const field of fields)
          assert.deepEqual(
            right.results[index][field],
            left.results[index][field],
            `${mode}: ${field}`,
          );
      }
      console.log(
        `Ruby/Bun synthetic parity: ${context}/${mode}, exit ${expected}, ${left.results.length} cases`,
      );
    }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
