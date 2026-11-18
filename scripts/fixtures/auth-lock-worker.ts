// Holds the production credential lock, then starts native Codex against a local mock provider with
// the lease inherited as fd 3. Prints the native PID once spawned and exits when native Codex does.
// Used only by scripts/audit-auth-lock.ts.
// Usage: auth-lock-worker.ts <store-json> <workspace> <codex-executable> <response-path> <mock-port>
import { spawn } from 'node:child_process';

import { CodexAgent } from '../../src/adaptors/codex.ts';
import { createAuthContext } from '../../src/auth/runtime/context.ts';
import { CredentialLock } from '../../src/auth/credentials/lock.ts';
import type { AuthStoreLocation } from '../../src/auth/contracts/types.ts';

const [storeJson, workspace, executable, responsePath, mockPort] = process.argv.slice(2);

if (!storeJson || !workspace || !executable || !responsePath || !mockPort) {
  console.error('Usage: auth-lock-worker.ts <store> <workspace> <codex> <response> <port>');
  process.exit(2);
}

const store = JSON.parse(storeJson) as AuthStoreLocation;

const lease = await CredentialLock.acquire(store);
const context = await createAuthContext(store, workspace);

const args = new CodexAgent(executable, 20).command('gpt-6.1-sol', responsePath, 'low');

for (const config of mockProviderConfig(mockPort)) args.push('-c', config);

const child = spawn(args[0]!, [...args.slice(1), '-'], {
  cwd: context.directory,
  env: context.env,
  stdio: ['pipe', 'ignore', 'ignore', lease.fd],
});

child.once('spawn', () => {
  console.log(child.pid);
  child.stdin!.end('Synthetic lock lifetime audit.');
});
child.once('error', () => process.exit(2));
child.once('exit', () => process.exit(0));

// Route the model request to the audit's localhost server, with OpenAI authentication disabled.
function mockProviderConfig(port: string): string[] {
  return [
    'model_provider="fixture"',
    'model_providers.fixture.name="Lock Fixture"',
    `model_providers.fixture.base_url="http://127.0.0.1:${port}/v1"`,
    'model_providers.fixture.wire_api="responses"',
    'model_providers.fixture.requires_openai_auth=false',
    'model_providers.fixture.request_max_retries=0',
    'model_providers.fixture.stream_max_retries=0',
  ];
}
