import type { ReactNode } from 'react';

import { terminalText } from '../../utils/index.ts';
import { useTheme } from '../hooks/use-theme.ts';
import { borderInk } from '../theme.ts';

/** Recorded content, shown complete and escaped, set off by a quiet bar rather than a full frame. */
export function Quote({ text }: { text: string }): ReactNode {
  const { colors } = useTheme();
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border={['left']}
      paddingLeft={1}
      {...borderInk(colors.quote)}
    >
      <text wrapMode="word" selectable>
        {terminalText(text)}
      </text>
    </box>
  );
}
