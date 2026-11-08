import type { ReactNode } from 'react';

import { singleLine } from '../../utils/index.ts';
import type { Summary } from '../../report/index.ts';
import { useTheme } from '../hooks/use-theme.ts';
import { BOLD, borderInk, ink } from '../theme.ts';
import { CASE_STATUS, progressCells } from '../view-model.ts';
import type { StatusStyle } from '../view-model.ts';

import { Badge } from './badge.tsx';
import { Count } from './count.tsx';

export interface HeaderProps {
  run: StatusStyle;
  elapsed?: string | undefined;
  model: string;
  judge: string;
  phase?: string | undefined;
  reportName: string;
  summary: Summary;
  total: number;
  barWidth: number;
}

export function Header({
  run,
  elapsed,
  model,
  judge,
  phase,
  reportName,
  summary,
  total,
  barWidth,
}: HeaderProps): ReactNode {
  const { colors, color } = useTheme();
  const done = Math.max(0, total - summary.pending);
  const { filled, empty } = progressCells(done, total, barWidth);
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
      border={['bottom']}
      {...borderInk(colors.rule)}
    >
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text wrapMode="none" flexShrink={0}>
          <span {...ink(colors.accent, BOLD)}>skill-evals</span>
          {'  '}
          <Badge status={run} />
          {elapsed ? <span {...ink(colors.muted)}>{`  ${elapsed}`}</span> : null}
        </text>
        <text wrapMode="none" truncate flexShrink={1} {...ink(colors.muted)}>
          {reportName}
        </text>
      </box>
      <text wrapMode="word">
        <span {...ink(colors.muted)}>operator </span>
        {singleLine(model)}
        <span {...ink(colors.muted)}>{'  →  grader '}</span>
        {singleLine(judge)}
        {phase ? <span {...ink(colors.muted)}>{'  ·  '}</span> : null}
        {phase ? <span {...ink(colors.accent)}>{phase}</span> : null}
      </text>
      <box flexDirection="row" flexWrap="wrap" columnGap={3}>
        <text wrapMode="none" flexShrink={0}>
          <span {...ink(colors.accent, color ? 0 : BOLD)}>
            {(color ? '━' : '█').repeat(filled)}
          </span>
          <span {...ink(colors.rule)}>{(color ? '─' : '░').repeat(empty)}</span>
          {'  '}
          <span {...ink(undefined, BOLD)}>{`${done}/${total}`}</span>
          <span {...ink(colors.muted)}> complete</span>
        </text>
        <Count icon={CASE_STATUS.passed.icon} value={summary.passed} label="passed" tone="pass" />
        <Count icon={CASE_STATUS.failed.icon} value={summary.failed} label="failed" tone="fail" />
        <Count
          icon={CASE_STATUS.error.icon}
          value={summary.errors}
          label={summary.errors === 1 ? 'error' : 'errors'}
          tone="error"
        />
        <Count
          icon={CASE_STATUS.pending.icon}
          value={summary.pending}
          label="pending"
          tone="muted"
        />
      </box>
    </box>
  );
}
