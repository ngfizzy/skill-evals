import { spawn } from 'node:child_process';

import type { AuthContext } from './context.ts';
import { AuthError } from './errors.ts';
import { LineBuffer } from './lines.ts';
import { loginUrl } from './protocol.ts';
import type { AuthEvent } from './types.ts';

const MAX_NATIVE_OUTPUT_BYTES = 2_097_152;

export interface NativeAuthCommand {
  executable: string;
  args: string[];
  context: AuthContext;
  // Passed to the child as fd 3 so the native process holds the lock for its whole lifetime.
  lockFd: number;
  timeoutMs: number;
  onEvent?: (event: AuthEvent) => void;
}

export interface NativeAuthResult {
  code: number | null;
  stdout: string;
}

type OutputStream = 'stdout' | 'stderr';

export function runNativeAuth(command: NativeAuthCommand): Promise<NativeAuthResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.context.directory,
      env: command.context.env,
      stdio: ['ignore', 'pipe', 'pipe', command.lockFd],
    });
    const output = new NativeOutput(command.onEvent);
    let failed = false;

    const fail = () => {
      failed = true;
      child.kill('SIGKILL');
      // Let the launcher exit so its parent's supervisor kills pipe-holding descendants.
      reject(new AuthError('operation-failed'));
    };
    const receive = (chunk: Buffer, stream: OutputStream) => {
      try {
        output.receive(chunk, stream);
      } catch {
        fail();
      }
    };

    child.stdout!.on('data', (chunk: Buffer) => receive(chunk, 'stdout'));
    child.stderr!.on('data', (chunk: Buffer) => receive(chunk, 'stderr'));
    child.once('error', fail);
    const timer = setTimeout(fail, command.timeoutMs);

    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        if (failed) throw new AuthError('operation-failed');
        resolve({ code, stdout: output.finish() });
      } catch {
        reject(new AuthError('operation-failed'));
      }
    });
  });
}

// Collects stdout and announces login URLs from complete lines on either stream.
// Native diagnostics are scanned for the URL only and never retained.
class NativeOutput {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly stdout: string[] = [];
  private readonly lines: Record<OutputStream, LineBuffer> = {
    stdout: new LineBuffer(),
    stderr: new LineBuffer(),
  };
  private bytes = 0;
  private announcedUrl: string | undefined;

  constructor(private readonly onEvent?: (event: AuthEvent) => void) {}

  // Throws when output exceeds its bound or stdout is not valid UTF-8.
  receive(chunk: Buffer, stream: OutputStream): void {
    this.bytes += chunk.length;
    if (this.bytes > MAX_NATIVE_OUTPUT_BYTES) throw new AuthError('operation-failed');

    const text =
      stream === 'stdout' ? this.decoder.decode(chunk, { stream: true }) : chunk.toString('utf8');
    if (stream === 'stdout') this.stdout.push(text);
    for (const line of this.lines[stream].push(text)) this.announce(line);
  }

  finish(): string {
    this.stdout.push(this.decoder.decode());
    this.announce(this.lines.stdout.remainder);
    this.announce(this.lines.stderr.remainder);
    return this.stdout.join('');
  }

  private announce(text: string): void {
    const url = loginUrl(text);
    if (!url || url === this.announcedUrl) return;

    this.announcedUrl = url;
    this.onEvent?.({ type: 'login-url', url });
  }
}
