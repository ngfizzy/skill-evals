import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, open, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import { isSameFile, readBounded } from '../../utils/index.ts';
import { AuthError } from '../contracts/errors.ts';
import type { AuthStoreLocation } from '../contracts/types.ts';

import { Libc } from './libc.ts';
import { AuthStore } from './store.ts';

// The guardian holds flock through cleanup. This record also blocks reuse if it is killed or
// cleanup cannot be verified. It never expires and is never used to steal a surviving lock.
export class AuthCleanup {
  static async begin(store: AuthStoreLocation, workspace: string): Promise<void> {
    const existing = await AuthCleanup.readRecord(store);

    if (existing) {
      if (
        existing.record.phase === 'guardian' &&
        existing.record.guardian === Libc.load().parentProcessId() &&
        existing.record.workspace === workspace &&
        isSameFile(existing.record, await lstat(workspace))
      )
        return;
      throw new AuthError('cleanup-required');
    }

    const identity = await lstat(workspace);
    AuthStore.assertPrivateDirectory(identity);

    await writeFile(
      AuthCleanup.path(store),
      JSON.stringify({ workspace, dev: identity.dev, ino: identity.ino, phase: 'launcher' }),
      { flag: 'wx', mode: 0o600 },
    );
  }

  static async pending(store: AuthStoreLocation): Promise<boolean> {
    try {
      await lstat(AuthCleanup.path(store));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new AuthError('cleanup-required');
    }
  }

  static async prepareGuardian(store: AuthStoreLocation, workspace: string): Promise<void> {
    const owned = await AuthCleanup.readRecord(store);
    if (!owned || owned.record.workspace !== workspace || owned.record.phase !== 'launcher')
      throw new AuthError('cleanup-required');

    await AuthCleanup.replaceRecord(store, owned, { ...owned.record, phase: 'starting' });
  }

  static async claim(store: AuthStoreLocation, workspace: string): Promise<void> {
    const owned = await AuthCleanup.readRecord(store);
    if (!owned || owned.record.workspace !== workspace || owned.record.phase !== 'starting')
      throw new AuthError('cleanup-required');

    await AuthCleanup.replaceRecord(store, owned, {
      ...owned.record,
      phase: 'guardian',
      guardian: process.pid,
    });
  }

  // The parent waits for the guardian. Requests that never created a context remove only their
  // own empty workspace; they must not disturb another operation's cleanup record.
  static async finish(store: AuthStoreLocation, workspace: string): Promise<void> {
    try {
      const started = performance.now();

      while (true) {
        const owned = await AuthCleanup.readRecord(store);
        if (!owned || owned.record.workspace !== workspace) break;

        if (owned.record.phase === 'launcher')
          return await AuthCleanup.finishOwnedCleanup(store, owned);

        if (performance.now() - started >= 3000) throw new AuthError('cleanup-required');
        await delay(10);
      }

      await rm(workspace, { recursive: true, force: true });
    } catch {
      throw new AuthError('cleanup-required');
    }
  }

  // Run after worker shutdown, under the inherited lease. Keep the verified deletion
  // in memory so a failed record unlink can be retried against the same inode.
  static guardianCleanup(
    store: AuthStoreLocation,
    workspace: string,
    claimed: boolean,
  ): () => Promise<void> {
    let removedWorkspace: OwnedCleanup | undefined;

    return async () => {
      try {
        if (!removedWorkspace) {
          const owned = claimed
            ? await AuthCleanup.guardianRecord(store, workspace)
            : await AuthCleanup.unclaimedRecord(store, workspace);

          await AuthCleanup.deleteWorkspace(store, owned);
          removedWorkspace = owned;
        }

        await AuthCleanup.deleteRecord(store, removedWorkspace);
      } catch {
        throw new AuthError('cleanup-required');
      }
    };
  }

  static async verifyGuardianWorkspace(store: AuthStoreLocation, workspace: string): Promise<void> {
    await AuthCleanup.verifyWorkspace(store, await AuthCleanup.guardianRecord(store, workspace));
  }

  private static async guardianRecord(
    store: AuthStoreLocation,
    workspace: string,
  ): Promise<OwnedCleanup> {
    const owned = await AuthCleanup.readRecord(store);
    if (
      !owned ||
      owned.record.workspace !== workspace ||
      owned.record.phase !== 'guardian' ||
      owned.record.guardian !== process.pid
    )
      throw new AuthError('cleanup-required');
    return owned;
  }

  // Only a caller holding the lease may recover an unclaimed record.
  static async finishUnclaimed(store: AuthStoreLocation, workspace: string): Promise<void> {
    await AuthCleanup.finishOwnedCleanup(
      store,
      await AuthCleanup.unclaimedRecord(store, workspace),
    );
  }

  private static async unclaimedRecord(
    store: AuthStoreLocation,
    workspace: string,
  ): Promise<OwnedCleanup> {
    const owned = await AuthCleanup.readRecord(store);
    if (!owned || owned.record.workspace !== workspace || owned.record.phase !== 'starting')
      throw new AuthError('cleanup-required');

    return owned;
  }

  private static async replaceRecord(
    store: AuthStoreLocation,
    owned: OwnedCleanup,
    record: CleanupRecord,
  ): Promise<void> {
    const path = AuthCleanup.path(store);
    const temporary = path + '.' + randomUUID();
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(record));
      } finally {
        await file.close();
      }

      if (!isSameFile(owned.identity, await lstat(path))) throw new AuthError('cleanup-required');
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  private static async finishOwnedCleanup(
    store: AuthStoreLocation,
    owned: OwnedCleanup,
  ): Promise<void> {
    try {
      await AuthCleanup.deleteWorkspace(store, owned);
      await AuthCleanup.deleteRecord(store, owned);
    } catch {
      throw new AuthError('cleanup-required');
    }
  }

  private static async deleteWorkspace(
    store: AuthStoreLocation,
    owned: OwnedCleanup,
  ): Promise<void> {
    const { workspace } = owned.record;
    await AuthCleanup.verifyWorkspace(store, owned);

    await rm(workspace, { recursive: true, force: true });
    if (await pathExists(workspace)) throw new AuthError('cleanup-required');
  }

  private static async deleteRecord(store: AuthStoreLocation, owned: OwnedCleanup): Promise<void> {
    const path = AuthCleanup.path(store);
    if (await pathExists(owned.record.workspace)) throw new AuthError('cleanup-required');

    if (!isSameFile(owned.identity, await lstat(path))) throw new AuthError('cleanup-required');

    await unlink(path);
  }

  private static async verifyWorkspace(
    store: AuthStoreLocation,
    owned: OwnedCleanup,
  ): Promise<void> {
    const identity = await lstat(owned.record.workspace);
    AuthStore.assertPrivateDirectory(identity);
    if (
      !isSameFile(owned.record, identity) ||
      !isSameFile(owned.identity, await lstat(AuthCleanup.path(store)))
    )
      throw new AuthError('cleanup-required');
  }

  private static async readRecord(store: AuthStoreLocation): Promise<OwnedCleanup | undefined> {
    try {
      const path = AuthCleanup.path(store);
      const identity = await lstat(path);
      AuthStore.assertPrivateFile(identity);

      const record = cleanupRecordSchema.parse(JSON.parse(await readBounded(path, 4096)));

      const current = await lstat(path);
      AuthStore.assertPrivateFile(current);
      if (!isSameFile(identity, current)) throw new AuthError('cleanup-required');

      return { identity, record };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new AuthError('cleanup-required');
    }
  }

  private static path(store: AuthStoreLocation): string {
    return join(store.directory, '.auth-context.json');
  }
}

const recordIdentity = {
  workspace: z.string().refine(isAbsolute),
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
};
const cleanupRecordSchema = z.discriminatedUnion('phase', [
  z.object({ ...recordIdentity, phase: z.literal('launcher') }).strict(),
  z.object({ ...recordIdentity, phase: z.literal('starting') }).strict(),
  z
    .object({ ...recordIdentity, phase: z.literal('guardian'), guardian: z.number().int().min(2) })
    .strict(),
]);
type CleanupRecord = z.infer<typeof cleanupRecordSchema>;

interface OwnedCleanup {
  identity: Stats;
  record: CleanupRecord;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
