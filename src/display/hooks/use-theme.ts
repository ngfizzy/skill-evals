import { useContext } from 'react';

import { ThemeContext, type Theme } from '../contexts/theme-context.ts';

export const useTheme = (): Theme => useContext(ThemeContext);
