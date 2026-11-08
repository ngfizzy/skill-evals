import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, readFile, stat, symlink, writeFile, readdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import type { Criterion } from '../src/evaluation/index.ts';
import type { Report } from '../src/report/index.ts';
import { run } from '../src/runner/index.ts';
import { ReportWriter, withSummary } from '../src/report/index.ts';
import { CodexAgent } from '../src/adaptors/index.ts';
import { validateEvents } from '../src/adaptors/codex-helpers.ts';

import { temporary, skill, fakeAgent, jsonCase, reportFixture } from './helpers/fixture.ts';

const cli = resolve('src/cli.ts');
async function setup(t: TestContext) {
  const root = await temporary(t);
  await skill(root);
  const executable = join(root, 'fake-codex');
  await copyFile('tests/helpers/fake-codex.ts', executable);
  await chmod(executable, 0o700);
  return { root, executable };
}
function invoke(root: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [cli, '--root', root, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, ...env },
  });
  assert.ifError(result.error);
  return result;
}

test('offline help/list work without Codex; filters, explicit model and bounds fail closed', async (t) => {
  const { root } = await setup(t);
  assert.equal(invoke('/missing/root', ['--help']).status, 0);
  assert.equal(invoke(root, ['--list', '--codex', '/missing/agent']).status, 0);
  assert.equal(invoke(root, ['--list', '--limit', '2147483']).status, 0);
  for (const args of [
    [],
    ['--list', '--skill', 'missing'],
    ['--list', '--limit', '0'],
    ['--list', '--limit', '-1'],
    ['--list', '--timeout', '1.2'],
    ['--list', '--limit', '2147484'],
    ['--list', '--limit', '1e3'],
    ['--model', ' '],
    ['--unknown'],
    ['unexpected'],
    ['--list', '--context', 'unknown'],
    ['--list', '--effort', 'bogus'],
    ['--list', '--judge-effort', 'bogus'],
    ['--list', '--color', 'bogus'],
    ['--list', '--progress', 'bogus'],
    ['--list', '--width', '0'],
  ]) {
    assert.equal(invoke(root, args).status, 2, args.join(' '));
  }
});

test('Bun executable ignores local dotenv files and prints plain phase progress when redirected', async (t) => {
  const { root, executable } = await setup(t),
    output = join(root, 'report.json');
  await writeFile(join(root, '.env'), 'FAKE_VERSION=unaudited\nFAKE_MODE=fail\n');
  const env = { ...process.env };
  delete env.FAKE_VERSION;
  delete env.FAKE_MODE;
  const execution = spawnSync(
    cli,
    [
      '--root',
      root,
      '--codex',
      executable,
      '--model',
      'candidate',
      '--color',
      'never',
      '--progress',
      'plain',
      '--output',
      output,
    ],
    { cwd: root, env, encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(execution.status, 0, execution.stderr + execution.stdout);
  assert.doesNotMatch(execution.stdout + execution.stderr, /\u001b|\r/);
  assert.match(execution.stderr, /operator running/);
  assert.match(execution.stderr, /grader running/);
});

test('forced color is presentation-only and never allows authored bidi controls into the terminal', async (t) => {
  const { root, executable } = await setup(t),
    doc = jsonCase();
  doc.evals[0].prompt += '\u202e';
  await skill(root, 'routing', doc);
  const output = join(root, 'report.json');
  const execution = invoke(root, [
    '--codex',
    executable,
    '--model',
    'candidate',
    '--color',
    'always',
    '--progress',
    'none',
    '--output',
    output,
  ]);
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /\u001b\[32m/);
  assert.doesNotMatch(execution.stdout, /\u202e|\u001b\[2K|\r/);
  assert.match(execution.stdout, /\\u202e/);
  const report: Report = JSON.parse(await readFile(output, 'utf8'));
  assert.ok(report.results[0]!.prompt.endsWith('\u202e'));
});

test('SIGINT under Bun terminates the active call and saves an honest unscored interrupted report', async (t) => {
  const { root, executable } = await setup(t),
    output = join(root, 'report.json'),
    log = join(root, 'calls.jsonl');
  const child = spawn(
    process.execPath,
    [
      '--no-env-file',
      cli,
      '--root',
      root,
      '--codex',
      executable,
      '--model',
      'candidate',
      '--progress',
      'plain',
      '--output',
      output,
    ],
    {
      env: { ...process.env, FAKE_LOG: log, FAKE_DELAY_MS: '2000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  let text = '';
  child.stdout.on('data', (chunk) => {
    text += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    text += String(chunk);
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await readFile(log, 'utf8')).trim()) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for the call, not preflight. */
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(ready, text);
  child.kill('SIGINT');
  assert.equal(await exit, 2, text);
  const report: Report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.interrupted, true);
  assert.equal(report.finished_at, undefined);
  assert.equal(report.results[0]!.status, 'error');
  assert.equal(report.results[0]!.score, null);
  assert.equal(report.summary!.pending, 0);
  assert.equal(report.summary!.errors, 1);
  assert.match(text, /INTERRUPTED/);
});

for (const [mode, code, status] of [
  ['pass', 0, 'passed'],
  ['fail', 1, 'failed'],
  ['invalid', 2, 'error'],
  ['incomplete', 2, 'error'],
  ['tool', 2, 'error'],
  ['invalid-event', 2, 'error'],
  ['missing-response', 2, 'error'],
] as const) {
  test(`CLI ${mode}: exit ${code}, private report and correct score semantics`, async (t) => {
    const { root, executable } = await setup(t),
      output = join(root, 'report.json');
    const result = invoke(
      root,
      [
        '--model',
        'candidate',
        '--judge-model',
        'judge',
        '--codex',
        executable,
        '--output',
        output,
        '--full-input',
      ],
      { FAKE_MODE: mode },
    );
    assert.equal(result.status, code, result.stderr + result.stdout);
    const report: Report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.results[0]!.status, status);
    assert.equal(report.results[0]!.context_mode, 'full');
    assert.equal(report.summary!.pending, 0);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.ok(
      result.stdout.includes(
        `  Exact operator prompt:\n${report.results[0]!.candidate_input!.split('\n')
          .map((line) => `    ${line}`)
          .join('\n')}`,
      ),
    );
    if (status === 'error') {
      assert.equal(report.results[0]!.score, null);
      assert.equal(report.summary!.assertion_score, null);
      assert.match(result.stdout, /score=unscored/);
      assert.match(result.stdout, /ERROR — unscored \((candidate|judge|grading)\)/);
      assert.doesNotMatch(result.stdout, /  PASS assertion-/);
    } else {
      assert.match(result.stdout, /Case: small/);
      assert.match(result.stdout, /Operator response:\n    Routine\. Keep this bounded\./);
      assert.match(
        result.stdout,
        status === 'passed' ? /PASS assertion-1 — Must:/ : /FAIL assertion-1 — Must:/,
      );
      for (const assertion of report.results[0]!.assertions!) {
        assert.ok(result.stdout.includes(assertion.text), 'Criterion must be visible');
        assert.ok(result.stdout.includes(assertion.reason), 'Judge reason must be visible');
        assert.ok(
          result.stdout.includes(`> ${assertion.evidence}`),
          'Quoted evidence must be visible',
        );
      }
    }
    const before = await readFile(output, 'utf8');
    assert.equal(
      invoke(root, ['--model', 'candidate', '--codex', executable, '--output', output]).status,
      2,
    );
    assert.equal(await readFile(output, 'utf8'), before);
  });
}

test('negative criteria clearly describe a passing absence check without inventing evidence', async (t) => {
  const root = await temporary(t);
  await skill(
    root,
    'guard',
    `skill: guard
behaviors:
  - name: Propose review only
    given: Choose a review route without claiming completed work.
    must: [Chooses Routine.]
    must_not: [Claims completed work.]
`,
    'yaml',
  );
  const agent = fakeAgent();
  agent.call = async (prompt, request) => {
    if (!request.schema) return 'I would choose Routine.\nNo review has been performed.';
    const data: { criteria: Criterion[] } = JSON.parse(prompt.split('EVALUATION DATA:\n')[1]!);
    return JSON.stringify({
      assertions: data.criteria.map((criterion) => ({
        id: criterion.id,
        passed: true,
        reason: criterion.required
          ? 'Explicitly chooses Routine.'
          : 'No completed work is claimed.',
        evidence_ids: criterion.required ? ['line-1'] : [],
      })),
    });
  };
  const lines: string[] = [],
    output = join(root, 'report.json');
  assert.equal(
    await run(['--root', root, '--model', 'candidate', '--output', output], {
      out: (line) => lines.push(line),
      err: (line) => assert.fail(line),
      createAgent: () => agent,
    }),
    0,
  );
  const text = lines.join('\n');
  assert.match(text, /PASS assertion-2 — Must not:\n    Claims completed work\./);
  assert.match(text, /No completed work is claimed\./);
  assert.match(text, /Evidence:\n      \(none; judge found the prohibited behavior absent\)/);
  const report: Report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.results[0]!.assertions![1]!.evidence, '');
});

test('model text cannot inject terminal controls and original response stays intact in JSON', async (t) => {
  const root = await temporary(t);
  await skill(root);
  const response = 'Routine.\n\u001b[2J\u009b31m';
  const agent = fakeAgent();
  agent.call = async (prompt, request) => {
    if (!request.schema) return response;
    const data: { criteria: Criterion[] } = JSON.parse(prompt.split('EVALUATION DATA:\n')[1]!);
    return JSON.stringify({
      assertions: data.criteria.map((criterion) => ({
        id: criterion.id,
        passed: true,
        reason: 'Supported.\r\u001b[2J',
        evidence_ids: ['line-1', 'line-2'],
      })),
    });
  };
  const lines: string[] = [],
    output = join(root, 'report.json');
  assert.equal(
    await run(['--root', root, '--model', 'candidate', '--output', output], {
      out: (line) => lines.push(line),
      err: (line) => assert.fail(line),
      createAgent: () => agent,
    }),
    0,
  );
  const text = lines.join('\n');
  assert.doesNotMatch(text, /[\u001b\u009b\r]/);
  assert.ok(text.includes('\\u001b[2J\\u009b31m'));
  assert.ok(text.includes('\\u000d\\u001b[2J'));
  assert.ok(text.includes('      > \\u001b[2J\\u009b31m'));
  const report: Report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.results[0]!.response, response);
  assert.equal(report.results[0]!.assertions![0]!.evidence, response);
});

test('input payload is the actual candidate prompt, including conversation and instructions, with safe console rendering', async (t) => {
  const root = await temporary(t),
    doc = jsonCase();
  doc.evals[0]!.prompt =
    'Your previous response: "The page may be slow because the database has no spare connections."\n' +
    'The user replies: "Explain that more simply."\n\u001b[2J';
  const path = await skill(root, 'routing', doc);
  const instructions = '# routing\nKeep uncertainty.\r\u001b[2J\n';
  await writeFile(join(path, 'SKILL.md'), instructions);
  const agent = fakeAgent(),
    lines: string[] = [],
    output = join(root, 'report.json');
  assert.equal(
    await run(['--root', root, '--model', 'candidate', '--output', output, '--full-input'], {
      out: (line) => lines.push(line),
      err: (line) => assert.fail(line),
      createAgent: () => agent,
    }),
    0,
  );
  const result = JSON.parse(await readFile(output, 'utf8')).results[0]!;
  assert.equal(result.candidate_input, agent.calls[0]!.prompt);
  assert.ok(result.candidate_input.includes(instructions));
  assert.ok(result.candidate_input.endsWith(doc.evals[0]!.prompt));
  assert.doesNotMatch(result.candidate_input, /Selects Routine\./);
  const text = lines.join('\n');
  const start = text.indexOf('  Exact operator prompt:\n');
  const responseStart = text.indexOf('\n  Operator response:');
  assert.ok(start > responseStart && responseStart > 0);
  assert.ok(text.includes('Your previous response:'));
  assert.ok(text.includes('The user replies: "Explain that more simply."'));
  assert.ok(text.includes('Keep uncertainty.\\u000d\\u001b[2J'));
  assert.doesNotMatch(text, /[\u001b\r]/);
  assert.ok(text.indexOf('    PASS assertion-', responseStart) > responseStart);
});

test('Codex isolation flags, fresh sessions and temporary directory cleanup', async (t) => {
  const { root, executable } = await setup(t),
    log = join(root, 'calls.jsonl');
  const result = invoke(
    root,
    [
      '--codex',
      executable,
      '--model',
      'candidate',
      '--judge-model',
      'judge',
      '--effort',
      'high',
      '--judge-effort',
      'medium',
      '--output',
      join(root, 'report'),
    ],
    { FAKE_LOG: log },
  );
  assert.equal(result.status, 0, result.stderr);
  const calls = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { args: string[]; cwd: string; prompt: string });
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]!.cwd, calls[1]!.cwd);
  for (const call of calls) {
    for (const flag of [
      '--strict-config',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--skip-git-repo-check',
      '--json',
    ])
      assert.ok(call.args.includes(flag), flag);
    for (const pair of [
      ['--sandbox', 'read-only'],
      ['--enable', 'skip_host_skill_discovery'],
      ['-c', 'approval_policy="never"'],
      ['-c', 'project_doc_max_bytes=0'],
      ['-c', 'mcp_servers={}'],
      ['-c', 'web_search="disabled"'],
    ]) {
      assert.ok(
        call.args.some((arg, index) => arg === pair[0]! && call.args[index + 1] === pair[1]!),
        pair.join(' '),
      );
    }
    for (const feature of [
      'shell_tool',
      'apps',
      'plugins',
      'hooks',
      'memories',
      'multi_agent',
      'browser_use',
      'computer_use',
      'image_generation',
      'view_image',
      'sleep_tool',
      'workspace_dependencies',
      'skill_search',
      'artifact',
      'code_mode',
      'goals',
      'default_mode_request_user_input',
    ]) {
      assert.ok(
        call.args.some((arg, index) => arg === '--disable' && call.args[index + 1] === feature),
        feature,
      );
    }
    await assert.rejects(stat(call.cwd), /ENOENT/);
  }
  assert.ok(calls[0]!.args.includes('model_reasoning_effort="high"'));
  assert.ok(calls[1]!.args.includes('model_reasoning_effort="medium"'));
  assert.doesNotMatch(calls[0]!.prompt, /Selects Routine\./);
  assert.equal(calls[0]!.args[calls[0]!.args.indexOf('--model') + 1], 'candidate');
  assert.equal(calls[1]!.args[calls[1]!.args.indexOf('--model') + 1], 'judge');
});

test('preflight rejects unaudited versions or missing isolation capabilities before model calls', async (t) => {
  const { root, executable } = await setup(t),
    log = join(root, 'calls');
  for (const env of [
    { FAKE_VERSION: 'codex-cli 99.0.0' },
    { FAKE_MISSING: '--ignore-user-config' },
    { FAKE_MISSING: 'shell_tool' },
  ]) {
    const result = invoke(root, ['--model', 'model', '--codex', executable], {
      ...env,
      FAKE_LOG: log,
    });
    assert.equal(result.status, 2);
    await assert.rejects(stat(log), /ENOENT/);
  }
});

test('interruption preserves completed results and pending count in a valid atomic report', async (t) => {
  const root = await temporary(t);
  const doc = jsonCase();
  doc.evals.push({ ...doc.evals[0]!, id: 'second' }, { ...doc.evals[0]!, id: 'third' });
  await skill(root, 'routing', doc);
  const controller = new AbortController(),
    agent = fakeAgent();
  const call = agent.call;
  agent.call = async function (prompt, request) {
    const response = await call.call(this, prompt, request);
    if (this.calls.length === 2) controller.abort();
    return response;
  };
  const output = join(root, 'partial.json');
  const code = await run(
    ['--root', root, '--model', 'candidate', '--output', output],
    {
      out() {},
      err() {},
      createAgent: () => agent,
    },
    controller.signal,
  );
  assert.equal(code, 2);
  const report: Report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0]!.status, 'passed');
  assert.equal(report.summary!.pending, 2);
  assert.equal(report.interrupted, true);
  assert.equal(report.finished_at, undefined);
});

test('atomic report replacement and no-overwrite for symlinks/external file replacements', async (t) => {
  const root = await temporary(t),
    path = join(root, 'report');
  const report = Object.freeze(withSummary(reportFixture(2)));
  const writer = await ReportWriter.create(path, report);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).summary.pending, 2);
  const before = (await stat(path)).ino;
  await writer.write(report);
  assert.notEqual((await stat(path)).ino, before);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).summary.pending, 2);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readdir(root)).filter((name) => name.startsWith('.eval-report-')).length, 0);
  const link = join(root, 'link');
  await symlink(join(root, 'nonexistent'), link);
  await assert.rejects(ReportWriter.create(link, report), /EEXIST/);
  await symlink(path, join(root, 'existing-link'));
  await assert.rejects(ReportWriter.create(join(root, 'existing-link'), report), /EEXIST/);
  const replacement = await ReportWriter.create(join(root, 'replacement'), report);
  const { rename } = await import('node:fs/promises');
  await rename(replacement.path, path);
  await assert.rejects(writer.write(report), /replaced externally/);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), report);
});

test('strict event stream rejects tool activity, errors, malformed and incomplete streams', () => {
  for (const events of [
    '',
    '{}',
    'not JSON',
    '{"type":"turn.failed"}',
    '{"type":"error"}',
    '{"type":"item.completed","item":{"type":"mcp_tool_call"}}',
    '{"type":"unknown"}',
  ]) {
    assert.throws(() => validateEvents(events));
  }
});

test('initial snapshot failure leaves no destination and no temporary report', async (t) => {
  const root = await temporary(t),
    path = join(root, 'initial.json');
  const report = {
    ...withSummary(reportFixture()),
    toJSON() {
      throw new Error('serialization failed');
    },
  };
  await assert.rejects(ReportWriter.create(path, report), /serialization failed/);
  await assert.rejects(stat(path), /ENOENT/);
  assert.deepEqual(await readdir(root), []);
  const valid = withSummary(reportFixture());
  await ReportWriter.create(path, valid);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).summary.pending, 1);
});

test('per-case focused context, explicit reasoning efforts and legacy fallback reach agent and report', async (t) => {
  const root = await temporary(t),
    doc = jsonCase();
  doc.evals[0]!.references = [];
  doc.evals.push({ ...jsonCase('second').evals[0]! });
  const path = await skill(root, 'routing', doc);
  await writeFile(join(path, 'SKILL.md'), '# Routing\nKeep it concise. Exemple : résumé.\n');
  const agent = fakeAgent(),
    output = join(root, 'report.json');
  assert.equal(
    await run(
      [
        '--root',
        root,
        '--model',
        'candidate',
        '--context',
        'focused',
        '--effort',
        'high',
        '--judge-effort',
        'medium',
        '--output',
        output,
      ],
      {
        out() {},
        err() {},
        createAgent: () => agent,
      },
    ),
    0,
  );
  const report: Report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.context, 'focused');
  assert.equal(report.reasoning_effort, 'high');
  assert.equal(report.judge_reasoning_effort, 'medium');
  assert.deepEqual(
    report.results.map((r) => r.context_mode),
    ['focused', 'full-fallback'],
  );
  for (const result of report.results) {
    assert.ok(result.skill_instructions);
    assert.equal(result.context_bytes, Buffer.byteLength(result.skill_instructions));
  }
  assert.deepEqual(
    agent.calls.map((call) => call.effort),
    ['high', 'medium', 'high', 'medium'],
  );
});

test('grader receives the candidate bundle with dependencies and only the references selected for each case', async (t) => {
  const root = await temporary(t),
    doc = jsonCase();
  doc.evals[0]!.references = ['references/selected.md'];
  doc.evals.push({ ...jsonCase('second').evals[0]!, references: [] });
  const path = await skill(root, 'routing', doc);
  await skill(root, 'dependency', { ...jsonCase(), skill_name: 'dependency' });
  await writeFile(join(root, 'external-skills.yaml'), 'references:\n  routing: [dependency]\n');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(path, 'references'));
  await writeFile(join(path, 'references/selected.md'), 'SELECTED_REFERENCE');
  await writeFile(join(path, 'references/omitted.md'), 'OMITTED_REFERENCE');
  const agent = fakeAgent(),
    output = join(root, 'report.json');
  assert.equal(
    await run(
      [
        '--root',
        root,
        '--skill',
        'routing',
        '--model',
        'candidate',
        '--context',
        'focused',
        '--output',
        output,
      ],
      {
        out() {},
        err: (text) => assert.fail(text),
        createAgent: () => agent,
      },
    ),
    0,
  );
  const report: Report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.evaluation_protocol, 'response-decisions-v4');
  assert.equal(agent.calls.length, 4);
  for (let i = 0; i < 2; i++) {
    const candidate = agent.calls[i * 2]!.prompt;
    const grader = JSON.parse(agent.calls[i * 2 + 1]!.prompt.split('EVALUATION DATA:\n')[1]!);
    assert.ok(
      candidate.includes(`SKILL INSTRUCTIONS:\n${grader.skill_instructions}\n\nSCENARIO:\n`),
    );
    assert.match(grader.skill_instructions, /--- dependency\/SKILL.md ---/);
    assert.match(grader.skill_instructions, /--- routing\/SKILL.md ---/);
    assert.equal(grader.skill_instructions.includes('SELECTED_REFERENCE'), i === 0);
    assert.doesNotMatch(candidate, /OMITTED_REFERENCE/);
    assert.doesNotMatch(grader.skill_instructions, /OMITTED_REFERENCE/);
    assert.deepEqual(grader.criteria, report.results[i]!.criteria);
  }
});

test('command builder rejects missing or invalid effort instead of emitting undefined config', () => {
  const agent = new CodexAgent('codex', 1);
  assert.throws(() => agent.command('model', 'response'), /Invalid reasoning effort/);
  assert.throws(() => agent.command('model', 'response', 'unknown'), /Invalid reasoning effort/);
  assert.ok(agent.command('model', 'response', 'high').includes('model_reasoning_effort="high"'));
});
