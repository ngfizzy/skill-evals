import type { CaseResult } from '../evaluation/index.ts';
import { singleLine, terminalText } from '../utils/index.ts';

import { resultSections } from './sections.ts';

export function formatCaseResult(
  result: CaseResult,
  color = false,
  width = Infinity,
  fullInput = false,
): string[] {
  const lines: DisplayLine[] = [
    {
      text: `${result.status.toUpperCase()} ${singleLine(result.key)} score=${result.score ?? 'unscored'}`,
      code: result.status === 'passed' ? 32 : result.status === 'failed' ? 31 : 35,
    },
    { text: `  Case: ${singleLine(result.title)}`, code: 36 },
  ];

  for (const section of resultSections(result, result)) {
    const hidden = section.id === 'skill' || (section.id === 'input' && !fullInput);
    if (hidden) {
      const note =
        section.id === 'skill' && result.skill_instructions === undefined
          ? 'not stored separately; inspect the exact prompt'
          : 'in JSON report; use --view or --full-input';
      lines.push({ text: `  ${section.title}: (${note})` });
    } else {
      appendText(lines, `  ${section.title}:`, section.text, '    ');
    }
  }

  return present(lines, color, width);
}

interface DisplayLine {
  text: string;
  code?: number;
}

function appendText(
  lines: DisplayLine[],
  label: string,
  value: string,
  indent: string,
  code = 36,
): void {
  lines.push(
    { text: label, code },
    ...terminalText(value)
      .split('\n')
      .map((line) => ({ text: `${indent}${line}` })),
  );
}

export function paint(text: string, code: number, enabled: boolean): string {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function present(lines: DisplayLine[], color: boolean, width: number): string[] {
  return lines.flatMap(({ text, code }) => {
    return wrapLine(text, width).map((part) => (code ? paint(part, code, color) : part));
  });
}

function wrapLine(line: string, width: number): string[] {
  if (!Number.isFinite(width) || Bun.stringWidth(line) <= width) return [line];

  const lines: string[] = [];
  const originalIndent = line.match(/^ */)![0];
  const indent = originalIndent.slice(0, Math.max(0, width - 2));
  let current = '';

  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
    line,
  )) {
    if (current && Bun.stringWidth(current + segment) > width) {
      const boundary = current.lastIndexOf(' ');
      if (boundary >= originalIndent.length && boundary > indent.length) {
        lines.push(current.slice(0, boundary));
        current = indent + current.slice(boundary + 1);
      } else {
        lines.push(current);
        current = indent;
      }
    }
    current += segment;
  }

  if (current) lines.push(current);
  return lines;
}
