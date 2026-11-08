import type { ReactNode } from 'react';

import type { CaseResult } from '../../evaluation/index.ts';
import { verdictItems } from '../sections.ts';

import { AssertionItem } from './assertion-item.tsx';

export function GradedVerdict({ result }: { result: CaseResult }): ReactNode {
  return (
    <box flexDirection="column" flexShrink={0}>
      {verdictItems(result).map((item) => (
        <AssertionItem key={item.id} item={item} />
      ))}
    </box>
  );
}
