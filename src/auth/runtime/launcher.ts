// Launcher process entrypoint: reads one request on stdin and writes newline-delimited events on
// stdout. AuthService runs it in a separate process so native Codex inherits only the lease.

import { AuthError } from '../contracts/errors.ts';
import { readAuthRequest, serializeAuthEvent } from '../contracts/protocol.ts';
import type { AuthEvent } from '../contracts/types.ts';

import { AuthLauncherJob } from './operations.ts';

if (import.meta.main) {
  const emit = (event: AuthEvent) => process.stdout.write(serializeAuthEvent(event));

  try {
    await AuthLauncherJob.run(await readAuthRequest(process.stdin), emit);
  } catch (error) {
    emit({ type: 'error', code: error instanceof AuthError ? error.code : 'operation-failed' });
    process.exitCode = 2;
  }
}
