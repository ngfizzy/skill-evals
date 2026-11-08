import { constants } from 'node:fs';
import { access, open, realpath } from 'node:fs/promises';
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

    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }

    if (length > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${path}`);
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
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
