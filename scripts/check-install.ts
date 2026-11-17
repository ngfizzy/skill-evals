import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isAuditedAuthPlatform } from '../src/auth/platform.ts';

const temporary = mkdtempSync(join(tmpdir(), 'skill-evals-install-'));
const execute = (command: string, args: string[], cwd: string, env = process.env): string => {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
};
try {
  const packed = JSON.parse(
    execute(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        temporary,
        '--cache',
        join(temporary, 'cache'),
      ],
      process.cwd(),
    ),
  );

  const prefix = join(temporary, 'installed');
  execute(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefix',
      prefix,
      '--cache',
      join(temporary, 'cache'),
      join(temporary, packed[0].filename),
    ],
    temporary,
  );

  const executable = join(prefix, 'node_modules', '.bin', 'skill-evals');
  assert.match(execute(executable, ['--help'], temporary), /Usage: skill-evals/);
  assert.match(execute(executable, ['auth', '--help'], temporary), /login\|status\|logout/);

  const root = join(prefix, 'node_modules', 'skill-evals', 'examples', 'basic');
  const list = execute(executable, ['--root', root, '--list'], temporary);
  assert.match(list, /routing\/behavior-1/);
  assert.match(list, /caution\/proposed-review/);
  const scoped = execute(
    executable,
    ['--root', root, '--load-skill', 'routing', '--list'],
    temporary,
  );
  assert.match(scoped, /routing\/behavior-1/);
  assert.doesNotMatch(scoped, /caution\/proposed-review/);

  const { writeFileSync } = await import('node:fs');
  const probe = join(prefix, 'import-contract.ts');
  writeFileSync(
    probe,
    `import assert from 'node:assert/strict';
for (const name of ['skill-evals', 'skill-evals/src/catalog/index.ts', 'skill-evals/src/adaptors/index.ts']) {
  await assert.rejects(import(name), (error: unknown) => error instanceof Error &&
    'code' in error && ['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_MODULE_NOT_FOUND'].includes(String(error.code)));
}
`,
  );
  execute(process.execPath, [probe], temporary);
  console.log('Installed package import boundary passed: root and deep imports rejected.');

  writeFileSync(
    probe,
    `import assert from 'node:assert/strict';
const {CodexAgent} = await import(${JSON.stringify(join(prefix, 'node_modules', 'skill-evals', 'src', 'adaptors', 'index.ts'))});
process.env.PATH = ${JSON.stringify(temporary)};
const agent = new CodexAgent(undefined, 20);
await agent.preflight();
assert.equal(agent.version, 'codex-cli 0.165.0');
`,
  );
  execute(process.execPath, ['--no-env-file', '--no-install', probe], temporary);
  console.log('Installed Codex preflight passed outside checkout with no Codex or Node on PATH.');

  if (isAuditedAuthPlatform()) {
    const data = join(temporary, 'auth-fixture');
    const env = {
      ...process.env,
      HOME: data,
      XDG_DATA_HOME: data,
      CODEX_HOME: join(data, 'normal'),
    };
    assert.equal(execute(executable, ['auth', 'status'], temporary, env).trim(), 'signed-out');
    const credentials = join(data, 'skill-evals', 'codex-auth', 'auth.json');
    writeFileSync(
      credentials,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: 'synthetic-id',
          access_token: 'synthetic-access',
          refresh_token: 'synthetic-refresh',
        },
      }),
      { mode: 0o600 },
    );
    assert.equal(execute(executable, ['auth', 'status'], temporary, env).trim(), 'signed-in');
    assert.equal(execute(executable, ['auth', 'logout'], temporary, env).trim(), 'signed-out');
    assert.equal(await Bun.file(credentials).exists(), false);
    console.log('Installed CLI auth status and logout passed using a separate synthetic store.');
  } else {
    console.log('Installed auth smoke skipped outside the audited platform matrix.');
  }

  writeFileSync(
    probe,
    `import assert from 'node:assert/strict';
import {act, createElement} from 'react';
import {createRoot} from '@opentui/react';
import {createTestRenderer} from '@opentui/core/testing';
const {RunView} = await import(${JSON.stringify(join(prefix, 'node_modules', 'skill-evals', 'src', 'display', 'components', 'index.ts'))});
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
const setup = await createTestRenderer({width: 80, height: 24});
const root = createRoot(setup.renderer);
try {
  await act(async () => root.render(createElement(RunView, {
    snapshot: {report: {results: [], selected_cases: 0, model: 'fixture', judge_model: 'fixture',
      summary: {passed: 0, failed: 0, errors: 0, pending: 0, assertion_score: null}},
      entries: [], path: 'synthetic.json', finished: true},
    options: {color: 'never', progress: 'none'}, onExit() {}, onFailure: assert.fail,
  })));
  await setup.flush();
  assert.match(setup.captureCharFrame(), /No completed cases recorded/);
} finally { await act(async () => root.unmount()); await setup.dispose(); }
`,
  );
  execute(process.execPath, [probe], temporary);
  console.log(
    'Installed TSX view rendered with React and the native OpenTUI dependency outside checkout.',
  );
  console.log(
    'Packed installation passed outside checkout: executable help and both fixture formats.',
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
