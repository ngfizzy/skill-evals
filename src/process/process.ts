import { spawn, type ChildProcess } from 'node:child_process';

import { supervisorCommand } from './supervisor.ts';
import { ProcessTeardownError, type ProcessOptions, type SupervisedOutcome } from './types.ts';

export { ProcessTeardownError } from './types.ts';

export const MAX_OUTPUT = 2_097_152;
export class ProcessTimeoutError extends Error {}

const DIAGNOSTIC_TAIL_BYTES = 3000;
const EXIT_DRAIN_TIMEOUT_MS = 1_000;

type OutputStream = 'stdout' | 'stderr';

export class ProcessManager {
  async run(command: string[], options: ProcessOptions): Promise<string> {
    if (process.platform === 'win32')
      throw new Error('Live evaluation requires POSIX process groups (macOS or Linux)');

    options.signal?.throwIfAborted();
    const [executable, ...args] = command;
    if (!executable) throw new Error('Missing executable');

    return ProcessRun.start(executable, args, options);
  }
}

// The auth launcher has its own guardian. Other commands run under a dedicated group owner.
class ProcessRun {
  private readonly stdout: Buffer[] = [];
  private readonly bytes: Record<OutputStream, number> = { stdout: 0, stderr: 0 };
  private diagnosticTail = Buffer.alloc(0);
  private failure: Error | undefined;
  private result = '';

  private constructor(
    private readonly child: ChildProcess,
    private readonly options: ProcessOptions,
    private readonly direct: boolean,
  ) {}

  static start(executable: string, args: string[], options: ProcessOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      const direct = options.termination === 'leader';
      const [command, ...params] = direct
        ? [executable, ...args]
        : supervisorCommand([executable, ...args]);
      const child = spawn(command!, params, {
        cwd: options.directory,
        env: options.env,
        detached: direct,
        stdio: direct ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'],
      });
      new ProcessRun(child, options, direct).supervise(resolve, reject);
    });
  }

  private supervise(resolve: (output: string) => void, reject: (error: Error) => void): void {
    const { child, options } = this;

    child.stdout!.on('data', (chunk: Buffer) => this.receive(chunk, 'stdout'));
    child.stderr!.on('data', (chunk: Buffer) => this.receive(chunk, 'stderr'));
    const result = child.stdio[3];
    result?.on('data', (chunk: Buffer) => {
      if (this.result.length + chunk.length > 256)
        this.stop(new ProcessTeardownError('Supervisor result exceeded its bound'));
      else this.result += chunk.toString();
    });
    child.on('error', (error) => {
      this.failure ??= new Error(`Agent process error: ${error.message}`);
    });

    const timer = setTimeout(
      () => this.stop(new ProcessTimeoutError('Agent timed out')),
      options.timeoutMs,
    );
    const abort = (): void => this.stop(new Error('Evaluation interrupted'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    child.stdin!.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') this.stop(error);
    });

    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (readOutput: () => string) => {
      if (settled) return;
      settled = true;

      clearTimeout(timer);
      clearTimeout(drainTimer);
      options.signal?.removeEventListener('abort', abort);

      try {
        resolve(readOutput());
      } catch (error) {
        reject(error instanceof Error ? error : new ProcessTeardownError('Process failed'));
      }
    };

    child.once('exit', () => {
      if (settled) return;

      // The supervisor has exited, but a descendant can still hold an inherited stream.
      drainTimer = setTimeout(() => {
        settle(() => {
          child.stdout!.destroy();
          child.stderr!.destroy();
          result?.destroy();
          throw new ProcessTeardownError('Process output remained open after exit');
        });
      }, EXIT_DRAIN_TIMEOUT_MS);
    });

    child.once('close', (code, signal) => settle(() => this.finish(code, signal)));

    child.stdin!.end(options.input);
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

  private finish(code: number | null, signal: NodeJS.Signals | null): string {
    if (this.direct) return this.output(code, signal);
    if (!this.result && this.failure && (!this.child.pid || signal === 'SIGTERM'))
      throw this.failure;
    if (code !== 0 || !this.result)
      throw new ProcessTeardownError('Supervisor exited before confirming teardown');

    const outcome = JSON.parse(this.result) as SupervisedOutcome;
    if ('error' in outcome) {
      if (outcome.error === 'spawn')
        throw new Error('Agent process error: executable could not start');
      throw new ProcessTeardownError('Process-group exit could not be verified');
    }
    return this.output(outcome.code, outcome.signal);
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
    if (this.failure) return;
    this.failure = error;
    this.child.kill(this.direct ? 'SIGKILL' : 'SIGTERM');
  }
}
