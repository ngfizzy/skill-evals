import { useMemo } from 'react';

import type { ResultSection } from '../types.ts';

export function useSectionSizes(sections: readonly ResultSection[]): ReadonlyMap<string, number> {
  return useMemo(
    () =>
      new Map(
        sections
          .filter(
            (section) => (section.id === 'skill' || section.id === 'input') && !section.placeholder,
          )
          .map((section) => [section.id, Buffer.byteLength(section.text)] as const),
      ),
    [sections],
  );
}
