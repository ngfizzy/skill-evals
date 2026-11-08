import type { ReactNode } from 'react';

import { useTheme } from '../hooks/use-theme.ts';
import { BOLD, ink } from '../theme.ts';
import { toneColor } from '../view-model.ts';
import type { Tone } from '../view-model.ts';

/** Each count is its own text so narrow terminals wrap between counts, never inside one. */
export function Count({
  icon,
  value,
  label,
  tone,
}: {
  icon: string;
  value: number;
  label: string;
  tone: Tone;
}): ReactNode {
  const { colors } = useTheme();
  return (
    <text
      wrapMode="none"
      flexShrink={0}
      {...ink(value ? toneColor(colors, tone) : colors.muted, value ? BOLD : 0)}
    >{`${icon} ${value} ${label}`}</text>
  );
}
