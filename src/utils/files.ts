import { constants, type Stats } from 'node:fs';
import { access, mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

export async function containedPath(path: string, directory: string): Promise<string> {
  const real = await realpath(path);
  const rel = relative(directory, real);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Skill path escapes its directory: ${path}`);
  }
  return real;
}

export async function readBounded(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
    if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${path}`);

    // Read one byte past the limit to catch a file that grew after stat.
    const contents = await readUpTo(file, maxBytes + 1);
    if (contents.length > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${path}`);
    return new TextDecoder('utf-8', { fatal: true }).decode(contents);
  } finally {
    await file.close();
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR'
    )
      return false;
    throw error;
  }
}

// Reads until end of file or until `limit` bytes, whichever comes first.
export async function readUpTo(file: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(limit);
  let length = 0;
  while (length < limit) {
    const { bytesRead } = await file.read(buffer, length, limit - length, null);
    if (!bytesRead) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}

// Creates one directory level with the given mode; an existing directory is left as it is.
export async function ensureDirectory(path: string, mode: number): Promise<void> {
  await mkdir(path, { mode }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
}

export type FileIdentity = Pick<Stats, 'dev' | 'ino'>;

export function isSameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
