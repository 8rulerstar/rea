import { describe, expect, it } from "vitest";
import {
  UnityAssetsFormatFailure,
  type UnityAssetsFailureKind,
  type UnityAssetsFailureReason,
} from "../../../src/unity/UnityAssetsFailure.js";
import { readUnityAssets } from "../../../src/unity/UnityAssetsFile.js";
import {
  UNITYFS_DEFAULT_LIMITS,
  type UnityFsLimits,
} from "../../../src/unity/UnityFsBundle.js";
import { decodeLz4Block } from "../../../src/unity/lz4Block.js";
import {
  createSerializedFileFixture,
  createUnityFsFixture,
  encodeLz4Block,
  FIXTURE_BODIES,
  FIXTURE_EXTERNAL,
  FIXTURE_SCRIPT_ID,
  FIXTURE_UNITY_VERSION,
} from "../../fixtures/unity/assets.js";

const rejects = (
  bytes: Uint8Array,
  reason: UnityAssetsFailureReason,
  kind: UnityAssetsFailureKind,
  limits?: UnityFsLimits,
) => {
  try {
    readUnityAssets(bytes, limits);
  } catch (cause: unknown) {
    if (!(cause instanceof UnityAssetsFormatFailure)) throw cause;
    expect(cause.reason).toBe(reason);
    expect(cause.kind).toBe(kind);
    expect(cause.message.startsWith(`${reason}: `)).toBe(true);
    return;
  }
  throw new Error("Expected the input to be rejected");
};

describe("SerializedFile", () => {
  for (const [version, bigEndian, typeTree] of [
    [22, false, true],
    [22, true, false],
    [21, false, true],
    [17, true, true],
    [15, false, true],
    [11, false, true],
    [9, true, true],
  ] as const)
    it(`decodes version ${version} ${bigEndian ? "big" : "little"}-endian${typeTree ? " with TypeTrees" : ""}`, () => {
      const fixture = createSerializedFileFixture({
        version,
        bigEndian,
        typeTree,
      });
      const report = readUnityAssets(fixture.bytes);
      expect(report.container).toBe("serialized-file");
      expect(report.bundle).toBeNull();
      expect(report.serialized_files).toEqual([
        {
          entry: -1,
          version,
          big_endian: bigEndian,
          metadata_size: fixture.metadataSize,
          file_size: fixture.bytes.length,
          data_offset: fixture.dataOffset,
          unity_version: FIXTURE_UNITY_VERSION,
          target_platform: 2,
          type_tree_enabled: typeTree,
          type_count: 2,
          object_count: 2,
          script_count: version >= 11 ? 1 : 0,
          external_count: 1,
          ref_type_count: 0,
          user_information: "",
        },
      ]);
      expect(report.types.map((type) => type.class_id)).toEqual([1, 114]);
      expect(report.types[0]).toMatchObject({
        file: 0,
        index: 0,
        class_name: "GameObject",
        stripped: version >= 16 ? false : null,
        script_type_index: version >= 17 ? -1 : null,
        type_tree_nodes: typeTree ? 1 : null,
        type_tree_root: typeTree ? "GameObject" : null,
      });
      expect(report.types[1]!.script_id).toBe(
        version >= 16 ? FIXTURE_SCRIPT_ID : null,
      );
      expect(report.objects).toEqual([
        {
          file: 0,
          path_id: "1",
          class_id: 1,
          type_index: version >= 16 ? 0 : -1,
          offset: fixture.objectOffsets[0],
          size: FIXTURE_BODIES[0]!.length,
        },
        {
          file: 0,
          path_id: "-2",
          class_id: 114,
          type_index: version >= 16 ? 1 : -1,
          offset: fixture.objectOffsets[1],
          size: FIXTURE_BODIES[1]!.length,
        },
      ]);
      expect(
        Buffer.from(fixture.bytes).subarray(
          fixture.objectOffsets[0],
          fixture.objectOffsets[0]! + FIXTURE_BODIES[0]!.length,
        ),
      ).toEqual(FIXTURE_BODIES[0]);
      expect(report.externals).toEqual([
        {
          file: 0,
          path: FIXTURE_EXTERNAL,
          guid: "11".repeat(16),
          type: 3,
        },
      ]);
    });

  it("reads script IDs of script types whose class ID is not 114", () => {
    const report = readUnityAssets(
      createSerializedFileFixture({ scriptClassId: 0x7c90b5b3 }).bytes,
    );
    expect(report.types[1]).toMatchObject({
      class_id: 0x7c90b5b3,
      class_name: null,
      script_type_index: 0,
      script_id: FIXTURE_SCRIPT_ID,
      type_tree_root: "MonoBehaviour",
    });
  });

  it("refuses versions outside 9 to 22 and unrecognized files", () => {
    for (const version of [8, 23]) {
      const bytes = createSerializedFileFixture().bytes;
      bytes.writeUInt32BE(version, 8);
      rejects(bytes, "unsupported-version", "unsupported");
    }
    rejects(Buffer.alloc(64, 0xff), "unrecognized-format", "unsupported");
    // A PNG's third word (13) is in range, but its marker bytes are not.
    const png = Buffer.alloc(64);
    Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000200000002008060000",
      "hex",
    ).copy(png);
    rejects(png, "unrecognized-format", "unsupported");
    rejects(
      Buffer.from("UnityWeb\0rest-of-a-legacy-bundle", "latin1"),
      "unsupported-container",
      "unsupported",
    );
  });

  it("rejects damaged headers, tables and object ranges", () => {
    rejects(Buffer.alloc(10), "truncated-header", "corrupt");
    const fixture = createSerializedFileFixture();
    rejects(fixture.bytes.subarray(0, -1), "file-size-mismatch", "corrupt");
    const huge = Buffer.from(fixture.bytes);
    huge.writeUInt32BE(fixture.dataOffset, 20);
    rejects(huge, "metadata-out-of-bounds", "corrupt");
    const legacy = createSerializedFileFixture({ version: 17 });
    // The type count follows the version string, platform and TypeTree flag.
    const typeCount = 20 + FIXTURE_UNITY_VERSION.length + 1 + 4 + 1;
    const counted = Buffer.from(legacy.bytes);
    counted.writeUInt32LE(0x10000, typeCount);
    rejects(counted, "count-out-of-range", "corrupt");
  });

  it("rejects objects outside the file and type indices outside the table", () => {
    const fixture = createSerializedFileFixture({ typeTree: false });
    const bytes = Buffer.from(fixture.bytes);
    const marker = Buffer.alloc(4);
    marker.writeUInt32LE(FIXTURE_BODIES[1]!.length);
    // Second object's size field: last occurrence of its body length in metadata.
    const metadata = bytes.subarray(0, 48 + fixture.metadataSize);
    const at = metadata.lastIndexOf(marker);
    bytes.writeUInt32LE(4096, at);
    rejects(bytes, "object-out-of-bounds", "corrupt");
    const typed = Buffer.from(fixture.bytes);
    typed.writeInt32LE(9, at + 4);
    rejects(typed, "index-out-of-range", "corrupt");
  });
});

describe("UnityFS", () => {
  const serialized = createSerializedFileFixture();
  const entries = [
    { path: "CAB-fixture", bytes: serialized.bytes, flags: 4 },
    { path: "CAB-fixture.resS", bytes: Buffer.alloc(300, 3), flags: 0 },
  ];

  for (const compression of ["none", "lz4"] as const)
    for (const infoAtEnd of [false, true])
      it(`decodes ${compression} blocks with blocks info ${infoAtEnd ? "at the end" : "after the header"}`, () => {
        const fixture = createUnityFsFixture(entries, {
          compression,
          infoAtEnd,
        });
        const report = readUnityAssets(fixture.bytes);
        expect(report.container).toBe("unityfs");
        expect(report.bundle).toMatchObject({
          signature: "UnityFS",
          format_version: 7,
          player_version: "5.x.x",
          unity_revision: FIXTURE_UNITY_VERSION,
          declared_size: fixture.bytes.length,
          blocks_info: {
            compression: "lz4",
            uncompressed_size: fixture.infoRaw.length,
            at_end: infoAtEnd,
          },
          uncompressed_data_size: fixture.data.length,
        });
        expect(report.blocks).toHaveLength(fixture.blocks);
        expect(
          report.blocks.every((block) => block.compression === compression),
        ).toBe(true);
        expect(report.entries).toEqual([
          {
            path: "CAB-fixture",
            offset: 0,
            size: serialized.bytes.length,
            flags: 4,
            serialized_file: 0,
          },
          {
            path: "CAB-fixture.resS",
            offset: serialized.bytes.length,
            size: 300,
            flags: 0,
            serialized_file: -1,
          },
        ]);
        expect(report.serialized_files).toEqual([
          expect.objectContaining({ entry: 0, version: 22, object_count: 2 }),
        ]);
        expect(report.objects.map(({ offset }) => offset)).toEqual(
          serialized.objectOffsets,
        );
      });

  it("decodes format version 6 without header alignment", () => {
    const report = readUnityAssets(
      createUnityFsFixture(entries, { formatVersion: 6 }).bytes,
    );
    expect(report.bundle?.format_version).toBe(6);
    expect(report.objects).toHaveLength(2);
  });

  it("refuses LZMA blocks and encrypted bundles as unsupported", () => {
    rejects(
      createUnityFsFixture(entries, { compression: "lzma" }).bytes,
      "unsupported-compression",
      "unsupported",
    );
    rejects(
      createUnityFsFixture(entries, { extraFlags: 0x400 }).bytes,
      "encrypted-bundle",
      "unsupported",
    );
  });

  it("enforces decompressed size, ratio and block-count guards before expanding", () => {
    const { bytes } = createUnityFsFixture(entries);
    rejects(bytes, "decompressed-size", "limit", {
      ...UNITYFS_DEFAULT_LIMITS,
      maximumUncompressedBytes: 256,
    });
    rejects(bytes, "block-count", "limit", {
      ...UNITYFS_DEFAULT_LIMITS,
      maximumBlocks: 2,
    });
    // 64 KiB of zeros compresses to a few hundred bytes.
    const bomb = createUnityFsFixture(
      [{ path: "zeros", bytes: Buffer.alloc(65_536), flags: 0 }],
      { blockSize: 65_536 },
    );
    rejects(bomb.bytes, "compression-ratio", "limit", {
      ...UNITYFS_DEFAULT_LIMITS,
      maximumRatio: 16,
    });
    expect(readUnityAssets(bomb.bytes).entries).toHaveLength(1);
  });

  it("rejects truncated bundles, bad sizes and invalid LZ4", () => {
    const { bytes } = createUnityFsFixture(entries);
    rejects(bytes.subarray(0, 20), "truncated-header", "corrupt");
    rejects(
      Buffer.concat([bytes, Buffer.alloc(1)]),
      "file-size-mismatch",
      "corrupt",
    );
    const stored = createUnityFsFixture(entries, { compression: "none" });
    const damaged = Buffer.from(stored.bytes);
    // Corrupt the LZ4 blocks info by pointing its first match before the output.
    const infoStart = damaged.indexOf(encodeLz4Block(stored.infoRaw));
    damaged.fill(0xff, infoStart, infoStart + 8);
    rejects(damaged, "lz4-invalid", "corrupt");
  });

  it("rejects entries outside the decompressed stream", () => {
    const fixture = createUnityFsFixture(
      [{ path: "x", bytes: Buffer.alloc(10), flags: 0 }],
      { compression: "none" },
    );
    // Rebuild with an entry size past the data by editing the raw info.
    const info = Buffer.from(fixture.infoRaw);
    info.writeBigUInt64BE(11n, info.length - 2 - 4 - 8);
    const stored = encodeLz4Block(info);
    const bytes = Buffer.from(fixture.bytes);
    const at = bytes.indexOf(encodeLz4Block(fixture.infoRaw));
    expect(stored.length).toBe(encodeLz4Block(fixture.infoRaw).length);
    stored.copy(bytes, at);
    rejects(bytes, "entry-out-of-bounds", "corrupt");
  });
});

describe("LZ4 block", () => {
  it("decodes overlapping matches and refuses inconsistent sizes", () => {
    // Literal "ab" then a 10-byte match at distance 2 ("ababababab").
    const block = Uint8Array.from([0x26, 0x61, 0x62, 2, 0, 0x10, 0x7a]);
    expect(Buffer.from(decodeLz4Block(block, 13, "test")).toString()).toBe(
      "abababababab" + "z",
    );
    expect(() => decodeLz4Block(block, 12, "test")).toThrow(/lz4-invalid/);
    expect(() => decodeLz4Block(block, 14, "test")).toThrow(
      /block-size-mismatch/,
    );
    expect(() =>
      decodeLz4Block(Uint8Array.from([0x00, 5, 0]), 8, "test"),
    ).toThrow(/lz4-invalid/);
  });
});
