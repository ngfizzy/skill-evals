import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { OwnedProcessGroup } from '../process/group.ts';
import { MAX_OUTPUT } from '../process/index.ts';

import { launcherEnvironment, stagedLoginStore } from './context.ts';
import { AuthCleanup } from './cleanup.ts';
import { AuthError } from './errors.ts';
import { LauncherEventReader } from './events.ts';
import { CredentialLock } from './lock.ts';
import { authRequestSchema, serializeAuthEvent } from './protocol.ts';
import { AuthStore } from './store.ts';
import type { AuthEvent, AuthLauncherRequest } from './types.ts';

export class CleanupGuardian {
  static async run(
    request: AuthLauncherRequest,
    lockFd: number,
    emit: (event: AuthEvent) => void,
  ): Promise<void> {
    await AuthCleanup.prepareGuardian(request.store, request.workspace);
    const child = spawn(
      process.execPath,
      [
        '--no-env-file',
        '--no-install',
        fileURLToPath(import.meta.url),
        JSON.stringify(request),
        String(process.pid),
      ],
      {
        detached: false,
        env: launcherEnvironment(request.workspace),
        stdio: ['ignore', 'pipe', 'ignore', lockFd],
      },
    );
    const events = new LauncherEventReader(emit);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', () => reject(new AuthError('operation-failed')));
        child.stdout!.on('data', (chunk: Buffer) => {
          try {
            events.consume(chunk);
          } catch (error) {
            reject(error);
          }
        });
        child.once('close', (code) => {
          if (code === 0) resolve();
          else reject(events.failure ?? new AuthError('operation-failed'));
        });
      });
      events.finalState();
    } catch (error) {
      // A failed spawn left the lease here and could not authorize a worker.
      if (!child.pid) await AuthCleanup.finishUnclaimed(request.store, request.workspace);
      throw error;
    } finally {
      // On transport failure, let the guardian observe our exit and stop its own worker group.
      // Never kill the keeper and drop its descriptor before its writers are stopped.
      child.stdout!.destroy();
      child.unref();
    }
  }
}

class GuardianRun {
  private claimed = false;
  private stopping = false;
  private result = 0;
  private events: LauncherEventReader | undefined;
  private stopWorker: (() => Promise<void>) | undefined;
  private workerClosed: Promise<void> | undefined;
  private parentPoll: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly request: AuthLauncherRequest,
    private readonly launcher: number,
  ) {}

  async start(): Promise<void> {
    const { store, workspace } = this.request;
    try {
      // Check descriptor identity before using it as authority to recover the record.
      await CredentialLock.inherit(store, 3);
    } catch {
      this.report({ type: 'error', code: 'cleanup-required' });
      process.exit(2);
    }

    try {
      if (OwnedProcessGroup.parentPid() !== this.launcher) throw new AuthError('interrupted');
      await AuthCleanup.claim(store, workspace);
      this.claimed = true;
      await this.startWorker();
    } catch {
      await this.stop(2);
    }
  }

  private async startWorker(): Promise<void> {
    const group = new OwnedProcessGroup();
    const env = launcherEnvironment(this.request.workspace);
    const { child, exited } = await group.start(() => {
      const worker = spawn(
        process.execPath,
        ['--no-env-file', '--no-install', fileURLToPath(new URL('./worker.ts', import.meta.url))],
        { env, stdio: ['pipe', 'pipe', 'ignore', 3] },
      );
      this.workerClosed = new Promise<void>((resolve) => worker.once('close', () => resolve()));
      worker.stdin!.on('error', () => void this.stop(2));
      return worker;
    }, env);
    this.stopWorker = () => group.stop(exited);

    this.events = new LauncherEventReader((event) => {
      if (event.type === 'login-url') this.report(event);
      if (event.type === 'state') void this.stop(0);
      if (event.type === 'error') void this.stop(2);
    });
    let bytes = 0;
    child.stdout!.on('data', (chunk: Buffer) => {
      try {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) throw new AuthError('operation-failed');
        this.events!.consume(chunk);
      } catch {
        void this.stop(2);
      }
    });
    void exited.then(({ code }) => {
      if (!this.stopping) void this.stop(code ?? 2);
    });

    this.deadline = setTimeout(() => void this.stop(2), this.request.timeoutMs + 25_000);
    this.parentPoll = setInterval(() => {
      if (OwnedProcessGroup.parentPid() !== this.launcher) void this.stop(2);
    }, 25);
    if (OwnedProcessGroup.parentPid() !== this.launcher) {
      await this.stop(2);
      return;
    }
    child.stdin!.end(JSON.stringify(this.request));
  }

  private async stop(code: number): Promise<void> {
    if (code !== 0) this.result = 2;
    if (this.stopping) return;

    this.stopping = true;
    if (this.parentPoll) clearInterval(this.parentPoll);
    if (this.deadline) clearTimeout(this.deadline);

    let reported = false;
    const retry = async (work: () => Promise<void>) => {
      while (true) {
        try {
          await work();
          return;
        } catch {
          if (!reported) {
            this.report({ type: 'error', code: 'cleanup-required' });
            reported = true;
          }
          await delay(250);
        }
      }
    };

    if (this.stopWorker) await retry(this.stopWorker);
    await this.workerClosed;
    const event = await this.verifiedResult();

    const { store, workspace } = this.request;
    await retry(() =>
      this.claimed
        ? AuthCleanup.finishGuardian(store, workspace)
        : AuthCleanup.finishUnclaimed(store, workspace),
    );

    if (!reported) this.report(event);
    process.exit(!reported && event.type === 'state' ? 0 : 2);
  }

  private async verifiedResult(): Promise<AuthEvent> {
    try {
      if (this.result !== 0 || !this.events)
        throw this.events?.failure ?? new AuthError('operation-failed');
      const state = this.events.finalState();
      const { operation, store, workspace } = this.request;
      if (operation === 'login' && state === 'signed-in') {
        await AuthCleanup.verifyGuardianWorkspace(store, workspace);
        const managed = new AuthStore(store);
        await managed.publishLogin(stagedLoginStore(store, workspace));
        if ((await managed.inspectCredentials()) !== 'signed-in')
          throw new AuthError('login-required');
      }
      return { type: 'state', state };
    } catch (error) {
      return { type: 'error', code: error instanceof AuthError ? error.code : 'operation-failed' };
    }
  }

  private report(event: AuthEvent): void {
    try {
      writeSync(1, serializeAuthEvent(event));
    } catch {
      // The launcher may have exited. Cleanup still owns the lease and must finish.
    }
  }
}

if (import.meta.main) {
  const request = authRequestSchema.parse(JSON.parse(process.argv[2]!));
  const launcher = Number(process.argv[3]);
  if (!Number.isSafeInteger(launcher) || launcher <= 1) throw new AuthError('operation-failed');
  await new GuardianRun(request, launcher).start();
}
