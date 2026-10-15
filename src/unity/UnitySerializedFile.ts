import {
  UNITY_SERIALIZED_FILE_VERSION_RANGE,
  type UnityExternal,
  type UnityObject,
  type UnityScript,
  type UnitySerializedFile,
  type UnityType,
} from "../domain/unity/unityAssets.js";
import { fail } from "./UnityAssetsFailure.js";
import { unityClassName } from "./unityClassNames.js";

/** Rows of one decoded SerializedFile before they are numbered in a report. */
export interface DecodedSerializedFile {
  readonly header: Omit<UnitySerializedFile, "entry">;
  readonly types: readonly Omit<UnityType, "file">[];
  readonly objects: readonly Omit<UnityObject, "file">[];
  readonly scripts: readonly Omit<UnityScript, "file">[];
  readonly externals: readonly Omit<UnityExternal, "file">[];
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const HEADER_V22_BYTES = 48;
const HEADER_BYTES = 20;
const COMMON_STRING_FLAG = 0x80000000;

/** Bounded cursor over the metadata region; every read checks its end. */
class Cursor {
  position: number;
  constructor(
    readonly view: DataView,
    start: number,
    readonly end: number,
    readonly little: boolean,
  ) {
    this.position = start;
  }
  need(bytes: number, what: string): number {
    const at = this.position;
    if (bytes < 0 || at + bytes > this.end)
      fail(
        "metadata-out-of-bounds",
        `${what} at ${at} runs past the metadata end ${this.end}.`,
      );
    this.position = at + bytes;
    return at;
  }
  u8(what: string) {
    return this.view.getUint8(this.need(1, what));
  }
  i16(what: string) {
    return this.view.getInt16(this.need(2, what), this.little);
  }
  u16(what: string) {
    return this.view.getUint16(this.need(2, what), this.little);
  }
  i32(what: string) {
    return this.view.getInt32(this.need(4, what), this.little);
  }
  u32(what: string) {
    return this.view.getUint32(this.need(4, what), this.little);
  }
  i64(what: string) {
    return this.view.getBigInt64(this.need(8, what), this.little);
  }
  /** Unsigned 64-bit value that must fit a safe JavaScript integer. */
  u64(what: string) {
    const value = this.view.getBigUint64(this.need(8, what), this.little);
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      fail("metadata-out-of-bounds", `${what} ${value} is not addressable.`);
    return Number(value);
  }
  hex(bytes: number, what: string) {
    const at = this.need(bytes, what);
    return Buffer.from(
      this.view.buffer,
      this.view.byteOffset + at,
      bytes,
    ).toString("hex");
  }
  align4() {
    // Alignment is relative to the start of the SerializedFile.
    const padded = (this.position + 3) & ~3;
    this.need(padded - this.position, "alignment padding");
  }
  cstring(what: string) {
    const bytes = new Uint8Array(
      this.view.buffer,
      this.view.byteOffset + this.position,
      this.end - this.position,
    );
    const length = bytes.indexOf(0);
    if (length < 0) fail("invalid-string", `${what} is not NUL-terminated.`);
    const text = utf8(bytes.subarray(0, length), what);
    this.position += length + 1;
    return text;
  }
  /** Reject a count whose minimum encoding cannot fit before allocating rows. */
  count(minimumBytes: number, what: string) {
    const value = this.u32(what);
    if (value * minimumBytes > this.end - this.position)
      fail(
        "count-out-of-range",
        `${what} ${value} needs at least ${value * minimumBytes} bytes but ${this.end - this.position} remain.`,
      );
    return value;
  }
}

const utf8 = (bytes: Uint8Array, what: string) => {
  try {
    return decoder.decode(bytes);
  } catch {
    return fail("invalid-string", `${what} is not UTF-8.`);
  }
};

/** Read a NUL-terminated local TypeTree string; common-buffer names stay unknown. */
const typeTreeString = (buffer: Uint8Array, offset: number) => {
  if ((offset & COMMON_STRING_FLAG) !== 0 || offset >= buffer.length)
    return null;
  const end = buffer.indexOf(0, offset);
  if (end < 0) return null;
  try {
    return decoder.decode(buffer.subarray(offset, end));
  } catch {
    return null;
  }
};

const blobTypeTree = (cursor: Cursor, version: number, isRefType: boolean) => {
  const nodeBytes = version >= 19 ? 32 : 24;
  const nodes = cursor.count(nodeBytes, "TypeTree node count");
  const stringBytes = cursor.u32("TypeTree string buffer size");
  const nodeStart = cursor.need(nodes * nodeBytes, "TypeTree nodes");
  const stringStart = cursor.need(stringBytes, "TypeTree string buffer");
  const strings = new Uint8Array(
    cursor.view.buffer,
    cursor.view.byteOffset + stringStart,
    stringBytes,
  );
  // Node: u16 version, u8 level, u8 flags, u32 type string offset, ...
  const root =
    nodes === 0
      ? null
      : typeTreeString(
          strings,
          cursor.view.getUint32(nodeStart + 4, cursor.little),
        );
  if (version >= 21) {
    if (isRefType) {
      cursor.cstring("reference type class name");
      cursor.cstring("reference type namespace");
      cursor.cstring("reference type assembly");
    } else {
      const dependencies = cursor.count(4, "type dependency count");
      cursor.need(dependencies * 4, "type dependencies");
    }
  }
  return { nodes, root };
};

/** Pre-blob recursive TypeTree (versions 9 and 11); returns node count and root type. */
const legacyTypeTree = (cursor: Cursor) => {
  let nodes = 0;
  let root: string | null = null;
  const pending = [1];
  while (pending.length > 0) {
    const remaining = pending.pop()!;
    if (remaining === 0) continue;
    pending.push(remaining - 1);
    nodes += 1;
    if (nodes > cursor.end) fail("count-out-of-range", "TypeTree is cyclic.");
    const type = cursor.cstring("TypeTree node type");
    root ??= type;
    cursor.cstring("TypeTree node name");
    // byteSize, index, typeFlags, version, metaFlag
    cursor.need(20, "TypeTree node fields");
    pending.push(cursor.count(17, "TypeTree child count"));
  }
  return { nodes, root };
};

const readType = (
  cursor: Cursor,
  version: number,
  typeTree: boolean,
  index: number,
  isRefType: boolean,
): Omit<UnityType, "file"> => {
  const classId = cursor.i32("class ID");
  const stripped = version >= 16 ? cursor.u8("stripped flag") !== 0 : null;
  const scriptTypeIndex =
    version >= 17 ? cursor.i16("script type index") : null;
  let scriptId: string | null = null;
  if (version >= 13) {
    if (
      isRefType ||
      (version < 16 && classId < 0) ||
      (version >= 16 && classId === 114)
    )
      scriptId = cursor.hex(16, "script ID");
    cursor.need(16, "old type hash");
  }
  let tree: { nodes: number; root: string | null } | null = null;
  if (typeTree)
    tree =
      version >= 12 || version === 10
        ? blobTypeTree(cursor, version, isRefType)
        : legacyTypeTree(cursor);
  return {
    index,
    class_id: classId,
    class_name: unityClassName(classId),
    stripped,
    script_type_index: scriptTypeIndex,
    script_id: scriptId,
    type_tree_nodes: tree?.nodes ?? null,
    type_tree_root: tree?.root ?? null,
  };
};

const isLittle = (marker: number) => {
  if (marker > 1)
    fail("truncated-header", `Endianness marker ${marker} is not 0 or 1.`);
  return marker === 0;
};

/** Decode one SerializedFile's header and metadata tables from `bytes`. */
export const readUnitySerializedFile = (
  bytes: Uint8Array,
): DecodedSerializedFile => {
  if (bytes.length < HEADER_BYTES)
    fail("truncated-header", `Header needs ${HEADER_BYTES} bytes.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(8, false);
  if (version > 0xffff || version === 0)
    fail(
      "unrecognized-format",
      "Not a Unity SerializedFile or UnityFS bundle.",
    );
  if (
    version < UNITY_SERIALIZED_FILE_VERSION_RANGE.min ||
    version > UNITY_SERIALIZED_FILE_VERSION_RANGE.max
  )
    fail(
      "unsupported-version",
      `SerializedFile version ${version} is outside ${UNITY_SERIALIZED_FILE_VERSION_RANGE.min}-${UNITY_SERIALIZED_FILE_VERSION_RANGE.max}.`,
    );
  let metadataSize = view.getUint32(0, false);
  let fileSize = view.getUint32(4, false);
  let dataOffset = view.getUint32(12, false);
  const little = isLittle(view.getUint8(16));
  let metadataStart = HEADER_BYTES;
  if (version >= 22) {
    if (bytes.length < HEADER_V22_BYTES)
      fail(
        "truncated-header",
        `Version 22 headers need ${HEADER_V22_BYTES} bytes.`,
      );
    const wide = new Cursor(view, HEADER_BYTES, HEADER_V22_BYTES, false);
    metadataSize = wide.u32("metadata size");
    fileSize = wide.u64("file size");
    dataOffset = wide.u64("data offset");
    metadataStart = HEADER_V22_BYTES;
  }
  if (fileSize !== bytes.length)
    fail(
      "file-size-mismatch",
      `Header file size ${fileSize} differs from the ${bytes.length} available bytes.`,
    );
  const metadataEnd = metadataStart + metadataSize;
  if (metadataEnd > dataOffset || dataOffset > fileSize)
    fail(
      "metadata-out-of-bounds",
      `Metadata ${metadataStart}+${metadataSize} and data offset ${dataOffset} do not fit ${fileSize} bytes.`,
    );
  const cursor = new Cursor(view, metadataStart, metadataEnd, little);
  const unityVersion = version >= 7 ? cursor.cstring("Unity version") : null;
  const targetPlatform = version >= 8 ? cursor.i32("target platform") : null;
  const typeTree = version >= 13 ? cursor.u8("TypeTree flag") !== 0 : true;

  const typeCount = cursor.count(4, "type count");
  const types = Array.from({ length: typeCount }, (_, index) =>
    readType(cursor, version, typeTree, index, false),
  );
  const bigIds =
    version >= 7 && version < 14 ? cursor.i32("big ID flag") !== 0 : false;
  const objectBytes = version >= 22 ? 24 : version >= 14 ? 20 : 16;
  const objectCount = cursor.count(objectBytes, "object count");
  const objects: Omit<UnityObject, "file">[] = [];
  for (let row = 0; row < objectCount; row += 1) {
    if (version >= 14) cursor.align4();
    const pathId =
      version >= 14 || bigIds
        ? cursor.i64("path ID")
        : BigInt(cursor.i32("path ID"));
    const start =
      version >= 22 ? cursor.u64("object start") : cursor.u32("object start");
    const size = cursor.u32("object size");
    const typeId = cursor.i32("object type ID");
    let classId: number;
    let typeIndex = -1;
    if (version < 16) {
      classId = cursor.u16("object class ID");
      if (version < 11) cursor.u16("destroyed flag");
      else cursor.i16("script type index");
      if (version === 15) cursor.u8("stripped flag");
    } else {
      const type = types[typeId];
      if (type === undefined)
        fail(
          "index-out-of-range",
          `Object ${row} type index ${typeId} is outside ${types.length} types.`,
        );
      typeIndex = typeId;
      classId = type!.class_id;
      if (version === 16) cursor.u8("stripped flag");
    }
    const offset = dataOffset + start;
    if (offset + size > fileSize)
      fail(
        "object-out-of-bounds",
        `Object ${row} at ${offset}+${size} is outside ${fileSize} bytes.`,
      );
    objects.push({
      path_id: pathId.toString(),
      class_id: classId,
      type_index: typeIndex,
      offset,
      size,
    });
  }
  const scripts: Omit<UnityScript, "file">[] = [];
  if (version >= 11) {
    const scriptCount = cursor.count(8, "script count");
    for (let row = 0; row < scriptCount; row += 1) {
      const fileIndex = cursor.i32("script file index");
      let pathId: bigint;
      if (version >= 14) {
        cursor.align4();
        pathId = cursor.i64("script path ID");
      } else pathId = BigInt(cursor.i32("script path ID"));
      scripts.push({ file_index: fileIndex, path_id: pathId.toString() });
    }
  }
  const externalCount = cursor.count(version >= 5 ? 21 : 1, "external count");
  const externals: Omit<UnityExternal, "file">[] = [];
  for (let row = 0; row < externalCount; row += 1) {
    if (version >= 6) cursor.cstring("external temporary path");
    const guid = version >= 5 ? cursor.hex(16, "external GUID") : null;
    const type = version >= 5 ? cursor.i32("external type") : null;
    externals.push({ path: cursor.cstring("external path"), guid, type });
  }
  let refTypeCount = 0;
  if (version >= 20) {
    refTypeCount = cursor.count(4, "reference type count");
    for (let row = 0; row < refTypeCount; row += 1)
      readType(cursor, version, typeTree, row, true);
  }
  const userInformation =
    version >= 5 ? cursor.cstring("user information") : null;
  return {
    header: {
      version,
      big_endian: !little,
      metadata_size: metadataSize,
      file_size: fileSize,
      data_offset: dataOffset,
      unity_version: unityVersion,
      target_platform: targetPlatform,
      type_tree_enabled: typeTree,
      type_count: types.length,
      object_count: objects.length,
      script_count: scripts.length,
      external_count: externals.length,
      ref_type_count: refTypeCount,
      user_information: userInformation,
    },
    types,
    objects,
    scripts,
    externals,
  };
};
