import { readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { containedPath, exists, readBounded } from '../utils/index.ts';

import type { DirectoryListing, SkillRoot, SourceKind } from './types.ts';

export class LocalSkillRoot implements SkillRoot {
  private constructor(
    private readonly path: string,
    private readonly signal?: AbortSignal,
  ) {}

  static async open(path: string, signal?: AbortSignal): Promise<LocalSkillRoot> {
    signal?.throwIfAborted();
    return new LocalSkillRoot(await realpath(path), signal);
  }

  async directory(path: string): Promise<LocalSkillRoot> {
    const directory = await this.resolve(path);
    if (!(await stat(directory)).isDirectory())
      throw new Error(`Expected a directory: ${directory}`);
    return new LocalSkillRoot(directory, this.signal);
  }

  async list(path?: string): Promise<DirectoryListing> {
    this.signal?.throwIfAborted();
    const directory = path === undefined ? this.path : await this.resolve(path);
    return { identity: directory, names: await readdir(directory) };
  }

  async kind(path: string): Promise<SourceKind> {
    this.signal?.throwIfAborted();
    if (!(await exists(this.source(path)))) return 'missing';

    const info = await stat(await this.resolve(path));
    if (info.isDirectory()) return 'directory';
    return info.isFile() ? 'file' : 'other';
  }

  async readText(path: string, maxBytes: number): Promise<string> {
    return readBounded(await this.resolve(path), maxBytes);
  }

  source(path: string): string {
    return join(this.path, path);
  }

  private resolve(path: string): Promise<string> {
    this.signal?.throwIfAborted();
    return containedPath(this.source(path), this.path);
  }
}
