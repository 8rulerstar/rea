import { expect, it } from "vitest";
import { UnityAssetsService } from "./UnityAssetsService.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { UnityAssets } from "../../domain/unity/unityAssets.js";
import { ok } from "../../domain/result.js";

const identity = {
  id: "fixture-unity",
  name: "Source-owned Unity asset reader seam",
  version: "1",
};
const report: UnityAssets = {
  artifact: { path: "/artifacts/level0", sha256: "a".repeat(64), bytes: 1024 },
  container: "serialized-file",
  bundle: null,
  blocks: [],
  entries: [],
  serialized_files: [
    {
      entry: -1,
      version: 22,
      big_endian: false,
      metadata_size: 100,
      file_size: 1024,
      data_offset: 160,
      unity_version: "2022.3.30f1",
      target_platform: 2,
      type_tree_enabled: false,
      type_count: 0,
      object_count: 0,
      script_count: 0,
      external_count: 0,
      ref_type_count: 0,
      user_information: "",
    },
  ],
  types: [],
  objects: [],
  scripts: [],
  externals: [],
  limitations: [],
};

const serviceReturning = (value: UnityAssets, calls = { count: 0 }) =>
  new UnityAssetsService({
    identity,
    inspect: () => {
      calls.count += 1;
      return Promise.resolve(ok(value));
    },
  });

it("rejects invalid paths and extra arguments before invoking the reader", async () => {
  const calls = { count: 0 };
  const service = serviceReturning(report, calls);
  for (const input of [
    { path: "relative/level0", detail: "complete" },
    { path: "/artifacts/\0level0", detail: "complete" },
    { path: report.artifact.path, detail: "complete", decode_bodies: true },
    { path: report.artifact.path, detail: "rows" },
  ]) {
    const result = await service.inspect(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisInputError);
  }
  expect(calls.count).toBe(0);
});

it("refuses the default summary without Evidence retention before reading", async () => {
  const calls = { count: 0 };
  const result = await serviceReturning(report, calls).inspect({
    path: report.artifact.path,
  });
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error).toBeInstanceOf(AnalysisCapabilityUnavailableError);
  expect(calls.count).toBe(0);
});

it("returns complete artifact-bound Evidence locating the metadata", async () => {
  const result = await serviceReturning(report).inspect({
    path: report.artifact.path,
    detail: "complete",
  });
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toEqual(report);
  expect(result.value.locations).toContainEqual({
    kind: "file-offset-range",
    start: 48,
    end: 148,
  });
});

it("rejects a reader that changes the selected artifact identity", async () => {
  const result = await serviceReturning({
    ...report,
    artifact: { ...report.artifact, path: "/artifacts/other" },
  }).inspect({ path: report.artifact.path, detail: "complete" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("reports cancellation before reading", async () => {
  const aborted = new AbortController();
  aborted.abort();
  const calls = { count: 0 };
  const result = await serviceReturning(report, calls).inspect(
    { path: report.artifact.path, detail: "complete" },
    { signal: aborted.signal },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(calls.count).toBe(0);
});
