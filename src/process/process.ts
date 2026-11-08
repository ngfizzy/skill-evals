import { spawn } from 'node:child_process';

import type { ProcessOptions } from './types.ts';

export async function runProcess(command: string[], options: ProcessOptions): Promise<string> {
  if (process.platform === 'win32')
    throw new Error('Live evaluation requires POSIX process groups (macOS or Linux)');
  options.signal?.throwIfAborted();
  const executable = command[0];
  if (!executable) throw new Error('Missing executable');

  return new Promise((resolve, reject) => {
    const child = spawn(executable, command.slice(1), {
      cwd: options.directory,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    let bytes = 0;
    let diagnosticTail = Buffer.alloc(0);
    let failure: Error | undefined;

    const cleanup = (): void => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          child.kill('SIGKILL');
          failure ??= new Error('Process-group cleanup denied; terminated the agent process');
        }
      }
    };
    const stop = (error: Error): void => {
      failure ??= error;
      cleanup();
    };

    const receive = (chunk: Buffer, stdout: boolean): void => {
      bytes += chunk.length;
      diagnosticTail = Buffer.concat([diagnosticTail, chunk]).subarray(-3000);
      if (bytes > MAX_OUTPUT) stop(new Error(`Agent output exceeded ${MAX_OUTPUT} bytes`));
      else if (stdout) chunks.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => receive(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => receive(chunk, false));
    child.on('error', (error) => {
      failure ??= new Error(`Agent process error: ${error.message}`);
    });

    // A successful leader can leave children holding the pipes open. Kill the group on
    // exit, before waiting for close, as well as on timeout, abort and output overflow.
    child.on('exit', cleanup);

    const timer = setTimeout(() => stop(new Error('Agent timed out')), options.timeoutMs);
    const abort = (): void => stop(new Error('Evaluation interrupted'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    child.stdin.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      cleanup();

      if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error(`Agent exited ${code ?? signal}: ${diagnosticTail.toString('utf8')}`));
      else {
        try {
          resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        } catch {
          reject(new Error('Agent output is not valid UTF-8'));
        }
      }
    });

    child.stdin.end(options.input);
  });
}

export const MAX_OUTPUT = 2_097_152;
