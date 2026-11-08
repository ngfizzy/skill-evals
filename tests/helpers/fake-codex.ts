#!/usr/bin/env -S bun --no-env-file --no-install
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

import type { Criterion } from '../../src/evaluation/index.ts';
const args = process.argv.slice(2);
const features = [
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
  'skip_host_skill_discovery',
];
const flags = [
  '--strict-config',
  '--ignore-user-config',
  '--ignore-rules',
  '--ephemeral',
  '--output-schema',
  '--output-last-message',
  '--json',
];
if (args.join() === '--version') console.log(process.env.FAKE_VERSION ?? 'codex-cli 0.165.0');
else if (args.includes('--help'))
  console.log(flags.filter((flag) => flag !== process.env.FAKE_MISSING).join(' '));
else if (args.join() === 'features,list')
  console.log(
    features
      .filter((feature) => feature !== process.env.FAKE_MISSING)
      .map((feature) => `${feature} stable true`)
      .join('\n'),
  );
else {
  const prompt = readFileSync(0, 'utf8');
  const responsePath = args[args.indexOf('--output-last-message') + 1]!;
  if (process.env.FAKE_LOG)
    appendFileSync(
      process.env.FAKE_LOG,
      JSON.stringify({ args, prompt, cwd: process.cwd() }) + '\n',
    );
  if (process.env.FAKE_DELAY_MS)
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_DELAY_MS)));
  let response = 'Routine. Keep this bounded.';
  if (args.includes('--output-schema')) {
    const payload: { criteria: Criterion[] } = JSON.parse(prompt.split('EVALUATION DATA:\n')[1]!);
    response =
      process.env.FAKE_MODE === 'invalid'
        ? 'invalid JSON'
        : JSON.stringify({
            assertions: payload.criteria.map((criterion) => ({
              id: criterion.id,
              passed: process.env.FAKE_MODE !== 'fail',
              reason: 'Observed',
              evidence_ids: ['line-1'],
            })),
          });
  }
  if (process.env.FAKE_MODE !== 'missing-response') writeFileSync(responsePath, response);
  if (process.env.FAKE_MODE === 'invalid-event') console.log('invalid');
  else {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic' }));
    console.log(JSON.stringify({ type: 'turn.started' }));
    console.log(
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: process.env.FAKE_MODE === 'tool' ? 'command_execution' : 'agent_message',
          text: response,
        },
      }),
    );
    if (process.env.FAKE_MODE !== 'incomplete')
      console.log(JSON.stringify({ type: 'turn.completed' }));
  }
}
