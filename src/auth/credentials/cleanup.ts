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

        if (owned.record.phase === 'launcher' || owned.record.phase === 'removed')
          throw new AuthError('cleanup-required');

        if (performance.now() - started >= 3000) throw new AuthError('cleanup-required');
        await delay(10);
      }

      await rm(workspace, { recursive: true, force: true });
    } catch {
      throw new AuthError('cleanup-required');
    }
  }

  // Run after worker shutdown, under the inherited lease.
  static guardianCleanup(
    store: AuthStoreLocation,
    workspace: string,
    claimed: boolean,
  ): () => Promise<void> {
    return AuthCleanup.workspaceCleanup(store, () =>
      claimed
        ? AuthCleanup.guardianRecord(store, workspace)
        : AuthCleanup.unclaimedRecord(store, workspace),
    );
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
    await AuthCleanup.workspaceCleanup(store, () =>
      AuthCleanup.unclaimedRecord(store, workspace),
    )();
  }

  // The parent may recover its own workspace after the launcher exits and the lease is free.
  static async recoverWorkspace(store: AuthStoreLocation, workspace: string): Promise<void> {
    const owned = await AuthCleanup.readRecord(store);
    if (!owned || owned.record.workspace !== workspace) {
      if (await pathExists(workspace)) throw new AuthError('cleanup-required');
      return;
    }

    if (owned.record.phase === 'guardian') throw new AuthError('cleanup-required');

    await AuthCleanup.workspaceCleanup(store, async () => owned)();
  }

  // A new lease holder can remove a completed record after checking that the workspace is gone.
  static async clearCompleted(store: AuthStoreLocation): Promise<boolean> {
    const owned = await AuthCleanup.readRecord(store);
    if (!owned) return true;

    if (owned.record.phase !== 'removed') return false;

    await AuthCleanup.deleteRecord(store, owned);
    return true;
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
  ): Promise<OwnedCleanup> {
    const path = AuthCleanup.path(store);
    const temporary = path + '.' + randomUUID();
    const file = await open(temporary, 'wx', 0o600);
    try {
      let identity: Stats;
      try {
        await file.writeFile(JSON.stringify(record));
        await file.sync();
        identity = await file.stat();
      } finally {
        await file.close();
      }

      if (!isSameFile(owned.identity, await lstat(path))) throw new AuthError('cleanup-required');
      await rename(temporary, path);
      return { identity, record };
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  private static workspaceCleanup(
    store: AuthStoreLocation,
    load: () => Promise<OwnedCleanup>,
  ): () => Promise<void> {
    let removed: OwnedCleanup | undefined;

    return async () => {
      try {
        if (!removed) {
          const owned = await load();
          if (owned.record.phase !== 'removed') await AuthCleanup.deleteWorkspace(store, owned);
          removed = owned;
        }

        // Publish only after deletion was verified. An older phase plus a missing workspace
        // is still ambiguous, so recovery must leave that record in place.
        if (removed.record.phase !== 'removed') {
          const { workspace, dev, ino } = removed.record;
          removed = await AuthCleanup.replaceRecord(store, removed, {
            workspace,
            dev,
            ino,
            phase: 'removed',
          });
        }

        await AuthCleanup.deleteRecord(store, removed);
      } catch {
        throw new AuthError('cleanup-required');
      }
    };
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
    if (owned.record.phase !== 'removed' || (await pathExists(owned.record.workspace)))
      throw new AuthError('cleanup-required');

    const path = AuthCleanup.path(store);
    if (!isSameFile(owned.identity, await lstat(path))) throw new AuthError('cleanup-required');

    try {
      await unlink(path);
    } catch {
      throw new AuthError('cleanup-required');
    }
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
  z.object({ ...recordIdentity, phase: z.literal('removed') }).strict(),
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
