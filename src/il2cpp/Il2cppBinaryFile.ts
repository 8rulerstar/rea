import {
  readFatContainerHeader,
  validateFatSlice,
} from "../domain/apple/machoContainer.js";
import {
  GoBinaryFormatFailure,
  mappedFileOffset,
  type GoBinaryContainer,
} from "../go/GoBinaryContainer.js";
import { readGoBinaryContainer } from "../go/GoBinaryImage.js";
import type {
  Il2cppMetadataDecoded,
  Il2cppMetadataLinkFacts,
} from "./Il2cppMetadataFile.js";

export const IL2CPP_BINARY_FAILURE_REASONS = {
  unsupported: [
    "unsupported-container",
    "slice-selection-required",
    "slice-not-found",
    "unsupported-pointer-encoding",
  ],
  malformed: [
    "malformed-container",
    "code-gen-modules-not-found",
    "ambiguous-code-gen-module",
    "code-registration-not-found",
    "invalid-method-pointer",
    "invalid-method-token",
    "metadata-registration-not-found",
    "invalid-type",
  ],
} as const;

export type Il2cppBinaryFailureReason =
  (typeof IL2CPP_BINARY_FAILURE_REASONS)[keyof typeof IL2CPP_BINARY_FAILURE_REASONS][number];

/** A native image REA cannot link, either outside coverage or inconsistent with the metadata. */
export class Il2cppBinaryFormatFailure extends Error {
  readonly kind: "unsupported" | "malformed";
  constructor(
    readonly reason: Il2cppBinaryFailureReason,
    message: string,
  ) {
    super(`${reason}: ${message}`);
    this.name = "Il2cppBinaryFormatFailure";
    this.kind = (
      IL2CPP_BINARY_FAILURE_REASONS.unsupported as readonly string[]
    ).includes(reason)
      ? "unsupported"
      : "malformed";
  }
}

/** One linked code-generation module; its name matches a metadata image. */
export interface Il2cppCodeGenModule {
  readonly image: number;
  readonly address: bigint;
  readonly method_pointer_count: number;
  readonly method_pointers: bigint;
}

export interface Il2cppBinaryLink {
  readonly format: "macho" | "pe";
  readonly architecture: string;
  readonly image_base: bigint;
  /** Address of the CodeRegistration field holding the module pointer array. */
  readonly code_gen_modules_field: bigint;
  readonly code_gen_modules: readonly Il2cppCodeGenModule[];
  /** Native code address per metadata method index; null when the module has no body. */
  readonly method_addresses: readonly (bigint | null)[];
  /** Address of MetadataRegistration's typesCount field. */
  readonly types_field: bigint;
  readonly types_count: number;
  /** Il2CppType table index and display name per method return, field and parameter. */
  readonly return_types: readonly Il2cppTypeReference[];
  readonly field_types: readonly Il2cppTypeReference[];
  readonly parameter_types: readonly Il2cppTypeReference[];
}

export interface Il2cppTypeReference {
  readonly type: number;
  readonly name: string | null;
}

const MACHO_CPU = new Map([
  [0x01000007, "amd64"],
  [0x0100000c, "arm64"],
]);
const LC_DYLD_CHAINED_FIXUPS = 0x80000034;

/** Select one thin image; a universal Mach-O needs the caller's architecture. */
const selectImage = (
  bytes: Buffer,
  architecture: string | undefined,
): Buffer => {
  const fat = readFatContainerHeader(bytes, bytes.length);
  if (fat.state === "not-fat") {
    if (architecture !== undefined)
      throw new Il2cppBinaryFormatFailure(
        "slice-not-found",
        `architecture ${architecture} was requested but the binary is not a universal Mach-O`,
      );
    return bytes;
  }
  if (fat.state !== "parsed")
    throw new Il2cppBinaryFormatFailure(
      "malformed-container",
      fat.state === "malformed" ? fat.reason : "universal header is truncated",
    );
  const available = fat.slices.map(
    (slice) => MACHO_CPU.get(slice.cpuType) ?? `macho-cpu-${slice.cpuType}`,
  );
  if (architecture === undefined)
    throw new Il2cppBinaryFormatFailure(
      "slice-selection-required",
      `universal Mach-O holds ${available.join(", ")}; select one architecture`,
    );
  const index = available.indexOf(architecture);
  const slice = fat.slices[index];
  if (slice === undefined)
    throw new Il2cppBinaryFormatFailure(
      "slice-not-found",
      `universal Mach-O holds ${available.join(", ")}, not ${architecture}`,
    );
  const issue = validateFatSlice(slice, bytes.length, fat.tableEnd);
  if (issue !== null)
    throw new Il2cppBinaryFormatFailure("malformed-container", issue);
  return bytes.subarray(slice.offset, slice.offset + slice.size);
};

/** Mach-O load commands that change how on-disk pointers must be read. */
const usesChainedFixups = (image: Buffer): boolean => {
  const count = image.readUInt32LE(16);
  let offset = 32;
  for (let index = 0; index < count; index++) {
    if (offset + 8 > image.length) return false;
    if (image.readUInt32LE(offset) === LC_DYLD_CHAINED_FIXUPS) return true;
    offset += image.readUInt32LE(offset + 4);
  }
  return false;
};

interface NativeImage {
  readonly bytes: Buffer;
  readonly container: GoBinaryContainer;
  readonly imageBase: bigint;
}

const openImage = (
  bytes: Buffer,
  architecture: string | undefined,
): NativeImage => {
  const image = selectImage(bytes, architecture);
  let container: GoBinaryContainer;
  try {
    container = readGoBinaryContainer(image);
  } catch (cause) {
    if (cause instanceof GoBinaryFormatFailure)
      throw new Il2cppBinaryFormatFailure(
        cause.kind === "unsupported"
          ? "unsupported-container"
          : "malformed-container",
        cause.message,
      );
    throw cause;
  }
  if (container.format === "elf")
    // Position-independent ELF stores RELA addends outside the pointer slots.
    throw new Il2cppBinaryFormatFailure(
      "unsupported-pointer-encoding",
      "ELF images need relocation processing, which is not implemented",
    );
  if (container.bits !== 64 || container.byte_order !== "little")
    throw new Il2cppBinaryFormatFailure(
      "unsupported-container",
      `only 64-bit little-endian images are supported, not ${container.bits}-bit ${container.byte_order}-endian`,
    );
  if (container.format === "macho" && usesChainedFixups(image))
    throw new Il2cppBinaryFormatFailure(
      "unsupported-pointer-encoding",
      "Mach-O chained fixups are not decoded",
    );
  const imageBase =
    container.format === "pe"
      ? readPeImageBase(image)
      : (container.mappings.find((mapping) => mapping.offset === 0)?.address ??
        0n);
  return { bytes: image, container, imageBase };
};

const readPeImageBase = (image: Buffer): bigint => {
  const header = image.readUInt32LE(0x3c);
  // Signature and COFF header precede the PE32+ optional header.
  return image.readBigUInt64LE(header + 24 + 24);
};

const readPointer = (image: NativeImage, address: bigint): bigint | null => {
  try {
    const offset = mappedFileOffset(
      image.container.mappings,
      address,
      8,
      image.container.zero_fills,
    );
    return image.bytes.readBigUInt64LE(offset);
  } catch (cause) {
    if (cause instanceof GoBinaryFormatFailure) return null;
    throw cause;
  }
};

const isMapped = (image: NativeImage, address: bigint, size: number) => {
  try {
    mappedFileOffset(image.container.mappings, address, size);
    return true;
  } catch (cause) {
    if (cause instanceof GoBinaryFormatFailure) return false;
    throw cause;
  }
};

/** Virtual addresses of every NUL-terminated occurrence of each image name. */
const nameAddresses = (
  image: NativeImage,
  names: readonly string[],
): Map<bigint, number> => {
  const found = new Map<bigint, number>();
  for (const [index, name] of names.entries()) {
    const needle = Buffer.concat([
      Buffer.of(0),
      Buffer.from(name, "utf8"),
      Buffer.of(0),
    ]);
    for (const mapping of image.container.mappings) {
      const region = image.bytes.subarray(
        mapping.offset,
        mapping.offset + mapping.size,
      );
      for (
        let at = region.indexOf(needle);
        at >= 0;
        at = region.indexOf(needle, at + 1)
      )
        found.set(mapping.address + BigInt(at + 1), index);
    }
  }
  return found;
};

/** Method count per image from its contiguous type-definition range. */
const imageMethodCounts = (metadata: Il2cppMetadataDecoded) =>
  metadata.images.map((image) => {
    let total = 0;
    for (let offset = 0; offset < image.type_count; offset++)
      total += metadata.types[image.type_start + offset]!.method_count;
    return total;
  });

/**
 * Find Il2CppCodeGenModule records: a moduleName pointer to an image name
 * followed by methodPointerCount equal to that image's method count.
 */
const findModules = (
  image: NativeImage,
  metadata: Il2cppMetadataDecoded,
): Il2cppCodeGenModule[] => {
  const names = nameAddresses(
    image,
    metadata.images.map((entry) => entry.name),
  );
  const counts = imageMethodCounts(metadata);
  const candidates = new Map<number, Il2cppCodeGenModule[]>();
  for (const mapping of image.container.mappings) {
    const start = Number((8n - (mapping.address % 8n)) % 8n);
    for (let at = start; at + 24 <= mapping.size; at += 8) {
      const offset = mapping.offset + at;
      const target = image.bytes.readBigUInt64LE(offset);
      const index = names.get(target);
      if (index === undefined) continue;
      const count = image.bytes.readUInt32LE(offset + 8);
      if (count !== counts[index]) continue;
      const pointers = image.bytes.readBigUInt64LE(offset + 16);
      if (count > 0 && !isMapped(image, pointers, count * 8)) continue;
      const list = candidates.get(index) ?? [];
      list.push({
        image: index,
        address: mapping.address + BigInt(at),
        method_pointer_count: count,
        method_pointers: pointers,
      });
      candidates.set(index, list);
    }
  }
  return metadata.images.map((entry, index) => {
    const list = candidates.get(index) ?? [];
    if (list.length === 0)
      throw new Il2cppBinaryFormatFailure(
        "code-gen-modules-not-found",
        `no code generation module names ${entry.name} with ${counts[index]} method pointers`,
      );
    if (list.length > 1)
      throw new Il2cppBinaryFormatFailure(
        "ambiguous-code-gen-module",
        `${list.length} records match code generation module ${entry.name}`,
      );
    return list[0]!;
  });
};

/**
 * Find the CodeRegistration codeGenModulesCount/codeGenModules pair: a count
 * equal to the image count followed by a pointer to an array holding exactly
 * the located module records.
 */
const findCodeRegistration = (
  image: NativeImage,
  modules: readonly Il2cppCodeGenModule[],
): bigint => {
  const expected = new Set(modules.map((module) => module.address));
  const total = BigInt(modules.length);
  const matches: bigint[] = [];
  for (const mapping of image.container.mappings) {
    const start = Number((8n - (mapping.address % 8n)) % 8n);
    for (let at = start; at + 16 <= mapping.size; at += 8) {
      const offset = mapping.offset + at;
      if (image.bytes.readBigUInt64LE(offset) !== total) continue;
      const array = image.bytes.readBigUInt64LE(offset + 8);
      if (!isMapped(image, array, modules.length * 8)) continue;
      const seen = new Set<bigint>();
      for (let slot = 0; slot < modules.length; slot++) {
        const pointer = readPointer(image, array + BigInt(slot * 8));
        if (pointer === null || !expected.has(pointer)) break;
        seen.add(pointer);
      }
      if (seen.size === modules.length)
        matches.push(mapping.address + BigInt(at));
    }
  }
  if (matches.length !== 1)
    throw new Il2cppBinaryFormatFailure(
      "code-registration-not-found",
      `${matches.length} CodeRegistration module tables list the ${modules.length} located modules`,
    );
  return matches[0]!;
};

/**
 * Find MetadataRegistration by its two TypeDefinitionIndex-sized counts:
 * fieldOffsetsCount and typeDefinitionsSizesCount (words 10 and 12) both equal
 * the metadata type-definition count and are followed by mapped pointers.
 * typesCount and types are words 6 and 7. Counts are int32 in 8-byte slots.
 */
const findMetadataRegistration = (
  image: NativeImage,
  typeDefinitions: number,
): {
  readonly field: bigint;
  readonly count: number;
  readonly types: bigint;
} => {
  const matches: { field: bigint; count: number; types: bigint }[] = [];
  const low = (offset: number) => image.bytes.readUInt32LE(offset);
  const word = (offset: number) => image.bytes.readBigUInt64LE(offset);
  for (const mapping of image.container.mappings) {
    const start = Number((8n - (mapping.address % 8n)) % 8n);
    for (let at = start; at + 128 <= mapping.size; at += 8) {
      const base = mapping.offset + at;
      if (low(base + 80) !== typeDefinitions) continue;
      if (low(base + 96) !== typeDefinitions) continue;
      const count = low(base + 48);
      const types = word(base + 56);
      if (
        count === 0 ||
        count > 0x7fffffff ||
        !isMapped(image, word(base + 88), 8) ||
        !isMapped(image, word(base + 104), 8) ||
        !isMapped(image, types, count * 8)
      )
        continue;
      matches.push({
        field: mapping.address + BigInt(at + 48),
        count,
        types,
      });
    }
  }
  if (matches.length !== 1)
    throw new Il2cppBinaryFormatFailure(
      "metadata-registration-not-found",
      `${matches.length} MetadataRegistration candidates count ${typeDefinitions} type definitions`,
    );
  return matches[0]!;
};

const PRIMITIVES = new Map([
  [0x01, "void"],
  [0x02, "bool"],
  [0x03, "char"],
  [0x04, "sbyte"],
  [0x05, "byte"],
  [0x06, "short"],
  [0x07, "ushort"],
  [0x08, "int"],
  [0x09, "uint"],
  [0x0a, "long"],
  [0x0b, "ulong"],
  [0x0c, "float"],
  [0x0d, "double"],
  [0x0e, "string"],
  [0x16, "System.TypedReference"],
  [0x18, "nint"],
  [0x19, "nuint"],
  [0x1c, "object"],
]);

/**
 * Render Il2CppType records as C#-like names: keywords for primitives,
 * Namespace.Outer+Inner for definitions, T[] and T[,] for arrays, generic
 * arguments in angle brackets and metadata names for generic parameters.
 */
const createTypeNamer = (
  image: NativeImage,
  metadata: Il2cppMetadataDecoded,
  facts: Il2cppMetadataLinkFacts,
  version: number,
) => {
  const fail = (message: string): never => {
    throw new Il2cppBinaryFormatFailure("invalid-type", message);
  };
  const pointer = (address: bigint, label: string): bigint =>
    readPointer(image, address) ??
    fail(`${label} at 0x${address.toString(16)} is not file mapped`);
  const u32 = (address: bigint, label: string): number => {
    const value = pointer(address, label);
    return Number(value & 0xffffffffn);
  };
  // num_mods grew from 5 to 6 bits before version 29, moving byref.
  const byrefBit = version >= 29 ? 29 : 30;
  const definitionName = (index: number): string => {
    const type =
      metadata.types[index] ?? fail(`type definition ${index} is out of range`);
    if (type.declaring_type !== -1)
      return `${definitionName(type.declaring_type)}+${type.name}`;
    return type.namespace === "" ? type.name : `${type.namespace}.${type.name}`;
  };
  const withoutArity = (name: string) => name.replace(/`\d+$/u, "");
  const byAddress = new Map<bigint, string>();
  const name = (address: bigint, depth: number): string => {
    const cached = byAddress.get(address);
    if (cached !== undefined) return cached;
    if (depth > 64) fail("type nesting exceeds 64 levels");
    const data = pointer(address, "Il2CppType data");
    const bits = u32(address + 8n, "Il2CppType attributes");
    const kind = (bits >>> 16) & 0xff;
    const index = Number(BigInt.asIntN(32, data & 0xffffffffn));
    let result: string;
    const primitive = PRIMITIVES.get(kind);
    if (primitive !== undefined) result = primitive;
    else if (kind === 0x11 || kind === 0x12) result = definitionName(index);
    else if (kind === 0x0f) result = `${name(data, depth + 1)}*`;
    else if (kind === 0x1d) result = `${name(data, depth + 1)}[]`;
    else if (kind === 0x14) {
      const rank = u32(data + 8n, "Il2CppArrayType rank") & 0xff;
      result = `${name(pointer(data, "array element"), depth + 1)}[${",".repeat(Math.max(rank - 1, 0))}]`;
    } else if (kind === 0x13 || kind === 0x1e)
      result =
        facts.genericParameterNames[index] ??
        fail(`generic parameter ${index} is out of range`);
    else if (kind === 0x15) {
      const definition =
        version >= 27
          ? name(pointer(data, "generic class type"), depth + 1)
          : definitionName(u32(data, "generic class definition"));
      const instance = pointer(data + 8n, "generic class instance");
      const count = u32(instance, "generic argument count");
      if (count > 64)
        fail(
          `generic instance at 0x${instance.toString(16)} has ${count} arguments`,
        );
      const argv = pointer(instance + 8n, "generic arguments");
      const args = Array.from({ length: count }, (_, slot) =>
        name(pointer(argv + BigInt(slot * 8), "generic argument"), depth + 1),
      );
      result = `${withoutArity(definition)}<${args.join(", ")}>`;
    } else result = fail(`type kind 0x${kind.toString(16)} is not rendered`);
    if (((bits >>> byrefBit) & 1) === 1) result = `${result}&`;
    byAddress.set(address, result);
    return result;
  };
  return name;
};

/**
 * Link metadata methods to native code addresses without executing the image.
 * A method token's row id selects its module's methodPointers slot.
 */
export const linkIl2cppBinary = (
  bytes: Buffer,
  metadata: Il2cppMetadataDecoded,
  facts: Il2cppMetadataLinkFacts,
  architecture?: string,
): Il2cppBinaryLink => {
  const version = metadata.metadata_version;
  const image = openImage(bytes, architecture);
  const modules = findModules(image, metadata);
  const codeGenModulesField = findCodeRegistration(image, modules);
  const methodImage = new Int32Array(metadata.methods.length).fill(-1);
  for (const [index, entry] of metadata.images.entries())
    for (let offset = 0; offset < entry.type_count; offset++) {
      const type = metadata.types[entry.type_start + offset]!;
      for (let method = 0; method < type.method_count; method++)
        methodImage[type.method_start + method] = index;
    }
  const tables = new Map<number, (bigint | null)[]>();
  const method_addresses = metadata.methods.map((_, index) => {
    const owner = methodImage[index]!;
    if (owner === -1) return null;
    const module = modules[owner]!;
    const token = facts.methodTokens[index]!;
    const row = token & 0xffffff;
    if (token >>> 24 !== 0x06 || row === 0 || row > module.method_pointer_count)
      throw new Il2cppBinaryFormatFailure(
        "invalid-method-token",
        `method ${index} token 0x${token.toString(16)} is outside module ${metadata.images[owner]!.name}'s ${module.method_pointer_count} method pointers`,
      );
    let table = tables.get(owner);
    if (table === undefined) {
      table = Array.from({ length: module.method_pointer_count }, (_, slot) =>
        readPointer(image, module.method_pointers + BigInt(slot * 8)),
      );
      tables.set(owner, table);
    }
    const address = table[row - 1];
    if (address === null || address === undefined)
      throw new Il2cppBinaryFormatFailure(
        "invalid-method-pointer",
        `module ${metadata.images[owner]!.name} method pointer ${row - 1} is not file mapped`,
      );
    if (address === 0n) return null;
    if (!isMapped(image, address, 1))
      throw new Il2cppBinaryFormatFailure(
        "invalid-method-pointer",
        `method ${index} points to unmapped address 0x${address.toString(16)}`,
      );
    return address;
  });
  const registration = findMetadataRegistration(image, metadata.types.length);
  const typeName = createTypeNamer(image, metadata, facts, version);
  const reference = (type: number): Il2cppTypeReference => {
    if (type === -1) return { type, name: null };
    if (type < 0 || type >= registration.count)
      throw new Il2cppBinaryFormatFailure(
        "invalid-type",
        `type index ${type} is outside the ${registration.count} binary types`,
      );
    const address =
      readPointer(image, registration.types + BigInt(type * 8)) ?? 0n;
    if (address === 0n)
      throw new Il2cppBinaryFormatFailure(
        "invalid-type",
        `type ${type} has no Il2CppType record`,
      );
    return { type, name: typeName(address, 0) };
  };
  const column = (types: Int32Array) => Array.from(types, reference);
  return {
    format: image.container.format === "pe" ? "pe" : "macho",
    architecture: image.container.architecture,
    image_base: image.imageBase,
    code_gen_modules_field: codeGenModulesField,
    code_gen_modules: modules,
    method_addresses,
    types_field: registration.field,
    types_count: registration.count,
    return_types: column(facts.returnTypes),
    field_types: column(facts.fieldTypes),
    parameter_types: column(facts.parameterTypes),
  };
};
