import { describe, expect, it } from "vitest";
import {
  il2cppIndexWidth,
  il2cppMetadataRecordBytes,
  Il2cppMetadataFormatFailure,
  readIl2cppMetadata,
  type Il2cppMetadataFailureReason,
} from "../../../src/il2cpp/Il2cppMetadataFile.js";
import {
  createIl2cppMetadataFixture,
  FIXTURE_IMAGES,
  FIXTURE_METHODS,
  FIXTURE_TYPES,
  type Il2cppMetadataFixture,
} from "../../fixtures/il2cpp/metadata.js";

const failure = (bytes: Buffer) => {
  try {
    readIl2cppMetadata(bytes);
  } catch (cause: unknown) {
    if (cause instanceof Il2cppMetadataFormatFailure) return cause;
    throw cause;
  }
  throw new Error("Expected the metadata to be rejected");
};

const rejects = (
  bytes: Buffer,
  reason: Il2cppMetadataFailureReason,
  kind: "unsupported" | "corrupt" = "corrupt",
) => {
  const rejected = failure(bytes);
  expect(rejected.reason).toBe(reason);
  expect(rejected.kind).toBe(kind);
  expect(rejected.message.startsWith(`${reason}: `)).toBe(true);
};

const mutated = (
  edit: (fixture: Il2cppMetadataFixture, bytes: Buffer) => void,
  fixture = createIl2cppMetadataFixture(),
) => {
  const bytes = Buffer.from(fixture.bytes);
  edit(fixture, bytes);
  return bytes;
};

describe("IL2CPP global-metadata version 39", () => {
  it.each([1, 2, 4] as const)(
    "decodes names, ranges and nesting with a %i-byte TypeIndex under 1 KiB",
    (typeIndexWidth) => {
      const fixture = createIl2cppMetadataFixture({ typeIndexWidth });
      expect(fixture.bytes.length).toBeLessThan(1024);
      const decoded = readIl2cppMetadata(fixture.bytes);
      expect(decoded.metadata_version).toBe(39);
      expect(decoded.index_widths).toEqual({
        type_definition: 1,
        generic_container: 1,
        parameter: 1,
        type: typeIndexWidth,
        type_width_source: "interface-offsets-record",
      });
      expect(decoded.images).toEqual(FIXTURE_IMAGES);
      expect(decoded.types).toEqual(FIXTURE_TYPES);
      expect(decoded.methods).toEqual(FIXTURE_METHODS);
      expect(decoded.sections).toHaveLength(31);
      expect(decoded.sections[0]).toEqual({
        name: "stringLiterals",
        offset: 380,
        size: 0,
        count: 0,
      });
    },
  );

  it("recovers the TypeIndex width from type records without interfaceOffsets", () => {
    const fixture = createIl2cppMetadataFixture({
      typeIndexWidth: 2,
      interfaceOffsets: false,
    });
    const decoded = readIl2cppMetadata(fixture.bytes);
    expect(decoded.index_widths.type).toBe(2);
    expect(decoded.index_widths.type_width_source).toBe(
      "type-definition-record",
    );
    expect(decoded.methods).toEqual(FIXTURE_METHODS);
  });

  it("accepts empty sections that share an offset with occupied sections and padding gaps", () => {
    const bytes = mutated((fixture, target) => {
      const methods = fixture.section("methods");
      target.writeInt32LE(
        methods.offset + 3,
        fixture.header("windowsRuntimeStrings", "offset"),
      );
      // Grow strings into trailing padding that no other section occupies.
      target.writeInt32LE(
        fixture.section("strings").size,
        fixture.header("strings", "size"),
      );
    });
    expect(readIl2cppMetadata(bytes).types).toEqual(FIXTURE_TYPES);
  });
});

describe("rejected IL2CPP global-metadata", () => {
  it("rejects an unrecognized magic and other versions as unsupported", () => {
    rejects(
      mutated((_, bytes) => bytes.writeUInt32LE(0x12345678, 0)),
      "unrecognized-magic",
      "unsupported",
    );
    rejects(Buffer.alloc(4), "unrecognized-magic", "unsupported");
    rejects(
      mutated((_, bytes) => bytes.writeInt32LE(31, 4)),
      "unsupported-version",
      "unsupported",
    );
  });

  it("rejects a truncated header and an unexpected header size", () => {
    rejects(
      createIl2cppMetadataFixture().bytes.subarray(0, 200),
      "truncated-header",
    );
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeInt32LE(384, fixture.header("stringLiterals", "offset")),
      ),
      "unexpected-header-size",
    );
  });

  it("rejects sections outside the file or with negative fields", () => {
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeInt32LE(bytes.length, fixture.header("methods", "size")),
      ),
      "section-out-of-bounds",
    );
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeInt32LE(-1, fixture.header("events", "count")),
      ),
      "section-out-of-bounds",
    );
  });

  it("rejects overlapping occupied sections", () => {
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeInt32LE(
          fixture.section("typeDefinitions").offset + 4,
          fixture.header("images", "offset"),
        ),
      ),
      "section-overlap",
    );
  });

  it("rejects record sizes that disagree with counts or index widths", () => {
    // Not a whole multiple of the record count.
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeInt32LE(
          fixture.section("methods").count + 1,
          fixture.header("methods", "count"),
        ),
      ),
      "record-size-mismatch",
    );
    // 300 generic containers widen GenericContainerIndex to two bytes.
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeInt32LE(300, fixture.header("genericContainers", "count")),
      ),
      "record-size-mismatch",
    );
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeInt32LE(2, fixture.header("nestedTypes", "count")),
      ),
      "record-size-mismatch",
    );
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeInt32LE(0, fixture.header("methods", "count")),
      ),
      "record-size-mismatch",
    );
  });

  it("rejects an interfaceOffsets record that implies no valid TypeIndex width", () => {
    rejects(
      createIl2cppMetadataFixture({ interfaceOffsetRecordBytes: 7 }).bytes,
      "type-index-width",
    );
  });
});

describe("rejected IL2CPP metadata references", () => {
  it("rejects image, type, method and nested-type indices outside their tables", () => {
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeUInt32LE(9, fixture.record("images", 1) + 9),
      ),
      "index-out-of-range",
    );
    rejects(
      mutated((fixture, bytes) => {
        // methodStart follows fieldStart in the int32 start block.
        const at = fixture.record("typeDefinitions", 0) + 8 + 3 + 1 + 4 + 4;
        bytes.writeInt32LE(4, at);
      }),
      "index-out-of-range",
    );
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeUInt8(4, fixture.record("methods", 2) + 4),
      ),
      "index-out-of-range",
    );
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeInt32LE(4, fixture.section("nestedTypes").offset),
      ),
      "index-out-of-range",
    );
  });

  it("rejects a type nested in two declaring types", () => {
    rejects(
      mutated((fixture, bytes) => {
        // Two string indices, three 1-byte type indices, generic container, flags.
        const starts = fixture.record("typeDefinitions", 3) + 8 + 3 + 1 + 4;
        bytes.writeInt32LE(0, starts + 16);
        bytes.writeUInt16LE(1, starts + 32 + 8);
      }),
      "nested-type-conflict",
    );
  });

  it("rejects unterminated, out-of-range and non-UTF-8 strings", () => {
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeInt32LE(
          fixture.section("strings").size,
          fixture.record("methods", 0),
        ),
      ),
      "invalid-string",
    );
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeInt32LE(
          fixture.section("strings").size - 1,
          fixture.header("strings", "size"),
        ),
      ),
      "invalid-string",
    );
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeUInt8(0xff, fixture.stringOffset("Update")),
      ),
      "invalid-string",
    );
  });

  it("rejects a shifted string section and names that start inside another string", () => {
    for (const delta of [-1, 1])
      rejects(
        mutated((fixture, bytes) => {
          const strings = fixture.section("strings");
          bytes.writeInt32LE(
            strings.offset + delta,
            fixture.header("strings", "offset"),
          );
          // Shrink a forward shift so it stays clear of the next section.
          bytes.writeInt32LE(
            strings.size - Math.max(delta, 0),
            fixture.header("strings", "size"),
          );
        }),
        "invalid-string",
      );
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeInt32LE(
          fixture.stringOffset("Update") +
            1 -
            fixture.section("strings").offset,
          fixture.record("methods", 0),
        ),
      ),
      "invalid-string",
    );
  });

  it("rejects nesting cycles and self-nesting", () => {
    // Type 0 owns nestedTypes entry 0; listing itself there is a self-cycle.
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeInt32LE(0, fixture.section("nestedTypes").offset),
      ),
      "nested-type-conflict",
    );
    rejects(
      createIl2cppMetadataFixture({ nestingCycle: true }).bytes,
      "nested-type-conflict",
    );
  });

  it("rejects methods whose declaring type disagrees with the owning type range", () => {
    rejects(
      mutated((fixture, bytes) =>
        bytes.writeUInt8(3, fixture.record("methods", 1) + 4),
      ),
      "declaring-type-mismatch",
    );
  });
});

describe("IL2CPP index widths", () => {
  it("switches widths at the runtime's 255 and 65535 entry boundaries", () => {
    expect(
      [0, 255, 256, 65535, 65536].map((entries) => il2cppIndexWidth(entries)),
    ).toEqual([1, 1, 2, 2, 4]);
    expect(
      il2cppMetadataRecordBytes({
        type_definition: 2,
        generic_container: 2,
        parameter: 4,
        type: 2,
      }),
    ).toEqual({ typeDefinitions: 76, images: 36, methods: 30 });
  });
});
