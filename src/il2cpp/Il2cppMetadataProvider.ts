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
  readIl2cppMetadataWithTokens,
  type Il2cppMetadataDecoded,
  type Il2cppMetadataRowCounts,
} from "./Il2cppMetadataFile.js";
import {
  Il2cppBinaryFormatFailure,
  linkIl2cppBinary,
  type Il2cppBinaryLink,
} from "./Il2cppBinaryFile.js";

/** Bundled format reader identity; the metadata version is a separate observed fact. */
export const IL2CPP_METADATA_PROVIDER_IDENTITY = {
  id: "il2cpp-metadata",
  name: "REA IL2CPP global-metadata reader",
  version: "1",
} as const;
const OPERATION = "inspect_il2cpp_metadata";
const INPUT_BYTES = 256 * 1024 * 1024;
// GameAssembly binaries of large games reach several hundred megabytes.
const BINARY_BYTES = 1024 * 1024 * 1024;
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
// A method without code serializes both fields as null.
const ADDRESS_ROW = JSON.stringify({ address: null, rva: null }).length;

/**
 * A lower bound on the serialized rows. Rows share decoded names, so the
 * report can be far larger than the file; refusing from this bound avoids
 * building a string the budget would reject anyway.
 */
const serializedRowsLowerBound = (
  decoded: Il2cppMetadataDecoded,
  linked: boolean,
) => {
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
  if (linked) total += decoded.methods.length * ADDRESS_ROW;
  return total;
};

const failureForPrimary = (
  cause: unknown,
  path: string,
  signal?: AbortSignal,
  field: "path" | "binary_path" = "path",
  maximum = INPUT_BYTES,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof Il2cppBinaryFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(OPERATION, path, cause.message, {
          cause,
        })
      : new AnalysisInputError(OPERATION, { cause }, [
          {
            path: [field],
            reason: "invalid_format",
            message: `Selected binary ${path} does not link to the metadata: ${cause.message}`,
          },
        ]);
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
        { maximum_input_bytes: maximum },
        { cause },
      );
    if (cause.reason === "path")
      return new AnalysisInputError(OPERATION, { cause }, [
        { path: [field], reason: "invalid_format", message: cause.message },
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
          path: [field],
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
  field: "path" | "binary_path" = "path",
  maximum = INPUT_BYTES,
): AnalysisError => {
  const primary = failureForPrimary(cause, path, signal, field, maximum);
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

const hex = (value: bigint) => `0x${value.toString(16)}`;

/** Report fields for a linked binary, with addresses as exact hexadecimal strings. */
const binaryReport = (
  link: Il2cppBinaryLink,
  artifact: { path: string; sha256: string; bytes: number },
) => ({
  binary: {
    artifact,
    format: link.format,
    architecture: link.architecture,
    image_base: hex(link.image_base),
    code_gen_modules_field: hex(link.code_gen_modules_field),
    code_gen_modules: link.code_gen_modules.map((module) => ({
      image: module.image,
      address: hex(module.address),
      method_pointer_count: module.method_pointer_count,
    })),
  },
  method_addresses: link.method_addresses.map((address) =>
    address === null
      ? { address: null, rva: null }
      : { address: hex(address), rva: hex(address - link.image_base) },
  ),
});

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
      const { metadata: decoded, methodTokens } = readIl2cppMetadataWithTokens(
        snapshot.bytes,
        {
          beforeRows: (counts) => {
            if (countLowerBound(counts) > limit)
              throw outputLimit(input.path, limit);
          },
        },
      );
      const binaryPath = input.binary_path;
      if (serializedRowsLowerBound(decoded, binaryPath !== undefined) > limit)
        throw outputLimit(input.path, limit);
      let linked: Pick<Il2cppMetadata, "binary" | "method_addresses"> = {
        binary: null,
        method_addresses: [],
      };
      if (binaryPath !== undefined) {
        try {
          const binary = await this.#resources.run(() =>
            readStableArtifact(
              binaryPath,
              BINARY_BYTES,
              options?.signal,
              undefined,
              this.#resources,
            ),
          );
          options?.signal?.throwIfAborted();
          linked = binaryReport(
            linkIl2cppBinary(
              binary.bytes,
              decoded,
              methodTokens,
              input.binary_architecture,
            ),
            {
              path: binaryPath,
              sha256: binary.sha256,
              bytes: binary.bytes.length,
            },
          );
        } catch (cause: unknown) {
          return err(
            failureFor(
              cause,
              binaryPath,
              options?.signal,
              "binary_path",
              BINARY_BYTES,
            ),
          );
        }
      }
      const report = {
        ...decoded,
        ...linked,
        artifact: {
          path: input.path,
          sha256: snapshot.sha256,
          bytes: snapshot.bytes.length,
        },
        limitations: [
          "Only unencrypted global-metadata.dat versions 24, 27, 29, 31 and 39 are decoded; names, counts and string literals are observed file content, not runtime behavior.",
          binaryPath === undefined
            ? "Native code addresses and IL2CPP binary registration are not recovered without binary_path."
            : "Method addresses come from the binary's code-generation module methodPointers, matched by module name, method count and metadata token; generic method instances, adjustor thunks and invokers are not linked, and a null address means the module records no body.",
          "Field and parameter types, method signatures and generic instances are not recovered; type indices refer to the native binary.",
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
