import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import type { ProcessOptions } from '../src/process/index.ts';
import { runProcess } from '../src/process/index.ts';

import { temporary } from './helpers/fixture.ts';

async function nodeRun(root: string, program: string, options: Partial<ProcessOptions> = {}) {
  return runProcess([process.execPath, '-e', program], {
    input: '',
    directory: root,
    timeoutMs: 3000,
    ...options,
  });
}

test('process stdin/stdout, spawn error, nonzero exit and bounded stderr diagnostics', async (t) => {
  const root = await temporary(t);
  assert.equal(
    await nodeRun(root, 'process.stdin.pipe(process.stdout)', { input: 'hello' }),
    'hello',
  );
  await assert.rejects(
    nodeRun(root, 'process.stderr.write("deliberate diagnostic");process.exit(7)'),
    /exited 7: deliberate diagnostic/,
  );
  await assert.rejects(
    runProcess(['/missing/agent'], { input: '', directory: root, timeoutMs: 100 }),
    /process error/,
  );
});

test('bounds include timeout, combined streams and output emitted immediately before exit', async (t) => {
  const root = await temporary(t);
  await assert.rejects(nodeRun(root, 'setTimeout(()=>{},10000)', { timeoutMs: 80 }), /timed out/);
  for (const program of [
    'process.stdout.write("x".repeat(3000000))',
    'process.stderr.write("x".repeat(3000000))',
    'process.stdout.write("x".repeat(1500000));process.stderr.write("x".repeat(1500000))',
  ])
    await assert.rejects(nodeRun(root, program), /output exceeded/);
});

for (const mode of ['timeout', 'leader-exit', 'abort'])
  test(`kills descendants on ${mode}`, async (t) => {
    const root = await temporary(t),
      pidPath = join(root, 'child.pid');
    const program = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{stdio:'inherit'});
    fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));
    ${mode === 'leader-exit' ? 'process.exit(0)' : 'setTimeout(()=>{},20000)'};`;
    const controller = new AbortController();
    if (mode === 'abort') setTimeout(() => controller.abort(), 300);
    const promise = nodeRun(root, program, {
      timeoutMs: mode === 'timeout' ? 300 : 3000,
      signal: controller.signal,
    });
    if (mode === 'leader-exit') await promise;
    else await assert.rejects(promise, mode === 'timeout' ? /timed out/ : /interrupted/);
    const pid = Number(await readFile(pidPath, 'utf8'));
    try {
      process.kill(pid, 0);
      const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
        encoding: 'utf8',
      }).trim();
      assert.ok(!state || state.startsWith('Z'), `Descendant ${pid} still running: ${state}`);
    } catch (error) {
      if (!(
        error &&
        typeof error === 'object' &&
        (('code' in error && error.code === 'ESRCH') || ('status' in error && error.status === 1))
      ))
        throw error;
    }
  });
