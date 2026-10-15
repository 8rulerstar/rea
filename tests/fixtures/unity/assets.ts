/** Synthetic Unity SerializedFile and UnityFS builders for decoder tests. */

class Writer {
  readonly chunks: Buffer[] = [];
  length = 0;
  constructor(
    readonly little: boolean,
    readonly base = 0,
  ) {}
  bytes(value: Uint8Array) {
    const chunk = Buffer.from(value);
    this.chunks.push(chunk);
    this.length += chunk.length;
    return this;
  }
  private number(bytes: number, write: (buffer: Buffer) => void) {
    const buffer = Buffer.alloc(bytes);
    write(buffer);
    return this.bytes(buffer);
  }
  u8(value: number) {
    return this.number(1, (b) => b.writeUInt8(value));
  }
  i16(value: number) {
    return this.number(2, (b) =>
      this.little ? b.writeInt16LE(value) : b.writeInt16BE(value),
    );
  }
  u16(value: number) {
    return this.number(2, (b) =>
      this.little ? b.writeUInt16LE(value) : b.writeUInt16BE(value),
    );
  }
  i32(value: number) {
    return this.number(4, (b) =>
      this.little ? b.writeInt32LE(value) : b.writeInt32BE(value),
    );
  }
  u32(value: number) {
    return this.number(4, (b) =>
      this.little ? b.writeUInt32LE(value) : b.writeUInt32BE(value),
    );
  }
  i64(value: bigint) {
    return this.number(8, (b) =>
      this.little ? b.writeBigInt64LE(value) : b.writeBigInt64BE(value),
    );
  }
  u64(value: number) {
    return this.number(8, (b) =>
      this.little
        ? b.writeBigUInt64LE(BigInt(value))
        : b.writeBigUInt64BE(BigInt(value)),
    );
  }
  cstring(value: string) {
    return this.bytes(Buffer.from(`${value}\0`, "utf8"));
  }
  align(to: number) {
    const absolute = this.base + this.length;
    return this.bytes(Buffer.alloc((to - (absolute % to)) % to));
  }
  done() {
    return Buffer.concat(this.chunks);
  }
}

export interface SerializedFileFixtureOptions {
  readonly version?: number;
  readonly bigEndian?: boolean;
  readonly typeTree?: boolean;
}

export const FIXTURE_UNITY_VERSION = "2022.3.30f1";
export const FIXTURE_EXTERNAL = "library/unity default resources";
export const FIXTURE_SCRIPT_ID = "0123456789abcdef0123456789abcdef";
/** Object bodies in table order: GameObject (pathID 1), MonoBehaviour (pathID -2). */
export const FIXTURE_BODIES = [Buffer.from("game-object"), Buffer.alloc(40, 7)];
export const FIXTURE_PATH_IDS = [1n, -2n];

const typeTreeBlob = (w: Writer, version: number, root: string) => {
  const strings = Buffer.from(`${root}\0Base\0`, "utf8");
  w.u32(1).u32(strings.length);
  w.u16(1)
    .u8(0)
    .u8(0)
    .u32(0)
    .u32(root.length + 1)
    .i32(-1)
    .i32(0)
    .i32(0);
  if (version >= 19) w.u64(0);
  w.bytes(strings);
  if (version >= 21) w.u32(0);
};

const writeType = (
  w: Writer,
  version: number,
  typeTree: boolean,
  classId: number,
  root: string,
) => {
  w.i32(classId);
  if (version >= 16) w.u8(0);
  if (version >= 17) w.i16(classId === 114 ? 0 : -1);
  if (version >= 13) {
    if ((version >= 16 && classId === 114) || (version < 16 && classId < 0))
      w.bytes(Buffer.from(FIXTURE_SCRIPT_ID, "hex"));
    w.bytes(Buffer.alloc(16, 0xaa));
  }
  if (!typeTree) return;
  if (version >= 12 || version === 10) typeTreeBlob(w, version, root);
  else {
    // Legacy recursive node: type, name, five int32 fields, child count.
    w.cstring(root).cstring("Base");
    for (let field = 0; field < 5; field += 1) w.i32(0);
    w.i32(0);
  }
};

/** One SerializedFile with two types, two objects, one script and one external. */
export const createSerializedFileFixture = ({
  version = 22,
  bigEndian = false,
  typeTree = true,
}: SerializedFileFixtureOptions = {}) => {
  const little = !bigEndian;
  const headerBytes = version >= 22 ? 48 : 20;
  const w = new Writer(little, headerBytes);
  w.cstring(FIXTURE_UNITY_VERSION).i32(2);
  if (version >= 13) w.u8(typeTree ? 1 : 0);
  const classIds = [1, 114];
  w.u32(2);
  writeType(w, version, typeTree, 1, "GameObject");
  writeType(w, version, typeTree, 114, "MonoBehaviour");
  if (version >= 7 && version < 14) w.i32(0);
  // Object starts are relative to the data offset.
  const starts = [0, 16];
  w.u32(2);
  FIXTURE_BODIES.forEach((body, index) => {
    if (version >= 14) w.align(4);
    if (version >= 14) w.i64(FIXTURE_PATH_IDS[index]!);
    else w.i32(Number(FIXTURE_PATH_IDS[index]));
    if (version >= 22) w.u64(starts[index]!);
    else w.u32(starts[index]!);
    w.u32(body.length);
    w.i32(version >= 16 ? index : classIds[index]!);
    if (version < 16) {
      w.u16(classIds[index]!);
      if (version < 11) w.u16(0);
      else w.i16(-1);
      if (version === 15) w.u8(0);
    } else if (version === 16) w.u8(0);
  });
  if (version >= 11) {
    w.u32(1).i32(0);
    if (version >= 14) w.align(4).i64(11500000n);
    else w.i32(115);
  }
  w.u32(1).cstring("").bytes(Buffer.alloc(16, 0x11)).i32(3);
  w.cstring(FIXTURE_EXTERNAL);
  if (version >= 20) w.u32(0);
  w.cstring("");
  const metadata = w.done();
  const dataOffset = Math.ceil((headerBytes + metadata.length) / 16) * 16;
  const data = Buffer.alloc(starts[1]! + FIXTURE_BODIES[1]!.length);
  FIXTURE_BODIES.forEach((body, index) => body.copy(data, starts[index]));
  const fileSize = dataOffset + data.length;
  const header = new Writer(false);
  if (version >= 22) {
    header.u32(0).u32(0).u32(version).u32(0);
    header.u8(bigEndian ? 1 : 0).bytes(Buffer.alloc(3));
    header.u32(metadata.length).u64(fileSize).u64(dataOffset).u64(0);
  } else {
    header.u32(metadata.length).u32(fileSize).u32(version).u32(dataOffset);
    header.u8(bigEndian ? 1 : 0).bytes(Buffer.alloc(3));
  }
  const head = header.done();
  const bytes = Buffer.concat([
    head,
    metadata,
    Buffer.alloc(dataOffset - head.length - metadata.length),
    data,
  ]);
  return {
    bytes,
    headerBytes,
    metadataSize: metadata.length,
    dataOffset,
    objectOffsets: starts.map((start) => dataOffset + start),
  };
};

/** Greedy LZ4 block encoder; Unity bundles use raw blocks without frames. */
export const encodeLz4Block = (input: Uint8Array): Buffer => {
  const out: number[] = [];
  const table = new Map<number, number>();
  const length = (value: number) => {
    while (value >= 255) {
      out.push(255);
      value -= 255;
    }
    out.push(value);
  };
  const sequence = (
    literalStart: number,
    literalEnd: number,
    match?: { distance: number; length: number },
  ) => {
    const literals = literalEnd - literalStart;
    const matchCode = match === undefined ? 0 : match.length - 4;
    out.push((Math.min(literals, 15) << 4) | Math.min(matchCode, 15));
    if (literals >= 15) length(literals - 15);
    for (let index = literalStart; index < literalEnd; index += 1)
      out.push(input[index]!);
    if (match === undefined) return;
    out.push(match.distance & 255, match.distance >> 8);
    if (matchCode >= 15) length(matchCode - 15);
  };
  let anchor = 0;
  let position = 0;
  // The format requires the last five bytes to be literals.
  const limit = input.length - 12;
  const view = Buffer.from(input.buffer, input.byteOffset, input.length);
  while (position < limit) {
    const key = view.readUInt32LE(position);
    const candidate = table.get(key);
    table.set(key, position);
    if (candidate !== undefined && position - candidate < 65536) {
      let matched = 4;
      while (
        position + matched < input.length - 5 &&
        input[candidate + matched] === input[position + matched]
      )
        matched += 1;
      sequence(anchor, position, {
        distance: position - candidate,
        length: matched,
      });
      position += matched;
      anchor = position;
    } else position += 1;
  }
  sequence(anchor, input.length);
  return Buffer.from(out);
};

export type FixtureCompression = "none" | "lzma" | "lz4";
const COMPRESSION_CODE: Record<FixtureCompression, number> = {
  none: 0,
  lzma: 1,
  lz4: 2,
};

export interface BundleEntryFixture {
  readonly path: string;
  readonly bytes: Buffer;
  /** 4 marks a SerializedFile. */
  readonly flags: number;
}

export interface UnityFsFixtureOptions {
  readonly compression?: FixtureCompression;
  readonly blockSize?: number;
  readonly formatVersion?: number;
  readonly infoAtEnd?: boolean;
  readonly extraFlags?: number;
}

/** UnityFS bundle with LZ4 blocks info and blocks in the selected compression. */
export const createUnityFsFixture = (
  entries: readonly BundleEntryFixture[],
  {
    compression = "lz4",
    blockSize = 64,
    formatVersion = 7,
    infoAtEnd = false,
    extraFlags = 0,
  }: UnityFsFixtureOptions = {},
) => {
  const data = Buffer.concat(entries.map(({ bytes }) => bytes));
  const blocks: { stored: Buffer; size: number }[] = [];
  for (let start = 0; start < data.length; start += blockSize) {
    const raw = data.subarray(start, start + blockSize);
    // LZMA content is never decoded; the reader must refuse it first.
    blocks.push({
      stored: compression === "lz4" ? encodeLz4Block(raw) : Buffer.from(raw),
      size: raw.length,
    });
  }
  const info = new Writer(false).bytes(Buffer.alloc(16)).u32(blocks.length);
  for (const block of blocks)
    info
      .u32(block.size)
      .u32(block.stored.length)
      .u16(COMPRESSION_CODE[compression]);
  info.u32(entries.length);
  let offset = 0;
  for (const entry of entries) {
    info
      .u64(offset)
      .u64(entry.bytes.length)
      .u32(entry.flags)
      .cstring(entry.path);
    offset += entry.bytes.length;
  }
  const infoRaw = info.done();
  const infoStored = encodeLz4Block(infoRaw);
  const flags = 2 | 0x40 | (infoAtEnd ? 0x80 : 0x200) | extraFlags;
  const blockBytes = Buffer.concat(blocks.map(({ stored }) => stored));
  const build = (size: number) => {
    const header = new Writer(false)
      .bytes(Buffer.from("UnityFS\0", "latin1"))
      .u32(formatVersion)
      .cstring("5.x.x")
      .cstring(FIXTURE_UNITY_VERSION)
      .u64(size)
      .u32(infoStored.length)
      .u32(infoRaw.length)
      .u32(flags);
    if (formatVersion >= 7) header.align(16);
    if (infoAtEnd)
      return Buffer.concat([header.done(), blockBytes, infoStored]);
    header.bytes(infoStored);
    header.align(16);
    return Buffer.concat([header.done(), blockBytes]);
  };
  const bytes = build(build(0).length);
  return { bytes, data, infoRaw, blocks: blocks.length };
};
