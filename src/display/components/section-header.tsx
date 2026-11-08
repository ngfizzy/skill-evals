import type { ReactNode } from 'react';

import { useTheme } from '../hooks/use-theme.ts';
import { BOLD, ink } from '../theme.ts';

export function SectionHeader({
  id,
  title,
  collapsed,
  focused,
  meta,
}: {
  id: string;
  title: string;
  collapsed: boolean;
  focused: boolean;
  meta?: string | undefined;
}): ReactNode {
  const { colors } = useTheme();
  return (
    <text id={id} wrapMode="word">
      <span {...ink(colors.accent, BOLD)}>{focused ? '›' : ' '}</span>{' '}
      <span {...ink(focused ? colors.accent : colors.muted)}>{collapsed ? '▸' : '▾'}</span>{' '}
      <span {...ink(focused ? colors.accent : undefined, BOLD)}>{title}</span>
      {meta ? <span {...ink(colors.muted)}>{`   ${meta}`}</span> : null}
    </text>
  );
}
