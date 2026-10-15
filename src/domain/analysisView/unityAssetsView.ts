import { analysisViewInputError } from "./analysisViewErrors.js";
import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import {
  UNITY_ASSETS_COLLECTIONS,
  unityAssetsObjectSchema,
  unityAssetsSchema,
  unityBundleBlockSchema,
  unityBundleEntrySchema,
  unityExternalSchema,
  unityObjectSchema,
  unityScriptSchema,
  unitySerializedFileSchema,
  unityTypeSchema,
} from "../unity/unityAssets.js";
import { err, ok, type Result } from "../result.js";
import { parseAnalysisViewResult } from "./analysisViewParent.js";
import type {
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";

const countsSchema = z.strictObject(
  Object.fromEntries(
    UNITY_ASSETS_COLLECTIONS.map((name) => [
      name,
      z.number().int().nonnegative(),
    ]),
  ) as Record<(typeof UNITY_ASSETS_COLLECTIONS)[number], z.ZodNumber>,
);

/** Container identity and every SerializedFile header, with row counts instead of rows. */
export const unityAssetsSummarySchema = unityAssetsObjectSchema
  .omit({
    blocks: true,
    entries: true,
    types: true,
    objects: true,
    scripts: true,
    externals: true,
  })
  .extend({ counts: countsSchema });

/** Pages of decoded rows in report order. */
export const unityAssetsViewRequestSchema = z.strictObject({
  kind: z.literal("unity-assets"),
  collection: z.enum(UNITY_ASSETS_COLLECTIONS),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
});

export const unityAssetsViewItemsSchema = z.union([
  z.array(unityBundleBlockSchema),
  z.array(unityBundleEntrySchema),
  z.array(unitySerializedFileSchema),
  z.array(unityTypeSchema),
  z.array(unityObjectSchema),
  z.array(unityScriptSchema),
  z.array(unityExternalSchema),
]);

export const unityAssetsViewContextSchema = z.strictObject({
  container: unityAssetsObjectSchema.shape.container,
  counts: countsSchema,
});

/** Reuse retained Unity asset Evidence without reopening or decoding the file. */
export const projectUnityAssetsView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "summary" && view.kind !== "unity-assets")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Unity asset Evidence supports summary and unity-assets pages.",
        },
      ]),
    );
  const parsed = parseAnalysisViewResult(unityAssetsSchema, parent);
  if (!parsed.ok) return parsed;
  const { blocks, entries, types, objects, scripts, externals, ...identity } =
    parsed.value;
  const rows = {
    blocks,
    entries,
    serialized_files: identity.serialized_files,
    types,
    objects,
    scripts,
    externals,
  };
  const counts = Object.fromEntries(
    Object.entries(rows).map(([name, list]) => [name, list.length]),
  ) as z.infer<typeof countsSchema>;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_unity_assets" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: {
      path: identity.artifact.path,
      sha256: identity.artifact.sha256,
    },
    limitations: [...parent.limitations],
    unknowns: [
      "Object bodies were not decoded; object names, field values and script bindings remain unknown.",
      ...(parent.subject == null
        ? [
            "The parent has no recorded subject; its normalized artifact identity cannot be cross-checked against a subject digest.",
          ]
        : []),
    ],
  };
  if (view.kind === "summary")
    return ok({
      kind: "summary",
      view,
      ...shared,
      summary: { ...identity, counts },
      coverage: completeWithinViewCoverage(1, 1),
    });
  const collection: readonly unknown[] = rows[view.collection];
  const items = collection.slice(
    view.offset,
    view.offset + view.limit,
  ) as z.infer<typeof unityAssetsViewItemsSchema>;
  return ok({
    kind: "unity-assets",
    view,
    ...shared,
    items,
    container: identity.container,
    counts,
    coverage: pageViewCoverage(view.offset, items.length, collection.length),
  });
};
