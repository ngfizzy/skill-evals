import { AuthError, AuthService } from '../auth/index.ts';
import { AUTH_OPERATIONS, type AuthOperation } from '../auth/contracts/types.ts';

import type { RunIO } from './types.ts';

export const AUTH_HELP = `Usage: skill-evals auth <login|status|logout>

  login   Sign in to the dedicated evaluation store with ChatGPT
  status  Check local sign-in state
  logout  Remove the dedicated evaluation login`;

export async function runAuthCommand(
  args: string[],
  io: RunIO,
  signal?: AbortSignal,
): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    io.out(AUTH_HELP);
    return 0;
  }

  const operation = AUTH_OPERATIONS.find((candidate) => candidate === args[0]);
  if (args.length !== 1 || !operation)
    throw new Error('Usage: skill-evals auth <login|status|logout>');

  try {
    io.out(await authenticate(operation, io, signal));
    return 0;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('operation-failed');
  }
}

async function authenticate(operation: AuthOperation, io: RunIO, signal?: AbortSignal) {
  return await new AuthService().execute(operation, {
    ...(signal && { signal }),
    onEvent(event) {
      if (event.type === 'login-url') io.out(event.url);
    },
  });
}
