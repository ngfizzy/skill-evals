import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

import { ProcessManager, type ProcessOptions } from '../src/process/index.ts';

import { temporary } from './helpers/fixture.ts';

const processManager = new ProcessManager();

async function nodeRun(root: string, program: string, options: Partial<ProcessOptions> = {}) {
  return processManager.run([process.execPath, '-e', program], {
    input: '',
    directory: root,
    timeoutMs: 6000,
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
    processManager.run(['/missing/agent'], { input: '', directory: root, timeoutMs: 6000 }),
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

test('stdout callbacks stream output and callback failure terminates the process', async (t) => {
  const root = await temporary(t);
  const chunks: Buffer[] = [];
  const result = await nodeRun(root, 'process.stdout.write("streamed")', {
    onStdout: (chunk) => chunks.push(chunk),
  });
  assert.equal(Buffer.concat(chunks).toString(), result);

  await assert.rejects(
    nodeRun(root, 'console.log("ready");setInterval(()=>{},1000)', {
      onStdout() {
        throw new Error('consumer failure');
      },
    }),
    /Process output consumer failed/,
  );
});

test('one manager keeps concurrent output and cancellation independent', async (t) => {
  const root = await temporary(t);
  const controller = new AbortController();
  const interrupted = assert.rejects(
    nodeRun(root, 'console.log("cancel-me");setInterval(()=>{},1000)', {
      signal: controller.signal,
      onStdout: () => controller.abort(),
    }),
    /interrupted/,
  );
  const successful = nodeRun(root, 'setTimeout(()=>process.stdout.write("survived"),100)');

  const [, output] = await Promise.all([interrupted, successful]);
  assert.equal(output, 'survived');
});

for (const mode of ['timeout', 'leader-exit', 'abort'])
  test(`kills descendants on ${mode}`, async (t) => {
    const root = await temporary(t),
      pidPath = join(root, 'child.pid');
    const program = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{stdio:'inherit'});
    fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid)); console.log('child ready');
    ${mode === 'leader-exit' ? 'process.exit(0)' : 'setTimeout(()=>{},20000)'};`;
    const controller = new AbortController();
    const promise = nodeRun(root, program, {
      timeoutMs: mode === 'timeout' ? 2000 : 6000,
      signal: controller.signal,
      onStdout: () => {
        if (mode === 'abort') controller.abort();
      },
    });
    if (mode === 'leader-exit') await promise;
    else await assert.rejects(promise, mode === 'timeout' ? /timed out/ : /interrupted/);
    const pid = Number(await readFile(pidPath, 'utf8'));
    if (process.platform === 'linux') {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      return;
    }
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
