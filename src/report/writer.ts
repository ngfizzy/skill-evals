import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { ReportCheckpoint } from './types.ts';

export class ReportWriter {
  private constructor(
    readonly path: string,
    private inode: number,
  ) {}

  static async create(path: string, initial: ReportCheckpoint): Promise<ReportWriter> {
    const absolute = resolve(path);
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });

    const snapshot = await createSnapshot(absolute, initial);

    try {
      // Hard-link publication is atomic and exclusive. Before this operation the
      // destination is absent; afterwards it contains the complete synced JSON.
      // Existing files, directories and even dangling symlinks cause EEXIST.
      await link(snapshot.path, absolute);
      await syncDirectory(dirname(absolute));
      return new ReportWriter(absolute, snapshot.inode);
    } finally {
      await rm(snapshot.path, { force: true });
    }
  }

  async write(report: ReportCheckpoint): Promise<void> {
    const snapshot = await createSnapshot(this.path, report);
    try {
      const current = await lstat(this.path);
      if (!current.isFile() || current.ino !== this.inode)
        throw new Error('Report was replaced externally; refusing overwrite');

      await rename(snapshot.path, this.path);
      this.inode = snapshot.inode;
      await syncDirectory(dirname(this.path));
    } finally {
      await rm(snapshot.path, { force: true });
    }
  }
}

async function createSnapshot(
  path: string,
  report: ReportCheckpoint,
): Promise<{ path: string; inode: number }> {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const temporary = join(dirname(path), `.eval-report-${randomUUID()}.json`);

  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(serialized);
      await file.sync();
      return { path: temporary, inode: (await file.stat()).ino };
    } finally {
      await file.close();
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
