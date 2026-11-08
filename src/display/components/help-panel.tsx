import type { ReactNode } from 'react';

import { singleLine } from '../../utils/index.ts';
import { useTheme } from '../hooks/use-theme.ts';
import { BOLD, ink } from '../theme.ts';

const HELP_KEYS: [string, string][] = [
  ['[ and ]', 'Previous / next case'],
  ['Tab / Shift-Tab', 'Select the next / previous section'],
  ['Enter', 'Open or close the selected section'],
  ['s', 'Open or close the loaded skill'],
  ['p', 'Open or close the exact operator prompt'],
  ['↑ ↓ PgUp PgDn', 'Scroll the reading pane'],
  ['Home / End', 'Jump to top / bottom'],
  ['f', 'Follow the case that is running now'],
  ['? or Esc', 'Close this help'],
  ['q', 'Close when finished; asks first while running'],
  ['Ctrl-C', 'Stop immediately and save partial results'],
];

export function HelpPanel({ path }: { path: string }): ReactNode {
  const { colors } = useTheme();
  return (
    <box flexDirection="column" flexShrink={0}>
      <text wrapMode="none" marginBottom={1} {...ink(colors.accent, BOLD)}>
        Keyboard
      </text>
      {HELP_KEYS.map(([key, label]) => (
        <box key={key} flexDirection="row" flexShrink={0}>
          <text wrapMode="none" width={18} flexShrink={0} {...ink(colors.accent, BOLD)}>
            {key}
          </text>
          <text wrapMode="word" flexShrink={1}>
            {label}
          </text>
        </box>
      ))}
      <text wrapMode="none" marginTop={1} marginBottom={1} {...ink(colors.accent, BOLD)}>
        Reading a case
      </text>
      <text wrapMode="word">
        Scenario is the case input. Operator response is the model's complete answer. Grader verdict
        lists every criterion with its reason and the quoted evidence, for passing cases too.
      </text>
      <text wrapMode="word">
        Loaded skill holds the instructions shared with operator and grader. Exact operator prompt
        is the evaluation wrapper, skill and scenario as sent.
      </text>
      <text wrapMode="word">
        Errors are unscored. Every status is spelled out in words, so color is optional. Navigating
        stops following the live case; new results then keep your place.
      </text>
      <text wrapMode="word" marginTop={1}>
        <span {...ink(colors.muted, BOLD)}>{'Report  '}</span>
        {singleLine(path)}
      </text>
    </box>
  );
}
