import { isCommit } from './input.ts';
import type { GitCommand } from './git-command.ts';

export class GitTree {
  private readonly entries = new Map<string, TreeEntry | undefined>();
  private readonly directories = new Map<string, readonly string[]>();

  constructor(
    private readonly git: GitCommand,
    private readonly commit: string,
  ) {
    this.entries.set('', { kind: 'directory', oid: commit });
  }

  async find(path: string): Promise<TreeEntry | undefined> {
    if (this.entries.has(path)) return this.entries.get(path);

    const slash = path.lastIndexOf('/');
    const parent = slash < 0 ? '' : path.slice(0, slash);
    const directory = await this.find(parent);
    if (directory?.kind === 'unsupported') throw new Error(`Unsupported Git entry: ${parent}`);
    if (directory?.kind !== 'directory') return undefined;
    if (this.directories.has(parent)) return undefined;

    const output = await this.git.run('tree lookup', [
      '--literal-pathspecs',
      'ls-tree',
      '-z',
      '--full-tree',
      this.commit,
      '--',
      path,
    ]);
    const records = parseTree(output);
    if (records.length > 1 || (records[0] && records[0][0] !== path))
      throw new Error('Unexpected Git tree lookup result');

    const entry = records[0]?.[1];
    this.entries.set(path, entry);
    return entry;
  }

  async list(path: string, entry: TreeEntry): Promise<readonly string[]> {
    const cached = this.directories.get(path);
    if (cached) return cached;

    const records = parseTree(
      await this.git.run('tree listing', ['ls-tree', '-z', entry.oid], { maxBytes: 2_097_152 }),
    );
    const prefix = path ? `${path}/` : '';
    const seen = new Set<string>();
    const names = records.map(([name, child]) => {
      if (!name || name === '.' || name === '..' || name.includes('/') || seen.has(name))
        throw new Error('Invalid Git tree entry name');
      seen.add(name);
      this.entries.set(prefix + name, child);
      return name;
    });
    this.directories.set(path, names);
    return names;
  }

  async readText(entry: TreeEntry, source: string, maxBytes: number): Promise<string> {
    const size = await this.git.run('blob size check', ['cat-file', '-s', entry.oid]);
    if (!GIT_BLOB_SIZE_LINE_PATTERN.test(size)) throw new Error('Invalid Git blob size');
    if (Number(size) > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${source}`);
    return this.git.run('blob read', ['cat-file', 'blob', entry.oid], { maxBytes });
  }
}

export interface TreeEntry {
  readonly kind: 'file' | 'directory' | 'unsupported';
  readonly oid: string;
}

function parseTree(output: string): [string, TreeEntry][] {
  if (!output) return [];
  if (!output.endsWith('\0')) throw new Error('Invalid Git tree output');
  return output.slice(0, -1).split('\0').map(parseEntry);
}

function parseEntry(record: string): [string, TreeEntry] {
  const tab = record.indexOf('\t');
  const [mode, type, oid] = record.slice(0, tab).split(' ');
  if (tab === -1 || !oid || !isCommit(oid)) throw new Error('Invalid Git tree record');

  if (mode === '040000' && type === 'tree')
    return [record.slice(tab + 1), { kind: 'directory', oid }];
  const file = (mode === '100644' || mode === '100755') && type === 'blob';
  return [record.slice(tab + 1), { kind: file ? 'file' : 'unsupported', oid }];
}

const GIT_BLOB_SIZE_LINE_PATTERN = /^\d+\n$/u;
