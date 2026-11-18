import { dlopen, ptr, toArrayBuffer, type Pointer } from 'bun:ffi';

import { ProcessTeardownError } from './types.ts';

const EINTR = 4;
const LINUX_ECHILD = 10;
const PR_SET_CHILD_SUBREAPER = 36;
const WNOHANG = 1;
const DARWIN_ENOMEM = 12;

// Darwin's 64-bit kinfo_proc layout, derived from the macOS SDK's sys/sysctl.h.
const KINFO_PROC_SIZE = 648;
const PROC_STATUS = 36;
const PROC_PID = 40;
const PROC_GROUP = 564;
const SZOMB = 5;
const MAX_GROUP_BYTES = KINFO_PROC_SIZE * 4096;

interface PlatformReaping {
  prepare(): void;
  reap(group: number): void;
  zombies(group: number): string | undefined;
}

export class GroupPlatform {
  private static instance: GroupPlatform | undefined;

  private constructor(
    readonly parentPid: () => number,
    readonly currentGroup: () => number,
    private readonly setGroup: (group: number) => number,
    readonly children: PlatformReaping,
  ) {}

  static load(): GroupPlatform {
    return (this.instance ??= this.open());
  }

  moveTo(group: number): void {
    if (!this.tryMoveTo(group)) throw new ProcessTeardownError('Cannot assign process group');
  }

  tryMoveTo(group: number): boolean {
    return this.setGroup(group) === 0 && this.currentGroup() === (group || process.pid);
  }

  private static open(): GroupPlatform {
    const darwin = process.platform === 'darwin';
    const paths = darwin
      ? ['/usr/lib/libSystem.B.dylib']
      : ['libc.so.6', `/lib/ld-musl-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`];
    for (const path of paths) {
      try {
        const { symbols } = dlopen(path, {
          getppid: { args: [], returns: 'i32' },
          getpgid: { args: ['i32'], returns: 'i32' },
          setpgid: { args: ['i32', 'i32'], returns: 'i32' },
          [darwin ? '__error' : '__errno_location']: { args: [], returns: 'ptr' },
        });
        const errnoLocation = symbols[darwin ? '__error' : '__errno_location']!;
        const errno = () => new Int32Array(toArrayBuffer(errnoLocation() as Pointer, 0, 4))[0]!;
        return new GroupPlatform(
          () => symbols.getppid(),
          () => symbols.getpgid(0),
          (group) => symbols.setpgid(0, group),
          darwin ? darwinReaping(path, errno) : linuxReaping(path, errno),
        );
      } catch {
        // musl and glibc expose the same operations through different loaders.
      }
    }
    throw new ProcessTeardownError('Process supervision is unavailable');
  }
}

function linuxReaping(path: string, errno: () => number): PlatformReaping {
  const { symbols } = dlopen(path, {
    prctl: { args: ['i32', 'u64', 'u64', 'u64', 'u64'], returns: 'i32' },
    waitpid: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
  });
  return {
    prepare() {
      if (symbols.prctl(PR_SET_CHILD_SUBREAPER, 1n, 0n, 0n, 0n) !== 0)
        throw new ProcessTeardownError('Cannot adopt subprocess descendants');
    },
    reap(group) {
      // The runtime has already reaped its direct worker. Collect only adopted children
      // of this group. Bound work in one poll, including interrupted waits.
      for (let attempt = 0; attempt < 128; attempt++) {
        const child = symbols.waitpid(-group, null, WNOHANG);
        if (child > 0) continue;
        if (child === 0) return;
        const error = errno();
        if (error === LINUX_ECHILD) return;
        if (error !== EINTR) throw new ProcessTeardownError('Cannot reap subprocess descendants');
      }
    },
    zombies() {
      return undefined;
    },
  };
}

function darwinReaping(path: string, errno: () => number): PlatformReaping {
  const { symbols } = dlopen(path, {
    sysctl: { args: ['ptr', 'u32', 'ptr', 'ptr', 'ptr', 'u64'], returns: 'i32' },
  });
  return {
    prepare() {},
    reap() {},
    zombies(group) {
      // CTL_KERN, KERN_PROC, KERN_PROC_PGRP. The kernel reports live entries and zombies.
      const query = Int32Array.of(1, 14, 2, group);
      const bytes = BigUint64Array.of(0n);
      if (symbols.sysctl(ptr(query), query.length, null, ptr(bytes), null, 0n) !== 0)
        throw new ProcessTeardownError('Cannot inspect process group');

      const capacity = Number(bytes[0]);
      if (capacity > MAX_GROUP_BYTES || capacity < KINFO_PROC_SIZE) return undefined;
      const records = Buffer.alloc(capacity);
      if (symbols.sysctl(ptr(query), query.length, ptr(records), ptr(bytes), null, 0n) !== 0) {
        if (errno() === DARWIN_ENOMEM) return undefined;
        throw new ProcessTeardownError('Cannot inspect process group');
      }

      const count = Number(bytes[0]);
      if (count <= 0 || count > capacity || count % KINFO_PROC_SIZE !== 0) return undefined;
      const pids = new Set<number>();
      for (let offset = 0; offset < count; offset += KINFO_PROC_SIZE) {
        const pid = records.readInt32LE(offset + PROC_PID);
        if (
          records[offset + PROC_STATUS] !== SZOMB ||
          records.readInt32LE(offset + PROC_GROUP) !== group ||
          pid <= 1 ||
          pids.has(pid)
        )
          return undefined;
        pids.add(pid);
      }
      return [...pids].sort((a, b) => a - b).join(',');
    },
  };
}
