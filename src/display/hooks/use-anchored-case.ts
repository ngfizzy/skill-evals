import type { Renderable, ScrollBoxRenderable } from '@opentui/core';
import { useLayoutEffect, useMemo, useState, type RefObject } from 'react';

import type { CaseResult, EvaluationCase } from '../../evaluation/index.ts';
import { resultSections } from '../sections.ts';

interface AnchoredCaseInput {
  entry: Readonly<EvaluationCase> | undefined;
  caseKey: string | undefined;
  incomingResult: CaseResult | undefined;
  bundle: string | undefined;
  scroll: RefObject<ScrollBoxRenderable | null>;
}

/** Stage an incoming result while the old sections still provide a scroll anchor. */
export function useAnchoredCase({
  entry,
  caseKey,
  incomingResult,
  bundle,
  scroll,
}: AnchoredCaseInput) {
  const [shownCase, setShownCase] = useState({ key: caseKey, result: incomingResult });
  const sameCase = shownCase.key === caseKey;
  const result = sameCase ? shownCase.result : incomingResult;

  const sections = useMemo(
    () => (entry ? resultSections(entry, result, bundle) : []),
    [entry, result, bundle],
  );

  useLayoutEffect(() => {
    if (sameCase && result === incomingResult) return;
    const box = scroll.current;
    // Keep the old sections mounted until we can anchor the reader's place. The state
    // update then commits the incoming result before OpenTUI lays out the next frame.
    if (sameCase && box && box.scrollTop > 0) {
      const top = box.viewport.screenY;
      let target: Renderable | undefined;
      for (const section of sections) {
        const block = box.findDescendantById(`block-${section.id}`);
        if (!block) continue;
        if (block.screenY > top) break;
        target = block;
      }
      if (target) box.afterLayout(box.anchor(target));
    }
    setShownCase({ key: caseKey, result: incomingResult });
  }, [caseKey, incomingResult, result, sameCase, sections, scroll]);

  return { result, sections };
}
