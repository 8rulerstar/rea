/**
 * Synthetic thin arm64 Mach-O holding the IL2CPP registration tables for the
 * metadata fixture: image names, code-generation modules, their method
 * pointer arrays and the CodeRegistration module count and array pointer.
 */
export const FIXTURE_BINARY_BASE = 0x1_0000_0000n;

/** Method addresses by metadata method index; ToString has no body. */
export const FIXTURE_METHOD_ADDRESSES = [
  FIXTURE_BINARY_BASE + 0x200n,
  FIXTURE_BINARY_BASE + 0x210n,
  FIXTURE_BINARY_BASE + 0x220n,
  FIXTURE_BINARY_BASE + 0x230n,
  null,
] as const;

export interface Il2cppBinaryFixtureOptions {
  /** methodPointerCount written for Assembly-CSharp.dll; 3 matches the metadata. */
  readonly firstModuleCount?: number;
  /** Write a second record that also matches Assembly-CSharp.dll. */
  readonly duplicateModule?: boolean;
  /** Add an LC_DYLD_CHAINED_FIXUPS load command. */
  readonly chainedFixups?: boolean;
  /** Omit the CodeRegistration module count and array pointer. */
  readonly codeRegistration?: boolean;
}

const SIZE = 0x800;
const STRINGS = 0x100;
const POINTERS = 0x300;
const MODULES = 0x400;
const MODULE_ARRAY = 0x500;
const REGISTRATION = 0x600;
const DUPLICATE = 0x700;

export const createIl2cppBinaryFixture = (
  options: Il2cppBinaryFixtureOptions = {},
): Buffer => {
  const bytes = Buffer.alloc(SIZE);
  const address = (offset: number) => FIXTURE_BINARY_BASE + BigInt(offset);
  const chained = options.chainedFixups === true;
  // Mach-O 64-bit header: arm64 dylib with one or two load commands.
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(6, 12);
  bytes.writeUInt32LE(chained ? 2 : 1, 16);
  bytes.writeUInt32LE(chained ? 72 + 16 : 72, 20);
  // LC_SEGMENT_64 __TEXT mapping the whole file read-execute.
  bytes.writeUInt32LE(0x19, 32);
  bytes.writeUInt32LE(72, 36);
  bytes.write("__TEXT", 40, "latin1");
  bytes.writeBigUInt64LE(FIXTURE_BINARY_BASE, 56);
  bytes.writeBigUInt64LE(BigInt(SIZE), 64);
  bytes.writeBigUInt64LE(0n, 72);
  bytes.writeBigUInt64LE(BigInt(SIZE), 80);
  bytes.writeUInt32LE(5, 88);
  bytes.writeUInt32LE(5, 92);
  if (chained) {
    // linkedit_data_command pointing at an empty range.
    bytes.writeUInt32LE(0x80000034, 104);
    bytes.writeUInt32LE(16, 108);
  }
  const names = ["Assembly-CSharp.dll", "mscorlib.dll"];
  const nameAt: number[] = [];
  let cursor = STRINGS + 1;
  for (const name of names) {
    nameAt.push(cursor);
    cursor += bytes.write(`${name}\0`, cursor, "utf8");
  }
  // Slots are indexed by token row id - 1 (see FIXTURE_METHOD_TOKENS).
  const tables = [
    [0x210n, 0x200n, 0x220n],
    [0x230n, null],
  ];
  const tableAt: number[] = [];
  let pointer = POINTERS;
  for (const table of tables) {
    tableAt.push(pointer);
    for (const slot of table) {
      bytes.writeBigUInt64LE(
        slot === null ? 0n : FIXTURE_BINARY_BASE + slot,
        pointer,
      );
      pointer += 8;
    }
  }
  const writeModule = (at: number, image: number, count: number) => {
    bytes.writeBigUInt64LE(address(nameAt[image]!), at);
    bytes.writeUInt32LE(count, at + 8);
    bytes.writeBigUInt64LE(address(tableAt[image]!), at + 16);
  };
  writeModule(MODULES, 0, options.firstModuleCount ?? 3);
  writeModule(MODULES + 0x40, 1, 2);
  if (options.duplicateModule === true) writeModule(DUPLICATE, 0, 3);
  bytes.writeBigUInt64LE(address(MODULES), MODULE_ARRAY);
  bytes.writeBigUInt64LE(address(MODULES + 0x40), MODULE_ARRAY + 8);
  if (options.codeRegistration !== false) {
    bytes.writeBigUInt64LE(2n, REGISTRATION);
    bytes.writeBigUInt64LE(address(MODULE_ARRAY), REGISTRATION + 8);
  }
  return bytes;
};

/** Wrap thin Mach-O slices in a 32-bit universal header, page aligned. */
export const createUniversalFixture = (
  slices: readonly { readonly cpu: number; readonly bytes: Buffer }[],
): Buffer => {
  const align = 0x1000;
  const header = Buffer.alloc(align);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(slices.length, 4);
  const parts: Buffer[] = [header];
  let offset = align;
  slices.forEach((slice, index) => {
    const at = 8 + index * 20;
    header.writeUInt32BE(slice.cpu, at);
    header.writeUInt32BE(0, at + 4);
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(slice.bytes.length, at + 12);
    header.writeUInt32BE(12, at + 16);
    const padded = Buffer.alloc(Math.ceil(slice.bytes.length / align) * align);
    slice.bytes.copy(padded);
    parts.push(padded);
    offset += padded.length;
  });
  return Buffer.concat(parts);
};
