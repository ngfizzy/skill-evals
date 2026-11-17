import { constants, fstatSync, closeSync, type Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isSameFile } from '../utils/index.ts';

import { AuthCleanup } from './cleanup.ts';
import { AuthError } from './errors.ts';
import { Libc } from './libc.ts';
import { AuthStore } from './store.ts';
import type { AuthStoreLocation, CredentialLease } from './types.ts';

const LOCK_FILE_NAME = '.auth.lock';
const DEFAULT_LOCK_WAIT_MS = 120_000;
const POLL_INTERVAL_MS = 25;

export class CredentialLock implements CredentialLease {
  private released = false;
  readonly fd: number;

  private constructor(private readonly file: FileHandle) {
    this.fd = file.fd;
  }

  static async acquire(
    store: AuthStoreLocation,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_LOCK_WAIT_MS,
  ): Promise<CredentialLock> {
    await new AuthStore(store).assertValid();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new AuthError('lock-failed');

    const path = join(store.directory, LOCK_FILE_NAME);
    const started = performance.now();
    try {
      while (true) {
        const file = await CredentialLock.openLockFile(path);
        try {
          await CredentialLock.waitForLock(
            file,
            path,
            timeoutMs - (performance.now() - started),
            signal,
          );
          CredentialLock.throwIfInterrupted(signal);
          if (!(await AuthCleanup.pending(store))) {
            CredentialLock.throwIfInterrupted(signal);
            return new CredentialLock(file);
          }
        } catch (error) {
          await file.close();
          throw error;
        }
        // A matching recovery caller needs to acquire the lease before it can clear a record.
        await file.close();
        const remainingMs = timeoutMs - (performance.now() - started);
        if (remainingMs <= 0) throw new AuthError('cleanup-required');
        await delay(Math.min(POLL_INTERVAL_MS, remainingMs), undefined, { signal }).catch(() => {
          throw new AuthError('interrupted');
        });
      }
    } catch (error) {
      throw error instanceof AuthError ? error : new AuthError('lock-failed');
    }
  }

  static async inherit(store: AuthStoreLocation, fd: number): Promise<CredentialLease> {
    await new AuthStore(store).assertValid();
    const identity = fstatSync(fd);
    AuthStore.assertPrivateFile(identity);
    if (
      !isSameFile(identity, await lstat(join(store.directory, LOCK_FILE_NAME))) ||
      !Libc.load().tryLockExclusive(fd)
    )
      throw new AuthError('lock-failed');
    let released = false;
    return {
      fd,
      async release() {
        if (released) return;
        released = true;
        closeSync(fd);
      },
    };
  }

  // Once the launcher has exited, a fresh exclusive lease proves nobody inherited a
  // live descriptor. Only the matching pre-worker record can be recovered this way.
  static async recoverUnclaimed(store: AuthStoreLocation, workspace: string): Promise<void> {
    try {
      await new AuthStore(store).assertValid();
      const path = join(store.directory, LOCK_FILE_NAME);
      const file = await CredentialLock.openLockFile(path);
      try {
        await CredentialLock.waitForLock(file, path, 250);
        await AuthCleanup.finishUnclaimed(store, workspace);
      } finally {
        await file.close();
      }
    } catch {
      throw new AuthError('cleanup-required');
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    // Closing our copy preserves an inherited child's ownership. Never LOCK_UN.
    await this.file.close();
  }

  private static async openLockFile(path: string): Promise<FileHandle> {
    try {
      return await open(
        path,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      );
    } catch {
      throw new AuthError('lock-failed');
    }
  }

  private static async waitForLock(
    file: FileHandle,
    path: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const opened = await file.stat();
    AuthStore.assertPrivateFile(opened);

    const started = performance.now();
    while (true) {
      CredentialLock.throwIfInterrupted(signal);
      await CredentialLock.assertStillLockFile(path, opened);
      CredentialLock.throwIfInterrupted(signal);
      if (Libc.load().tryLockExclusive(file.fd)) return;

      const remainingMs = timeoutMs - (performance.now() - started);
      if (remainingMs <= 0) throw new AuthError('lock-timeout');
      await delay(Math.min(POLL_INTERVAL_MS, remainingMs), undefined, { signal }).catch(() => {
        throw new AuthError('interrupted');
      });
    }
  }

  // The path must still name the file we opened, so a swapped lock file cannot split holders.
  private static async assertStillLockFile(path: string, opened: Stats): Promise<void> {
    const current = await lstat(path);
    if (!isSameFile(opened, current)) throw new AuthError('lock-failed');
    AuthStore.assertPrivateFile(current);
  }

  private static throwIfInterrupted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AuthError('interrupted');
  }
}
