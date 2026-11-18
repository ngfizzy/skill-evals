import { z } from 'zod';

import { AUTH_ERROR_CODES, AuthError } from './errors.ts';
import { AUTH_OPERATIONS, AUTH_STATES, type AuthEvent, type AuthLauncherRequest } from './types.ts';

const MAX_LAUNCHER_REQUEST_BYTES = 65_536;

const MAX_NATIVE_TIMEOUT_MS = 15 * 60_000;
const MAX_LOCK_WAIT_MS = 120_000;

const LOGIN_ORIGIN = 'https://auth.openai.com';
const LOGIN_PATHS = new Set(['/oauth/authorize', '/codex/device']);
const LOGIN_QUERY_KEYS = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'id_token_add_organizations',
  'codex_cli_simplified_flow',
  'originator',
  'prompt',
]);
const HTTPS_URL = /https:\/\/[^\s<>"']+/g;

export const authRequestSchema = z
  .object({
    operation: z.enum(AUTH_OPERATIONS),
    store: z
      .object({
        directory: z.string().min(1),
        authFile: z.string().min(1),
        normalDirectory: z.string().min(1),
      })
      .strict(),
    nativeExecutable: z.string().min(1),
    timeoutMs: z.number().int().positive().max(MAX_NATIVE_TIMEOUT_MS),
    lockWaitMs: z.number().int().positive().max(MAX_LOCK_WAIT_MS),
    workspace: z.string().min(1),
  })
  .strict() satisfies z.ZodType<AuthLauncherRequest>;

export const authEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('login-url'), url: z.string().url() }).strict(),
  z.object({ type: z.literal('state'), state: z.enum(AUTH_STATES) }).strict(),
  z.object({ type: z.literal('error'), code: z.enum(AUTH_ERROR_CODES) }).strict(),
]) satisfies z.ZodType<AuthEvent>;

// Returns the first native ChatGPT login URL in the text. Any other URL is ignored.
export function loginUrl(text: string): string | undefined {
  for (const [candidate] of text.matchAll(HTTPS_URL)) {
    const url = URL.parse(candidate);
    if (url && isNativeLoginUrl(url)) return url.href;
  }
}

// Reads the launcher's single JSON request from its input stream.
export async function readAuthRequest(
  input: AsyncIterable<string | Buffer>,
): Promise<AuthLauncherRequest> {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let bytes = 0;

    for await (const chunk of input) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += buffer.length;
      if (bytes > MAX_LAUNCHER_REQUEST_BYTES) throw new AuthError('operation-failed');
      text += decoder.decode(buffer, { stream: true });
    }

    return authRequestSchema.parse(JSON.parse(text + decoder.decode()));
  } catch {
    throw new AuthError('operation-failed');
  }
}

// Launcher events travel as newline-delimited JSON.
export function serializeAuthEvent(event: AuthEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function parseAuthEvent(text: string): AuthEvent {
  try {
    const event = authEventSchema.parse(JSON.parse(text));

    if (event.type === 'login-url' && loginUrl(event.url) !== event.url)
      throw new AuthError('operation-failed');

    return event;
  } catch {
    throw new AuthError('operation-failed');
  }
}

function isNativeLoginUrl(url: URL): boolean {
  return (
    url.origin === LOGIN_ORIGIN &&
    !url.username &&
    !url.password &&
    !url.hash &&
    LOGIN_PATHS.has(url.pathname) &&
    [...url.searchParams.keys()].every((key) => LOGIN_QUERY_KEYS.has(key))
  );
}
