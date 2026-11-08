import { TextAttributes } from '@opentui/core';

export const { BOLD } = TextAttributes;

interface Ink {
  fg?: string;
  attributes?: number;
}

export function ink(fg: string | undefined, attributes = 0): Ink {
  const style: Ink = {};
  if (fg) style.fg = fg;
  if (attributes) style.attributes = attributes;
  return style;
}
export const borderInk = (color: string | undefined): { borderColor?: string } =>
  color ? { borderColor: color } : {};
export const fillInk = (color: string | undefined): { backgroundColor?: string } =>
  color ? { backgroundColor: color } : {};
