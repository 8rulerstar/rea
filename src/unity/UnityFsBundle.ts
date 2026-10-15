import type {
  UnityBundle,
  UnityBundleBlock,
  UnityCompression,
} from "../domain/unity/unityAssets.js";
import { fail } from "./UnityAssetsFailure.js";
import { decodeLz4Block } from "./lz4Block.js";

export const UNITYFS_SIGNATURE = "UnityFS";
const LEGACY_SIGNATURES = ["UnityWeb", "UnityRaw", "UnityArchive"];
const BLOCKS_INFO_AT_END = 0x80;
const PADDING_AT_START = 0x200;
const ENCRYPTED = 0x400;
const SERIALIZED_FILE_FLAG = 0x4;
const BLOCK_RECORD_BYTES = 10;
const ENTRY_MIN_BYTES = 21;
const BLOCKS_INFO_HASH_BYTES = 16;

/** Resource guards applied before each expansion. */
export interface UnityFsLimits {
  /** Sum of declared uncompressed block and directory sizes. */
  readonly maximumUncompressedBytes: number;
  /** Largest accepted uncompressed/compressed size ratio per compressed block. */
  readonly maximumRatio: number;
  readonly maximumBlocks: number;
}

export const UNITYFS_DEFAULT_LIMITS: UnityFsLimits = {
  // Twice the 256 MiB input bound, held in memory as one decoded stream.
  maximumUncompressedBytes: 512 * 1024 * 1024,
  // LZ4 cannot exceed about 255:1; a larger declared ratio is an expansion bomb.
  maximumRatio: 256,
  maximumBlocks: 1 << 20,
};

export interface DecodedUnityFsEntry {
  readonly path: string;
  readonly offset: number;
  readonly size: number;
  readonly flags: number;
  readonly isSerializedFile: boolean;
}

export interface DecodedUnityFs {
  readonly bundle: UnityBundle;
  readonly blocks: readonly UnityBundleBlock[];
  readonly entries: readonly DecodedUnityFsEntry[];
  /** Decompressed block stream; entry ranges index it. */
  readonly data: Uint8Array;
}

const COMPRESSION: readonly UnityCompression[] = [
  "none",
  "lzma",
  "lz4",
  "lz4hc",
];

const compressionOf = (flags: number, what: string): UnityCompression => {
  const kind = COMPRESSION[flags & 0x3f];
  if (kind === undefined)
    fail(
      "unsupported-compression",
      `${what} uses compression type ${flags & 0x3f}.`,
    );
  return kind!;
};

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Big-endian bounded cursor used for the UnityFS header and directory. */
class BigEndianCursor {
  readonly view: DataView;
  constructor(
    readonly bytes: Uint8Array,
    public position: number,
    readonly end: number,
    readonly truncated: "truncated-header" | "block-out-of-bounds",
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  need(bytes: number, what: string) {
    const at = this.position;
    if (at + bytes > this.end)
      fail(this.truncated, `${what} at ${at} runs past ${this.end}.`);
    this.position += bytes;
    return at;
  }
  u16(what: string) {
    return this.view.getUint16(this.need(2, what), false);
  }
  u32(what: string) {
    return this.view.getUint32(this.need(4, what), false);
  }
  u64(what: string) {
    const value = this.view.getBigUint64(this.need(8, what), false);
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      fail(this.truncated, `${what} ${value} is not addressable.`);
    return Number(value);
  }
  cstring(what: string) {
    const length = this.bytes.subarray(this.position, this.end).indexOf(0);
    if (length < 0)
      fail(
        this.truncated === "truncated-header"
          ? this.truncated
          : "invalid-string",
        `${what} is not NUL-terminated.`,
      );
    let text = "";
    try {
      text = decoder.decode(
        this.bytes.subarray(this.position, this.position + length),
      );
    } catch {
      fail("invalid-string", `${what} is not UTF-8.`);
    }
    this.position += length + 1;
    return text;
  }
  align16() {
    this.need(((this.position + 15) & ~15) - this.position, "alignment");
  }
}

/** Return the legacy signature when `bytes` begins with one. */
export const legacyBundleSignature = (bytes: Uint8Array) =>
  LEGACY_SIGNATURES.find((signature) =>
    Buffer.from(signature + "\0", "latin1").equals(
      bytes.subarray(0, signature.length + 1),
    ),
  );

export const isUnityFs = (bytes: Uint8Array) =>
  Buffer.from(UNITYFS_SIGNATURE + "\0", "latin1").equals(
    bytes.subarray(0, UNITYFS_SIGNATURE.length + 1),
  );

const checkExpansion = (
  compressed: number,
  uncompressed: number,
  compression: UnityCompression,
  limits: UnityFsLimits,
  what: string,
) => {
  if (compression === "none") {
    if (compressed !== uncompressed)
      fail(
        "block-size-mismatch",
        `${what} is stored but declares ${compressed} compressed and ${uncompressed} uncompressed bytes.`,
      );
    return;
  }
  if (uncompressed > Math.max(compressed, 1) * limits.maximumRatio)
    fail(
      "compression-ratio",
      `${what} declares ${uncompressed} bytes from ${compressed}, above the ${limits.maximumRatio}:1 guard.`,
    );
};

const expand = (
  input: Uint8Array,
  outputBytes: number,
  compression: UnityCompression,
  what: string,
): Uint8Array => {
  if (compression === "none") return input;
  if (compression === "lzma")
    return fail(
      "unsupported-compression",
      `${what} uses LZMA, which this reader does not decode; rebuild with ChunkBasedCompression (LZ4) or UncompressedAssetBundle.`,
    );
  return decodeLz4Block(input, outputBytes, what);
};

/** Decode a UnityFS header, block/directory table and every storage block. */
export const readUnityFs = (
  bytes: Uint8Array,
  limits: UnityFsLimits = UNITYFS_DEFAULT_LIMITS,
  signal?: AbortSignal,
): DecodedUnityFs => {
  const header = new BigEndianCursor(
    bytes,
    0,
    bytes.length,
    "truncated-header",
  );
  header.need(UNITYFS_SIGNATURE.length + 1, "signature");
  const formatVersion = header.u32("format version");
  if (formatVersion < 6 || formatVersion > 8)
    fail(
      "unsupported-version",
      `UnityFS format version ${formatVersion} is outside 6-8.`,
    );
  const playerVersion = header.cstring("player version");
  const revision = header.cstring("Unity revision");
  const declaredSize = header.u64("bundle size");
  const compressedInfo = header.u32("compressed blocks-info size");
  const uncompressedInfo = header.u32("uncompressed blocks-info size");
  const flags = header.u32("flags");
  if ((flags & ENCRYPTED) !== 0)
    fail(
      "encrypted-bundle",
      `Flags 0x${flags.toString(16)} mark an encrypted bundle.`,
    );
  if (declaredSize !== bytes.length)
    fail(
      "file-size-mismatch",
      `Header bundle size ${declaredSize} differs from the ${bytes.length}-byte file.`,
    );
  if (formatVersion >= 7) header.align16();
  const atEnd = (flags & BLOCKS_INFO_AT_END) !== 0;
  const infoOffset = atEnd ? bytes.length - compressedInfo : header.position;
  if (
    infoOffset < header.position ||
    infoOffset + compressedInfo > bytes.length
  )
    fail("block-out-of-bounds", "Blocks info lies outside the file.");
  if (!atEnd) header.position += compressedInfo;
  if ((flags & PADDING_AT_START) !== 0) header.align16();
  const dataOffset = header.position;

  const infoCompression = compressionOf(flags, "Blocks info");
  checkExpansion(
    compressedInfo,
    uncompressedInfo,
    infoCompression,
    limits,
    "Blocks info",
  );
  if (uncompressedInfo > limits.maximumUncompressedBytes)
    fail(
      "decompressed-size",
      `Blocks info declares ${uncompressedInfo} bytes.`,
    );
  const info = expand(
    bytes.subarray(infoOffset, infoOffset + compressedInfo),
    uncompressedInfo,
    infoCompression,
    "Blocks info",
  );
  const table = new BigEndianCursor(
    info,
    0,
    info.length,
    "block-out-of-bounds",
  );
  table.need(BLOCKS_INFO_HASH_BYTES, "blocks-info hash");
  const blockCount = table.u32("block count");
  if (blockCount > limits.maximumBlocks)
    fail(
      "block-count",
      `${blockCount} blocks exceed the ${limits.maximumBlocks} guard.`,
    );
  if (blockCount * BLOCK_RECORD_BYTES > info.length - table.position)
    fail(
      "count-out-of-range",
      `Block count ${blockCount} does not fit the blocks info.`,
    );
  const blocks: UnityBundleBlock[] = [];
  let compressedTotal = 0;
  let uncompressedTotal = 0;
  for (let index = 0; index < blockCount; index += 1) {
    const uncompressed = table.u32("block uncompressed size");
    const compressed = table.u32("block compressed size");
    const blockFlags = table.u16("block flags");
    const compression = compressionOf(blockFlags, `Block ${index}`);
    checkExpansion(
      compressed,
      uncompressed,
      compression,
      limits,
      `Block ${index}`,
    );
    compressedTotal += compressed;
    uncompressedTotal += uncompressed;
    blocks.push({
      compressed_size: compressed,
      uncompressed_size: uncompressed,
      compression,
      flags: blockFlags,
    });
  }
  if (uncompressedTotal + uncompressedInfo > limits.maximumUncompressedBytes)
    fail(
      "decompressed-size",
      `Blocks declare ${uncompressedTotal} bytes, above the ${limits.maximumUncompressedBytes}-byte guard.`,
    );
  const dataEnd = atEnd ? infoOffset : bytes.length;
  if (dataOffset + compressedTotal > dataEnd)
    fail(
      "block-out-of-bounds",
      `Blocks need ${compressedTotal} bytes from ${dataOffset}.`,
    );

  const entryCount = table.u32("entry count");
  if (entryCount * ENTRY_MIN_BYTES > info.length - table.position)
    fail(
      "count-out-of-range",
      `Entry count ${entryCount} does not fit the blocks info.`,
    );
  const entries: DecodedUnityFsEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    const offset = table.u64("entry offset");
    const size = table.u64("entry size");
    const entryFlags = table.u32("entry flags");
    const path = table.cstring("entry path");
    if (offset + size > uncompressedTotal)
      fail(
        "entry-out-of-bounds",
        `Entry ${path} at ${offset}+${size} is outside ${uncompressedTotal} decompressed bytes.`,
      );
    entries.push({
      path,
      offset,
      size,
      flags: entryFlags,
      isSerializedFile: (entryFlags & SERIALIZED_FILE_FLAG) !== 0,
    });
  }

  const lzma = blocks.findIndex(({ compression }) => compression === "lzma");
  if (lzma >= 0) expand(new Uint8Array(), 0, "lzma", `Block ${lzma}`);
  // Every block is decoded so the whole container is validated, not only the entries.
  const data = new Uint8Array(uncompressedTotal);
  let source = dataOffset;
  let target = 0;
  blocks.forEach((block, index) => {
    signal?.throwIfAborted();
    data.set(
      expand(
        bytes.subarray(source, source + block.compressed_size),
        block.uncompressed_size,
        block.compression,
        `Block ${index}`,
      ),
      target,
    );
    source += block.compressed_size;
    target += block.uncompressed_size;
  });
  return {
    bundle: {
      signature: "UnityFS",
      format_version: formatVersion,
      player_version: playerVersion,
      unity_revision: revision,
      declared_size: declaredSize,
      flags,
      blocks_info: {
        offset: infoOffset,
        compressed_size: compressedInfo,
        uncompressed_size: uncompressedInfo,
        compression: infoCompression,
        at_end: atEnd,
      },
      data_offset: dataOffset,
      uncompressed_data_size: uncompressedTotal,
    },
    blocks,
    entries,
    data,
  };
};
