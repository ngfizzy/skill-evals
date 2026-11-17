import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, statfs, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

import { ensureDirectory, isSameFile, readUpTo } from '../utils/index.ts';

import { AuthError } from './errors.ts';
import type { AuthState, AuthStoreLocation } from './types.ts';

export const MAX_CREDENTIAL_BYTES = 65_536;

const AUTH_FILE_NAME = 'auth.json';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

// statfs magic numbers for local filesystems. Network and FUSE mounts are rejected.
const DARWIN_LOCAL_FILESYSTEMS = [
  0x1a, // APFS
  0x11, // HFS+
];
const LINUX_LOCAL_FILESYSTEMS = [
  0xef53, // ext2/3/4
  0x1021994, // tmpfs
  0x794c7630, // overlayfs
  0x58465342, // XFS
  0x9123683e, // Btrfs
];

const chatgptCredentialsSchema = z.object({
  auth_mode: z.literal('chatgpt'),
  OPENAI_API_KEY: z.union([z.null(), z.literal('')]).optional(),
  tokens: z.object({
    id_token: z.string().min(1),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
  }),
});

export class AuthStore {
  constructor(readonly location: AuthStoreLocation) {}

  static async resolve(env: NodeJS.ProcessEnv = process.env): Promise<AuthStore> {
    const home = env.HOME || homedir();
    const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
    if (!isAbsolute(data) || !isAbsolute(home)) throw new AuthError('invalid-store');

    try {
      await mkdir(data, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      const application = join(await realpath(data), 'skill-evals');
      await ensureDirectory(application, PRIVATE_DIRECTORY_MODE);
      AuthStore.assertPrivateDirectory(await lstat(application));

      const directory = join(application, 'codex-auth');
      await ensureDirectory(directory, PRIVATE_DIRECTORY_MODE);

      const store = new AuthStore({
        directory,
        authFile: join(directory, AUTH_FILE_NAME),
        normalDirectory: resolve(env.CODEX_HOME || join(home, '.codex')),
      });
      await store.assertValid();
      return store;
    } catch {
      throw new AuthError('invalid-store');
    }
  }

  // Call only while the store lease is held. Token values never leave this boundary.
  async inspectCredentials(): Promise<AuthState> {
    await this.assertValid();

    let file: FileHandle;
    try {
      file = await open(
        this.location.authFile,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'signed-out';
      throw new AuthError('invalid-store');
    }

    try {
      const text = await this.readCredentialFile(file);
      if (!chatgptCredentialsSchema.safeParse(JSON.parse(text)).success)
        throw new AuthError('invalid-credentials');
      return 'signed-in';
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError('invalid-credentials');
    } finally {
      await file.close();
    }
  }

  async assertValid(): Promise<void> {
    try {
      const canonical = await realpath(this.location.directory);
      const normal = await realpath(this.location.normalDirectory).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return resolve(this.location.normalDirectory);
        },
      );
      if (
        canonical !== this.location.directory ||
        canonical === normal ||
        this.location.authFile !== join(canonical, AUTH_FILE_NAME)
      )
        throw new AuthError('invalid-store');
      AuthStore.assertPrivateDirectory(await lstat(canonical));

      const { type } = await statfs(canonical);
      const local =
        process.platform === 'darwin' ? DARWIN_LOCAL_FILESYSTEMS : LINUX_LOCAL_FILESYSTEMS;
      if (!local.includes(type >>> 0)) throw new AuthError('invalid-store');
    } catch {
      throw new AuthError('invalid-store');
    }
  }

  static assertPrivateDirectory(stat: Stats): void {
    if (!AuthStore.isOwnedWithMode(stat, PRIVATE_DIRECTORY_MODE) || !stat.isDirectory())
      throw new AuthError('invalid-store');
  }

  // A second hard link would let another path observe or replace the credentials.
  static assertPrivateFile(stat: Stats): void {
    if (!AuthStore.isOwnedWithMode(stat, PRIVATE_FILE_MODE) || !stat.isFile() || stat.nlink !== 1)
      throw new AuthError('invalid-store');
  }

  private static isOwnedWithMode(stat: Stats, mode: number): boolean {
    return (
      Boolean(process.getuid) && stat.uid === process.getuid!() && (stat.mode & 0o7777) === mode
    );
  }

  private async readCredentialFile(file: FileHandle): Promise<string> {
    const stat = await file.stat();
    AuthStore.assertPrivateFile(stat);
    if (stat.size > MAX_CREDENTIAL_BYTES) throw new AuthError('invalid-credentials');

    // Read one byte past the limit to catch a file that grew after stat.
    const contents = await readUpTo(file, MAX_CREDENTIAL_BYTES + 1);
    if (contents.length > MAX_CREDENTIAL_BYTES) throw new AuthError('invalid-credentials');

    if (!isSameFile(stat, await lstat(this.location.authFile)))
      throw new AuthError('invalid-store');

    return new TextDecoder('utf-8', { fatal: true }).decode(contents);
  }
}
