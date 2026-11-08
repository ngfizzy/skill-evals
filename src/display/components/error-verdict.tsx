import type { ReactNode } from 'react';

import type { CaseResult } from '../../evaluation/index.ts';
import { useTheme } from '../hooks/use-theme.ts';
import { ink } from '../theme.ts';
import { CASE_STATUS } from '../view-model.ts';

import { Badge } from './badge.tsx';
import { Quote } from './quote.tsx';

export function ErrorVerdict({ result }: { result: CaseResult }): ReactNode {
  const { colors } = useTheme();

  return (
    <box flexDirection="column" flexShrink={0}>
      <text wrapMode="word">
        <Badge status={CASE_STATUS.error} />
        <span
          {...ink(colors.muted)}
        >{`  unscored · ${result.error_stage ?? 'execution'} stage`}</span>
      </text>
      <Quote text={result.error ?? 'No error details recorded.'} />
      <text wrapMode="word" marginTop={1} {...ink(colors.muted)}>
        {`Errors are excluded from scoring.${result.judgment !== undefined ? ' The raw judgment below is unvalidated and is not a verdict.' : ''}`}
      </text>
    </box>
  );
}
