// Launcher process entrypoint: reads one request on stdin and writes newline-delimited events on
// stdout. AuthService runs it in a separate process so native Codex inherits only the lease.
import { AuthError } from './errors.ts';
import { AuthLauncherJob } from './operations.ts';
import { readAuthRequest, serializeAuthEvent } from './protocol.ts';
import type { AuthEvent } from './types.ts';

if (import.meta.main) {
  const emit = (event: AuthEvent) => process.stdout.write(serializeAuthEvent(event));

  try {
    await AuthLauncherJob.run(await readAuthRequest(process.stdin), emit);
  } catch (error) {
    emit({ type: 'error', code: error instanceof AuthError ? error.code : 'operation-failed' });
    process.exitCode = 2;
  }
}
