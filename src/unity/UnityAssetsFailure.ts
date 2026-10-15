/** Stable machine-readable reason for each rejected input. */
export const UNITY_ASSETS_FAILURE_REASONS = {
  unsupported: [
    "unrecognized-format",
    "unsupported-container",
    "unsupported-version",
    "unsupported-compression",
    "encrypted-bundle",
  ],
  corrupt: [
    "truncated-header",
    "metadata-out-of-bounds",
    "file-size-mismatch",
    "count-out-of-range",
    "index-out-of-range",
    "object-out-of-bounds",
    "invalid-string",
    "block-out-of-bounds",
    "block-size-mismatch",
    "lz4-invalid",
    "entry-out-of-bounds",
  ],
  /** Declared expansion exceeds a resource guard; the input may be valid. */
  limit: ["decompressed-size", "compression-ratio", "block-count"],
} as const;
export type UnityAssetsFailureKind = keyof typeof UNITY_ASSETS_FAILURE_REASONS;
export type UnityAssetsFailureReason =
  (typeof UNITY_ASSETS_FAILURE_REASONS)[UnityAssetsFailureKind][number];

const kindOf = (reason: UnityAssetsFailureReason): UnityAssetsFailureKind =>
  (
    Object.entries(UNITY_ASSETS_FAILURE_REASONS) as [
      UnityAssetsFailureKind,
      readonly string[],
    ][]
  ).find(([, reasons]) => reasons.includes(reason))?.[0] ?? "corrupt";

/** Distinguish inputs outside decoder coverage, damaged inputs and guard refusals. */
export class UnityAssetsFormatFailure extends Error {
  readonly kind: UnityAssetsFailureKind;
  constructor(
    readonly reason: UnityAssetsFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${reason}: ${message}`, options);
    this.name = "UnityAssetsFormatFailure";
    this.kind = kindOf(reason);
  }
}

export const fail = (
  reason: UnityAssetsFailureReason,
  message: string,
): never => {
  throw new UnityAssetsFormatFailure(reason, message);
};
