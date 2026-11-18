export function readInt32(buffer: ArrayBufferLike, offset = 0, littleEndian = true): number {
  return new DataView(buffer).getInt32(offset, littleEndian);
}
