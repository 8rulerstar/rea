import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { UnityAssetsPort } from "../application/unity/UnityAssetsPort.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  unityAssetsSchema,
  type UnityAssets,
  type UnityAssetsProviderInput,
} from "../domain/unity/unityAssets.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { UnityAssetsFormatFailure } from "./UnityAssetsFailure.js";
import { readUnityAssets, type UnityAssetsDecoded } from "./UnityAssetsFile.js";
import { UNITYFS_DEFAULT_LIMITS, type UnityFsLimits } from "./UnityFsBundle.js";

/** Bundled format reader identity; container and file versions are separate observed facts. */
export const UNITY_ASSETS_PROVIDER_IDENTITY = {
  id: "unity-assets",
  name: "REA Unity SerializedFile and UnityFS reader",
  version: "1",
} as const;
const OPERATION = "inspect_unity_assets";
const INPUT_BYTES = 256 * 1024 * 1024;
const OUTPUT_BYTES = 64 * 1024 * 1024;

/** JSON characters of one row with one-digit numbers and empty strings. */
const rowBytes = (row: object) => JSON.stringify(row).length;
const OBJECT_ROW = rowBytes({
  file: 0,
  path_id: "0",
  class_id: 0,
  type_index: 0,
  offset: 0,
  size: 0,
});
const TYPE_ROW = rowBytes({
  file: 0,
  index: 0,
  class_id: 0,
  class_name: null,
  stripped: null,
  script_type_index: null,
  script_id: null,
  type_tree_nodes: null,
  type_tree_root: null,
});
const SCRIPT_ROW = rowBytes({ file: 0, file_index: 0, path_id: "0" });
const EXTERNAL_ROW = rowBytes({ file: 0, path: "", guid: null, type: null });
const ENTRY_ROW = rowBytes({
  path: "",
  offset: 0,
  size: 0,
  flags: 0,
  serialized_file: 0,
});

/**
 * A lower bound on the serialized rows, checked before serializing: a small
 * compressed bundle can declare far more rows than the output budget holds.
 */
const serializedRowsLowerBound = (decoded: UnityAssetsDecoded) =>
  decoded.objects.length * OBJECT_ROW +
  decoded.types.length * TYPE_ROW +
  decoded.scripts.length * SCRIPT_ROW +
  decoded.externals.reduce(
    (total, row) => total + EXTERNAL_ROW + row.path.length,
    0,
  ) +
  decoded.entries.reduce(
    (total, row) => total + ENTRY_ROW + row.path.length,
    0,
  );

const failureForPrimary = (
  cause: unknown,
  path: string,
  signal?: AbortSignal,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
    return new AnalysisArtifactChangedError(OPERATION, path, cause.message, {
      cause,
    });
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return new AnalysisCancelledError(OPERATION, { cause });
  if (signal?.aborted) return new AnalysisCancelledError(OPERATION, { cause });
  if (cause instanceof UnityAssetsFormatFailure)
    return cause.kind === "limit"
      ? new AnalysisResourceConstraintError(
          OPERATION,
          "memory",
          cause.message,
          {
            maximum_uncompressed_bytes:
              UNITYFS_DEFAULT_LIMITS.maximumUncompressedBytes,
            maximum_ratio: UNITYFS_DEFAULT_LIMITS.maximumRatio,
            maximum_blocks: UNITYFS_DEFAULT_LIMITS.maximumBlocks,
          },
          { cause },
        )
      : cause.kind === "unsupported"
        ? new AnalysisUnsupportedTargetError(OPERATION, path, cause.message, {
            cause,
          })
        : new AnalysisInputError(OPERATION, { cause }, [
            {
              path: ["path"],
              reason: "invalid_format",
              message: `Selected artifact ${path} is corrupt: ${cause.message}`,
            },
          ]);
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        { maximum_input_bytes: INPUT_BYTES },
        { cause },
      );
    if (cause.reason === "path")
      return new AnalysisInputError(OPERATION, { cause }, [
        { path: ["path"], reason: "invalid_format", message: cause.message },
      ]);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
        cause,
      });
    if (
      ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"].includes(
        String(cause.code),
      )
    )
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected artifact could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(
    UNITY_ASSETS_PROVIDER_IDENTITY.id,
    OPERATION,
    {
      cause,
      diagnostics: {
        path,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    },
  );
};

const failureFor = (
  cause: unknown,
  path: string,
  signal?: AbortSignal,
): AnalysisError => {
  const primary = failureForPrimary(cause, path, signal);
  if (!(cause instanceof ArtifactReaderFailure) || cause.cleanup === undefined)
    return primary;
  const cleanup = new ProviderCleanupError(
    UNITY_ASSETS_PROVIDER_IDENTITY.id,
    cause.cleanup.resources,
    { reason: cause.cleanup.reason },
    { operation: OPERATION, cause },
  );
  return analysisErrorWithCleanupFailure(primary, cleanup, OPERATION);
};

const outputLimit = (path: string) =>
  new AnalysisResourceConstraintError(
    OPERATION,
    "transport",
    `Complete Unity asset inventory for ${path} exceeds the inline output budget; no partial success is returned.`,
    { maximum_output_bytes: OUTPUT_BYTES },
  );

/** Stable in-process decoding without Unity, subprocesses, temporary files or decryption. */
export class UnityAssetsProvider implements UnityAssetsPort {
  readonly identity = UNITY_ASSETS_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  constructor(readonly limits: UnityFsLimits = UNITYFS_DEFAULT_LIMITS) {}

  close(): Promise<void> {
    return this.#resources.close();
  }

  /** Read one stable file snapshot and decode every SerializedFile it holds. */
  async inspect(
    input: UnityAssetsProviderInput,
    options?: ExecutionOptions,
  ): Promise<Result<UnityAssets, AnalysisError>> {
    try {
      const snapshot = await this.#resources.run(() =>
        readStableArtifact(
          input.path,
          INPUT_BYTES,
          options?.signal,
          undefined,
          this.#resources,
        ),
      );
      options?.signal?.throwIfAborted();
      const decoded = readUnityAssets(
        snapshot.bytes,
        this.limits,
        options?.signal,
      );
      if (serializedRowsLowerBound(decoded) > OUTPUT_BYTES)
        throw outputLimit(input.path);
      const report = {
        ...decoded,
        artifact: {
          path: input.path,
          sha256: snapshot.sha256,
          bytes: snapshot.bytes.length,
        },
        limitations: [
          "Only SerializedFile versions 9 to 22 and UnityFS format versions 6 to 8 with uncompressed or LZ4/LZ4HC blocks are decoded; LZMA blocks, encrypted bundles and pre-UnityFS containers are refused.",
          "Object bodies are not decoded: no names, field values, textures, meshes or scripts. Offsets and sizes locate each body inside its SerializedFile; for bundles they index the decompressed entry.",
          "class_name comes from a partial built-in table of well-known class IDs; type_tree_root is read only from the file's own TypeTree strings and is null for Unity common-string names.",
        ],
      };
      if (Buffer.byteLength(JSON.stringify(report), "utf8") > OUTPUT_BYTES)
        throw outputLimit(input.path);
      const parsed = unityAssetsSchema.safeParse(report);
      if (!parsed.success)
        throw new AnalysisOutputError(
          OPERATION,
          "Unity asset reader produced an inconsistent inventory.",
          { cause: parsed.error },
        );
      options?.signal?.throwIfAborted();
      return ok(parsed.data);
    } catch (cause: unknown) {
      return err(failureFor(cause, input.path, options?.signal));
    }
  }
}
