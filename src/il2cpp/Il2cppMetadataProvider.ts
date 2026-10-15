import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { Il2cppMetadataPort } from "../application/il2cpp/Il2cppMetadataPort.js";
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
  il2cppMetadataSchema,
  type Il2cppMetadata,
  type Il2cppMetadataProviderInput,
} from "../domain/il2cpp/il2cppMetadata.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  Il2cppMetadataFormatFailure,
  readIl2cppMetadata,
  type Il2cppMetadataDecoded,
  type Il2cppMetadataRowCounts,
} from "./Il2cppMetadataFile.js";

/** Bundled format reader identity; the metadata version is a separate observed fact. */
export const IL2CPP_METADATA_PROVIDER_IDENTITY = {
  id: "il2cpp-metadata",
  name: "REA IL2CPP global-metadata reader",
  version: "1",
} as const;
const OPERATION = "inspect_il2cpp_metadata";
const INPUT_BYTES = 256 * 1024 * 1024;
// A 12.9 MB Unity 6000.4 file with 112,232 methods serializes to 7.8 MB.
const OUTPUT_BYTES = 64 * 1024 * 1024;
// The smallest JSON a row can take: empty names and one-digit numbers.
const EMPTY_NAME = JSON.stringify("").length;

/** JSON characters of one row besides its strings, with one-digit numbers. */
const rowOverhead = (row: Record<string, string | number>) =>
  JSON.stringify(row).length -
  2 * Object.values(row).filter((value) => typeof value === "string").length;
const IMAGE_ROW = rowOverhead({ name: "", type_start: 0, type_count: 0 });
const TYPE_ROW = rowOverhead({
  name: "",
  namespace: "",
  method_start: 0,
  method_count: 0,
  nested_type_start: 0,
  nested_type_count: 0,
  declaring_type: 0,
});
const METHOD_ROW = rowOverhead({ name: "", declaring_type: 0 });
const MEMBER_ROW = METHOD_ROW;
const PARAMETER_ROW = rowOverhead({ name: "", method: 0 });
// Literals carry `null` for the unused form instead of a string.
const LITERAL_ROW =
  JSON.stringify({ value: null, value_base64: null }).length - 4;

/**
 * A lower bound on the serialized rows. Rows share decoded names, so the
 * report can be far larger than the file; refusing from this bound avoids
 * building a string the budget would reject anyway.
 */
const serializedRowsLowerBound = (decoded: Il2cppMetadataDecoded) => {
  const lengths = new Map<string, number>();
  const text = (value: string) => {
    let length = lengths.get(value);
    if (length === undefined) {
      // UTF-16 code units never exceed UTF-8 bytes.
      length = JSON.stringify(value).length;
      lengths.set(value, length);
    }
    return length;
  };
  let total = 0;
  for (const image of decoded.images) total += IMAGE_ROW + text(image.name);
  for (const type of decoded.types)
    total += TYPE_ROW + text(type.name) + text(type.namespace);
  for (const method of decoded.methods) total += METHOD_ROW + text(method.name);
  for (const members of [decoded.fields, decoded.properties, decoded.events])
    for (const member of members) total += MEMBER_ROW + text(member.name);
  for (const parameter of decoded.parameters)
    total += PARAMETER_ROW + text(parameter.name);
  for (const literal of decoded.string_literals)
    total += LITERAL_ROW + text(literal.value ?? literal.value_base64 ?? "");
  return total;
};

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
  if (cause instanceof Il2cppMetadataFormatFailure)
    return cause.kind === "unsupported"
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
    IL2CPP_METADATA_PROVIDER_IDENTITY.id,
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
    IL2CPP_METADATA_PROVIDER_IDENTITY.id,
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
    `Complete IL2CPP metadata for ${path} exceeds the inline output budget; no partial success is returned.`,
    { maximum_output_bytes: maximumBytes },
  );

/** Lower bound from row counts alone, so oversized files fail before rows are allocated. */
const countLowerBound = ({ images, types, methods }: Il2cppMetadataRowCounts) =>
  images * (IMAGE_ROW + EMPTY_NAME) +
  types * (TYPE_ROW + 2 * EMPTY_NAME) +
  methods * (METHOD_ROW + EMPTY_NAME);

/** Stable in-process decoding without subprocesses, temporary files, native binaries or decryption. */
export class Il2cppMetadataProvider implements Il2cppMetadataPort {
  readonly identity = IL2CPP_METADATA_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  /** `outputBytes` exists so tests can reach the guard with small files. */
  constructor(private readonly outputBytes: number = OUTPUT_BYTES) {}

  close(): Promise<void> {
    return this.#resources.close();
  }

  /** Read every image, type and method name from one stable file snapshot. */
  async inspect(
    input: Il2cppMetadataProviderInput,
    options?: ExecutionOptions,
  ): Promise<Result<Il2cppMetadata, AnalysisError>> {
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
      const limit = this.outputBytes;
      const decoded = readIl2cppMetadata(snapshot.bytes, {
        beforeRows: (counts) => {
          if (countLowerBound(counts) > limit)
            throw outputLimit(input.path, limit);
        },
      });
      if (serializedRowsLowerBound(decoded) > limit)
        throw outputLimit(input.path, limit);
      const report = {
        ...decoded,
        artifact: {
          path: input.path,
          sha256: snapshot.sha256,
          bytes: snapshot.bytes.length,
        },
        limitations: [
          "Only unencrypted global-metadata.dat versions 29, 31 and 39 are decoded; names, counts and string literals are observed file content, not runtime behavior.",
          "Native code addresses, IL2CPP binary registration, field and parameter types, method signatures and generic instances are not recovered; type indices refer to the native binary.",
          "declaring_type for types is derived from the nestedTypes section, and member and parameter owners from the owners' index ranges; row positions are the metadata indices.",
        ],
      };
      if (Buffer.byteLength(JSON.stringify(report), "utf8") > limit)
        throw outputLimit(input.path, limit);
      const parsed = il2cppMetadataSchema.safeParse(report);
      if (!parsed.success)
        throw new AnalysisOutputError(
          OPERATION,
          "IL2CPP metadata reader produced invalid section ranges or report values.",
          { cause: parsed.error },
        );
      options?.signal?.throwIfAborted();
      return ok(parsed.data);
    } catch (cause: unknown) {
      return err(failureFor(cause, input.path, options?.signal));
    }
  }
}
