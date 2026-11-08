import { useEffect, useState } from 'react';

import type { Options } from '../../runner/index.ts';
import type { ViewSnapshot } from '../types.ts';
import { formatElapsed } from '../view-model.ts';

export function useRunElapsed(
  snapshot: ViewSnapshot,
  progress: Options['progress'],
): string | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (snapshot.finished || progress !== 'auto') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [snapshot.finished, progress]);

  const { report } = snapshot;
  const started = Date.parse(report.started_at);
  const ended = report.finished_at ? Date.parse(report.finished_at) : Number.NaN;
  // Elapsed wall time is measured, never projected; finished reports show their recorded duration.
  return !snapshot.finished
    ? progress === 'auto' && Number.isFinite(started)
      ? formatElapsed((now - started) / 1000)
      : undefined
    : Number.isFinite(started) && Number.isFinite(ended)
      ? `took ${formatElapsed((ended - started) / 1000)}`
      : undefined;
}
