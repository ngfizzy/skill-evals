import { mkdtemp, mkdir, readlink, rm, symlink, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { AuthCleanup } from './cleanup.ts';
import { AuthError } from './errors.ts';
import { AuthStore } from './store.ts';
import type { AuthStoreLocation } from './types.ts';

export const SYSTEM_PATH = '/usr/bin:/bin';

export interface NativeAuthContext {
  directory: string;
  home: string;
  codexHome: string;
  env: NodeJS.ProcessEnv;
  dispose(): Promise<void>;
}

export interface AuthContext extends NativeAuthContext {
  verifyLink(missingAllowed?: boolean): Promise<void>;
}

// Native login can remove and recreate auth.json. Keep its new file in the
// operation workspace until its guardian has stopped and verified all writers.
export function stagedLoginStore(store: AuthStoreLocation, workspace: string): AuthStore {
  const directory = join(workspace, 'login-codex');
  return new AuthStore({ ...store, directory, authFile: join(directory, 'auth.json') });
}

export async function createLoginContext(
  store: AuthStoreLocation,
  workspace: string,
): Promise<NativeAuthContext> {
  await new AuthStore(store).assertValid();
  await AuthCleanup.begin(store, workspace);
  const directory = await mkdtemp(join(workspace, 'context-'));
  const home = join(directory, 'home');
  const codexHome = stagedLoginStore(store, workspace).location.directory;
  await mkdir(home, { mode: 0o700 });
  await mkdir(codexHome, { mode: 0o700 });
  return {
    directory,
    home,
    codexHome,
    env: isolatedEnvironment(directory, home, codexHome),
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// The caller owns the credential lease for this context's complete lifetime.
export async function createAuthContext(
  store: AuthStoreLocation,
  workspace: string,
): Promise<AuthContext> {
  await new AuthStore(store).assertValid();

  await AuthCleanup.begin(store, workspace);
  const directory = await mkdtemp(join(workspace, 'context-'));
  const home = join(directory, 'home');
  const codexHome = join(directory, 'codex');
  const link = join(codexHome, 'auth.json');
  const dispose = async () => {
    await unlink(link).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await lstat(link).then(
      () => {
        throw new AuthError('cleanup-required');
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
    await rm(directory, { recursive: true, force: true });
  };

  try {
    for (const folder of [home, codexHome]) await mkdir(folder, { mode: 0o700 });
    await symlink(store.authFile, link);
  } catch {
    await dispose();
    throw new AuthError('operation-failed');
  }

  return {
    directory,
    home,
    codexHome,
    env: isolatedEnvironment(directory, home, codexHome),
    async verifyLink(missingAllowed = false) {
      try {
        if ((await readlink(link)) !== store.authFile) throw new AuthError('invalid-store');
      } catch (error) {
        if (missingAllowed && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw new AuthError('invalid-store');
      }
    },
    dispose,
  };
}

export function launcherEnvironment(workspace: string): NodeJS.ProcessEnv {
  const home = join(workspace, 'launcher-home');
  return isolatedEnvironment(workspace, home, join(home, '.codex'));
}

// Native auth sees only this allowlist, never the caller's environment.
function isolatedEnvironment(
  directory: string,
  home: string,
  codexHome: string,
): NodeJS.ProcessEnv {
  return {
    PATH: SYSTEM_PATH,
    HOME: home,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    TMPDIR: directory,
  };
}
