import { fail } from "./UnityAssetsFailure.js";

/**
 * Decode one raw LZ4 block (no frame header) into exactly `outputBytes`
 * bytes. The caller sizes the output from the container's declared size, so
 * decoding never grows a buffer and stops at the first inconsistency.
 */
export const decodeLz4Block = (
  input: Uint8Array,
  outputBytes: number,
  what: string,
): Uint8Array => {
  const output = new Uint8Array(outputBytes);
  let read = 0;
  let written = 0;
  const invalid = (detail: string): never =>
    fail("lz4-invalid", `${what}: ${detail} at input ${read}.`);
  const length = (initial: number) => {
    let total = initial;
    if (initial !== 15) return total;
    for (;;) {
      if (read >= input.length) invalid("length runs past the block");
      const extra = input[read++]!;
      total += extra;
      if (extra !== 255) return total;
    }
  };
  while (read < input.length) {
    const token = input[read++]!;
    const literals = length(token >> 4);
    if (read + literals > input.length) invalid("literals run past the block");
    if (written + literals > outputBytes)
      invalid("literals exceed the declared size");
    output.set(input.subarray(read, read + literals), written);
    read += literals;
    written += literals;
    // The last sequence ends after its literals.
    if (read === input.length) break;
    if (read + 2 > input.length) invalid("match offset runs past the block");
    const distance = input[read]! | (input[read + 1]! << 8);
    read += 2;
    if (distance === 0 || distance > written)
      invalid(`match distance ${distance} precedes the output`);
    const match = length(token & 15) + 4;
    if (written + match > outputBytes)
      invalid("match exceeds the declared size");
    // Overlapping matches repeat bytes, so copy forward one at a time.
    for (let from = written - distance, end = written + match; written < end;)
      output[written++] = output[from++]!;
  }
  if (written !== outputBytes)
    fail(
      "block-size-mismatch",
      `${what} decoded ${written} bytes, not the declared ${outputBytes}.`,
    );
  return output;
};
