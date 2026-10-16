import { describe, expect, it } from "vitest";
import {
  readUnrealPak,
  UnrealPakFormatFailure,
  type UnrealPakLimits,
} from "../../../src/unreal/UnrealPakFile.js";
import {
  createPakFixture,
  PAK_FIXTURE_FILES,
  type PakFixtureLayout,
} from "../../fixtures/unreal/pak.js";

const LIMITS: UnrealPakLimits = { regionBytes: 1 << 20, entries: 1000 };

const sourceOf = (bytes: Buffer) => ({
  size: bytes.length,
  read: async (offset: number, length: number) =>
    bytes.subarray(offset, offset + length),
});

const read = (bytes: Buffer, limits: UnrealPakLimits = LIMITS) =>
  readUnrealPak(sourceOf(bytes), limits);

const failure = async (bytes: Buffer, limits: UnrealPakLimits = LIMITS) => {
  try {
    await read(bytes, limits);
  } catch (cause) {
    if (cause instanceof UnrealPakFormatFailure)
      return { reason: cause.reason, kind: cause.kind };
    throw cause;
  }
  throw new Error("expected a pak failure");
};

describe("Unreal pak footers and indexes", () => {
  it.each([
    "v1",
    "v3",
    "v4",
    "v7",
    "v8a",
    "v8b",
    "v9",
    "v10",
    "v11",
    "v12",
  ] as const satisfies readonly PakFixtureLayout[])(
    "reads every %s entry with its placement and compression",
    async (layout) => {
      const { bytes, files, indexOffset, indexSize } = createPakFixture({
        layout,
      });
      const pak = await read(bytes);
      expect(pak.footer).toMatchObject({
        layout,
        index: { offset: indexOffset, size: indexSize },
      });
      expect(pak.index).toMatchObject({
        state: "decoded",
        mount_point: "../../../",
        entry_count: files.length,
      });
      expect(
        pak.entries.map((entry) => [
          entry.path,
          entry.offset,
          entry.size,
          entry.uncompressed_size,
          entry.compression_name,
        ]),
      ).toEqual(
        files.map((file) => [
          file.path,
          file.offset,
          file.stored,
          file.uncompressed,
          file.method === 0 ? null : "Zlib",
        ]),
      );
      const version = Number(layout.replace(/[ab]$/u, "").slice(1));
      expect(
        pak.entries.every(
          (entry) => entry.record === (version >= 10 ? "encoded" : "full"),
        ),
      ).toBe(true);
    },
  );

  it("reads version 12 file names as UTF-8 without a terminator", async () => {
    const pak = await read(createPakFixture({ layout: "v12" }).bytes);
    expect(pak.entries.map((entry) => entry.path)).toContain(
      "Game/Content/한글.txt",
    );
  });

  it("resolves negative references to the non-encoded full records", async () => {
    const pak = await read(
      createPakFixture({
        layout: "v11",
        files: [
          { path: "A/b.txt", size: 9, fullRecord: true },
          { path: "A/c.txt", size: 5 },
        ],
      }).bytes,
    );
    expect(
      pak.entries.map((entry) => [entry.path, entry.record, entry.size]),
    ).toEqual([
      ["A/b.txt", "full", 9],
      ["A/c.txt", "encoded", 5],
    ]);
  });

  it("names entries by path hash when no full directory index exists", async () => {
    const pak = await read(
      createPakFixture({ layout: "v11", directoryIndex: false }).bytes,
    );
    expect(pak.index).toMatchObject({ full_directory_index: null });
    expect(pak.entries).toHaveLength(PAK_FIXTURE_FILES.length);
    expect(
      pak.entries.every(
        (entry) => entry.path === null && entry.path_hash !== null,
      ),
    ).toBe(true);
  });

  it("reports an encrypted index from the footer without reading it", async () => {
    const pak = await read(
      createPakFixture({ layout: "v11", encryptedIndex: true }).bytes,
    );
    expect(pak).toMatchObject({
      footer: { index_encrypted: true },
      index: { state: "encrypted" },
      entries: [],
    });
  });
});

describe("rejected Unreal pak files", () => {
  const valid = () => createPakFixture({ layout: "v11" });

  it("refuses an unrecognized footer", async () => {
    expect(await failure(Buffer.alloc(300))).toEqual({
      reason: "unrecognized-footer",
      kind: "unsupported",
    });
  });

  it("refuses a version 9 frozen index", async () => {
    expect(
      await failure(
        createPakFixture({ layout: "v9", frozenIndex: true }).bytes,
      ),
    ).toEqual({
      reason: "frozen-index",
      kind: "unsupported",
    });
  });

  it("rejects an index region that leaves the file", async () => {
    const { bytes } = valid();
    // Footer index size sits 4 + 8 bytes past the magic, before the SHA-1.
    const magic = bytes.lastIndexOf(Buffer.from([0xe1, 0x12, 0x6f, 0x5a]));
    bytes.writeBigUInt64LE(BigInt(bytes.length), magic + 16);
    expect(await failure(bytes)).toEqual({
      reason: "region-out-of-bounds",
      kind: "corrupt",
    });
  });

  it("rejects an index cut short", async () => {
    const { bytes, indexSize } = valid();
    const magic = bytes.lastIndexOf(Buffer.from([0xe1, 0x12, 0x6f, 0x5a]));
    bytes.writeBigUInt64LE(BigInt(indexSize - 6), magic + 16);
    expect((await failure(bytes)).kind).toBe("corrupt");
  });

  it("rejects duplicate legacy paths", async () => {
    const bytes = createPakFixture({
      layout: "v8b",
      files: [
        { path: "A/x", size: 1 },
        { path: "A/x", size: 1 },
      ],
    }).bytes;
    expect(await failure(bytes)).toEqual({
      reason: "duplicate-path",
      kind: "corrupt",
    });
  });

  it("refuses an index region above the limit before reading it", async () => {
    expect(
      await failure(valid().bytes, { regionBytes: 16, entries: 1000 }),
    ).toEqual({ reason: "region-too-large", kind: "resource" });
  });

  it("refuses more entries than the limit before building them", async () => {
    expect(
      await failure(valid().bytes, { regionBytes: 1 << 20, entries: 2 }),
    ).toEqual({
      reason: "too-many-entries",
      kind: "resource",
    });
  });

  it("lets the caller refuse an entry count before entries are built", async () => {
    const seen: number[] = [];
    await expect(
      read(valid().bytes, {
        ...LIMITS,
        beforeEntries: (count) => {
          seen.push(count);
          throw new Error("refused");
        },
      }),
    ).rejects.toThrow("refused");
    expect(seen).toEqual([PAK_FIXTURE_FILES.length]);
  });
});
