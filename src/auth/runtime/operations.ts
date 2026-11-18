import { lstat, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { AUDITED_CODEX_VERSION_OUTPUT } from '../../adaptors/codex-helpers.ts';
import { isSameFile, readBounded, sha256, type FileIdentity } from '../../utils/index.ts';
import { AuthError } from '../contracts/errors.ts';
import type {
  AuthEvent,
  AuthLauncherRequest,
  AuthState,
  CredentialLease,
} from '../contracts/types.ts';
import { AuthCleanup } from '../credentials/cleanup.ts';
import { CredentialLock } from '../credentials/lock.ts';
import { AuthStore, MAX_CREDENTIAL_BYTES } from '../credentials/store.ts';

import {
  createAuthContext,
  createLoginContext,
  stagedLoginStore,
  type NativeAuthContext,
} from './context.ts';
import { GuardedAuth } from './guarded-auth.ts';
import { runNativeAuth } from './native.ts';

const VERSION_PROBE_TIMEOUT_MS = 20_000;

const NATIVE_AUTH_CONFIG = [
  '-c',
  'cli_auth_credentials_store="file"',
  '-c',
  'forced_login_method="chatgpt"',
];

type EventSink = (event: AuthEvent) => void;

// One launcher request, run while holding the credential lease. Emits login URLs while native
// Codex runs, then the resulting state.
export class AuthLauncherJob {
  private constructor(
    private readonly request: AuthLauncherRequest,
    private readonly store: AuthStore,
    private readonly lease: CredentialLease,
    private readonly emit: EventSink,
  ) {}

  static async run(request: AuthLauncherRequest, emit: EventSink): Promise<void> {
    if (!isAbsolute(request.nativeExecutable) || !isAbsolute(request.workspace))
      throw new AuthError('invalid-store');
    AuthStore.assertPrivateDirectory(await lstat(request.workspace));

    const lease = await CredentialLock.acquire(request.store, undefined, request.lockWaitMs);

    try {
      const state = await new AuthStore(request.store).inspectCredentials();

      if (
        request.operation === 'status' ||
        (request.operation === 'logout' && state === 'signed-out')
      ) {
        emit({ type: 'state', state });
        return;
      }
      await AuthCleanup.begin(request.store, request.workspace);
      await GuardedAuth.run(request, lease.fd, emit);
    } finally {
      await lease.release();
    }
  }

  static async runInherited(request: AuthLauncherRequest, emit: EventSink): Promise<void> {
    if (!isAbsolute(request.nativeExecutable) || !isAbsolute(request.workspace))
      throw new AuthError('invalid-store');
    AuthStore.assertPrivateDirectory(await lstat(request.workspace));

    const store = new AuthStore(request.store);
    const lease = await CredentialLock.inherit(request.store, 3);

    try {
      const job = new AuthLauncherJob(request, store, lease, emit);
      const state = await job.perform(await store.inspectCredentials());
      emit({ type: 'state', state });
    } finally {
      await lease.release();
    }
  }

  private perform(current: AuthState): Promise<AuthState> {
    switch (this.request.operation) {
      case 'status':
        return Promise.resolve(current);
      case 'login':
        return this.login();
      case 'logout':
        return current === 'signed-out' ? Promise.resolve(current) : this.logout();
    }
  }

  private async login(): Promise<AuthState> {
    const { store, workspace } = this.request;
    const context = await createLoginContext(store, workspace);
    try {
      const session = new NativeAuthSession(this.request, this.lease, context, this.emit);
      await session.verifyRuntime();

      await session.run('login');

      if ((await stagedLoginStore(store, workspace).inspectCredentials()) !== 'signed-in')
        throw new AuthError('login-required');
      return 'signed-in';
    } finally {
      await context.dispose();
    }
  }

  private async logout(): Promise<AuthState> {
    const { authFile } = this.request.store;
    const before = await CredentialSnapshot.capture(authFile);

    const context = await createAuthContext(this.request.store, this.request.workspace);
    try {
      const session = new NativeAuthSession(this.request, this.lease, context, this.emit);
      await session.verifyRuntime();
      await context.verifyLink();

      await session.run('logout');
      await context.verifyLink(true);

      // Delete only the exact credentials we saw. A concurrent re-login must survive.
      const unchanged =
        before.hasIdentity(await lstat(authFile)) &&
        (await this.store.inspectCredentials()) === 'signed-in' &&
        before.digest === (await CredentialSnapshot.digest(authFile));
      if (!unchanged) throw new AuthError('invalid-store');

      // Codex removes its temporary auth.json symlink. Remove the managed target too.
      await unlink(authFile);
      return 'signed-out';
    } finally {
      await context.dispose();
    }
  }
}

// Runs the audited native Codex executable inside an isolated context with the lease inherited.
class NativeAuthSession {
  constructor(
    private readonly request: AuthLauncherRequest,
    private readonly lease: CredentialLease,
    private readonly context: NativeAuthContext,
    private readonly emit: EventSink,
  ) {}

  async verifyRuntime(): Promise<void> {
    const version = await this.runNative(['--version'], VERSION_PROBE_TIMEOUT_MS);

    if (version.code !== 0 || version.stdout.trim() !== AUDITED_CODEX_VERSION_OUTPUT)
      throw new AuthError('unsupported-runtime');
  }

  async run(operation: 'login' | 'logout'): Promise<void> {
    const result = await this.runNative(
      [...NATIVE_AUTH_CONFIG, operation],
      this.request.timeoutMs,
      this.emit,
    );
    if (result.code !== 0) throw new AuthError('operation-failed');
  }

  private runNative(args: string[], timeoutMs: number, onEvent?: EventSink) {
    return runNativeAuth({
      executable: this.request.nativeExecutable,
      args,
      context: this.context,
      lockFd: this.lease.fd,
      timeoutMs,
      ...(onEvent ? { onEvent } : {}),
    });
  }
}

// The identity and contents of the credentials file at one moment.
class CredentialSnapshot {
  private constructor(
    private readonly identity: FileIdentity,
    readonly digest: string,
  ) {}

  static async capture(path: string): Promise<CredentialSnapshot> {
    const identity = await lstat(path);
    return new CredentialSnapshot(identity, await CredentialSnapshot.digest(path));
  }

  static async digest(path: string): Promise<string> {
    return sha256(await readBounded(path, MAX_CREDENTIAL_BYTES));
  }

  hasIdentity(current: FileIdentity): boolean {
    return isSameFile(this.identity, current);
  }
}
