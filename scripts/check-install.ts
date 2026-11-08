import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporary = mkdtempSync(join(tmpdir(), 'skill-evals-install-'));
const execute = (command: string, args: string[], cwd: string): string => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
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
  const root = join(prefix, 'node_modules', 'skill-evals', 'examples', 'basic');
  const list = execute(executable, ['--root', root, '--list'], temporary);
  assert.match(list, /routing\/behavior-1/);
  assert.match(list, /caution\/proposed-review/);
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
