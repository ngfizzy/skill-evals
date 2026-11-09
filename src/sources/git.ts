import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitCommand } from './git-command.ts';
import { GitTree, type TreeEntry } from './git-tree.ts';
import { isCommit } from './input.ts';
import type { DirectoryListing, GitRootInput, GitSource, SkillRoot, SourceKind } from './types.ts';

export class GitSkillRoot implements SkillRoot {
  private constructor(
    private readonly tree: GitTree,
    private readonly provenance: GitSource,
    private readonly prefix = '',
  ) {}

  static async open(input: GitRootInput, signal: AbortSignal): Promise<GitSnapshot> {
    signal.throwIfAborted();
    const executable = Bun.which('git');
    if (!executable) throw new Error('Git is required for remote skill roots');

    const directory = await mkdtemp(join(tmpdir(), 'skill-evals-git-'));
    const dispose = (): Promise<void> => removeSnapshot(directory);

    try {
      const git = new GitCommand(executable, directory, input.url, signal);
      await git.fetch(input);
      const commit = (
        await git.run('commit resolution', ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
      ).trim();
      if (!isCommit(commit) || (isCommit(input.revision) && commit !== input.revision))
        throw new Error(`Git returned an unexpected commit for ${input.url}`);

      const provenance = { url: input.url, commit };
      return { root: new GitSkillRoot(new GitTree(git, commit), provenance), provenance, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  async directory(path: string): Promise<GitSkillRoot> {
    const full = this.path(path);
    if ((await this.entry(full))?.kind !== 'directory')
      throw new Error(`Expected a Git directory: ${this.source(path)}`);
    return new GitSkillRoot(this.tree, this.provenance, full);
  }

  async list(path?: string): Promise<DirectoryListing> {
    const full = path === undefined ? this.prefix : this.path(path);
    const entry = await this.entry(full);
    if (entry?.kind !== 'directory')
      throw new Error(`Expected a Git directory: ${this.location(full)}`);
    return { identity: this.location(full), names: await this.tree.list(full, entry) };
  }

  async kind(path: string): Promise<SourceKind> {
    const entry = await this.entry(this.path(path));
    return entry?.kind === 'file' || entry?.kind === 'directory' ? entry.kind : 'missing';
  }

  async readText(path: string, maxBytes: number): Promise<string> {
    const full = this.path(path);
    const entry = await this.entry(full);
    if (entry?.kind !== 'file') throw new Error(`Expected a Git file: ${this.location(full)}`);
    return this.tree.readText(entry, this.location(full), maxBytes);
  }

  source(path: string): string {
    return this.location(this.path(path));
  }

  private async entry(path: string): Promise<TreeEntry | undefined> {
    const entry = await this.tree.find(path);
    if (entry?.kind === 'unsupported')
      throw new Error(`Unsupported Git entry: ${this.location(path)}`);
    return entry;
  }

  private path(relative: string): string {
    if (
      relative.includes('\0') ||
      relative.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('Invalid relative Git path');
    return this.prefix ? `${this.prefix}/${relative}` : relative;
  }

  private location(path: string): string {
    const { url, commit } = this.provenance;
    return `git+${url}#${commit}:${path.split('/').map(encodeURIComponent).join('/')}`;
  }
}

export interface GitSnapshot {
  readonly root: SkillRoot;
  readonly provenance: GitSource;
  dispose(): Promise<void>;
}

async function removeSnapshot(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    throw new Error('Could not remove temporary Git skill snapshot');
  }
}
