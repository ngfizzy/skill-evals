import type { ReactNode } from 'react';

import { singleLine, terminalText } from '../../utils/index.ts';
import type { VerdictItem } from '../types.ts';
import { useTheme } from '../hooks/use-theme.ts';
import { BOLD, ink } from '../theme.ts';
import { toneColor } from '../view-model.ts';

import { Quote } from './quote.tsx';

export function AssertionItem({ item }: { item: VerdictItem }): ReactNode {
  const { colors } = useTheme();
  return (
    <box flexDirection="column" flexShrink={0} marginBottom={1}>
      <text wrapMode="word">
        <span {...ink(toneColor(colors, item.passed ? 'pass' : 'fail'), BOLD)}>
          {item.passed ? '✓ PASS' : '✗ FAIL'}
        </span>{' '}
        <span {...ink(undefined, BOLD)}>{singleLine(item.id)}</span>
        <span {...ink(colors.muted)}>{` · ${item.required ? 'Must' : 'Must not'}`}</span>
      </text>
      <box flexDirection="column" flexShrink={0} paddingLeft={2}>
        <text wrapMode="word">{terminalText(item.text)}</text>
        <text wrapMode="word">
          <span {...ink(colors.muted, BOLD)}>{'Reason  '}</span>
          {terminalText(item.reason)}
        </text>
        {item.evidence !== undefined ? (
          <box flexDirection="column" flexShrink={0}>
            <text wrapMode="none" {...ink(colors.muted, BOLD)}>
              Evidence
            </text>
            <Quote text={item.evidence} />
          </box>
        ) : (
          <text wrapMode="word">
            <span {...ink(colors.muted, BOLD)}>{'Evidence  '}</span>
            <span {...ink(colors.muted)}>{`(${item.note})`}</span>
          </text>
        )}
      </box>
    </box>
  );
}
