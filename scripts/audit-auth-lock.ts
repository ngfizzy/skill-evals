import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuthCleanup } from '../src/auth/cleanup.ts';
import { CredentialLock } from '../src/auth/lock.ts';
import { packagedAuthRuntime } from '../src/auth/runtime.ts';
import { AuthStore } from '../src/auth/store.ts';

const WORKER = fileURLToPath(new URL('./fixtures/auth-lock-worker.ts', import.meta.url));
const READINESS_TIMEOUT_MS = 15_000;

// Explicit local audit: no account credentials or external network requests. Proves that native
// Codex keeps holding the inherited credential lock after its launcher dies, and that its exit
// releases it.
async function audit(root: string): Promise<void> {
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { mode: 0o700 });
  const store = (await AuthStore.resolve({ HOME: root, XDG_DATA_HOME: root })).location;
  const executable = process.argv[2] ?? packagedAuthRuntime();
  const provider = startMockProvider();

  const worker = spawn(
    process.execPath,
    [
      '--no-env-file',
      '--no-install',
      WORKER,
      JSON.stringify(store),
      workspace,
      executable,
      join(root, 'response'),
      String(provider.port),
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  try {
    // Native Codex is running under the lock once it has started and reached the mock provider.
    const [nativePid] = await withDeadline(
      Promise.all([readNativePid(worker), provider.requested]),
      'Local native lock audit timed out',
    );

    await killAndWait(worker);
    await assert.rejects(CredentialLock.acquire(store, undefined, 100), /Timed out/);

    process.kill(nativePid, 'SIGKILL');
    await assert.rejects(CredentialLock.acquire(store, undefined, 2000), {
      code: 'cleanup-required',
    });
    await AuthCleanup.finish(store, workspace);
    const recovered = await CredentialLock.acquire(store, undefined, 2000);
    await recovered.release();

    console.log(
      'Native Codex retained the production lock after launcher death; exit released it. No credentials used.',
    );
  } finally {
    killProcessGroup(worker);
    provider.stop();
  }
}

// A localhost Responses endpoint that never answers, so native Codex stays alive mid-request.
function startMockProvider() {
  let reached!: () => void;
  const requested = new Promise<void>((resolve) => (reached = resolve));
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname.endsWith('/responses')) {
        reached();
        return new Promise<Response>(() => {});
      }
      return Response.json({ models: [] }, { status: 404 });
    },
  });
  return { port: server.port, requested, stop: () => server.stop(true) };
}

function readNativePid(worker: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let text = '';
    worker.stdout!.on('data', (chunk) => {
      text += String(chunk);
      if (!text.includes('\n')) return;

      const pid = Number(text.trim());
      if (Number.isSafeInteger(pid) && pid > 0) resolve(pid);
      else reject(new Error('Invalid native PID'));
    });
    worker.once('exit', () => reject(new Error('Lock launcher exited before audit readiness')));
    worker.once('error', reject);
  });
}

async function withDeadline<T>(work: Promise<T>, message: string): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => reject(new Error(message)), READINESS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(deadline);
  }
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const controller = new AbortController();
  const exited = once(child, 'exit', { signal: controller.signal });
  try {
    child.kill('SIGKILL');
    await withDeadline(exited, 'Lock launcher did not exit after SIGKILL');
  } finally {
    controller.abort();
  }
}

function killProcessGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

const root = await realpath(await mkdtemp(join(tmpdir(), 'skill-evals-native-lock-')));
try {
  await audit(root);
} finally {
  await rm(root, { recursive: true, force: true });
}
