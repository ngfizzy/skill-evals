import { dlopen, toArrayBuffer, type Pointer } from 'bun:ffi';

import { readInt32 } from '../../utils/index.ts';
import { AuthError } from '../contracts/errors.ts';
import {
  AUDITED_BUN_VERSION,
  supportedPlatform,
  type SupportedPlatform,
} from '../runtime/platform.ts';

// flock(2) operation flags, and the errno values that mean "try again".
const LOCK_EX = 2;
const LOCK_NB = 4;
const EINTR = 4;
const EWOULDBLOCK: Record<SupportedPlatform['os'], number> = { darwin: 35, linux: 11 };

// The audited libc calls behind the credential lock, loaded once per process through Bun FFI.
export class Libc {
  private static loaded: Libc | undefined;

  private constructor(
    private readonly flock: (fd: number, operation: number) => number,
    private readonly errnoLocation: () => Pointer,
    private readonly wouldBlock: number,
    private readonly parentPid: () => number,
    private readonly setGroup: (pid: number, group: number) => number,
    private readonly getGroup: (pid: number) => number,
  ) {}

  static load(): Libc {
    Libc.loaded ??= Libc.open();
    return Libc.loaded;
  }

  parentProcessId(): number {
    return this.parentPid();
  }

  moveToGroup(group: number): void {
    if (this.setGroup(0, group) !== 0) throw new AuthError('cleanup-required');
  }

  processGroupId(): number {
    const group = this.getGroup(0);
    if (group <= 1) throw new AuthError('cleanup-required');
    return group;
  }

  // Returns false while another open file description holds the lock.
  tryLockExclusive(fd: number): boolean {
    if (this.flock(fd, LOCK_EX | LOCK_NB) === 0) return true;

    const errno = this.errno();
    if (errno === this.wouldBlock || errno === EINTR) return false;
    throw new AuthError('lock-failed');
  }

  private errno(): number {
    return readInt32(toArrayBuffer(this.errnoLocation(), 0, 4));
  }

  private static open(): Libc {
    if (Bun.version !== AUDITED_BUN_VERSION) throw new AuthError('unsupported-runtime');

    const { os, arch } = supportedPlatform();
    const errnoSymbol = os === 'darwin' ? '__error' : '__errno_location';

    for (const path of Libc.libraryPaths(os, arch)) {
      try {
        const { symbols } = dlopen(path, {
          flock: { args: ['i32', 'i32'], returns: 'i32' },
          getppid: { args: [], returns: 'i32' },
          setpgid: { args: ['i32', 'i32'], returns: 'i32' },
          getpgid: { args: ['i32'], returns: 'i32' },
          [errnoSymbol]: { args: [], returns: 'ptr' },
        });

        const errnoLocation = symbols[errnoSymbol]!;

        return new Libc(
          (fd, operation) => symbols.flock(fd, operation),
          () => errnoLocation() as Pointer,
          EWOULDBLOCK[os],
          () => symbols.getppid(),
          (pid, group) => symbols.setpgid(pid, group),
          (pid) => symbols.getpgid(pid),
        );
      } catch {
        /* Try only the other audited platform loader. */
      }
    }

    throw new AuthError('unsupported-runtime');
  }

  private static libraryPaths(
    os: SupportedPlatform['os'],
    arch: SupportedPlatform['arch'],
  ): string[] {
    if (os === 'darwin') return ['/usr/lib/libSystem.B.dylib'];

    const musl = arch === 'arm64' ? '/lib/ld-musl-aarch64.so.1' : '/lib/ld-musl-x86_64.so.1';
    return ['libc.so.6', musl];
  }
}
