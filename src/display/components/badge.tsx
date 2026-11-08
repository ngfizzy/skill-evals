import type { ReactNode } from 'react';

import { useTheme } from '../hooks/use-theme.ts';
import { BOLD, ink } from '../theme.ts';
import { toneColor } from '../view-model.ts';
import type { StatusStyle } from '../view-model.ts';

export function Badge({ status }: { status: StatusStyle }): ReactNode {
  const { colors } = useTheme();
  return (
    <span {...ink(toneColor(colors, status.tone), BOLD)}>{`${status.icon} ${status.label}`}</span>
  );
}
