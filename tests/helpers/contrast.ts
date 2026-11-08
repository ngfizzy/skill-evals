import type { RGBA } from '@opentui/core';

export function hex(color: RGBA): string {
  return (
    '#' +
    color
      .toInts()
      .slice(0, 3)
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
  );
}

/** WCAG relative-luminance contrast between two #rrggbb colors. */
export function contrastRatio(first: string, second: string): number {
  const luminance = (value: string): number => {
    const [r, g, b] = [1, 3, 5].map((index) => {
      const channel = Number.parseInt(value.slice(index, index + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}
