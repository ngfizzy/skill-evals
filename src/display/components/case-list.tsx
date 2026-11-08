import type { ReactNode } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import type { Ref } from 'react';

import { singleLine } from '../../utils/index.ts';
import type { EvaluationCase } from '../../evaluation/index.ts';
import { useTheme } from '../hooks/use-theme.ts';
import { BOLD, borderInk, fillInk, ink } from '../theme.ts';
import { CASE_STATUS, toneColor } from '../view-model.ts';
import type { CaseState } from '../view-model.ts';

const SHORT_LABEL: Record<CaseState, string> = {
  passed: 'pass',
  failed: 'fail',
  error: 'error',
  running: 'running',
  pending: 'queued',
  'not-run': 'not run',
};

export interface CaseListProps {
  entries: readonly Readonly<EvaluationCase>[];
  states: CaseState[];
  selected: number;
  width: number;
  listRef: Ref<ScrollBoxRenderable>;
}

/** Navigation only: keys may be cut at the pane edge here, while the reading pane always shows them in full. */
export function CaseList({ entries, states, selected, width, listRef }: CaseListProps): ReactNode {
  const { colors } = useTheme();
  return (
    <box
      flexDirection="column"
      width={width}
      flexShrink={0}
      border={['right']}
      {...borderInk(colors.rule)}
    >
      <text wrapMode="none" paddingX={1} marginBottom={1}>
        <span {...ink(colors.muted, BOLD)}>CASES</span>
        <span {...ink(colors.muted)}>
          {entries.length ? `  ${selected + 1} of ${entries.length}` : ''}
        </span>
      </text>
      <scrollbox
        ref={listRef}
        flexGrow={1}
        flexShrink={1}
        contentOptions={{ flexDirection: 'column' }}
      >
        {entries.map((entry, index) => {
          const status = CASE_STATUS[states[index] ?? 'pending'];
          const active = index === selected;
          // Selection is the › marker plus bold. A fill appears only when the theme is known, always paired
          // with its own foreground; never inverse video, which some renderers capture as identical colors.
          return (
            <box
              key={entry.key}
              id={`case-${index}`}
              flexShrink={0}
              paddingX={1}
              {...(active ? fillInk(colors.selectedBg) : {})}
            >
              <text wrapMode="none" truncate>
                <span {...ink(colors.accent, BOLD)}>{active ? '›' : ' '}</span>{' '}
                <span
                  {...ink(toneColor(colors, status.tone))}
                >{`${status.icon} ${SHORT_LABEL[states[index] ?? 'pending'].padEnd(8)}`}</span>
                <span {...ink(active ? colors.selectedFg : undefined, active ? BOLD : 0)}>
                  {singleLine(entry.key)}
                </span>
              </text>
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}
