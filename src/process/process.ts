import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { Readable, Writable } from 'node:stream';

import type { ProcessOptions } from './types.ts';

export const MAX_OUTPUT = 2_097_152;
export class ProcessTimeoutError extends Error {}
export class ProcessTeardownError extends Error {}

const DIAGNOSTIC_TAIL_BYTES = 3000;

type OutputStream = 'stdout' | 'stderr';
type PipedChild = ChildProcessByStdio<Writable, Readable, Readable>;

export class ProcessManager {
  async run(command: string[], options: ProcessOptions): Promise<string> {
    if (process.platform === 'win32')
      throw new Error('Live evaluation requires POSIX process groups (macOS or Linux)');

    options.signal?.throwIfAborted();
    const [executable, ...args] = command;
    if (!executable) throw new Error('Missing executable');

    return ProcessRun.start(executable, args, options);
  }

  static async waitForGroupExit(pid?: number): Promise<void> {
    const started = performance.now();
    while (pid) {
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
        if ((error as NodeJS.ErrnoException).code !== 'EPERM')
          throw new ProcessTeardownError('Process-group exit could not be verified');
      }
      if (performance.now() - started >= 2000)
        throw new ProcessTeardownError('Process group remained after termination');
      await delay(10);
    }
  }
}

// One child process group, supervised from spawn until close. Every exit path kills the group.
class ProcessRun {
  private readonly stdout: Buffer[] = [];
  private readonly bytes: Record<OutputStream, number> = { stdout: 0, stderr: 0 };
  private diagnosticTail = Buffer.alloc(0);
  private failure: Error | undefined;

  private constructor(
    private readonly child: PipedChild,
    private readonly options: ProcessOptions,
  ) {}

  static start(executable: string, args: string[], options: ProcessOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: options.directory,
        env: options.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      new ProcessRun(child, options).supervise(resolve, reject);
    });
  }

  private supervise(resolve: (output: string) => void, reject: (error: Error) => void): void {
    const { child, options } = this;

    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => this.receive(chunk, 'stderr'));
    child.on('error', (error) => {
      this.failure ??= new Error(`Agent process error: ${error.message}`);
    });

    // A successful leader can leave children holding the pipes open. Kill the group on
    // exit, before waiting for close, as well as on timeout, abort and output overflow.
    child.on('exit', () => this.killGroup());

    const timer = setTimeout(
      () => this.stop(new ProcessTimeoutError('Agent timed out')),
      options.timeoutMs,
    );
    const abort = (): void => this.stop(new Error('Evaluation interrupted'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    child.stdin.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') this.stop(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      this.killGroup();

      void this.finish(code, signal).then(resolve, reject);
    });

    child.stdin.end(options.input);
  }

  private receive(chunk: Buffer, stream: OutputStream): void {
    this.bytes[stream] += chunk.length;
    this.diagnosticTail = Buffer.concat([this.diagnosticTail, chunk]).subarray(
      -DIAGNOSTIC_TAIL_BYTES,
    );

    // With per-stream limits each stream is bounded alone; otherwise they share MAX_OUTPUT.
    const { outputLimits } = this.options;
    const used = outputLimits ? this.bytes[stream] : this.bytes.stdout + this.bytes.stderr;
    const limit = outputLimits?.[stream] ?? MAX_OUTPUT;
    if (used > limit) return this.stop(new Error(`Agent output exceeded ${limit} bytes`));
    if (stream !== 'stdout') return;

    this.stdout.push(chunk);
    try {
      this.options.onStdout?.(chunk);
    } catch {
      this.stop(new Error('Process output consumer failed'));
    }
  }

  private async finish(code: number | null, signal: NodeJS.Signals | null): Promise<string> {
    if (this.options.termination !== 'leader')
      await ProcessManager.waitForGroupExit(this.child.pid);
    return this.output(code, signal);
  }

  private output(code: number | null, signal: NodeJS.Signals | null): string {
    if (this.failure) throw this.failure;
    if (code !== 0)
      throw new Error(`Agent exited ${code ?? signal}: ${this.diagnosticTail.toString('utf8')}`);

    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(this.stdout));
    } catch {
      throw new Error('Agent output is not valid UTF-8');
    }
  }

  private stop(error: Error): void {
    this.failure ??= error;
    this.killGroup();
  }

  private killGroup(): void {
    if (this.options.termination === 'leader') {
      this.child.kill('SIGKILL');
      return;
    }
    const { pid } = this.child;
    if (!pid) return;

    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        this.child.kill('SIGKILL');
        this.failure ??= new Error('Process-group cleanup denied; terminated the agent process');
      }
    }
  }
}
