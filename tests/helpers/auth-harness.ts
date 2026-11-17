import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AuthService, type AuthEvent, type AuthServiceOptions } from '../../src/auth/index.ts';
import { CredentialLock } from '../../src/auth/lock.ts';
import { AuthStore } from '../../src/auth/store.ts';
import type { AuthStoreLocation } from '../../src/auth/types.ts';

import {
  SYNTHETIC_CREDENTIALS,
  type FakeCodexAuthMode,
  type FakeCodexAuthTrace,
} from './fake-codex-auth.ts';
import { temporary } from './fixture.ts';

const helper = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));

// A private credential store under a temporary XDG data home, plus fake native runtimes.
export class AuthHarness {
  private constructor(
    private readonly t: TestContext,
    readonly root: string,
    readonly home: string,
    readonly env: NodeJS.ProcessEnv,
    readonly authStore: AuthStore,
  ) {}

  static async create(t: TestContext): Promise<AuthHarness> {
    const root = await realpath(await temporary(t));
    const home = join(root, 'home');
    await mkdir(home, { mode: 0o700 });

    // Secrets in the caller's environment must never reach native Codex.
    const env = {
      HOME: home,
      XDG_DATA_HOME: root,
      CODEX_API_KEY: 'MUST_NOT_LEAK',
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'https://invalid.example',
    };
    return new AuthHarness(t, root, home, env, await AuthStore.resolve(env));
  }

  get store(): AuthStoreLocation {
    return this.authStore.location;
  }

  get lockFile(): string {
    return join(this.store.directory, '.auth.lock');
  }

  private get tracePath(): string {
    return join(this.root, 'trace.json');
  }

  async service(
    mode: FakeCodexAuthMode = 'normal',
    options: Pick<AuthServiceOptions, 'timeoutMs' | 'lockWaitMs'> = {},
  ): Promise<AuthService> {
    const nativeExecutable = join(this.root, `fake-codex-${mode}.ts`);
    await writeFile(
      nativeExecutable,
      [
        `#!${process.execPath}`,
        `import { runFakeCodexAuth } from ${JSON.stringify(helper('fake-codex-auth.ts'))};`,
        `await runFakeCodexAuth(${JSON.stringify(mode)}, ${JSON.stringify(this.tracePath)});`,
      ].join('\n'),
    );
    await chmod(nativeExecutable, 0o700);

    return new AuthService({ env: this.env, nativeExecutable, ...options });
  }

  async signIn(credentials: object = SYNTHETIC_CREDENTIALS): Promise<void> {
    await writeFile(this.store.authFile, JSON.stringify(credentials), { mode: 0o600 });
  }

  async readCredentials(): Promise<unknown> {
    return JSON.parse(await readFile(this.store.authFile, 'utf8'));
  }

  async credentialsExist(): Promise<boolean> {
    return Bun.file(this.store.authFile).exists();
  }

  async nativeRuntimeRan(): Promise<boolean> {
    return Bun.file(this.tracePath).exists();
  }

  async readTrace(): Promise<FakeCodexAuthTrace> {
    return JSON.parse(await readFile(this.tracePath, 'utf8'));
  }

  // The temporary auth.json link that native Codex saw must be gone after every outcome.
  async assertNativeContextRemoved(): Promise<void> {
    const { codexHome } = await this.readTrace();
    assert.equal(await Bun.file(join(codexHome, 'auth.json')).exists(), false);
  }

  async assertLockAvailable(): Promise<void> {
    const lease = await CredentialLock.acquire(this.store, undefined, 200);
    await lease.release();
  }

  async assertLockHeld(): Promise<void> {
    await assert.rejects(CredentialLock.acquire(this.store, undefined, 50), {
      code: 'lock-timeout',
    });
  }

  // Holds the lock from another process until the returned child is killed.
  async startLockHolder(): Promise<ChildProcess> {
    const child = this.spawnHelper('lock-holder.ts', [JSON.stringify(this.store)]);
    await once(child.stdout!, 'data');
    return child;
  }

  async runLockWriters(writers: number, increments: number): Promise<void> {
    const children = Array.from({ length: writers }, () =>
      this.spawnHelper('lock-writer.ts', [JSON.stringify(this.store), String(increments)]),
    );
    const exitCodes = await Promise.all(
      children.map(async (child) => (await once(child, 'exit'))[0]),
    );
    assert.deepEqual(exitCodes, Array(writers).fill(0));
  }

  private spawnHelper(name: string, args: string[]): ChildProcess {
    const child = spawn(
      process.execPath,
      ['--no-env-file', '--no-install', helper(name), ...args],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    this.t.after(() => child.kill('SIGKILL'));
    return child;
  }
}

export async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

// Resolves once the service reports a login URL, i.e. native Codex is running under the lock.
export function loginUrlListener(): {
  onEvent: (event: AuthEvent) => void;
  reached: Promise<void>;
} {
  let resolve!: () => void;
  const reached = new Promise<void>((done) => (resolve = done));
  return {
    reached,
    onEvent: (event) => {
      if (event.type === 'login-url') resolve();
    },
  };
}
