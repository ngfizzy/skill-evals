import assert from 'node:assert/strict';
import { chmod, copyFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import type { Report } from '../src/report/index.ts';
import { sha256 } from '../src/utils/index.ts';

import { jsonCase, skill } from './helpers/fixture.ts';
import { gitServer } from './helpers/git-server.ts';

const cli = resolve(process.env.SKILL_EVALS_TEST_ENTRY ?? 'src/cli.ts');
const fakeCodex = resolve('tests/helpers/fake-codex.ts');

test('CLI loads named cases across mixed roots, records provenance and replays offline', async (t) => {
  const server = await gitServer(t);
  const repo = await server.repository();
  const dependency = await server.repository('deps');
  const output = join(server.root, 'report.json');
  const log = join(server.root, 'agent-calls.jsonl');
  const agent = join(server.root, 'fake-codex');
  await copyFile(fakeCodex, agent);
  await chmod(agent, 0o700);
  const doc = jsonCase();
  await skill(repo.work, 'routing', doc);
  await skill(repo.work, 'unrelated', { evals: [null] });
  await writeFile(
    join(repo.work, 'external-skills.yaml'),
    'references:\n  routing: [remote-helper, local-helper]\n',
  );
  const targetCommit = repo.publish();

  const remote = await skill(dependency.work, 'remote-helper');
  await unlink(join(remote, 'evals/evals.json'));
  const dependencyCommit = dependency.publish();
  const local = await skill(server.root, 'local-helper');
  await unlink(join(local, 'evals/evals.json'));

  const root = `git+${server.url()}#${targetCommit}`;
  const select = ['--root', root, '--load-skill', 'routing', '--case', 'routing/small'];
  const listed = await collect(invoke(server, [...select, '--list', '--codex', '/missing/agent']));
  assert.equal(listed.code, 0, listed.err);
  assert.equal(listed.out, 'routing/small\tsmall\n1 case(s); no agent calls.\n');
  await server.assertClean();

  const fullList = await collect(invoke(server, ['--root', root, '--list']));
  assert.equal(fullList.code, 2);
  assert.match(fullList.err, /mapping/);

  const evaluated = await collect(
    invoke(
      server,
      [
        '--root',
        `git+${server.url('deps')}`,
        '--root',
        server.root,
        ...select,
        '--codex',
        agent,
        '--model',
        'synthetic',
        '--ui',
        'plain',
        '--progress',
        'none',
        '--output',
        output,
      ],
      { FAKE_LOG: log },
    ),
  );
  assert.equal(evaluated.code, 0, evaluated.err);
  assert.match(evaluated.out, /PASSED routing\/small/);
  await server.assertClean();

  const report: Report = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(report.git_sources, [
    { url: server.url('deps'), commit: dependencyCommit },
    { url: server.url(), commit: targetCommit },
  ]);
  assert.equal(report.results.length, 1);
  const result = report.results[0]!;
  assert.equal(result.source, `${root}:skills/routing/evals/evals.json`);
  assert.equal(result.source_sha256, sha256(JSON.stringify(doc)));
  const bundle = result.skill_instructions!;
  assert.equal(result.skill_sha256, sha256(bundle));
  assert.deepEqual(
    [...bundle.matchAll(/--- ([\w-]+)\/SKILL.md ---/g)].map((match) => match[1]),
    ['remote-helper', 'local-helper', 'routing'],
  );
  const calls = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.ok(calls[0].prompt.includes(bundle));
  assert.equal(
    JSON.parse(calls[1].prompt.split('EVALUATION DATA:\n')[1]).skill_instructions,
    bundle,
  );

  const requestCount = server.requests.length;
  const replay = await collect(
    invoke(server, ['--view', output, '--ui', 'plain'], { PATH: '/missing/git' }),
  );
  assert.equal(replay.code, 0, replay.err);
  assert.match(replay.out, /PASSED routing\/small/);
  assert.equal(server.requests.length, requestCount);

  const invalid = join(server.root, 'invalid-report.json');
  await writeFile(
    invalid,
    JSON.stringify({ ...report, git_sources: [{ url: server.url(), commit: 'main' }] }),
  );
  const invalidReplay = await collect(invoke(server, ['--view', invalid]));
  assert.equal(invalidReplay.code, 2);
  assert.match(invalidReplay.err, /Invalid saved report structure/);
  for (const args of [
    ['--root', root],
    ['--load-skill', 'routing'],
  ]) {
    const combined = await collect(invoke(server, ['--view', output, ...args]));
    assert.equal(combined.code, 2);
    assert.match(combined.err, /accepts display options only/);
  }
  assert.equal(server.requests.length, requestCount);
});

test('source setup failures and cancellation happen before starting an agent or writing a report', async (t) => {
  const server = await gitServer(t);
  const repo = await server.repository();
  await skill(repo.work);
  await writeFile(join(repo.work, 'external-skills.yaml'), 'references:\n  routing: [missing]\n');
  repo.publish();
  const output = join(server.root, 'report.json');
  const started = join(server.root, 'codex-started');
  const executable = join(server.root, 'unexpected-codex');
  await writeFile(executable, '#!/bin/sh\ntouch "$MARKER"\nexit 1\n');
  await chmod(executable, 0o700);
  const args = [
    '--load-skill',
    'routing',
    '--codex',
    executable,
    '--model',
    'synthetic',
    '--output',
    output,
  ];

  const missing = await collect(
    invoke(server, ['--root', `git+${server.url()}`, ...args], { MARKER: started }),
  );
  assert.equal(missing.code, 2);
  assert.match(missing.err, /Missing dependency missing/);
  await assert.rejects(readFile(started), { code: 'ENOENT' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  await server.assertClean();

  const child = invoke(server, ['--root', `git+${server.url('stall')}`, ...args], {
    MARKER: started,
  });
  t.after(() => {
    child.kill();
  });
  const done = collect(child);
  await Promise.race([server.stalled, done.then(({ err }) => assert.fail(err))]);
  child.kill('SIGINT');
  const interrupted = await done;
  assert.equal(interrupted.code, 2);
  assert.match(interrupted.err, /interrupted/);
  await assert.rejects(readFile(started), { code: 'ENOENT' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  await server.assertClean();
});

function invoke(
  server: Awaited<ReturnType<typeof gitServer>>,
  args: string[],
  env?: NodeJS.ProcessEnv,
) {
  return Bun.spawn([process.execPath, '--no-env-file', '--no-install', cli, ...args], {
    cwd: server.root,
    env: { ...server.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function collect(child: ReturnType<typeof invoke>) {
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}
