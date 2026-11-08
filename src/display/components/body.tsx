import type { ReactNode } from 'react';

import { terminalText } from '../../utils/index.ts';
import type { ResultSection } from '../types.ts';
import { useTheme } from '../hooks/use-theme.ts';
import { ink } from '../theme.ts';

export function Body({ section }: { section: ResultSection }): ReactNode {
  const { colors } = useTheme();
  if (section.placeholder)
    return (
      <text wrapMode="word" {...ink(colors.muted)}>
        {section.text}
      </text>
    );
  return (
    <text wrapMode="word" selectable>
      {terminalText(section.text)}
    </text>
  );
}
