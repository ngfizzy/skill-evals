import type { ReactNode } from 'react';

import { useTheme } from '../hooks/use-theme.ts';
import { BOLD, ink } from '../theme.ts';
import { toneColor } from '../view-model.ts';
import type { Tone } from '../view-model.ts';

/** Owned explanatory line for waiting or missing content; never used for recorded text. */
export function Notice({
  icon,
  tone,
  children,
}: {
  icon: string;
  tone: Tone;
  children: string;
}): ReactNode {
  const { colors } = useTheme();
  return (
    <text wrapMode="word">
      <span {...ink(toneColor(colors, tone), BOLD)}>{icon} </span>
      <span {...ink(colors.muted)}>{children}</span>
    </text>
  );
}
