import { AuthError } from '../contracts/errors.ts';
import { parseAuthEvent } from '../contracts/protocol.ts';
import type { AuthEvent, AuthState } from '../contracts/types.ts';

import { LineBuffer } from './lines.ts';

// Reads the launcher's newline-delimited JSON events and tracks the reported outcome.
// Every failure surfaces as an AuthError, so launcher output never reaches diagnostics.
export class LauncherEventReader {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly lines = new LineBuffer();

  private state: AuthState | undefined;
  failure: AuthError | undefined;

  constructor(private readonly onEvent?: (event: AuthEvent) => void) {}

  // Throws on malformed output or an error event so the process manager stops the launcher.
  consume(chunk: Buffer): void {
    for (const line of this.lines.push(this.decode(chunk))) {
      const event = parseAuthEvent(line);

      if (event.type === 'error') this.failure = new AuthError(event.code);

      if (event.type === 'state') this.state = event.state;

      this.onEvent?.(event);
      if (this.failure) throw this.failure;
    }
  }

  // A clean run ends with a state event and no partial trailing output.
  finalState(): AuthState {
    const trailing = this.lines.remainder + this.decode();
    if (trailing || !this.state || this.failure)
      throw this.failure ?? new AuthError('operation-failed');

    return this.state;
  }

  // Without a chunk, flushes the decoder; an incomplete trailing character is malformed output.
  private decode(chunk?: Buffer): string {
    try {
      return chunk ? this.decoder.decode(chunk, { stream: true }) : this.decoder.decode();
    } catch {
      throw new AuthError('operation-failed');
    }
  }
}
