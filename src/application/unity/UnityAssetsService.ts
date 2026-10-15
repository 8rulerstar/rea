import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import {
  requireAnalysisViewRetention,
  summarizeRetainedAnalysis,
  type AnalysisViewRetention,
} from "../analysisView/AnalysisViewService.js";
import type { UnityAssetsPort } from "./UnityAssetsPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  unityAssetsSchema,
  inspectUnityAssetsInputSchema,
  type UnityAssets,
} from "../../domain/unity/unityAssets.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";

const OPERATION = "inspect_unity_assets";
const NO_RETENTION: AnalysisViewRetention = {
  evidenceById: undefined,
  recordEvidence: undefined,
};

/** File ranges holding the decoded tables: SerializedFile metadata or the bundle directory. */
const unityAssetsLocations = (value: UnityAssets) => {
  if (value.bundle !== null) {
    const { offset, compressed_size } = value.bundle.blocks_info;
    return compressed_size > 0
      ? [
          {
            kind: "file-offset-range" as const,
            start: offset,
            end: offset + compressed_size,
          },
        ]
      : [];
  }
  return value.serialized_files.map((file) => {
    const start = file.version >= 22 ? 48 : 20;
    return {
      kind: "file-offset-range" as const,
      start,
      end: start + file.metadata_size,
    };
  });
};

/** Shared exact input validation, artifact-bound Evidence and summary delivery for CLI and MCP. */
export class UnityAssetsService {
  constructor(readonly provider: UnityAssetsPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  /** Inspect one explicitly selected file; detail changes delivery, not decoded coverage. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
    retention: AnalysisViewRetention = NO_RETENTION,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const input = inspectUnityAssetsInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const { detail, ...providerInput } = input.data;
    if (detail === "summary") {
      const ready = requireAnalysisViewRetention(OPERATION, retention);
      if (!ready.ok) return ready;
    }
    const inspected = await this.provider.inspect(providerInput, options);
    if (!inspected.ok) return inspected;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const report = unityAssetsSchema.safeParse(inspected.value);
    if (!report.success || report.data.artifact.path !== providerInput.path)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Unity asset reader returned a malformed inventory or changed the selected artifact identity.",
        ),
      );
    const value = report.data;
    const evidence = createEvidence(
      {
        path: value.artifact.path,
        sha256: value.artifact.sha256,
        format: "file",
      },
      this.provider.identity,
      {
        operation: OPERATION,
        parameters: providerInput,
        result: value,
        confidence: "observed",
        limitations: value.limitations,
        locations: [
          { kind: "artifact-path", path: value.artifact.path },
          ...unityAssetsLocations(value),
        ],
      },
    );
    return detail === "summary"
      ? summarizeRetainedAnalysis(evidence, retention)
      : ok(evidence);
  }
}
