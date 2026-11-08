import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexAgent } from '../src/adaptors/index.ts';
import { runProcess } from '../src/process/index.ts';

// Explicit integration audit: the actual Codex request targets a localhost mock,
// with OpenAI authentication disabled for that provider. Never record headers or
// prompt bodies. Only model, reasoning effort and tool names/counts are retained in memory.
interface AuditRequest {
  model: string;
  effort?: string;
  tools: unknown[];
}
const requests: AuditRequest[] = [];
const server = http.createServer(async (request, response) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2_097_152) throw new Error('Audit request exceeded bound');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString();
    if (!raw) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    const data = JSON.parse(raw);
    if (request.url === '/v1/responses') {
      requests.push({ model: data.model, effort: data.reasoning?.effort, tools: data.tools ?? [] });
    }
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        error: { message: 'Synthetic schema audit complete', type: 'invalid_request_error' },
      }),
    );
  } catch {
    response.writeHead(400);
    response.end();
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const directory = await mkdtemp(join(tmpdir(), 'skill-evals-tool-audit-'));
try {
  const agent = new CodexAgent(undefined, 20);
  await agent.preflight();
  // Exercise the exact builder with independently configured candidate/judge efforts.
  for (const effort of ['high', 'medium']) {
    const command = agent.command(
      'gpt-6.1-sol',
      join(directory, `response-${effort}.json`),
      effort,
    );
    for (const config of [
      'model_provider="audit"',
      'model_providers.audit.name="Synthetic Audit"',
      `model_providers.audit.base_url="http://127.0.0.1:${address.port}/v1"`,
      'model_providers.audit.wire_api="responses"',
      'model_providers.audit.requires_openai_auth=false',
      'model_providers.audit.request_max_retries=0',
      'model_providers.audit.stream_max_retries=0',
    ])
      command.push('-c', config);
    // The mock intentionally ends each call with HTTP 400 after inspecting its schema.
    await runProcess([...command, '-'], {
      input: 'Reply ready. Synthetic tool-schema audit.',
      directory,
      timeoutMs: 20_000,
    }).catch(() => {});
  }
  assert.equal(requests.length, 2, 'Expected two captured Responses requests');
  assert.deepEqual(
    requests.map((request) => request.effort),
    ['high', 'medium'],
    'Reasoning effort was not forwarded',
  );
  for (const request of requests) {
    assert.equal(request.model, 'gpt-6.1-sol');
    assert.deepEqual(request.tools, [], 'Model request exposed tools');
  }
  console.log(
    `${agent.version}: candidate/judge effort high/medium verified; zero tools (localhost mock; no model calls).`,
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(directory, { recursive: true, force: true });
}
