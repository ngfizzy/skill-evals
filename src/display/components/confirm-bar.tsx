import type { ReactNode } from 'react';

import { useTheme } from '../hooks/use-theme.ts';
import { BOLD, borderInk, fillInk, ink } from '../theme.ts';

export function ConfirmBar(): ReactNode {
  const { colors } = useTheme();
  // Without a palette the ■ icon, bold text and top rule mark the prompt; inverse video is not used.
  const text = ink(colors.alertFg, BOLD);
  return (
    <box
      flexShrink={0}
      paddingX={1}
      border={['top']}
      {...borderInk(colors.fail)}
      {...fillInk(colors.alertBg)}
    >
      <text wrapMode="word" {...text}>
        ■ Stop this run and save partial results? y stop n keep running
      </text>
    </box>
  );
}
