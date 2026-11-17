import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  link,
  lstat,
  mkdir,
  rm,
  symlink,
  writeFile,
  rename,
  readFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spyOn } from 'bun:test';

import { AuthError, type AuthErrorCode } from '../src/auth/index.ts';
import { AuthCleanup } from '../src/auth/cleanup.ts';
import { createAuthContext } from '../src/auth/context.ts';
import { LauncherEventReader } from '../src/auth/events.ts';
import { CredentialLock } from '../src/auth/lock.ts';
import { AuthLauncherJob } from '../src/auth/operations.ts';
import { loginUrl, readAuthRequest } from '../src/auth/protocol.ts';
import { AuthStore } from '../src/auth/store.ts';

import { AuthHarness, killAndWait, loginUrlListener } from './helpers/auth-harness.ts';
import {
  LEAKED_DIAGNOSTIC,
  SYNTHETIC_CREDENTIALS,
  SYNTHETIC_LOGIN_URL,
  type FakeCodexAuthMode,
} from './helpers/fake-codex-auth.ts';

const authError = (code: AuthErrorCode) => ({ name: 'AuthError', code });

describe('AuthStore.resolve', () => {
  test('creates an owner-only store directory', async (t) => {
    const auth = await AuthHarness.create(t);

    assert.equal((await lstat(auth.store.directory)).mode & 0o777, 0o700);
  });

  test('rejects a store that is also the personal Codex home', async (t) => {
    const auth = await AuthHarness.create(t);

    await assert.rejects(
      AuthStore.resolve({ ...auth.env, CODEX_HOME: auth.store.directory }),
      authError('invalid-store'),
    );
  });

  test('rejects a store directory that other users can read', async (t) => {
    const auth = await AuthHarness.create(t);
    await chmod(auth.store.directory, 0o755);

    await assert.rejects(AuthStore.resolve(auth.env), authError('invalid-store'));
  });

  test('rejects a store directory replaced by a symlink', async (t) => {
    const auth = await AuthHarness.create(t);
    const elsewhere = join(auth.root, 'elsewhere');
    await mkdir(elsewhere, { mode: 0o700 });
    await rm(auth.store.directory, { recursive: true });
    await symlink(elsewhere, auth.store.directory);

    await assert.rejects(AuthStore.resolve(auth.env), authError('invalid-store'));
  });
});

describe('AuthStore.inspectCredentials', () => {
  test('reports signed-out when no credentials exist', async (t) => {
    const auth = await AuthHarness.create(t);

    assert.equal(await auth.authStore.inspectCredentials(), 'signed-out');
  });

  test('reports signed-in for a ChatGPT login', async (t) => {
    const auth = await AuthHarness.create(t);
    await auth.signIn();

    assert.equal(await auth.authStore.inspectCredentials(), 'signed-in');
  });

  const invalidCredentials: [string, string][] = [
    ['malformed JSON', 'invalid'],
    ['an API key', JSON.stringify({ ...SYNTHETIC_CREDENTIALS, OPENAI_API_KEY: 'SYNTHETIC_KEY' })],
  ];
  for (const [description, contents] of invalidCredentials)
    test(`rejects credentials containing ${description}`, async (t) => {
      const auth = await AuthHarness.create(t);
      await writeFile(auth.store.authFile, contents, { mode: 0o600 });

      await assert.rejects(auth.authStore.inspectCredentials(), authError('invalid-credentials'));
    });

  test('rejects a credentials file that other users can read', async (t) => {
    const auth = await AuthHarness.create(t);
    await auth.signIn();
    await chmod(auth.store.authFile, 0o644);

    await assert.rejects(auth.authStore.inspectCredentials(), authError('invalid-store'));
  });

  test('rejects a credentials file with a second hard link', async (t) => {
    const auth = await AuthHarness.create(t);
    await auth.signIn();
    await link(auth.store.authFile, join(auth.root, 'second-link'));

    await assert.rejects(auth.authStore.inspectCredentials(), authError('invalid-store'));
  });

  test('rejects a credentials file replaced by a symlink', async (t) => {
    const auth = await AuthHarness.create(t);
    const elsewhere = join(auth.root, 'elsewhere.json');
    await writeFile(elsewhere, JSON.stringify(SYNTHETIC_CREDENTIALS), { mode: 0o600 });
    await symlink(elsewhere, auth.store.authFile);

    await assert.rejects(auth.authStore.inspectCredentials(), authError('invalid-store'));
  });
});

describe('createAuthContext', () => {
  test('gives native Codex only the allowlisted environment', async (t) => {
    const auth = await AuthHarness.create(t);
    const context = await createAuthContext(auth.store, auth.root);
    t.after(() => context.dispose());

    assert.deepEqual(Object.keys(context.env).sort(), [
      'CODEX_HOME',
      'HOME',
      'PATH',
      'TMPDIR',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
    ]);
    assert.notEqual(context.env.HOME, auth.home);
  });

  test('links auth.json to the managed store', async (t) => {
    const auth = await AuthHarness.create(t);
    const context = await createAuthContext(auth.store, auth.root);
    t.after(() => context.dispose());

    await context.verifyLink();
  });

  test('dispose removes the link but keeps the stored credentials', async (t) => {
    const auth = await AuthHarness.create(t);
    await auth.signIn();
    const context = await createAuthContext(auth.store, auth.root);

    await context.dispose();

    assert.equal(await Bun.file(join(context.codexHome, 'auth.json')).exists(), false);
    assert.equal(await auth.authStore.inspectCredentials(), 'signed-in');
  });
});

describe('cleanup ownership', () => {
  test('a failed guardian spawn removes the starting record while the launcher owns the lease', async (t) => {
    const auth = await AuthHarness.create(t);
    const workspace = join(auth.root, 'failed spawn');
    await mkdir(workspace, { mode: 0o700 });
    const missing = join(workspace, 'nonexistent-executable');
    const failedChild = new childProcess.ChildProcess();
    Object.defineProperty(failedChild, 'stdout', { value: new PassThrough() });
    const guardianSpawn = spyOn(childProcess, 'spawn').mockImplementation((() => {
      const error = Object.assign(new Error('spawn failed'), { code: 'EAGAIN' });
      queueMicrotask(() => failedChild.emit('error', error));
      return failedChild;
    }) as typeof childProcess.spawn);
    try {
      const requested = {
        operation: 'login' as const,
        store: auth.store,
        nativeExecutable: missing,
        timeoutMs: 1000,
        lockWaitMs: 1000,
        workspace,
      };
      await assert.rejects(
        AuthLauncherJob.run(requested, () => {}),
        authError('operation-failed'),
      );
      assert.equal(guardianSpawn.mock.calls.length, 1);
    } finally {
      guardianSpawn.mockRestore();
    }
    assert.equal(await AuthCleanup.pending(auth.store), false);
    await assert.rejects(lstat(workspace), { code: 'ENOENT' });
    assert.equal(await (await auth.service()).execute('status'), 'signed-out');
  });

  test('an unlaunched guardian can be recovered while another caller waits for status', async (t) => {
    const auth = await AuthHarness.create(t);
    const workspace = join(auth.root, 'startup');
    await mkdir(workspace, { mode: 0o700 });
    const launcher = await CredentialLock.acquire(auth.store);
    try {
      await AuthCleanup.begin(auth.store, workspace);
      await AuthCleanup.prepareGuardian(auth.store, workspace);
      await assert.rejects(
        CredentialLock.recoverUnclaimed(auth.store, workspace),
        authError('cleanup-required'),
      );
    } finally {
      await launcher.release();
    }

    const service = await auth.service();
    const status = service.execute('status');
    await Bun.sleep(200);
    await CredentialLock.recoverUnclaimed(auth.store, workspace);

    assert.equal(await status, 'signed-out');
    assert.equal(await AuthCleanup.pending(auth.store), false);
    await assert.rejects(lstat(workspace), { code: 'ENOENT' });
  });

  test('a relocated workspace keeps the store blocked until its auth link is removed', async (t) => {
    const auth = await AuthHarness.create(t);
    await auth.signIn();
    const workspace = join(auth.root, 'operation');
    const moved = join(auth.root, 'moved');
    await mkdir(workspace, { mode: 0o700 });
    const lease = await CredentialLock.acquire(auth.store);
    const context = await createAuthContext(auth.store, workspace);
    await rename(workspace, moved);
    await mkdir(workspace, { mode: 0o700 });
    await lease.release();

    await assert.rejects(AuthCleanup.finish(auth.store, workspace), authError('cleanup-required'));
    const link = join(moved, context.directory.slice(workspace.length), 'codex', 'auth.json');
    assert.equal(await readFile(link, 'utf8'), JSON.stringify(SYNTHETIC_CREDENTIALS));
    await assert.rejects(
      CredentialLock.acquire(auth.store, undefined, 50),
      authError('cleanup-required'),
    );

    await rm(workspace, { recursive: true });
    await rename(moved, workspace);
    await AuthCleanup.finish(auth.store, workspace);
    await auth.assertLockAvailable();
    assert.equal(await auth.authStore.inspectCredentials(), 'signed-in');
  });

  test('failed auth-link removal blocks the next lease until parent cleanup removes the link', async (t) => {
    const auth = await AuthHarness.create(t);
    await auth.signIn();
    const workspace = join(auth.root, 'operation');
    await mkdir(workspace, { mode: 0o700 });
    const lease = await CredentialLock.acquire(auth.store);
    const context = await createAuthContext(auth.store, workspace);
    const retained = join(context.directory, 'retained-codex');
    await rename(context.codexHome, retained);
    await writeFile(context.codexHome, 'obstruction', { mode: 0o600 });

    await assert.rejects(context.dispose());
    await lease.release();
    assert.equal(
      await readFile(join(retained, 'auth.json'), 'utf8'),
      JSON.stringify(SYNTHETIC_CREDENTIALS),
    );
    await assert.rejects(
      CredentialLock.acquire(auth.store, undefined, 50),
      authError('cleanup-required'),
    );

    await AuthCleanup.finish(auth.store, workspace);
    await auth.assertLockAvailable();
    assert.equal(await auth.authStore.inspectCredentials(), 'signed-in');
  });

  test('a cleanup waiter can cancel while another operation owns the pending record', async (t) => {
    const auth = await AuthHarness.create(t);
    const workspace = join(auth.root, 'operation');
    await mkdir(workspace, { mode: 0o700 });
    await AuthCleanup.begin(auth.store, workspace);
    const controller = new AbortController();
    const waiting = CredentialLock.acquire(auth.store, controller.signal, 1000);
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(waiting, authError('interrupted'));
    await AuthCleanup.finish(auth.store, workspace);
    await auth.assertLockAvailable();
  });
});

describe('CredentialLock', () => {
  test('times out while another process holds the lock', async (t) => {
    const auth = await AuthHarness.create(t);
    await auth.startLockHolder();

    await auth.assertLockHeld();
  });

  test('becomes available when the holding process dies', async (t) => {
    const auth = await AuthHarness.create(t);
    await killAndWait(await auth.startLockHolder());

    await auth.assertLockAvailable();
  });

  test('stops waiting when the signal is already aborted', async (t) => {
    const auth = await AuthHarness.create(t);

    await assert.rejects(
      CredentialLock.acquire(auth.store, AbortSignal.abort()),
      authError('interrupted'),
    );
  });

  test('stays held by a child that inherited the descriptor after release', async (t) => {
    const auth = await AuthHarness.create(t);
    const lease = await CredentialLock.acquire(auth.store, undefined, 200);
    const child = childProcess.spawn(
      process.execPath,
      ['-e', 'console.log("READY");setInterval(()=>{},1000)'],
      {
        stdio: ['ignore', 'pipe', 'inherit', lease.fd],
      },
    );
    t.after(() => child.kill('SIGKILL'));
    await once(child.stdout!, 'data');

    await lease.release();
    await auth.assertLockHeld();

    await killAndWait(child);
    await auth.assertLockAvailable();
  });

  test('refuses a lock file replaced by a symlink', async (t) => {
    const auth = await AuthHarness.create(t);
    const target = join(auth.root, 'lock-target');
    await writeFile(target, '', { mode: 0o600 });
    await symlink(target, auth.lockFile);

    await assert.rejects(CredentialLock.acquire(auth.store), authError('lock-failed'));
  });

  test('refuses a lock file with a second hard link', async (t) => {
    const auth = await AuthHarness.create(t);
    const target = join(auth.root, 'lock-target');
    await writeFile(target, '', { mode: 0o600 });
    await link(target, auth.lockFile);

    await assert.rejects(CredentialLock.acquire(auth.store), authError('invalid-store'));
  });

  test('serializes concurrent updates from eight processes', async (t) => {
    const auth = await AuthHarness.create(t);
    await auth.signIn({ ...SYNTHETIC_CREDENTIALS, counter: 0 });

    await auth.runLockWriters(8, 20);

    assert.deepEqual(await auth.readCredentials(), { ...SYNTHETIC_CREDENTIALS, counter: 160 });
  });
});

describe('loginUrl', () => {
  const cases: [string, string, string | undefined][] = [
    ['accepts the native authorize route', SYNTHETIC_LOGIN_URL, SYNTHETIC_LOGIN_URL],
    ['rejects another origin', 'https://evil.example/oauth/authorize', undefined],
    [
      'rejects unexpected query parameters',
      'https://auth.openai.com/oauth/authorize?access_token=secret',
      undefined,
    ],
  ];
  for (const [description, text, expected] of cases)
    test(description, () => {
      assert.equal(loginUrl(text), expected);
    });
});

describe('LauncherEventReader', () => {
  const line = (event: object) => Buffer.from(`${JSON.stringify(event)}\n`);
  const signedIn = line({ type: 'state', state: 'signed-in' });

  test('returns the reported state once events arrive split across chunks', () => {
    const reader = new LauncherEventReader();

    reader.consume(signedIn.subarray(0, 10));
    reader.consume(signedIn.subarray(10));

    assert.equal(reader.finalState(), 'signed-in');
  });

  test('reports an error event to the listener, then throws its code', () => {
    const seen: string[] = [];
    const reader = new LauncherEventReader((event) => seen.push(event.type));

    assert.throws(
      () => reader.consume(line({ type: 'error', code: 'lock-timeout' })),
      authError('lock-timeout'),
    );
    assert.deepEqual(seen, ['error']);
    assert.throws(() => reader.finalState(), authError('lock-timeout'));
  });

  test('rejects output that never reports a state', () => {
    const reader = new LauncherEventReader();

    reader.consume(line({ type: 'login-url', url: SYNTHETIC_LOGIN_URL }));

    assert.throws(() => reader.finalState(), authError('operation-failed'));
  });

  test('rejects an unterminated trailing line', () => {
    const reader = new LauncherEventReader();

    reader.consume(Buffer.concat([signedIn, Buffer.from('{"type"')]));

    assert.throws(() => reader.finalState(), authError('operation-failed'));
  });

  test('rejects invalid UTF-8 as malformed output', () => {
    const reader = new LauncherEventReader();

    assert.throws(() => reader.consume(Buffer.from([0xff, 0x0a])), authError('operation-failed'));
  });

  test('rejects output that ends inside a multi-byte character', () => {
    const reader = new LauncherEventReader();

    reader.consume(Buffer.concat([signedIn, Buffer.from('é').subarray(0, 1)]));

    assert.throws(() => reader.finalState(), authError('operation-failed'));
  });
});

test('launcher request preserves a split UTF-8 character and rejects an incomplete one', async () => {
  const request = {
    operation: 'login',
    store: { directory: '/store', authFile: '/store/auth.json', normalDirectory: '/normal' },
    nativeExecutable: '/bin/codex',
    workspace: '/path with spacé',
    timeoutMs: 1000,
    lockWaitMs: 1000,
  };
  const bytes = Buffer.from(JSON.stringify(request));
  const splitAt = bytes.indexOf(0xc3) + 1;
  async function* chunks(complete: boolean) {
    yield bytes.subarray(0, splitAt);
    if (complete) yield bytes.subarray(splitAt);
  }

  assert.deepEqual(await readAuthRequest(chunks(true)), request);
  await assert.rejects(readAuthRequest(chunks(false)), authError('operation-failed'));
});

describe('AuthService', () => {
  test('status reports signed-out for an empty store', async (t) => {
    const auth = await AuthHarness.create(t);
    const service = await auth.service();

    assert.equal(await service.execute('status'), 'signed-out');
  });

  test('status reports signed-in for stored credentials', async (t) => {
    const auth = await AuthHarness.create(t);
    await auth.signIn();
    const service = await auth.service();

    assert.equal(await service.execute('status'), 'signed-in');
  });

  test('login reports the login URL, then the signed-in state', async (t) => {
    const auth = await AuthHarness.create(t);
    const service = await auth.service();
    const events: string[] = [];

    const state = await service.execute('login', { onEvent: (event) => events.push(event.type) });

    assert.equal(state, 'signed-in');
    assert.deepEqual(events, ['login-url', 'state']);
    assert.equal(await auth.authStore.inspectCredentials(), 'signed-in');
  });

  test('login runs native Codex isolated, under the inherited lock, and cleans up', async (t) => {
    const auth = await AuthHarness.create(t);
    const service = await auth.service();

    await service.execute('login');

    const trace = await auth.readTrace();
    assert.ok(!trace.environment.includes('CODEX_API_KEY'));
    assert.ok(!trace.environment.includes('CODEX_REFRESH_TOKEN_URL_OVERRIDE'));
    assert.equal(trace.lockInode, (await lstat(auth.lockFile)).ino);
    await auth.assertNativeContextRemoved();
  });

  test('login announces a URL with split UTF-8 from stderr once its line is complete', async (t) => {
    const auth = await AuthHarness.create(t);
    const service = await auth.service('split-url');
    const urls: string[] = [];

    await service.execute('login', {
      onEvent: (event) => {
        if (event.type === 'login-url') urls.push(event.url);
      },
    });

    assert.deepEqual(urls, [SYNTHETIC_LOGIN_URL.replace('synthetic', 'synth%C3%A9tic')]);
  });

  test('login rejects staged credentials changed after the worker completed', async (t) => {
    const auth = await AuthHarness.create(t);
    await auth.signIn();
    const service = await auth.service('late-credential-write');
    const states: string[] = [];

    await assert.rejects(
      service.execute('login', {
        onEvent: (event) => {
          if (event.type === 'state') states.push(event.state);
        },
      }),
      authError('invalid-credentials'),
    );

    assert.deepEqual(states, []);
    assert.deepEqual(await auth.readCredentials(), SYNTHETIC_CREDENTIALS);
    await auth.assertNativeContextRemoved();
    await auth.assertLockAvailable();
  });

  test('guardian recovers the starting record when its expected launcher is gone', async (t) => {
    const auth = await AuthHarness.create(t);
    const workspace = join(auth.root, 'interrupted workspace');
    await mkdir(workspace, { mode: 0o700 });
    const lease = await CredentialLock.acquire(auth.store);
    try {
      await AuthCleanup.begin(auth.store, workspace);
      await AuthCleanup.prepareGuardian(auth.store, workspace);
      const script = fileURLToPath(new URL('../src/auth/guardian.ts', import.meta.url));
      const child = childProcess.spawn(
        process.execPath,
        [
          '--no-env-file',
          '--no-install',
          script,
          JSON.stringify({
            operation: 'login',
            store: auth.store,
            nativeExecutable: '/missing/native',
            timeoutMs: 1000,
            lockWaitMs: 1000,
            workspace,
          }),
          // A guardian launched by this test can observe the parent mismatch without signaling it.
          String(process.pid + 1),
        ],
        { stdio: ['ignore', 'pipe', 'inherit', lease.fd] },
      );
      t.after(() => killAndWait(child));
      const [code] = await once(child, 'close', { signal: AbortSignal.timeout(5000) });
      assert.equal(code, 2);
      assert.equal(await AuthCleanup.pending(auth.store), false);
      await assert.rejects(lstat(workspace), { code: 'ENOENT' });
    } finally {
      await lease.release();
    }
    assert.equal(await (await auth.service()).execute('status'), 'signed-out');
  });

  test('login failure keeps native diagnostics out of the error', async (t) => {
    const auth = await AuthHarness.create(t);
    const service = await auth.service('failure');

    await assert.rejects(service.execute('login'), (error) => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.code, 'operation-failed');
      assert.ok(!String(error).includes(LEAKED_DIAGNOSTIC));
      return true;
    });
  });

  const misbehavingRuntimes: [FakeCodexAuthMode, string][] = [
    ['overflow', 'floods its output'],
    ['invalid-utf8', 'writes invalid UTF-8'],
    ['descendant', 'leaves a descendant holding its pipes'],
  ];
  for (const [mode, behavior] of misbehavingRuntimes)
    test(`login stops promptly when native Codex ${behavior}`, async (t) => {
      const auth = await AuthHarness.create(t);
      const service = await auth.service(mode, { timeoutMs: 1000 });
      const started = performance.now();

      await assert.rejects(service.execute('login'), AuthError);

      // Leave room for emulated Linux startup; never wait for the 120-second outer fallback.
      assert.ok(performance.now() - started < 10_000, `${mode} did not stop promptly`);
      await auth.assertNativeContextRemoved();
      await auth.assertLockAvailable();
    });

  test('a queued caller cannot enter while a descendant retains a writable credential handle', async (t) => {
    const auth = await AuthHarness.create(t);
    const service = await auth.service('writer-descendant');
    const observerPath = fileURLToPath(new URL('./helpers/lock-observer.ts', import.meta.url));
    let observer: ReturnType<typeof childProcess.spawn> | undefined;
    let observed: Promise<number | null> | undefined;
    await assert.rejects(
      service.execute('login', {
        onEvent(event) {
          if (event.type === 'login-url') {
            observer = childProcess.spawn(
              process.execPath,
              [
                '--no-env-file',
                observerPath,
                JSON.stringify(auth.store),
                join(auth.root, 'descendant-writes'),
              ],
              { stdio: 'inherit' },
            );
            observed = new Promise((resolve, reject) => {
              observer!.once('exit', resolve);
              observer!.once('error', reject);
            });
            t.after(() => observer?.kill('SIGKILL'));
          }
          // Delay the parent's error handling. The launcher can exit while this callback runs,
          // so a separate application process can observe any premature lease release.
          if (event.type === 'error') {
            const until = performance.now() + 500;
            while (performance.now() < until) {
              /* intentionally delay parent teardown */
            }
          }
        },
      }),
      authError('operation-failed'),
    );
    assert.ok(observed);
    assert.equal(await observed, 0);
    await auth.assertLockAvailable();
    await auth.assertNativeContextRemoved();
  });

  test('cleanup failure retains the actual OS lock until the original workspace is recovered', async (t) => {
    const auth = await AuthHarness.create(t);
    const service = await auth.service('blocked-cleanup');
    let workspace: string | undefined;
    try {
      await assert.rejects(service.execute('login'), authError('cleanup-required'));
      const record = JSON.parse(
        await readFile(join(auth.store.directory, '.auth-context.json'), 'utf8'),
      );
      workspace = record.workspace;
      assert.ok(workspace);
      assert.ok(record.guardian > 0);
      await assert.rejects(
        CredentialLock.acquire(auth.store, undefined, 50),
        authError('lock-timeout'),
      );
    } finally {
      if (!workspace) {
        const record = JSON.parse(
          await readFile(join(auth.store.directory, '.auth-context.json'), 'utf8'),
        );
        workspace = record.workspace;
      }
      await rename(workspace + '.moved', workspace!);
      const lease = await CredentialLock.acquire(auth.store, undefined, 5000);
      await lease.release();
    }
    assert.equal(await AuthCleanup.pending(auth.store), false);
    await auth.assertNativeContextRemoved();
  });

  test('a killed guardian leaves a recovery record that blocks store reuse', async (t) => {
    const auth = await AuthHarness.create(t);
    const service = await auth.service('kill-guardian');
    await assert.rejects(service.execute('login'), authError('cleanup-required'));
    const path = join(auth.store.directory, '.auth-context.json');
    const record = JSON.parse(await readFile(path, 'utf8'));
    await assert.rejects(
      CredentialLock.acquire(auth.store, undefined, 50),
      authError('cleanup-required'),
    );

    // Explicit recovery of this synthetic operation, whose group has already been drained.
    await rm(record.workspace, { recursive: true, force: true });
    await rm(path);
    await auth.assertLockAvailable();
  });

  test('logout deletes the stored credentials', async (t) => {
    const auth = await AuthHarness.create(t);
    await auth.signIn();
    const service = await auth.service();

    assert.equal(await service.execute('logout'), 'signed-out');
    assert.equal(await auth.credentialsExist(), false);
  });

  test('logout when already signed out does nothing', async (t) => {
    const auth = await AuthHarness.create(t);
    const service = await auth.service();

    assert.equal(await service.execute('logout'), 'signed-out');
    assert.equal(await auth.nativeRuntimeRan(), false);
  });

  test('logout keeps credentials whose contents changed during logout', async (t) => {
    const auth = await AuthHarness.create(t);
    await auth.signIn();
    const service = await auth.service('replace-on-logout');

    await assert.rejects(service.execute('logout'), authError('invalid-store'));

    assert.equal(await auth.authStore.inspectCredentials(), 'signed-in');
  });

  test('logout keeps credentials replaced by an identical copy during logout', async (t) => {
    const auth = await AuthHarness.create(t);
    await auth.signIn();
    const original = await lstat(auth.store.authFile);
    const service = await auth.service('replace-identical-on-logout');

    await assert.rejects(service.execute('logout'), authError('invalid-store'));

    assert.notEqual((await lstat(auth.store.authFile)).ino, original.ino);
    assert.deepEqual(await auth.readCredentials(), SYNTHETIC_CREDENTIALS);
  });

  test('parent loss stops the worker group pinned to the live guardian PID before unlocking', async (t) => {
    const auth = await AuthHarness.create(t);
    const service = await auth.service('hang');
    const controller = new AbortController();

    const login = service.execute('login', {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'login-url') controller.abort();
      },
    });

    await assert.rejects(login, authError('interrupted'));
    const trace = await auth.readTrace();
    assert.equal(trace.nativeGroup, trace.guardian);
    assert.notEqual(trace.nativePid, trace.guardian);
    await auth.assertNativeContextRemoved();
    await auth.assertLockAvailable();
  });

  test('cancelling an operation queued on the lock never starts native Codex', async (t) => {
    const auth = await AuthHarness.create(t);
    const lease = await CredentialLock.acquire(auth.store);
    t.after(() => lease.release());
    const service = await auth.service('normal', { lockWaitMs: 2000 });
    const controller = new AbortController();

    const login = service.execute('login', { signal: controller.signal });
    // Give the launcher time to start waiting on the held lock.
    await Bun.sleep(100);
    controller.abort();

    await assert.rejects(login, authError('interrupted'));
    assert.equal(await auth.nativeRuntimeRan(), false);
  });

  test('logout waits for an in-progress login to finish', async (t) => {
    const auth = await AuthHarness.create(t);
    const hangingLogin = await auth.service('hang');
    const service = await auth.service('normal', { lockWaitMs: 2000 });
    const controller = new AbortController();
    const listener = loginUrlListener();

    const login = hangingLogin.execute('login', {
      signal: controller.signal,
      onEvent: listener.onEvent,
    });
    await listener.reached;
    let logoutSettled = false;
    const logout = service.execute('logout').finally(() => (logoutSettled = true));
    // Give logout time to run if it were not blocked by the login's lock.
    await Bun.sleep(100);

    assert.equal(logoutSettled, false);
    controller.abort();
    await assert.rejects(login, authError('interrupted'));
    assert.equal(await logout, 'signed-out');
  });
});
