// Fake native Codex for auth tests. The launcher gives the native runtime fixed arguments and an
// allowlisted environment, so each test writes a tiny shim that calls runFakeCodexAuth with its
// scenario baked in. See AuthHarness.service().
import { spawn } from 'node:child_process';
import {
  fstatSync,
  openSync,
  closeSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

import { Libc } from '../../src/auth/credentials/libc.ts';
import { AUDITED_CODEX_VERSION_OUTPUT } from '../../src/adaptors/codex-helpers.ts';

export type FakeCodexAuthMode =
  | 'normal'
  // Login prints the URL in two writes, 50ms apart.
  | 'split-url'
  // Login prints a secret to stderr and exits 1.
  | 'failure'
  // Login writes credentials, then floods stdout past the output bound.
  | 'overflow'
  // Login writes credentials, then a byte that is not valid UTF-8.
  | 'invalid-utf8'
  // Login writes credentials, then never exits.
  | 'hang'
  // Login writes credentials, then never exits and leaves a child holding its pipes.
  | 'descendant'
  | 'writer-descendant'
  | 'late-credential-write'
  | 'blocked-cleanup'
  | 'kill-guardian'
  // Logout rewrites the credentials with different contents before unlinking its link.
  | 'replace-on-logout'
  // Logout swaps in a new inode with identical contents before unlinking its link.
  | 'replace-identical-on-logout';

export interface FakeCodexAuthTrace {
  codexHome: string;
  environment: string[];
  lockInode: number;
  nativeGroup: number;
  nativePid: number;
  guardian: number;
}

export const SYNTHETIC_CREDENTIALS = {
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: {
    id_token: 'synthetic-id',
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
  },
};
export const SYNTHETIC_LOGIN_URL =
  'https://auth.openai.com/oauth/authorize?response_type=code&state=synthetic';
export const LEAKED_DIAGNOSTIC = 'SYNTHETIC_CREDENTIAL_MUST_NOT_LEAK';

// The launcher passes the credential lease to native Codex as fd 3.
const INHERITED_LOCK_FD = 3;

export async function runFakeCodexAuth(
  mode: FakeCodexAuthMode,
  tracePath: string,
  store: string,
): Promise<void> {
  if (process.argv.includes('--version')) {
    console.log(AUDITED_CODEX_VERSION_OUTPUT);
    process.exit(0);
  }

  const authFile = join(process.env.CODEX_HOME!, 'auth.json');
  const ownership = JSON.parse(readFileSync(join(store, '.auth-context.json'), 'utf8'));

  writeTrace(tracePath, ownership.guardian);

  const operation = process.argv.at(-1);
  if (operation === 'login') await login(mode, authFile, tracePath, ownership);

  if (operation === 'logout') logout(mode, authFile);
}

function writeTrace(path: string, guardian: number): void {
  const trace: FakeCodexAuthTrace = {
    nativeGroup: Libc.load().processGroupId(),
    nativePid: process.pid,
    guardian,
    codexHome: process.env.CODEX_HOME!,
    environment: Object.keys(process.env),
    lockInode: fstatSync(INHERITED_LOCK_FD).ino,
  };

  writeFileSync(path, JSON.stringify(trace));
}

async function login(
  mode: FakeCodexAuthMode,
  authFile: string,
  tracePath: string,
  ownership: { guardian: number; workspace: string },
): Promise<void> {
  // Codex 0.165.0 logs out before starting OAuth, which unlinks an existing auth.json.
  try {
    unlinkSync(authFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await printLoginUrl(mode);
  if (mode === 'failure') {
    console.error(LEAKED_DIAGNOSTIC);
    process.exit(1);
  }

  writeFileSync(authFile, JSON.stringify(SYNTHETIC_CREDENTIALS), { mode: 0o600 });

  if (mode === 'late-credential-write') {
    await leaveLateCredentialWriter(authFile, ownership.guardian);
    process.exit(0);
  }

  if (mode === 'writer-descendant') {
    const writes = join(dirname(tracePath), 'descendant-writes');
    const descriptor = openSync(authFile, 'r+');

    spawn(
      process.execPath,
      [
        '--no-env-file',
        '-e',
        `const fs = require('node:fs');
      const data = Buffer.from(${JSON.stringify(JSON.stringify(SYNTHETIC_CREDENTIALS))});
      setInterval(() => {
        fs.writeSync(4, data, 0, data.length, 0);
        fs.appendFileSync(${JSON.stringify(writes)}, 'w');
      }, 1);`,
      ],
      { stdio: ['ignore', 'inherit', 'ignore', 'ignore', descriptor] },
    );
    closeSync(descriptor);

    while (!existsSync(writes)) await Bun.sleep(5);

    await Bun.sleep(100);

    writeSync(1, Buffer.from([0xff]));
    return stayAlive();
  }

  if (mode === 'kill-guardian') {
    if (!Number.isSafeInteger(ownership.guardian) || ownership.guardian <= 1) process.exit(2);
    process.kill(ownership.guardian, 'SIGKILL');
    process.exit(0);
  }

  if (mode === 'blocked-cleanup') {
    const { workspace } = ownership;
    renameSync(workspace, workspace + '.moved');
    process.exit(0);
  }

  switch (mode) {
    case 'overflow':
      writeSync(1, 'x'.repeat(2_100_000));
      break;
    case 'invalid-utf8':
      writeSync(1, Buffer.from([0xff]));
      break;
    case 'descendant':
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      return stayAlive();
    case 'hang':
      return stayAlive();
  }

  process.exit(0);
}

async function printLoginUrl(mode: FakeCodexAuthMode): Promise<void> {
  if (mode !== 'split-url') return console.log(SYNTHETIC_LOGIN_URL);

  const url = Buffer.from(SYNTHETIC_LOGIN_URL.replace('synthetic', 'synthétic'));
  const splitAt = url.indexOf(0xc3) + 1;

  process.stderr.write(url.subarray(0, splitAt));
  await Bun.sleep(50);
  process.stderr.write(Buffer.concat([url.subarray(splitAt), Buffer.from('\n')]));
}

async function leaveLateCredentialWriter(authFile: string, guardian: number): Promise<void> {
  const workerHome = process.env.HOME!;
  const descriptor = openSync(authFile, 'r+');

  try {
    const writer = spawn(
      process.execPath,
      [
        '--no-env-file',
        '-e',
        `const fs = require('node:fs');
        process.kill(${JSON.stringify(guardian)}, 'SIGSTOP');
        console.log('paused');
        try {
          const deadline = Date.now() + 5000;
          while (fs.existsSync(${JSON.stringify(workerHome)}) && Date.now() < deadline) {
            await Bun.sleep(5);
          }
          if (fs.existsSync(${JSON.stringify(workerHome)})) process.exitCode = 1;
          else {
            fs.ftruncateSync(4, 0);
            fs.writeSync(4, 'invalid-after-worker-check');
          }
        } finally {
          process.kill(${JSON.stringify(guardian)}, 'SIGCONT');
        }`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore', 'ignore', descriptor] },
    );
    await new Promise<void>((resolve, reject) => {
      writer.stdout!.once('data', () => resolve());
      writer.once('exit', () => reject(new Error('Late writer exited before pausing guardian')));
      writer.once('error', reject);
    });
  } finally {
    closeSync(descriptor);
  }
}

function logout(mode: FakeCodexAuthMode, authFile: string): void {
  if (mode === 'replace-on-logout')
    writeFileSync(authFile, JSON.stringify({ ...SYNTHETIC_CREDENTIALS, extra: 'changed' }));

  if (mode === 'replace-identical-on-logout') replaceWithIdenticalCopy(realpathSync(authFile));

  unlinkSync(authFile);

  process.exit(0);
}

function replaceWithIdenticalCopy(path: string): void {
  const replacement = `${path}.replacement`;
  writeFileSync(replacement, readFileSync(path), { mode: 0o600 });
  renameSync(replacement, path);
}

function stayAlive(): void {
  setInterval(() => {}, 1000);
}
