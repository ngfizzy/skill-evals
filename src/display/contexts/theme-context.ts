import { createContext } from 'react';

import type { Palette } from '../view-model.ts';

export interface Theme {
  colors: Palette;
  color: boolean;
}

export const ThemeContext = createContext<Theme>({ colors: {}, color: false });
