import assert from 'node:assert/strict';
import { chmod, readFile, unlink, writeFile, symlink, mkdir } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';

import { parseRootInput } from '../src/sources/index.ts';

import { skill } from './helpers/fixture.ts';
import { FIXTURE_SECRET, gitServer } from './helpers/git-server.ts';

const sources = resolve('src/sources/index.ts');
const file = 'skills/routing/SKILL.md';

test('root inputs reject credentials, non-HTTPS transports and ambiguous revisions', () => {
  assert.deepEqual(parseRootInput('./skills'), { kind: 'local', directory: './skills' });
  assert.deepEqual(parseRootInput('git+https://EXAMPLE.TEST/team/skills.git#refs/tags/v1'), {
    kind: 'git',
    url: 'https://example.test/team/skills.git',
    revision: 'refs/tags/v1',
  });
  for (const value of [
    `git+https://user:${FIXTURE_SECRET}@example.test/team/skills.git`,
    `https://user:${FIXTURE_SECRET}@example.test/team/skills.git`,
    `git+https://example.test/team/skills.git?token=${FIXTURE_SECRET}`,
    'git+http://example.test/team/skills.git',
    'git+ssh://example.test/team/skills.git',
    'git+file:///tmp/skills.git',
    'git+https://example.test/team/%2fskills.git',
    'git+https://example.test/team/%2e%2e/skills.git',
    'git+https://example.test/team/skills.git#',
    'git+https://example.test/team/skills.git#main',
    'git+https://example.test/team/skills.git#deadbeef',
  ]) {
    assert.throws(
      () => parseRootInput(value),
      (error) => {
        assert.doesNotMatch(String(error), new RegExp(FIXTURE_SECRET));
        return true;
      },
    );
  }
});

test('HTTPS snapshots pin HEAD, branches, annotated tags and full commits', async (t) => {
  const server = await gitServer(t);
  const repo = await server.repository();
  await skill(repo.work);
  const original = repo.publish();
  repo.pushTag('first');

  const active = probe(server, [`git+${server.url()}`], {
    wait: true,
  });
  const reader = active.stdout.getReader();
  try {
    const ready = await reader.read();
    assert.match(Buffer.from(ready.value ?? []).toString(), new RegExp(original));
    await writeFile(join(repo.work, file), 'Moved default branch.');
    const current = repo.publish();
    assert.notEqual(current, original);

    active.stdin.end();
    const next = await reader.read();
    assert.match(Buffer.from(next.value ?? []).toString(), /Use Routine/);
    assert.equal(await active.exited, 0, await new Response(active.stderr).text());

    for (const [revision, commit, expected] of [
      ['#refs/heads/main', current, 'Moved default branch.'],
      ['#refs/tags/first', original, '# routing\nUse Routine. Keep this bounded.\n'],
      [`#${original}`, original, '# routing\nUse Routine. Keep this bounded.\n'],
    ] as const) {
      const result = await collect(probe(server, [`git+${server.url()}${revision}`]));
      assert.equal(result.code, 0, result.err);
      assert.deepEqual(JSON.parse(result.out), { commit, text: expected });
    }
    assert.ok(server.requests.length > 0);
    await server.assertClean();
  } finally {
    active.kill();
  }
});

test('fetch uses the configured HTTPS credential helper and redacts failures', async (t) => {
  const server = await gitServer(t);
  const repo = await server.repository();
  await skill(repo.work);
  const commit = repo.publish();
  const root = `git+${server.url('private')}`;

  const missing = await collect(probe(server, [root]));
  assert.equal(missing.code, 2);
  assert.match(missing.err, /Git fetch failed/);
  await server.assertClean();

  server.configure('credential.helper', '');
  server.configure(
    'credential.helper',
    `!f() { printf '%s\\n' 'username=fixture' 'password=${FIXTURE_SECRET}'; printf '%s\\n' '${FIXTURE_SECRET}' >&2; }; f`,
  );
  const authenticated = await collect(
    probe(server, [root], {
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.sslCAInfo',
        GIT_CONFIG_VALUE_0: '/wrong/ca.pem',
        GIT_DIR: '/wrong/repo',
        GIT_ALLOW_PROTOCOL: 'file',
      },
    }),
  );
  assert.equal(authenticated.code, 0, authenticated.err);
  assert.equal(JSON.parse(authenticated.out).commit, commit);
  assert.ok(server.requests.some((request) => request.authenticated));
  assert.doesNotMatch(authenticated.out + authenticated.err, new RegExp(FIXTURE_SECRET));

  server.configure('credential.helper', '');
  server.configure(
    'credential.helper',
    `!f() { printf '%s\\n' '${FIXTURE_SECRET}' >&2; exit 1; }; f`,
  );
  const denied = await collect(probe(server, [root]));
  assert.equal(denied.code, 2);
  assert.match(denied.err, /Git fetch failed/);
  assert.doesNotMatch(denied.out + denied.err, new RegExp(FIXTURE_SECRET));
  await server.assertClean();
});

test('rewrites and redirects are rejected and failed multi-root resolution cleans up', async (t) => {
  const server = await gitServer(t);
  const repo = await server.repository();
  await skill(repo.work);
  repo.publish();

  const redirect = await collect(probe(server, [`git+${server.url('redirect')}`]));
  assert.equal(redirect.code, 2);
  assert.match(redirect.err, /Git fetch failed/);
  assert.ok(server.requests.some(({ path }) => path.startsWith('/team/redirect.git/')));
  assert.ok(!server.requests.some(({ path }) => path.startsWith('/team/trap.git/')));
  await server.assertClean();

  const absent = await collect(
    probe(server, [`git+${server.url()}`, `git+${server.url()}#refs/heads/no-such-ref`]),
  );
  assert.equal(absent.code, 2);
  assert.match(absent.err, /Git fetch failed/);
  await server.assertClean();

  server.configure(`url.${server.url('trap')}.insteadOf`, server.url());
  const count = server.requests.length;
  const rewrite = await collect(probe(server, [`git+${server.url()}`]));
  assert.equal(rewrite.code, 2);
  assert.match(rewrite.err, /Git URL rewrite rejected/);
  assert.equal(server.requests.length, count);
  await server.assertClean();
});

test('cancelled HTTPS fetch tears down the process and removes its snapshot', async (t) => {
  const server = await gitServer(t);
  const child = probe(server, [`git+${server.url('stall')}`]);
  t.after(() => {
    child.kill();
  });
  await Promise.race([
    server.stalled,
    child.exited.then(async () => assert.fail(await new Response(child.stderr).text())),
  ]);
  child.kill('SIGINT');
  const result = await collect(child);
  assert.equal(result.code, 2, result.err);
  assert.match(result.err, /interrupted/);
  await server.assertClean();
});

test('an HTTPS fetch timeout kills Git and removes its snapshot', async (t) => {
  const server = await gitServer(t);
  const pidPath = join(server.root, 'fetch.pid');
  const PATH = await wrapGit(server.root, 'if [ "$1" = fetch ]; then echo "$$" > "$FETCH_PID"; fi');
  const child = probe(server, [`git+${server.url('stall')}`], {
    env: { PATH, FETCH_PID: pidPath },
    accelerateFetchTimeout: true,
  });
  t.after(() => {
    child.kill();
  });
  const done = collect(child);
  await Promise.race([server.stalled, done.then(({ err }) => assert.fail(err))]);

  const result = await done;
  assert.equal(result.code, 2);
  assert.match(result.err, /Git fetch timed out/);
  const pid = Number(await readFile(pidPath, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await server.assertClean();
});

test('Git runs fetch with an empty hook directory even when a working hook is configured', async (t) => {
  const server = await gitServer(t);
  const repo = await server.repository();
  await skill(repo.work);
  const commit = repo.publish();

  const hooks = join(server.root, 'configured-hooks');
  const marker = join(server.root, 'hook-was-run');
  await mkdir(hooks);
  const hook = join(hooks, 'reference-transaction');
  await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
  await chmod(hook, 0o700);
  repo.git('-c', `core.hooksPath=${hooks}`, 'update-ref', 'refs/heads/control', commit);
  assert.equal(await readFile(marker, 'utf8'), '');
  await unlink(marker);

  server.configure('core.hooksPath', hooks);
  // Fetch writes only FETCH_HEAD. Force a reference transaction under the same fetch environment.
  const PATH = await wrapGit(
    server.root,
    `
    if [ "$1" = fetch ]; then
      test "$("$real_git" config --get core.hooksPath)" -ef "$PWD/empty-hooks" || exit 1
      "$real_git" "$@" || exit $?
      commit=$("$real_git" rev-parse 'FETCH_HEAD^{commit}') || exit $?
      exec "$real_git" update-ref refs/heads/hook-probe "$commit"
    fi
  `,
  );
  const fetched = await collect(probe(server, [`git+${server.url()}`], { env: { PATH } }));
  assert.equal(fetched.code, 0, fetched.err);
  assert.equal(JSON.parse(fetched.out).commit, commit);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await server.assertClean();
});

test('tree reads refuse unsafe entries, oversized blobs and non-UTF-8 content', async (t) => {
  const server = await gitServer(t);
  const repo = await server.repository();
  const path = await skill(repo.work);
  await mkdir(join(path, 'references'));
  await symlink('/synthetic/outside', join(path, 'references/link.md'));
  await writeFile(join(path, 'references/binary.md'), Buffer.from([0xff]));
  await writeFile(join(path, 'references/large.md'), 'x'.repeat(1025));
  const commit = repo.publish();
  // A bare fetch cannot consult repository attributes, templates, filters or hooks.
  await writeFile(join(repo.work, '.gitattributes'), '*.md filter=fixture\n');
  await writeFile(
    join(repo.work, '.gitmodules'),
    '[submodule "fixture"]\n  path = skills/routing/references/submodule\n  url = https://example.invalid/not-fetched.git\n',
  );
  repo.publish(() => {
    repo.git(
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${commit},skills/routing/references/submodule`,
    );
  });
  const marker = join(server.root, 'filter-was-run');
  server.configure('filter.fixture.smudge', `touch '${marker}'`);
  server.configure('filter.fixture.required', 'true');

  const normal = await collect(probe(server, [`git+${server.url()}`]));
  assert.equal(normal.code, 0, normal.err);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });

  for (const [path, expected] of [
    ['link.md', /Unsupported Git entry/],
    ['submodule/inside.md', /Unsupported Git entry/],
    ['binary.md', /Git blob read failed/],
    ['large.md', /File exceeds 1024 bytes/],
  ] as const) {
    const result = await collect(
      probe(server, [`git+${server.url()}`], {
        path: `skills/routing/references/${path}`,
      }),
    );
    assert.equal(result.code, 2);
    assert.match(result.err, expected);
    await server.assertClean();
  }
});

function probe(
  server: Awaited<ReturnType<typeof gitServer>>,
  roots: string[],
  {
    env,
    path = file,
    wait = false,
    accelerateFetchTimeout = false,
  }: {
    env?: NodeJS.ProcessEnv;
    path?: string;
    wait?: boolean;
    accelerateFetchTimeout?: boolean;
  } = {},
) {
  return Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '-e',
      `
      import { parseRootInput, resolveRoots } from ${JSON.stringify(sources)};
      const controller = new AbortController();
      process.on('SIGINT', () => controller.abort());
      if (${accelerateFetchTimeout}) {
        const schedule = globalThis.setTimeout;
        globalThis.setTimeout = (fn, ms, ...args) => schedule(fn, ms === 60_000 ? 1200 : ms, ...args);
      }
      try {
        const resolved = await resolveRoots(process.argv.slice(1).map(parseRootInput), controller.signal);
        try {
          const [{commit}] = resolved.gitSources;
          if (${wait}) {
            console.log(commit);
            await Bun.stdin.text();
          }
          const text = await resolved.roots[0].readText(${JSON.stringify(path)}, 1024);
          console.log(JSON.stringify({commit, text}));
        } finally {
          await resolved.dispose();
        }
      } catch (error) {
        console.error(error.message);
        process.exitCode = 2;
      }
    `,
      '--',
      ...roots,
    ],
    {
      cwd: server.root,
      env: { ...server.env, ...env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}

async function wrapGit(root: string, body: string): Promise<string> {
  const git = Bun.which('git');
  assert.ok(git, 'Installed Git is required');
  const directory = join(root, 'test-bin');
  const executable = join(directory, 'git');
  await mkdir(directory);
  await writeFile(executable, `#!/bin/sh\nreal_git='${git}'\n${body}\nexec "$real_git" "$@"\n`);
  await chmod(executable, 0o700);
  return [directory, process.env.PATH].join(delimiter);
}

async function collect(child: ReturnType<typeof probe>) {
  child.stdin.end();
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}
