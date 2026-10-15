import { z } from "zod";
import { digestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

/** SerializedFile format versions whose metadata layout is decoded. */
export const UNITY_SERIALIZED_FILE_VERSION_RANGE = { min: 9, max: 22 } as const;

/** Row collections retained in complete Evidence and paged by analysis views. */
export const UNITY_ASSETS_COLLECTIONS = [
  "blocks",
  "entries",
  "serialized_files",
  "types",
  "objects",
  "scripts",
  "externals",
] as const;

const count = z.number().int().nonnegative();
/** Row reference; -1 marks an absent link. */
const optionalIndex = z.number().int().min(-1);
const hex = (bytes: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));

/** One explicit local file; detail selects delivery, never decoding coverage. */
export const inspectUnityAssetsInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute filesystem path to a Unity SerializedFile (globalgamemanagers, *.assets, level*, sharedassets*) or UnityFS AssetBundle",
  ),
  detail: z
    .enum(["complete", "summary"])
    .default("summary")
    .describe(
      "summary (default) retains every row and returns counts with a linked inspect_analysis_view summary; complete returns every row inline",
    ),
});

export const UNITY_COMPRESSION_KINDS = [
  "none",
  "lzma",
  "lz4",
  "lz4hc",
] as const;
const compressionSchema = z.enum(UNITY_COMPRESSION_KINDS);

/** UnityFS container header and the decompressed block/directory table. */
export const unityBundleSchema = z.strictObject({
  signature: z.literal("UnityFS"),
  format_version: count,
  /** Player version recorded by the bundle, commonly "5.x.x". */
  player_version: z.string(),
  unity_revision: z.string(),
  declared_size: count,
  flags: count,
  blocks_info: z.strictObject({
    offset: count,
    compressed_size: count,
    uncompressed_size: count,
    compression: compressionSchema,
    at_end: z.boolean(),
  }),
  /** File offset of the first storage block. */
  data_offset: count,
  /** Sum of block uncompressed sizes; entry offsets index this stream. */
  uncompressed_data_size: count,
});

/** Storage block in stream order. */
export const unityBundleBlockSchema = z.strictObject({
  compressed_size: count,
  uncompressed_size: count,
  compression: compressionSchema,
  flags: count,
});

/** Directory entry; offset and size index the decompressed block stream. */
export const unityBundleEntrySchema = z.strictObject({
  path: z.string(),
  offset: count,
  size: count,
  flags: count,
  /** Row in serialized_files decoded from this entry, or -1 for raw data. */
  serialized_file: optionalIndex,
});

/** SerializedFile header and metadata facts. */
export const unitySerializedFileSchema = z.strictObject({
  /** Bundle entry row holding this file, or -1 for the selected file itself. */
  entry: optionalIndex,
  version: z.number().int().min(UNITY_SERIALIZED_FILE_VERSION_RANGE.min),
  big_endian: z.boolean(),
  metadata_size: count,
  file_size: count,
  data_offset: count,
  unity_version: z.string().nullable(),
  target_platform: z.number().int().nullable(),
  type_tree_enabled: z.boolean(),
  type_count: count,
  object_count: count,
  script_count: count,
  external_count: count,
  ref_type_count: count,
  user_information: z.string().nullable(),
});

/** Serialized type; row order within a file is its type index. */
export const unityTypeSchema = z.strictObject({
  file: count,
  index: count,
  class_id: z.number().int(),
  /** From REA's table of well-known class IDs; null when not listed. */
  class_name: z.string().nullable(),
  stripped: z.boolean().nullable(),
  script_type_index: z.number().int().nullable(),
  script_id: hex(16).nullable(),
  type_tree_nodes: count.nullable(),
  /** Root node type from the file's own TypeTree string buffer. */
  type_tree_root: z.string().nullable(),
});

/** Object table row; offset and size are byte positions inside its SerializedFile. */
export const unityObjectSchema = z.strictObject({
  file: count,
  /** Signed 64-bit local identifier as a decimal string. */
  path_id: z.string().regex(/^-?\d+$/),
  class_id: z.number().int(),
  /** Index into the file's types, or -1 before version 16. */
  type_index: optionalIndex,
  offset: count,
  size: count,
});

/** Script type reference used by MonoBehaviour types. */
export const unityScriptSchema = z.strictObject({
  file: count,
  file_index: z.number().int(),
  path_id: z.string().regex(/^-?\d+$/),
});

/** External SerializedFile reference; file_id 1 is the first row. */
export const unityExternalSchema = z.strictObject({
  file: count,
  path: z.string(),
  guid: hex(16).nullable(),
  type: z.number().int().nullable(),
});

export const unityAssetsObjectSchema = z.strictObject({
  artifact: z.strictObject({
    path: localPathStringSchema,
    sha256: digestSchema,
    bytes: count,
  }),
  container: z.enum(["serialized-file", "unityfs"]),
  bundle: unityBundleSchema.nullable(),
  blocks: z.array(unityBundleBlockSchema),
  entries: z.array(unityBundleEntrySchema),
  serialized_files: z.array(unitySerializedFileSchema),
  types: z.array(unityTypeSchema),
  objects: z.array(unityObjectSchema),
  scripts: z.array(unityScriptSchema),
  externals: z.array(unityExternalSchema),
  limitations: z.array(z.string()),
});

/** Complete inventory of one SerializedFile or UnityFS bundle. */
export const unityAssetsSchema = unityAssetsObjectSchema.superRefine(
  (report, context) => {
    const files = report.serialized_files;
    const fileRows = [
      ["types", report.types],
      ["objects", report.objects],
      ["scripts", report.scripts],
      ["externals", report.externals],
    ] as const;
    for (const [name, rows] of fileRows)
      rows.forEach((row, index) => {
        if (row.file >= files.length)
          context.addIssue({
            code: "custom",
            path: [name, index, "file"],
            message: "Row refers to a missing serialized file.",
          });
      });
    report.objects.forEach((object, index) => {
      const file = files[object.file];
      if (file !== undefined && object.offset + object.size > file.file_size)
        context.addIssue({
          code: "custom",
          path: ["objects", index],
          message: "Object range is outside its serialized file.",
        });
    });
    if ((report.container === "unityfs") !== (report.bundle !== null))
      context.addIssue({
        code: "custom",
        path: ["bundle"],
        message: "Only UnityFS containers carry bundle facts.",
      });
  },
);

export type InspectUnityAssetsInput = z.infer<
  typeof inspectUnityAssetsInputSchema
>;
export type UnityAssetsProviderInput = Omit<InspectUnityAssetsInput, "detail">;
export type UnityAssets = z.infer<typeof unityAssetsSchema>;
export type UnitySerializedFile = z.infer<typeof unitySerializedFileSchema>;
export type UnityType = z.infer<typeof unityTypeSchema>;
export type UnityObject = z.infer<typeof unityObjectSchema>;
export type UnityScript = z.infer<typeof unityScriptSchema>;
export type UnityExternal = z.infer<typeof unityExternalSchema>;
export type UnityBundle = z.infer<typeof unityBundleSchema>;
export type UnityBundleBlock = z.infer<typeof unityBundleBlockSchema>;
export type UnityBundleEntry = z.infer<typeof unityBundleEntrySchema>;
export type UnityCompression = (typeof UNITY_COMPRESSION_KINDS)[number];
