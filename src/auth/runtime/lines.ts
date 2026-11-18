// Splits streamed text into complete lines and holds back the trailing partial line.
export class LineBuffer {
  private pending = '';

  push(text: string): string[] {
    const lines = (this.pending + text).split('\n');
    this.pending = lines.pop()!;
    return lines;
  }

  get remainder(): string {
    return this.pending;
  }
}
