import { CliRenderEvents } from '@opentui/core';
import { useRenderer, useTerminalDimensions } from '@opentui/react';
import { useEffect, useMemo, useState } from 'react';

import type { Options } from '../../runner/index.ts';
import { colorEnabled, palette, type ThemeMode } from '../view-model.ts';

export function useRunLayout(options: Pick<Options, 'color' | 'width'>, themeMode?: ThemeMode) {
  const dimensions = useTerminalDimensions();
  const detected = useThemeMode();
  const mode = themeMode ?? detected;
  const color = colorEnabled(options.color, process.env);
  const theme = useMemo(() => ({ colors: palette(color, mode), color }), [color, mode]);
  const width = Math.max(1, Math.min(dimensions.width, options.width ?? dimensions.width));

  return { theme, width };
}

/** A terminal that does not answer theme detection stays `unknown`; its background is never guessed. */
function useThemeMode(): ThemeMode {
  const renderer = useRenderer();
  const [mode, setMode] = useState<ThemeMode>(renderer.themeMode ?? 'unknown');

  useEffect(() => {
    const update = (): void => setMode(renderer.themeMode ?? 'unknown');
    renderer.on(CliRenderEvents.THEME_MODE, update);
    return () => {
      renderer.off(CliRenderEvents.THEME_MODE, update);
    };
  }, [renderer]);
  return mode;
}
