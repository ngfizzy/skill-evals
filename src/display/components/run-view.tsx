import { basename } from 'node:path';

import type { ReactNode } from 'react';

import type { CaseResult, EvaluationPhase } from '../../evaluation/index.ts';
import type { Options } from '../../runner/index.ts';
import { singleLine } from '../../utils/index.ts';
import { ThemeContext } from '../contexts/theme-context.ts';
import { useRunElapsed } from '../hooks/use-run-elapsed.ts';
import { useRunLayout } from '../hooks/use-run-layout.ts';
import { useRunNavigation } from '../hooks/use-run-navigation.ts';
import type { ViewSnapshot } from '../types.ts';
import { CASE_STATUS, criteriaMet, phaseLabel, runState, runStatus } from '../view-model.ts';
import type { CaseState, ThemeMode } from '../view-model.ts';

import { CaseHeading } from './case-heading.tsx';
import { CaseList } from './case-list.tsx';
import { CaseSections } from './case-sections.tsx';
import { ConfirmBar } from './confirm-bar.tsx';
import { Footer } from './footer.tsx';
import { Header } from './header.tsx';
import { HelpPanel } from './help-panel.tsx';
import { Notice } from './notice.tsx';

export interface ViewProps {
  snapshot: ViewSnapshot;
  options: Pick<Options, 'color' | 'progress' | 'width'>;
  onExit(): void;
  onFailure(error: unknown): void;
  /** Overrides the renderer's theme report; used to render each palette deterministically. */
  themeMode?: ThemeMode | undefined;
}

/** Below this width the case list folds away and the reading pane takes the full terminal. */
export const WIDE_LAYOUT = 100;

/** One selected case keeps incoming results elsewhere from moving the reading pane. */
export function RunView({ snapshot, options, onExit, themeMode }: ViewProps): ReactNode {
  const { report, entries, current } = snapshot;
  const { theme, width } = useRunLayout(options, themeMode);
  const wide = width >= WIDE_LAYOUT;

  const { caseList, readingPane, help, confirmStop, keys } = useRunNavigation(
    snapshot,
    wide,
    onExit,
  );
  const { scroll, entry, result, sections, focus, isClosed, state, phase, followNote } =
    readingPane;

  const elapsed = useRunElapsed(snapshot, options.progress);

  const { summary } = report;
  const livePhase =
    !snapshot.finished && options.progress !== 'none' && current
      ? phaseLabel(current.phase)
      : undefined;

  return (
    <ThemeContext.Provider value={theme}>
      <box flexDirection="column" width={width} height="100%">
        <Header
          run={runStatus(
            runState(snapshot.finished, report.interrupted, report.finished_at, summary.pending),
            summary,
          )}
          elapsed={elapsed}
          model={report.model}
          judge={report.judge_model}
          phase={livePhase}
          reportName={singleLine(basename(snapshot.path))}
          summary={summary}
          total={report.selected_cases}
          barWidth={wide ? 24 : Math.max(8, Math.min(16, width - 40))}
        />
        <box flexDirection="row" flexGrow={1} flexShrink={1}>
          {wide && entries.length ? (
            <CaseList {...caseList} width={Math.min(40, Math.max(30, Math.floor(width * 0.28)))} />
          ) : null}
          <scrollbox
            ref={scroll}
            focused={!confirmStop}
            flexGrow={1}
            flexShrink={1}
            contentOptions={{
              flexDirection: 'column',
              paddingLeft: wide ? 2 : 1,
              paddingRight: wide ? 2 : 1,
              paddingTop: 1,
            }}
          >
            {help ? (
              <HelpPanel path={snapshot.path} />
            ) : !entry ? (
              <Notice icon={CASE_STATUS.pending.icon} tone="muted">
                No completed cases recorded.
              </Notice>
            ) : (
              <>
                <CaseHeading
                  entry={entry}
                  status={CASE_STATUS[state]}
                  detail={caseDetail(state, result, phase)}
                  position={`case ${caseList.selected + 1} of ${entries.length}`}
                  note={followNote}
                />
                <CaseSections
                  entry={entry}
                  sections={sections}
                  focus={focus}
                  isClosed={isClosed}
                  result={result}
                  state={state}
                  phase={phase}
                />
              </>
            )}
          </scrollbox>
        </box>
        {confirmStop ? <ConfirmBar /> : <Footer keys={keys} />}
      </box>
    </ThemeContext.Provider>
  );
}

function caseDetail(
  state: CaseState,
  result: CaseResult | undefined,
  phase: EvaluationPhase | undefined,
): string {
  const met = criteriaMet(result);
  if (met) return `${met.met} of ${met.total} criteria met`;
  if (state === 'error') return `unscored · ${result?.error_stage ?? 'execution'} stage`;
  if (state === 'running') return phaseLabel(phase);
  if (state === 'pending') return 'queued';
  return state === 'not-run' ? 'the run stopped before this case' : '';
}
