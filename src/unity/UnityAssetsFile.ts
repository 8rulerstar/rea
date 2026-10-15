import type {
  UnityAssets,
  UnityBundleEntry,
  UnitySerializedFile,
} from "../domain/unity/unityAssets.js";
import { fail } from "./UnityAssetsFailure.js";
import {
  isUnityFs,
  legacyBundleSignature,
  readUnityFs,
  UNITYFS_DEFAULT_LIMITS,
  type UnityFsLimits,
} from "./UnityFsBundle.js";
import {
  readUnitySerializedFile,
  type DecodedSerializedFile,
} from "./UnitySerializedFile.js";

export type UnityAssetsDecoded = Omit<UnityAssets, "artifact" | "limitations">;

const number = (
  decoded: readonly DecodedSerializedFile[],
  entries: readonly number[],
) => {
  const serialized_files: UnitySerializedFile[] = decoded.map(
    (file, index) => ({
      entry: entries[index] ?? -1,
      ...file.header,
    }),
  );
  const rows = <Row>(select: (file: DecodedSerializedFile) => readonly Row[]) =>
    decoded.flatMap((file, index) =>
      select(file).map((row) => ({ file: index, ...row })),
    );
  return {
    serialized_files,
    types: rows((file) => file.types),
    objects: rows((file) => file.objects),
    scripts: rows((file) => file.scripts),
    externals: rows((file) => file.externals),
  };
};

/** Decode a SerializedFile or a UnityFS bundle and every SerializedFile entry in it. */
export const readUnityAssets = (
  bytes: Uint8Array,
  limits: UnityFsLimits = UNITYFS_DEFAULT_LIMITS,
  signal?: AbortSignal,
): UnityAssetsDecoded => {
  if (isUnityFs(bytes)) {
    const bundle = readUnityFs(bytes, limits, signal);
    const decoded: DecodedSerializedFile[] = [];
    const sources: number[] = [];
    const entries: UnityBundleEntry[] = bundle.entries.map(
      ({ isSerializedFile, ...entry }, index) => {
        if (!isSerializedFile) return { ...entry, serialized_file: -1 };
        signal?.throwIfAborted();
        decoded.push(
          readUnitySerializedFile(
            bundle.data.subarray(entry.offset, entry.offset + entry.size),
          ),
        );
        sources.push(index);
        return { ...entry, serialized_file: decoded.length - 1 };
      },
    );
    return {
      container: "unityfs",
      bundle: bundle.bundle,
      blocks: [...bundle.blocks],
      entries,
      ...number(decoded, sources),
    };
  }
  const legacy = legacyBundleSignature(bytes);
  if (legacy !== undefined)
    fail(
      "unsupported-container",
      `${legacy} bundles predate UnityFS and are not decoded.`,
    );
  return {
    container: "serialized-file",
    bundle: null,
    blocks: [],
    entries: [],
    ...number([readUnitySerializedFile(bytes)], []),
  };
};
