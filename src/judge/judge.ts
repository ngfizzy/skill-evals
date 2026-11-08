import type { Agent, ModelSettings } from '../adaptors/index.ts';
import { responseSegments, type ResponseSegment } from '../evaluation/protocol.ts';
import { judgePrompt } from '../prompts/index.ts';
import { message } from '../utils/index.ts';

import { validateJudgments } from './helpers.ts';
import { judgeSchema } from './output-schema.ts';
import type { JudgeInput, JudgeOutcome } from './types.ts';

export class Judge {
  constructor(
    private readonly adapter: Agent,
    private readonly settings: Readonly<ModelSettings>,
  ) {}

  async judge({ entry, bundle, response, signal, onStart }: JudgeInput): Promise<JudgeOutcome> {
    let segments: ResponseSegment[];
    let judgment: string;

    try {
      onStart?.();
      segments = responseSegments(response);
      judgment = await this.adapter.call(judgePrompt(entry, response, bundle, segments), {
        ...this.settings,
        schema: judgeSchema(entry.criteria),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      return { stage: 'judge', error: message(error) };
    }

    try {
      const assertions = validateJudgments(JSON.parse(judgment), entry.criteria, segments);
      return { judgment, assertions };
    } catch (error) {
      return { stage: 'grading', error: message(error), judgment };
    }
  }
}
