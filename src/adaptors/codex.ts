import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { readBounded } from '../utils/index.ts';
import { MAX_OUTPUT, runProcess } from '../process/index.ts';

import type { Agent, AgentRequest } from './types.ts';
import {
  DISABLED_FEATURES,
  packagedLauncher,
  REQUIRED_FLAGS,
  validateEvents,
} from './codex-helpers.ts';

export class CodexAgent implements Agent {
  version = '';
  private readonly launcher: string[];

  constructor(
    executable: string | undefined,
    private readonly timeout: number,
  ) {
    // Resolve explicit relative paths before subprocesses change working directory.
    this.launcher =
      executable === undefined
        ? packagedLauncher()
        : [isAbsolute(executable) || !executable.includes('/') ? executable : resolve(executable)];
  }

  async preflight(signal?: AbortSignal): Promise<void> {
    const probe = (args: string[]): Promise<string> =>
      runProcess([...this.launcher, ...args], {
        input: '',
        timeoutMs: 20_000,
        directory: tmpdir(),
        ...(signal ? { signal } : {}),
      });

    this.version = (await probe(['--version'])).trim();
    // Fail closed on new CLI versions until their available tools and flags are audited.
    if (this.version !== 'codex-cli 0.165.0')
      throw new Error(`Unsupported Codex version: ${this.version}; audited version is 0.165.0`);

    const help = await probe(['exec', '--help']);
    const features = await probe(['features', 'list']);
    const missing = REQUIRED_FLAGS.filter((flag) => !help.includes(flag));
    for (const feature of [...DISABLED_FEATURES, 'skip_host_skill_discovery']) {
      if (
        !features
          .split('\n')
          .some((line) => line.startsWith(`${feature} `) || line.startsWith(`${feature}\t`))
      )
        missing.push(feature);
    }
    if (missing.length) throw new Error(`Codex lacks required options: ${missing.join(', ')}`);
  }

  async call(prompt: string, request: AgentRequest): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'skill-eval-'));
    try {
      const responsePath = join(directory, 'response.json');
      const args = this.command(request.model, responsePath, request.effort ?? 'low');

      if (request.schema) {
        const schemaPath = join(directory, 'schema.json');
        await writeFile(schemaPath, JSON.stringify(request.schema), { mode: 0o600 });
        args.push('--output-schema', schemaPath);
      }

      const events = await runProcess([...args, '-'], {
        input: prompt,
        timeoutMs: this.timeout * 1000,
        directory,
        ...(request.signal ? { signal: request.signal } : {}),
      });

      validateEvents(events);
      const response = (await readBounded(responsePath, MAX_OUTPUT)).trim();
      if (!response) throw new Error('Agent returned an empty response');
      return response;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  // Internal request builder, also used by the explicit localhost isolation audit.
  command(model: string, response: string, effort?: string): string[] {
    if (!effort || !['low', 'medium', 'high', 'xhigh'].includes(effort))
      throw new Error('Invalid reasoning effort');

    const args = [
      ...this.launcher,
      'exec',
      '--strict-config',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--json',
      '--model',
      model,
      '--output-last-message',
      response,
      '--enable',
      'skip_host_skill_discovery',
    ];

    const config = [
      'suppress_unstable_features_warning=true',
      'approval_policy="never"',
      'project_doc_max_bytes=0',
      'web_search="disabled"',
      'mcp_servers={}',
      `model_reasoning_effort=${JSON.stringify(effort)}`,
      'developer_instructions="This is an isolated response evaluation. Do not use tools, access files, or take external actions. Use only the supplied context."',
    ];

    for (const value of config) args.push('-c', value);
    for (const feature of DISABLED_FEATURES) args.push('--disable', feature);
    return args;
  }
}
