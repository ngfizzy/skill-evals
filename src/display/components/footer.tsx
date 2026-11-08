import type { ReactNode } from 'react';

import { useTheme } from '../hooks/use-theme.ts';
import { BOLD, borderInk, ink } from '../theme.ts';

export function Footer({ keys }: { keys: [string, string][] }): ReactNode {
  const { colors } = useTheme();
  return (
    <box
      flexShrink={0}
      flexDirection="row"
      flexWrap="wrap"
      columnGap={3}
      paddingX={1}
      border={['top']}
      {...borderInk(colors.rule)}
    >
      {keys.map(([key, label]) => (
        <text key={key} wrapMode="none" flexShrink={0}>
          <span {...ink(colors.accent, BOLD)}>{key}</span>
          <span {...ink(colors.muted)}>{` ${label}`}</span>
        </text>
      ))}
    </box>
  );
}
