import { spawn, type ChildProcess } from 'node:child_process';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ProcessGuardian, retryTeardown } from '../../process/guardian.ts';
import { MAX_OUTPUT } from '../../process/index.ts';
import { AuthError } from '../contracts/errors.ts';
import { authRequestSchema, serializeAuthEvent } from '../contracts/protocol.ts';
import type { AuthEvent, AuthLauncherRequest } from '../contracts/types.ts';
import { AuthCleanup } from '../credentials/cleanup.ts';
import { CredentialLock } from '../credentials/lock.ts';
import { AuthStore } from '../credentials/store.ts';

import { launcherEnvironment, stagedLoginStore } from './context.ts';
import { LauncherEventReader } from './events.ts';

export class GuardedAuth {
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

class GuardedAuthRun {
  private claimed = false;
  private workerFailed = false;
  private recoveryReported = false;
  private readonly events: LauncherEventReader;

  constructor(
    private readonly request: AuthLauncherRequest,
    private readonly guardian: ProcessGuardian,
  ) {
    this.events = new LauncherEventReader((event) => {
      if (event.type === 'login-url') this.report(event);

      if (event.type === 'state') this.guardian.stop();

      if (event.type === 'error') this.failWorker();
    });
  }

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
      if (!this.guardian.hasParent()) throw new AuthError('interrupted');

      await AuthCleanup.claim(store, workspace);
      this.claimed = true;

      await this.runWorker();
    } catch {
      this.workerFailed = true;
    }

    const event = await this.verifiedResult();
    await retryTeardown(AuthCleanup.guardianCleanup(store, workspace, this.claimed), () =>
      this.reportRecovery(),
    );

    if (!this.recoveryReported) this.report(event);
    process.exit(!this.recoveryReported && event.type === 'state' ? 0 : 2);
  }

  private async runWorker(): Promise<void> {
    const env = launcherEnvironment(this.request.workspace);

    const outcome = await this.guardian.run({
      env,
      spawn: () =>
        spawn(
          process.execPath,
          ['--no-env-file', '--no-install', fileURLToPath(new URL('./worker.ts', import.meta.url))],
          { env, stdio: ['pipe', 'pipe', 'ignore', 3] },
        ),
      authorize: (worker) => this.sendRequest(worker),
      timeoutMs: this.request.timeoutMs + 25_000,
      onTeardownFailure: () => this.reportRecovery(),
    });

    await outcome.closed;
    if (outcome.interrupted || (outcome.exit && outcome.exit.code !== 0)) this.workerFailed = true;
  }

  private sendRequest(worker: ChildProcess): void {
    const { stdin, stdout } = worker;
    if (!stdin || !stdout) throw new AuthError('operation-failed');

    let bytes = 0;
    stdout.on('data', (chunk: Buffer) => {
      try {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) throw new AuthError('operation-failed');
        this.events.consume(chunk);
      } catch {
        this.failWorker();
      }
    });

    stdin.on('error', () => this.failWorker());
    stdin.end(JSON.stringify(this.request));
  }

  private failWorker(): void {
    this.workerFailed = true;
    this.guardian.stop();
  }

  private async verifiedResult(): Promise<AuthEvent> {
    try {
      if (this.workerFailed) throw this.events.failure ?? new AuthError('operation-failed');

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

  private reportRecovery(): void {
    if (this.recoveryReported) return;
    this.recoveryReported = true;
    this.report({ type: 'error', code: 'cleanup-required' });
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

  await new GuardedAuthRun(request, new ProcessGuardian(launcher)).start();
}
