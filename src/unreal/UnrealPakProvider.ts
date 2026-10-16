import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { readStableArtifactRanges } from "../artifacts/readStableArtifact.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { UnrealPakPort } from "../application/unreal/UnrealPakPort.js";
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
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  unrealPakSchema,
  type UnrealPak,
  type UnrealPakProviderInput,
} from "../domain/unreal/unrealPak.js";
import { readUnrealPak, UnrealPakFormatFailure } from "./UnrealPakFile.js";

/** Bundled format reader identity; the pak version is a separate observed fact. */
export const UNREAL_PAK_PROVIDER_IDENTITY = {
  id: "unreal-pak",
  name: "REA Unreal Engine pak index reader",
  version: "1",
} as const;
const OPERATION = "inspect_unreal_pak";
const REGION_BYTES = 256 * 1024 * 1024;
const ENTRIES = 1_000_000;
const OUTPUT_BYTES = 64 * 1024 * 1024;

/** The smallest JSON one entry row can take: null path, one-digit numbers. */
const ENTRY_ROW = JSON.stringify({
  path: null,
  path_hash: null,
  offset: 0,
  size: 0,
  uncompressed_size: 0,
  compression_method: 0,
  compression_name: null,
  compression_blocks: 0,
  compression_block_size: 0,
  encrypted: false,
  deleted: false,
  sha1: null,
  record: "full",
}).length;

const LIMITATIONS = [
  "Only the footer and index of pak versions 1 to 12 are decoded; entry paths, offsets, sizes and compression names are observed index content. File data is not read, decompressed or extracted.",
  "Encrypted indexes are reported as encrypted with their footer facts only; no key is accepted and nothing is decrypted. Version 9 frozen indexes are unsupported.",
  "Compression names come from the footer table (version 8+) or legacy flag values (Zlib, Gzip, Custom); they name methods, not verified codecs. The pak version is not attributed to an engine release.",
];

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
  if (cause instanceof UnrealPakFormatFailure) {
    if (cause.kind === "unsupported")
      return new AnalysisUnsupportedTargetError(
        OPERATION,
        path,
        cause.message,
        { cause },
      );
    if (cause.kind === "resource")
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        { maximum_region_bytes: REGION_BYTES, maximum_entries: ENTRIES },
        { cause },
      );
    return new AnalysisInputError(OPERATION, { cause }, [
      {
        path: ["path"],
        reason: "invalid_format",
        message: `Selected artifact ${path} is corrupt: ${cause.message}`,
      },
    ]);
  }
  if (
    cause instanceof ArtifactReaderFailure &&
    (cause.reason === "path" || cause.reason === "limit")
  )
    return new AnalysisInputError(OPERATION, { cause }, [
      { path: ["path"], reason: "invalid_format", message: cause.message },
    ]);
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
  return new ProviderAdapterError(UNREAL_PAK_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
    diagnostics: {
      path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
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
    UNREAL_PAK_PROVIDER_IDENTITY.id,
    cause.cleanup.resources,
    { reason: cause.cleanup.reason },
    { operation: OPERATION, cause },
  );
  return analysisErrorWithCleanupFailure(primary, cleanup, OPERATION);
};

const outputLimit = (path: string, maximumBytes: number) =>
  new AnalysisResourceConstraintError(
    OPERATION,
    "transport",
    `Complete pak index for ${path} exceeds the inline output budget; no partial success is returned.`,
    { maximum_output_bytes: maximumBytes },
  );

/** Stable in-process index decoding without extraction, decompression or decryption. */
export class UnrealPakProvider implements UnrealPakPort {
  readonly identity = UNREAL_PAK_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  /** `outputBytes` exists so tests can reach the guard with small files. */
  constructor(private readonly outputBytes: number = OUTPUT_BYTES) {}

  close(): Promise<void> {
    return this.#resources.close();
  }

  /** Read the footer and index of one stable file snapshot and hash the whole file. */
  async inspect(
    input: UnrealPakProviderInput,
    options?: ExecutionOptions,
  ): Promise<Result<UnrealPak, AnalysisError>> {
    try {
      const limit = this.outputBytes;
      const {
        result: decoded,
        sha256,
        bytes,
      } = await this.#resources.run(() =>
        readStableArtifactRanges(
          input.path,
          (source) =>
            readUnrealPak(source, {
              regionBytes: REGION_BYTES,
              entries: ENTRIES,
              pathBytes: limit,
              beforeEntries: (count) => {
                if (count * ENTRY_ROW > limit)
                  throw outputLimit(input.path, limit);
              },
            }),
          options?.signal,
          this.#resources,
        ),
      );
      options?.signal?.throwIfAborted();
      const report = {
        ...decoded,
        artifact: { path: input.path, sha256, bytes },
        limitations: LIMITATIONS,
      };
      if (Buffer.byteLength(JSON.stringify(report), "utf8") > limit)
        throw outputLimit(input.path, limit);
      const parsed = unrealPakSchema.safeParse(report);
      if (!parsed.success)
        throw new AnalysisOutputError(
          OPERATION,
          "Unreal pak reader produced invalid footer, index or entry values.",
          { cause: parsed.error },
        );
      return ok(parsed.data);
    } catch (cause: unknown) {
      return err(failureFor(cause, input.path, options?.signal));
    }
  }
}
