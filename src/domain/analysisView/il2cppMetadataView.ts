import { analysisViewInputError } from "./analysisViewErrors.js";
import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import {
  IL2CPP_METADATA_COLLECTIONS,
  il2cppMetadataImageSchema,
  il2cppMetadataMethodSchema,
  il2cppMetadataObjectSchema,
  il2cppMetadataSchema,
  il2cppMetadataTypeSchema,
} from "../il2cpp/il2cppMetadata.js";
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

const countsSchema = z.strictObject({
  images: z.number().int().nonnegative(),
  types: z.number().int().nonnegative(),
  methods: z.number().int().nonnegative(),
  nested_types: z.number().int().nonnegative(),
});

/** Metadata identity, index widths and sections with row counts instead of rows. */
export const il2cppMetadataSummarySchema = il2cppMetadataObjectSchema
  .omit({ images: true, types: true, methods: true })
  .extend({ counts: countsSchema });

/** Pages of decoded rows; offsets are the metadata indices of the collection. */
export const il2cppMetadataViewRequestSchema = z.strictObject({
  kind: z.literal("il2cpp-metadata"),
  collection: z.enum(IL2CPP_METADATA_COLLECTIONS),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
});

export const il2cppMetadataViewItemsSchema = z.union([
  z.array(il2cppMetadataImageSchema),
  z.array(il2cppMetadataTypeSchema),
  z.array(il2cppMetadataMethodSchema),
]);

export const il2cppMetadataViewContextSchema = z.strictObject({
  metadata_version: il2cppMetadataObjectSchema.shape.metadata_version,
  counts: countsSchema,
});

/** Reuse retained metadata Evidence without reopening or decoding the file. */
export const projectIl2cppMetadataView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "summary" && view.kind !== "il2cpp-metadata")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "IL2CPP metadata Evidence supports summary and images/types/methods pages.",
        },
      ]),
    );
  const parsed = parseAnalysisViewResult(il2cppMetadataSchema, parent);
  if (!parsed.ok) return parsed;
  const { images, types, methods, ...identity } = parsed.value;
  const counts = {
    images: images.length,
    types: types.length,
    methods: methods.length,
    nested_types: types.filter((type) => type.declaring_type !== -1).length,
  };
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_il2cpp_metadata" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: {
      path: identity.artifact.path,
      sha256: identity.artifact.sha256,
    },
    limitations: [...parent.limitations],
    unknowns: [
      "Names come from unencrypted metadata only; native code addresses and runtime registration remain unknown.",
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
  const collection = { images, types, methods }[view.collection];
  const items = collection.slice(view.offset, view.offset + view.limit);
  return ok({
    kind: "il2cpp-metadata",
    view,
    ...shared,
    items,
    metadata_version: identity.metadata_version,
    counts,
    coverage: pageViewCoverage(view.offset, items.length, collection.length),
  });
};
