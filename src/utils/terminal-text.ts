export function singleLine(value: string): string {
  return terminalText(value).replaceAll('\n', '\\n');
}

export function terminalText(value: string): string {
  return value.replace(
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
