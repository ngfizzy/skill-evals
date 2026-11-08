export const PROTOCOL_VERSION = 'response-decisions-v4';

export function responseSegments(response: string): ResponseSegment[] {
  const lines = response.split(/\r?\n/, 2049);
  if (lines.length > 2048) throw new Error('Response exceeds 2048 evidence segments');
  return lines.map((text, index) => ({ id: `line-${index + 1}`, text }));
}

export interface ResponseSegment {
  readonly id: string;
  readonly text: string;
}
