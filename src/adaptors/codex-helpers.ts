import { createRequire } from 'node:module';

import { mapping } from '../utils/index.ts';

export function validateEvents(events: string): void {
  let completed = false;
  let message = false;

  for (const line of events.split('\n').filter((line) => line.trim())) {
    const event = mapping(JSON.parse(line));
    const type = event.type;
    if (type === 'error' || type === 'turn.failed') throw new Error('Agent turn failed');
    if (type === 'item.started' || type === 'item.completed') {
      const item = mapping(event.item);
      if (item.type !== 'agent_message' && item.type !== 'reasoning') {
        throw new Error(
          `Unexpected tool activity in response-only evaluation: ${String(item.type)}`,
        );
      }
      if (item.type === 'agent_message' && type === 'item.completed') message = true;
    } else if (type === 'turn.completed') completed = true;
    else if (type !== 'thread.started' && type !== 'turn.started')
      throw new Error(`Unknown agent event: ${String(type)}`);
  }

  if (!completed || !message) throw new Error('Incomplete agent event stream');
}

export const DISABLED_FEATURES = [
  'shell_tool',
  'apps',
  'plugins',
  'hooks',
  'memories',
  'multi_agent',
  'browser_use',
  'computer_use',
  'image_generation',
  'view_image',
  'sleep_tool',
  'workspace_dependencies',
  'skill_search',
  'artifact',
  'code_mode',
  'goals',
  'default_mode_request_user_input',
];

export const REQUIRED_FLAGS = [
  '--strict-config',
  '--ignore-user-config',
  '--ignore-rules',
  '--ephemeral',
  '--output-schema',
  '--output-last-message',
  '--json',
];

export function packagedLauncher(): string[] {
  try {
    const entrypoint = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
    // Run the official launcher with the same Bun runtime, without resolving a global codex.
    return [process.execPath, '--no-env-file', '--no-install', entrypoint];
  } catch (cause) {
    throw new Error(
      'Project Codex dependency is missing. Install dependencies or pass --codex PATH.',
      { cause },
    );
  }
}
