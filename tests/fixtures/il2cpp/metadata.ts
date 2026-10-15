import { IL2CPP_METADATA_SECTION_NAMES } from "../../../src/domain/il2cpp/il2cppMetadata.js";

type SectionName = (typeof IL2CPP_METADATA_SECTION_NAMES)[number];
type Width = 1 | 2 | 4;

/** Synthetic version 39 metadata small enough to read in a hex dump. */
export interface Il2cppMetadataFixtureOptions {
  /** Serialized TypeIndex width. */
  readonly typeIndexWidth?: Width;
  /** Omit interfaceOffsets so the TypeIndex width comes from type records. */
  readonly interfaceOffsets?: boolean;
  /** Raw interfaceOffsets record size; defaults to 4 + typeIndexWidth. */
  readonly interfaceOffsetRecordBytes?: number;
  /** Make type 1 also list type 0, so 0 and 1 nest in each other. */
  readonly nestingCycle?: boolean;
}

export const FIXTURE_IMAGES = [
  { name: "Assembly-CSharp.dll", type_start: 0, type_count: 3 },
  { name: "mscorlib.dll", type_start: 3, type_count: 1 },
] as const;

export const FIXTURE_TYPES = [
  {
    name: "Player",
    namespace: "Game",
    method_start: 0,
    method_count: 2,
    nested_type_start: 0,
    nested_type_count: 1,
    declaring_type: -1,
  },
  {
    name: "Slot",
    namespace: "",
    method_start: 2,
    method_count: 1,
    nested_type_start: -1,
    nested_type_count: 0,
    declaring_type: 0,
  },
  {
    name: "<Module>",
    namespace: "",
    method_start: -1,
    method_count: 0,
    nested_type_start: -1,
    nested_type_count: 0,
    declaring_type: -1,
  },
  {
    name: "Größe",
    namespace: "System",
    method_start: 3,
    method_count: 2,
    nested_type_start: -1,
    nested_type_count: 0,
    declaring_type: -1,
  },
] as const;

export const FIXTURE_METHODS = [
  { name: ".ctor", declaring_type: 0 },
  { name: "Update", declaring_type: 0 },
  { name: "Add", declaring_type: 1 },
  { name: ".ctor", declaring_type: 3 },
  { name: "ToString", declaring_type: 3 },
] as const;

const writeIndex = (
  target: Buffer,
  offset: number,
  width: Width,
  value: number,
) => {
  if (width === 1) target.writeUInt8(value === -1 ? 0xff : value, offset);
  else if (width === 2)
    target.writeUInt16LE(value === -1 ? 0xffff : value, offset);
  else target.writeInt32LE(value, offset);
};

/** Built bytes with helpers that address header fields and records by name. */
export interface Il2cppMetadataFixture {
  readonly bytes: Buffer;
  readonly typeIndexWidth: Width;
  readonly recordBytes: {
    readonly typeDefinitions: number;
    readonly images: number;
    readonly methods: number;
  };
  /** Byte offset of a header triple field. */
  header(name: SectionName, field: "offset" | "size" | "count"): number;
  section(name: SectionName): { offset: number; size: number; count: number };
  record(name: "typeDefinitions" | "images" | "methods", index: number): number;
  /** Absolute offset of a string's first byte in the strings section. */
  stringOffset(value: string): number;
}

/** Lay sections out in header order; empty sections share the next offset. */
export const createIl2cppMetadataFixture = (
  options: Il2cppMetadataFixtureOptions = {},
): Il2cppMetadataFixture => {
  const T = options.typeIndexWidth ?? 1;
  // Fewer than 256 type definitions, generic containers and parameters.
  const D = 1 as const;
  const G = 1 as const;
  const P = 1 as const;
  const nestedTypeEntries = options.nestingCycle === true ? [1, 0] : [1];
  const typeRows = FIXTURE_TYPES.map((type, index) =>
    options.nestingCycle === true && index === 1
      ? { ...type, nested_type_start: 1, nested_type_count: 1 }
      : type,
  );
  const recordBytes = {
    typeDefinitions: 68 + 3 * T + G,
    images: 32 + 2 * D,
    methods: 20 + D + T + P + G,
  };

  const stringParts: Buffer[] = [];
  const stringIndex = new Map<string, number>();
  let stringBytes = 0;
  const intern = (value: string) => {
    const known = stringIndex.get(value);
    if (known !== undefined) return known;
    const encoded = Buffer.from(`${value}\0`, "utf8");
    stringIndex.set(value, stringBytes);
    stringParts.push(encoded);
    stringBytes += encoded.length;
    return stringIndex.get(value)!;
  };
  for (const image of FIXTURE_IMAGES) intern(image.name);
  for (const type of FIXTURE_TYPES) {
    intern(type.name);
    intern(type.namespace);
  }
  for (const method of FIXTURE_METHODS) intern(method.name);
  const strings = Buffer.concat(stringParts);

  const types = Buffer.alloc(
    FIXTURE_TYPES.length * recordBytes.typeDefinitions,
  );
  typeRows.forEach((type, index) => {
    let at = index * recordBytes.typeDefinitions;
    types.writeInt32LE(intern(type.name), at);
    types.writeInt32LE(intern(type.namespace), at + 4);
    at += 8;
    // byval, native declaring and parent TypeIndex values are deliberately
    // unrelated to nesting; the reader must use nestedTypes instead.
    for (let field = 0; field < 3; field += 1, at += T)
      writeIndex(types, at, T, 0x2a);
    writeIndex(types, at, G, -1);
    at += G + 4;
    const starts = [-1, type.method_start, -1, -1, type.nested_type_start];
    starts.forEach((value, field) => types.writeInt32LE(value, at + field * 4));
    types.writeInt32LE(-1, at + 20);
    types.writeInt32LE(-1, at + 24);
    types.writeInt32LE(-1, at + 28);
    at += 32;
    types.writeUInt16LE(type.method_count, at);
    types.writeUInt16LE(type.nested_type_count, at + 8);
    at += 16;
    types.writeUInt32LE(0, at);
    types.writeUInt32LE(0x02000001 + index, at + 4);
  });

  const images = Buffer.alloc(FIXTURE_IMAGES.length * recordBytes.images);
  FIXTURE_IMAGES.forEach((image, index) => {
    const at = index * recordBytes.images;
    images.writeInt32LE(intern(image.name), at);
    images.writeInt32LE(index, at + 4);
    writeIndex(images, at + 8, D, image.type_start);
    images.writeUInt32LE(image.type_count, at + 8 + D);
    writeIndex(images, at + 12 + D, D, -1);
    images.writeUInt32LE(0, at + 12 + 2 * D);
    images.writeInt32LE(-1, at + 16 + 2 * D);
  });

  const methods = Buffer.alloc(FIXTURE_METHODS.length * recordBytes.methods);
  FIXTURE_METHODS.forEach((method, index) => {
    const at = index * recordBytes.methods;
    methods.writeInt32LE(intern(method.name), at);
    writeIndex(methods, at + 4, D, method.declaring_type);
    writeIndex(methods, at + 4 + D, T, 0);
    writeIndex(methods, at + 8 + D + T, P, -1);
    writeIndex(methods, at + 8 + D + T + P, G, -1);
    methods.writeUInt32LE(0x06000001 + index, at + 8 + D + T + P + G);
  });

  const nested = Buffer.alloc(nestedTypeEntries.length * 4);
  nestedTypeEntries.forEach((value, index) =>
    nested.writeInt32LE(value, index * 4),
  );

  const interfaceOffsetBytes = options.interfaceOffsetRecordBytes ?? 4 + T;
  const interfaceOffsets =
    options.interfaceOffsets === false
      ? null
      : Buffer.alloc(interfaceOffsetBytes);

  const contents = new Map<SectionName, { bytes: Buffer; count: number }>([
    ["strings", { bytes: strings, count: stringIndex.size }],
    ["methods", { bytes: methods, count: FIXTURE_METHODS.length }],
    ["nestedTypes", { bytes: nested, count: nestedTypeEntries.length }],
    ["typeDefinitions", { bytes: types, count: FIXTURE_TYPES.length }],
    ["images", { bytes: images, count: FIXTURE_IMAGES.length }],
    ...(interfaceOffsets === null
      ? []
      : [
          ["interfaceOffsets", { bytes: interfaceOffsets, count: 1 }] as [
            SectionName,
            { bytes: Buffer; count: number },
          ],
        ]),
  ]);

  const headerBytes = 8 + IL2CPP_METADATA_SECTION_NAMES.length * 12;
  const header = Buffer.alloc(headerBytes);
  header.writeUInt32LE(0xfab11baf, 0);
  header.writeInt32LE(39, 4);
  const body: Buffer[] = [];
  let cursor = headerBytes;
  IL2CPP_METADATA_SECTION_NAMES.forEach((name, index) => {
    const content = contents.get(name);
    const at = 8 + index * 12;
    header.writeInt32LE(cursor, at);
    header.writeInt32LE(content?.bytes.length ?? 0, at + 4);
    header.writeInt32LE(content?.count ?? 0, at + 8);
    if (content !== undefined) {
      body.push(content.bytes);
      cursor += content.bytes.length;
    }
  });
  const bytes = Buffer.concat([header, ...body]);
  const headerField = (name: SectionName, field: "offset" | "size" | "count") =>
    8 +
    IL2CPP_METADATA_SECTION_NAMES.indexOf(name) * 12 +
    { offset: 0, size: 4, count: 8 }[field];
  const section = (name: SectionName) => ({
    offset: bytes.readInt32LE(headerField(name, "offset")),
    size: bytes.readInt32LE(headerField(name, "size")),
    count: bytes.readInt32LE(headerField(name, "count")),
  });
  return {
    bytes,
    typeIndexWidth: T,
    recordBytes,
    header: headerField,
    section,
    record: (name, index) => section(name).offset + index * recordBytes[name],
    stringOffset: (value) => {
      const index = stringIndex.get(value);
      if (index === undefined) throw new Error(`Unknown string ${value}`);
      return section("strings").offset + index;
    },
  };
};
