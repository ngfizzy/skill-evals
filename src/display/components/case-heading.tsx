import type { ReactNode } from 'react';

import { singleLine } from '../../utils/index.ts';
import type { EvaluationCase } from '../../evaluation/index.ts';
import { useTheme } from '../hooks/use-theme.ts';
import { BOLD, ink } from '../theme.ts';
import type { StatusStyle } from '../view-model.ts';

import { Badge } from './badge.tsx';

export function CaseHeading({
  entry,
  status,
  detail,
  position,
  note,
}: {
  entry: EvaluationCase;
  status: StatusStyle;
  detail: string;
  position: string;
  note?: string | undefined;
}): ReactNode {
  const { colors } = useTheme();
  return (
    <box flexDirection="column" flexShrink={0} marginBottom={1}>
      <text wrapMode="word">
        <Badge status={status} />
        {'  '}
        <span {...ink(undefined, BOLD)}>{singleLine(entry.key)}</span>
      </text>
      <text wrapMode="word">{singleLine(entry.title)}</text>
      <text wrapMode="word" {...ink(colors.muted)}>
        {[detail, position, note].filter(Boolean).join('  ·  ')}
      </text>
    </box>
  );
}
