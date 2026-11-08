import type { Agent, ModelSettings } from '../adaptors/index.ts';
import { candidatePrompt } from '../prompts/index.ts';
import { message } from '../utils/index.ts';

import type { OperatorInput, OperatorOutcome } from './types.ts';

export class Operator {
  constructor(
    private readonly adapter: Agent,
    private readonly settings: Readonly<ModelSettings>,
  ) {}

  async respond({ entry, bundle, signal, onStart }: OperatorInput): Promise<OperatorOutcome> {
    const prompt = candidatePrompt(entry, bundle);
    try {
      onStart?.();
      const response = await this.adapter.call(prompt, {
        ...this.settings,
        ...(signal ? { signal } : {}),
      });
      return { prompt, response };
    } catch (error) {
      return { prompt, error: message(error) };
    }
  }
}
