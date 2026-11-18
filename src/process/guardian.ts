import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { OwnedProcessGroup, type ChildExit } from './group.ts';

const PARENT_POLL_MS = 25;
const RECOVERY_POLL_MS = 250;

interface GuardedWorker<Child extends ChildProcess> {
  env: NodeJS.ProcessEnv;
  spawn: () => Child;
  authorize: (child: Child) => void;
  timeoutMs?: number;
  onTeardownFailure?: () => void;
}

interface GuardedExit {
  interrupted: boolean;
  exit?: ChildExit;
  closed?: Promise<void>;
}

// Runs in the process that owns the group. The worker must wait for authorization
// before it can execute its workload.
export class ProcessGuardian {
  private readonly stopRequest = Promise.withResolvers<void>();
  private stopping = false;

  constructor(private readonly parent: number) {}

  hasParent(): boolean {
    return OwnedProcessGroup.parentPid() === this.parent;
  }

  stop(): void {
    this.stopping = true;
    this.stopRequest.resolve();
  }

  async run<Child extends ChildProcess>(worker: GuardedWorker<Child>): Promise<GuardedExit> {
    if (this.stopping || !this.hasParent()) return { interrupted: true };

    const group = new OwnedProcessGroup();
    const { child, exited, closed } = await group.start(worker.spawn, worker.env);

    let interrupted = false;
    const interrupt = () => {
      interrupted = true;
      this.stop();
    };

    const parentPoll = setInterval(() => {
      if (!this.hasParent()) interrupt();
    }, PARENT_POLL_MS);
    const deadline =
      worker.timeoutMs === undefined ? undefined : setTimeout(interrupt, worker.timeoutMs);

    let exit: ChildExit | void;
    try {
      if (!this.hasParent()) interrupt();

      if (!this.stopping) worker.authorize(child);

      exit = await Promise.race([exited, this.stopRequest.promise]);
    } finally {
      clearInterval(parentPoll);
      clearTimeout(deadline);

      await retryTeardown(() => group.stop(exited), worker.onTeardownFailure);
    }

    return { interrupted, ...(exit && { exit }), closed };
  }
}

// A caller with an inherited resource can report uncertainty while it continues
// to hold ownership and retry verification.
export async function retryTeardown(
  work: () => Promise<void>,
  onFailure?: () => void,
): Promise<void> {
  while (true) {
    try {
      await work();
      return;
    } catch (error) {
      if (!onFailure) throw error;

      onFailure();
      await delay(RECOVERY_POLL_MS);
    }
  }
}
