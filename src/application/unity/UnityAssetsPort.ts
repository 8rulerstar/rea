import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  UnityAssets,
  UnityAssetsProviderInput,
} from "../../domain/unity/unityAssets.js";
import type { Result } from "../../domain/result.js";

/** Replaceable offline Unity asset reader with no Unity, target-execution or decryption authority. */
export interface UnityAssetsPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: UnityAssetsProviderInput,
    options?: ExecutionOptions,
  ): Promise<Result<UnityAssets, AnalysisError>>;
}
