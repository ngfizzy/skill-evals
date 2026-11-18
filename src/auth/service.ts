import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProcessManager, ProcessTeardownError } from '../process/index.ts';

import { AuthError } from './contracts/errors.ts';
import type {
  AuthLauncherRequest,
  AuthOperation,
  AuthOperationOptions,
  AuthState,
} from './contracts/types.ts';
import { AuthCleanup } from './credentials/cleanup.ts';
import { CredentialLock } from './credentials/lock.ts';
import { AuthStore } from './credentials/store.ts';
import { launcherEnvironment } from './runtime/context.ts';
import { LauncherEventReader } from './runtime/events.ts';
import { packagedAuthRuntime } from './runtime/packaged-codex.ts';

const LOGIN_TIMEOUT_MS = 15 * 60_000;
const COMMAND_TIMEOUT_MS = 20_000;
const DEFAULT_LOCK_WAIT_MS = 120_000;
// Covers the launcher's native version probe and its own startup and exit.
const LAUNCHER_OVERHEAD_MS = 25_000;

const LAUNCHER_COMMAND = [
  process.execPath,
  '--no-env-file',
  '--no-install',
  fileURLToPath(new URL('./runtime/launcher.ts', import.meta.url)),
];

export interface AuthServiceOptions {
  env?: NodeJS.ProcessEnv;
  nativeExecutable?: string;
  timeoutMs?: number;
  lockWaitMs?: number;
}

// Runs each operation in a separate launcher process that owns the lock and native Codex.
export class AuthService {
  private readonly processManager = new ProcessManager();

  constructor(private readonly options: AuthServiceOptions = {}) {}

  async execute(operation: AuthOperation, options: AuthOperationOptions = {}): Promise<AuthState> {
    if (options.signal?.aborted) throw new AuthError('interrupted');

    const store = await AuthStore.resolve(this.options.env);

    const workspace = await realpath(tmpdir())
      .then((root) => mkdtemp(join(root, 'skill-evals-auth-operation-')))
      .catch(() => {
        throw new AuthError('operation-failed');
      });

    let cleanupSafe = true;
    try {
      const home = join(workspace, 'launcher-home');
      await mkdir(home, { mode: 0o700 });

      const request = this.launcherRequest(operation, store, workspace);
      const events = new LauncherEventReader(options.onEvent);

      try {
        await this.processManager.run(LAUNCHER_COMMAND, {
          input: JSON.stringify(request),
          timeoutMs: request.lockWaitMs + request.timeoutMs + LAUNCHER_OVERHEAD_MS,
          directory: workspace,
          // The guardian owns the worker group; this supervisor owns only its control child.
          termination: 'leader',
          env: launcherEnvironment(workspace),
          ...(options.signal ? { signal: options.signal } : {}),
          onStdout: (chunk) => events.consume(chunk),
        });
      } catch (error) {
        if (error instanceof ProcessTeardownError || events.failure?.code === 'cleanup-required')
          cleanupSafe = false;

        if (options.signal?.aborted) throw new AuthError('interrupted');
        throw events.failure ?? new AuthError('operation-failed');
      }

      return events.finalState();
    } finally {
      if (!cleanupSafe) throw new AuthError('cleanup-required');

      try {
        await AuthCleanup.finish(store.location, workspace);
      } catch {
        // The launcher can die just after writing 'starting', before it spawns the guardian.
        await CredentialLock.recoverUnclaimed(store.location, workspace);
      }
    }
  }

  private launcherRequest(
    operation: AuthOperation,
    store: AuthStore,
    workspace: string,
  ): AuthLauncherRequest {
    return {
      operation,
      store: store.location,
      workspace,
      nativeExecutable: this.options.nativeExecutable ?? packagedAuthRuntime(),
      timeoutMs:
        this.options.timeoutMs ?? (operation === 'login' ? LOGIN_TIMEOUT_MS : COMMAND_TIMEOUT_MS),
      lockWaitMs: this.options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
    };
  }
}
