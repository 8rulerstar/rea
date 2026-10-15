import {
  IL2CPP_METADATA_SECTION_NAMES,
  type Il2cppMetadata,
  type Il2cppMetadataSection,
} from "../domain/il2cpp/il2cppMetadata.js";

export const IL2CPP_METADATA_MAGIC = 0xfab11baf;
export const IL2CPP_METADATA_SUPPORTED_VERSION = 39;
/** Magic, version and 31 (offset, size, count) int32 triples. */
export const IL2CPP_METADATA_V39_HEADER_BYTES =
  8 + IL2CPP_METADATA_SECTION_NAMES.length * 12;
const NESTED_TYPE_ENTRY_BYTES = 4;

/** Stable machine-readable reason for each rejected input. */
export const IL2CPP_METADATA_FAILURE_REASONS = {
  unsupported: ["unrecognized-magic", "unsupported-version"],
  corrupt: [
    "truncated-header",
    "unexpected-header-size",
    "section-out-of-bounds",
    "section-overlap",
    "record-size-mismatch",
    "type-index-width",
    "index-out-of-range",
    "nested-type-conflict",
    "declaring-type-mismatch",
    "invalid-string",
  ],
} as const;
export type Il2cppMetadataFailureKind =
  keyof typeof IL2CPP_METADATA_FAILURE_REASONS;
export type Il2cppMetadataFailureReason =
  (typeof IL2CPP_METADATA_FAILURE_REASONS)[Il2cppMetadataFailureKind][number];

/** Distinguish inputs outside decoder coverage from damaged version 39 metadata. */
export class Il2cppMetadataFormatFailure extends Error {
  readonly kind: Il2cppMetadataFailureKind;
  constructor(
    readonly reason: Il2cppMetadataFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${reason}: ${message}`, options);
    this.name = "Il2cppMetadataFormatFailure";
    this.kind = (
      IL2CPP_METADATA_FAILURE_REASONS.unsupported as readonly string[]
    ).includes(reason)
      ? "unsupported"
      : "corrupt";
  }
}

type SectionName = (typeof IL2CPP_METADATA_SECTION_NAMES)[number];
type IndexWidth = 1 | 2 | 4;
export type Il2cppMetadataDecoded = Omit<
  Il2cppMetadata,
  "artifact" | "limitations"
>;

/** Width the runtime selects for an index into a collection of this many entries. */
export const il2cppIndexWidth = (entries: number): IndexWidth =>
  entries <= 0xff ? 1 : entries <= 0xffff ? 2 : 4;

/** Record sizes implied by the variable index widths. */
export const il2cppMetadataRecordBytes = (widths: {
  readonly type_definition: IndexWidth;
  readonly generic_container: IndexWidth;
  readonly parameter: IndexWidth;
  readonly type: IndexWidth;
}) => ({
  // Two string indices, three type indices, a generic container index, flags,
  // eight int32 starts, eight uint16 counts, bitfield and token.
  typeDefinitions: 68 + 3 * widths.type + widths.generic_container,
  // Name, assembly, two type-definition starts with uint32 counts, entry
  // point, token, custom-attribute start and count.
  images: 32 + 2 * widths.type_definition,
  // Name, declaring type, return type, return token, parameter start,
  // generic container, token and four uint16 fields.
  methods:
    20 +
    widths.type_definition +
    widths.type +
    widths.parameter +
    widths.generic_container,
});

const isIndexWidth = (value: number): value is IndexWidth =>
  value === 1 || value === 2 || value === 4;

/** Read a serialized index; the all-ones value of narrow widths means -1. */
const readIndex = (bytes: Buffer, offset: number, width: IndexWidth) => {
  if (width === 1) {
    const value = bytes.readUInt8(offset);
    return value === 0xff ? -1 : value;
  }
  if (width === 2) {
    const value = bytes.readUInt16LE(offset);
    return value === 0xffff ? -1 : value;
  }
  return bytes.readInt32LE(offset);
};

const readHeader = (bytes: Buffer): Il2cppMetadataSection[] => {
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== IL2CPP_METADATA_MAGIC)
    throw new Il2cppMetadataFormatFailure(
      "unrecognized-magic",
      "the file does not start with the IL2CPP global-metadata magic 0xFAB11BAF; encrypted or non-metadata inputs are not decoded",
    );
  const version = bytes.readInt32LE(4);
  if (version !== IL2CPP_METADATA_SUPPORTED_VERSION)
    throw new Il2cppMetadataFormatFailure(
      "unsupported-version",
      `metadata version ${version} is not supported; only version ${IL2CPP_METADATA_SUPPORTED_VERSION} is decoded`,
    );
  if (bytes.length < IL2CPP_METADATA_V39_HEADER_BYTES)
    throw new Il2cppMetadataFormatFailure(
      "truncated-header",
      `the file has ${bytes.length} bytes, fewer than the ${IL2CPP_METADATA_V39_HEADER_BYTES}-byte version ${IL2CPP_METADATA_SUPPORTED_VERSION} header`,
    );
  return IL2CPP_METADATA_SECTION_NAMES.map((name, index) => {
    const at = 8 + index * 12;
    return {
      name,
      offset: bytes.readInt32LE(at),
      size: bytes.readInt32LE(at + 4),
      count: bytes.readInt32LE(at + 8),
    };
  });
};

const checkSections = (
  bytes: Buffer,
  sections: readonly Il2cppMetadataSection[],
) => {
  const first = sections[0];
  if (first?.offset !== IL2CPP_METADATA_V39_HEADER_BYTES)
    throw new Il2cppMetadataFormatFailure(
      "unexpected-header-size",
      `stringLiterals starts at ${String(first?.offset)}, not immediately after the ${IL2CPP_METADATA_V39_HEADER_BYTES}-byte header`,
    );
  for (const section of sections)
    if (
      section.offset < 0 ||
      section.size < 0 ||
      section.count < 0 ||
      section.offset + section.size > bytes.length
    )
      throw new Il2cppMetadataFormatFailure(
        "section-out-of-bounds",
        `section ${section.name} (offset ${section.offset}, size ${section.size}, count ${section.count}) is negative or extends past the ${bytes.length}-byte file`,
      );
  // Empty sections may share an offset with any neighbor; gaps are padding.
  const occupied = sections
    .filter((section) => section.size > 0)
    .sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < occupied.length; index += 1) {
    const previous = occupied[index - 1]!;
    const current = occupied[index]!;
    if (previous.offset + previous.size > current.offset)
      throw new Il2cppMetadataFormatFailure(
        "section-overlap",
        `section ${previous.name} [${previous.offset}, ${previous.offset + previous.size}) overlaps ${current.name} starting at ${current.offset}`,
      );
  }
};

const recordBytes = (section: Il2cppMetadataSection): number | null => {
  if (section.count === 0) {
    if (section.size !== 0)
      throw new Il2cppMetadataFormatFailure(
        "record-size-mismatch",
        `section ${section.name} declares ${section.size} bytes for zero records`,
      );
    return null;
  }
  if (section.size % section.count !== 0)
    throw new Il2cppMetadataFormatFailure(
      "record-size-mismatch",
      `section ${section.name} size ${section.size} is not a whole multiple of its ${section.count} records`,
    );
  return section.size / section.count;
};

const resolveWidths = (
  section: (name: SectionName) => Il2cppMetadataSection,
): Il2cppMetadataDecoded["index_widths"] => {
  const type_definition = il2cppIndexWidth(section("typeDefinitions").count);
  const generic_container = il2cppIndexWidth(
    section("genericContainers").count,
  );
  const parameter = il2cppIndexWidth(section("parameters").count);
  // TypeIndex counts native types, so its width is recovered from records.
  const interfaceOffset = recordBytes(section("interfaceOffsets"));
  let type: number;
  let type_width_source: Il2cppMetadataDecoded["index_widths"]["type_width_source"];
  if (interfaceOffset !== null) {
    type = interfaceOffset - 4;
    type_width_source = "interface-offsets-record";
  } else {
    const typeDefinition = recordBytes(section("typeDefinitions"));
    type =
      typeDefinition === null
        ? Number.NaN
        : (typeDefinition - 68 - generic_container) / 3;
    type_width_source = "type-definition-record";
  }
  if (!isIndexWidth(type))
    throw new Il2cppMetadataFormatFailure(
      "type-index-width",
      `the ${type_width_source} does not imply a 1-, 2- or 4-byte TypeIndex`,
    );
  return {
    type_definition,
    generic_container,
    parameter,
    type,
    type_width_source,
  };
};

const checkRange = (
  label: string,
  start: number,
  length: number,
  total: number,
) => {
  if (length === 0 && start >= -1 && start <= total) return;
  if (start < 0 || start + length > total)
    throw new Il2cppMetadataFormatFailure(
      "index-out-of-range",
      `${label} range [${start}, ${start + length}) is outside the ${total} available entries`,
    );
};

/**
 * Decode NUL-terminated UTF-8 names once each from the strings section. An
 * index must start a string, so a shifted section or a pointer into another
 * name fails instead of returning a different name, and total decoding stays
 * bounded by the section size.
 */
const createStringReader = (bytes: Buffer, strings: Il2cppMetadataSection) => {
  const stringEnd = strings.offset + strings.size;
  const pool = bytes.subarray(strings.offset, stringEnd);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const cache = new Map<number, string>();
  return (index: number, label: string) => {
    const cached = cache.get(index);
    if (cached !== undefined) return cached;
    const end = index < 0 || index >= pool.length ? -1 : pool.indexOf(0, index);
    if (end === -1)
      throw new Il2cppMetadataFormatFailure(
        "invalid-string",
        `${label} string index ${index} has no terminated entry inside the ${strings.size}-byte string section`,
      );
    if (index > 0 && pool[index - 1] !== 0)
      throw new Il2cppMetadataFormatFailure(
        "invalid-string",
        `${label} string index ${index} starts inside another string`,
      );
    let value: string;
    try {
      value = decoder.decode(pool.subarray(index, end));
    } catch (cause: unknown) {
      throw new Il2cppMetadataFormatFailure(
        "invalid-string",
        `${label} string index ${index} is not valid UTF-8`,
        { cause },
      );
    }
    cache.set(index, value);
    return value;
  };
};

/** Checked header facts shared by the record readers. */
interface MetadataTables {
  readonly bytes: Buffer;
  readonly section: (name: SectionName) => Il2cppMetadataSection;
  readonly widths: Il2cppMetadataDecoded["index_widths"];
  readonly recordBytes: ReturnType<typeof il2cppMetadataRecordBytes>;
  readonly readString: ReturnType<typeof createStringReader>;
}

const readImages = ({
  bytes,
  section,
  widths,
  recordBytes: sizes,
  readString,
}: MetadataTables): Il2cppMetadataDecoded["images"] => {
  const images = section("images");
  const typeTotal = section("typeDefinitions").count;
  const width = widths.type_definition;
  return Array.from({ length: images.count }, (_, index) => {
    const at = images.offset + index * sizes.images;
    const image = {
      name: readString(bytes.readInt32LE(at), `image ${index} name`),
      type_start: readIndex(bytes, at + 8, width),
      type_count: bytes.readUInt32LE(at + 8 + width),
    };
    checkRange(
      `image ${index} types`,
      image.type_start,
      image.type_count,
      typeTotal,
    );
    return image;
  });
};

/** Record each type's enclosing type from its declaring type's nestedTypes range. */
const assignNesting = (
  { bytes, section }: MetadataTables,
  types: Il2cppMetadataDecoded["types"],
) => {
  const nestedTypes = section("nestedTypes");
  if (nestedTypes.size !== nestedTypes.count * NESTED_TYPE_ENTRY_BYTES)
    throw new Il2cppMetadataFormatFailure(
      "record-size-mismatch",
      `section nestedTypes size ${nestedTypes.size} does not hold ${nestedTypes.count} 4-byte entries`,
    );
  for (const [index, type] of types.entries()) {
    checkRange(
      `type ${index} nested types`,
      type.nested_type_start,
      type.nested_type_count,
      nestedTypes.count,
    );
    for (let offset = 0; offset < type.nested_type_count; offset += 1) {
      const nested = bytes.readInt32LE(
        nestedTypes.offset +
          (type.nested_type_start + offset) * NESTED_TYPE_ENTRY_BYTES,
      );
      const target = types[nested];
      if (target === undefined)
        throw new Il2cppMetadataFormatFailure(
          "index-out-of-range",
          `type ${index} lists nested type ${nested} outside the ${types.length} type definitions`,
        );
      if (nested === index)
        throw new Il2cppMetadataFormatFailure(
          "nested-type-conflict",
          `type ${index} lists itself as a nested type`,
        );
      if (target.declaring_type !== -1)
        throw new Il2cppMetadataFormatFailure(
          "nested-type-conflict",
          `type ${nested} is listed as nested in type ${index} and type ${target.declaring_type}`,
        );
      target.declaring_type = index;
    }
  }
  rejectNestingCycles(types);
};

/** Each enclosing chain must reach a top-level type. */
const rejectNestingCycles = (types: Il2cppMetadataDecoded["types"]) => {
  // 0 unvisited, 1 on the current chain, 2 reaches a top-level type.
  const state = new Uint8Array(types.length);
  for (let first = 0; first < types.length; first += 1) {
    const chain: number[] = [];
    let current = first;
    while (current !== -1 && state[current] === 0) {
      state[current] = 1;
      chain.push(current);
      current = types[current]!.declaring_type;
    }
    if (current !== -1 && state[current] === 1)
      throw new Il2cppMetadataFormatFailure(
        "nested-type-conflict",
        `type ${current} is nested inside itself through its declaring types`,
      );
    for (const index of chain) state[index] = 2;
  }
};

const readTypes = (tables: MetadataTables): Il2cppMetadataDecoded["types"] => {
  const { bytes, section, widths, recordBytes: sizes, readString } = tables;
  const typeDefinitions = section("typeDefinitions");
  const methodTotal = section("methods").count;
  const types = Array.from({ length: typeDefinitions.count }, (_, index) => {
    const at = typeDefinitions.offset + index * sizes.typeDefinitions;
    // int32 starts follow both string indices, three type indices, the
    // generic container index and flags.
    const starts = at + 12 + 3 * widths.type + widths.generic_container;
    const counts = starts + 32;
    const type = {
      name: readString(bytes.readInt32LE(at), `type ${index} name`),
      namespace: readString(
        bytes.readInt32LE(at + 4),
        `type ${index} namespace`,
      ),
      method_start: bytes.readInt32LE(starts + 4),
      method_count: bytes.readUInt16LE(counts),
      nested_type_start: bytes.readInt32LE(starts + 16),
      nested_type_count: bytes.readUInt16LE(counts + 8),
      declaring_type: -1,
    };
    checkRange(
      `type ${index} methods`,
      type.method_start,
      type.method_count,
      methodTotal,
    );
    return type;
  });
  assignNesting(tables, types);
  return types;
};

const readMethods = ({
  bytes,
  section,
  widths,
  recordBytes: sizes,
  readString,
}: MetadataTables): Il2cppMetadataDecoded["methods"] => {
  const methods = section("methods");
  const typeTotal = section("typeDefinitions").count;
  return Array.from({ length: methods.count }, (_, index) => {
    const at = methods.offset + index * sizes.methods;
    const method = {
      name: readString(bytes.readInt32LE(at), `method ${index} name`),
      declaring_type: readIndex(bytes, at + 4, widths.type_definition),
    };
    if (method.declaring_type < -1 || method.declaring_type >= typeTotal)
      throw new Il2cppMetadataFormatFailure(
        "index-out-of-range",
        `method ${index} declares type ${method.declaring_type} outside the ${typeTotal} type definitions`,
      );
    return method;
  });
};

/** Methods inside a type's range must name that type as their declaring type. */
const checkMethodOwners = (
  types: Il2cppMetadataDecoded["types"],
  methods: Il2cppMetadataDecoded["methods"],
) => {
  for (const [index, type] of types.entries())
    for (let offset = 0; offset < type.method_count; offset += 1) {
      const method = type.method_start + offset;
      const declaring = methods[method]!.declaring_type;
      if (declaring !== index)
        throw new Il2cppMetadataFormatFailure(
          "declaring-type-mismatch",
          `method ${method} is in type ${index}'s range but declares type ${declaring}`,
        );
    }
};

/** Decode version 39 image, type and method names without native binaries or decryption. */
export const readIl2cppMetadata = (bytes: Buffer): Il2cppMetadataDecoded => {
  const sections = readHeader(bytes);
  checkSections(bytes, sections);
  const byName = new Map(sections.map((entry) => [entry.name, entry]));
  const section = (name: SectionName) => byName.get(name)!;
  const widths = resolveWidths(section);
  const expected = il2cppMetadataRecordBytes(widths);
  for (const name of ["typeDefinitions", "images", "methods"] as const) {
    const actual = recordBytes(section(name));
    if (actual !== null && actual !== expected[name])
      throw new Il2cppMetadataFormatFailure(
        "record-size-mismatch",
        `section ${name} records are ${actual} bytes, but the index widths imply ${expected[name]}`,
      );
  }
  const tables: MetadataTables = {
    bytes,
    section,
    widths,
    recordBytes: expected,
    readString: createStringReader(bytes, section("strings")),
  };
  const types = readTypes(tables);
  const methods = readMethods(tables);
  checkMethodOwners(types, methods);
  return {
    metadata_version: IL2CPP_METADATA_SUPPORTED_VERSION,
    index_widths: widths,
    sections,
    images: readImages(tables),
    types,
    methods,
  };
};
