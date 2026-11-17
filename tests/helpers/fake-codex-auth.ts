// Fake native Codex for auth tests. The launcher gives the native runtime fixed arguments and an
// allowlisted environment, so each test writes a tiny shim that calls runFakeCodexAuth with its
// scenario baked in. See AuthHarness.service().
import { spawn } from 'node:child_process';
import {
  fstatSync,
  readlinkSync,
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

import { Libc } from '../../src/auth/libc.ts';
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

export async function runFakeCodexAuth(mode: FakeCodexAuthMode, tracePath: string): Promise<void> {
  if (process.argv.includes('--version')) {
    console.log(AUDITED_CODEX_VERSION_OUTPUT);
    process.exit(0);
  }

  const authFile = join(process.env.CODEX_HOME!, 'auth.json');
  writeTrace(tracePath);

  const operation = process.argv.at(-1);
  if (operation === 'login') await login(mode, authFile, tracePath);
  if (operation === 'logout') logout(mode, authFile);
}

function writeTrace(path: string): void {
  const store = dirname(readlinkSync(join(process.env.CODEX_HOME!, 'auth.json')));
  const ownership = JSON.parse(readFileSync(join(store, '.auth-context.json'), 'utf8'));
  const trace: FakeCodexAuthTrace = {
    nativeGroup: Libc.load().processGroupId(),
    nativePid: process.pid,
    guardian: ownership.guardian,
    codexHome: process.env.CODEX_HOME!,
    environment: Object.keys(process.env),
    lockInode: fstatSync(INHERITED_LOCK_FD).ino,
  };
  writeFileSync(path, JSON.stringify(trace));
}

async function login(mode: FakeCodexAuthMode, authFile: string, tracePath: string): Promise<void> {
  await printLoginUrl(mode);
  if (mode === 'failure') {
    console.error(LEAKED_DIAGNOSTIC);
    process.exit(1);
  }

  writeFileSync(authFile, JSON.stringify(SYNTHETIC_CREDENTIALS), { mode: 0o600 });

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
    const store = dirname(realpathSync(authFile));
    const record = JSON.parse(readFileSync(join(store, '.auth-context.json'), 'utf8'));
    if (!Number.isSafeInteger(record.guardian) || record.guardian <= 1) process.exit(2);
    process.kill(record.guardian, 'SIGKILL');
    process.exit(0);
  }

  if (mode === 'blocked-cleanup') {
    const workspace = dirname(dirname(process.env.CODEX_HOME!));
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

  const splitAt = SYNTHETIC_LOGIN_URL.indexOf('synthetic');
  process.stdout.write(SYNTHETIC_LOGIN_URL.slice(0, splitAt));
  await Bun.sleep(50);
  console.log(SYNTHETIC_LOGIN_URL.slice(splitAt));
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
