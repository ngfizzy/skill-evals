import type { ReactNode } from 'react';

import type { CaseResult, EvaluationCase, EvaluationPhase } from '../../evaluation/index.ts';
import { useSectionSizes } from '../hooks/use-section-sizes.ts';
import type { ResultSection } from '../types.ts';
import { formatBytes } from '../view-model.ts';
import type { CaseState } from '../view-model.ts';

import { Body } from './body.tsx';
import { ResponseBody } from './response-body.tsx';
import { SectionHeader } from './section-header.tsx';
import { VerdictBody } from './verdict-body.tsx';

interface CaseSectionsProps {
  entry: EvaluationCase;
  sections: ResultSection[];
  focus: number;
  isClosed(id: string, initial: boolean): boolean;
  result: CaseResult | undefined;
  state: CaseState;
  phase: EvaluationPhase | undefined;
}

export function CaseSections({
  entry,
  sections,
  focus,
  isClosed,
  result,
  state,
  phase,
}: CaseSectionsProps): ReactNode {
  const sizes = useSectionSizes(sections);

  return sections.map((section, index) => {
    const collapsed = isClosed(section.id, section.collapsed);

    return (
      <box
        key={`${entry.key}/${section.id}`}
        id={`block-${section.id}`}
        flexDirection="column"
        flexShrink={0}
        marginBottom={1}
      >
        <SectionHeader
          id={`section-${section.id}`}
          title={section.title}
          collapsed={collapsed}
          focused={focus === index}
          meta={sectionMeta(section, collapsed, sizes.get(section.id))}
        />
        {collapsed ? null : (
          <box flexDirection="column" flexShrink={0} paddingLeft={4}>
            {section.id === 'response' ? (
              <ResponseBody section={section} result={result} state={state} phase={phase} />
            ) : section.id === 'verdict' ? (
              <VerdictBody entry={entry} result={result} state={state} phase={phase} />
            ) : (
              <Body section={section} />
            )}
          </box>
        )}
      </box>
    );
  });
}

function sectionMeta(
  section: ResultSection,
  collapsed: boolean,
  bytes: number | undefined,
): string | undefined {
  if (section.id === 'raw-judgment')
    return `unvalidated · not a verdict · Enter to ${collapsed ? 'show' : 'hide'}`;
  if (section.id === 'skill' || section.id === 'input') {
    const key = section.id === 'skill' ? 's' : 'p';
    return [
      bytes === undefined ? '' : formatBytes(bytes),
      collapsed ? `hidden · ${key} to show` : `${key} to hide`,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  return collapsed ? 'hidden · Enter to show' : undefined;
}
