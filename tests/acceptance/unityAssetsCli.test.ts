import { createHash } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  analysisViewResultSchema,
  unityAssetsSummaryViewResultSchema,
} from "../../src/domain/analysisView/analysisView.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { unityAssetsSchema } from "../../src/domain/unity/unityAssets.js";
import {
  createSerializedFileFixture,
  createUnityFsFixture,
} from "../fixtures/unity/assets.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const COLLECTIONS = [
  "blocks",
  "entries",
  "serialized_files",
  "types",
  "objects",
  "scripts",
  "externals",
] as const;

cliTest(
  "returns identical complete bundle inventories through CLI and MCP and pages a retained summary after removal",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-unity-assets-");
    const path = join(root, "bundle");
    const serialized = createSerializedFileFixture();
    const { bytes } = createUnityFsFixture([
      { path: "CAB-a", bytes: serialized.bytes, flags: 4 },
      { path: "CAB-a.resS", bytes: Buffer.alloc(100, 1), flags: 0 },
      {
        path: "CAB-b",
        bytes: createSerializedFileFixture({ version: 17 }).bytes,
        flags: 4,
      },
    ]);
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-unity-assets", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_unity_assets").outputSchema.parse(
      result.json,
    );
    const report = unityAssetsSchema.parse(evidence.normalized_result);
    expect(report.artifact).toEqual({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    expect(report.entries.map((entry) => entry.serialized_file)).toEqual([
      0, -1, 1,
    ]);
    expect(report.objects).toHaveLength(4);
    expect(evidence.parameters).toEqual({ path });

    const { client, call } = await connectLocalToolsMcp();
    const complete = await call("inspect_unity_assets", {
      path,
      detail: "complete",
    });
    expect(complete.isError, JSON.stringify(complete)).not.toBe(true);
    expect(parseEvidence(complete.structuredContent).normalized_result).toEqual(
      report,
    );

    const summarized = await call("inspect_unity_assets", { path });
    expect(summarized.isError, JSON.stringify(summarized)).not.toBe(true);
    const view = unityAssetsSummaryViewResultSchema.parse(
      parseEvidence(summarized.structuredContent).normalized_result,
    );
    expect(view.summary.counts).toEqual(
      Object.fromEntries(
        COLLECTIONS.map((name) => [name, report[name].length]),
      ),
    );
    expect(view.summary.serialized_files).toEqual(report.serialized_files);
    expect(view.summary.bundle).toEqual(report.bundle);

    await unlink(path);
    for (const collection of COLLECTIONS) {
      const rows: unknown[] = [];
      let offset = 0;
      do {
        const page = await call("inspect_analysis_view", {
          source: {
            kind: "retained-evidence",
            evidence_id: view.parent_evidence_id,
          },
          view: { kind: "unity-assets", collection, offset, limit: 2 },
        });
        expect(page.isError, JSON.stringify(page)).not.toBe(true);
        const projected = analysisViewResultSchema.parse(
          parseEvidence(page.structuredContent).normalized_result,
        );
        if (projected.kind !== "unity-assets")
          throw new Error("Wrong Unity page kind");
        expect(projected.counts).toEqual(view.summary.counts);
        rows.push(...projected.items);
        offset = projected.coverage.next_offset ?? report[collection].length;
      } while (offset < report[collection].length);
      expect(rows).toEqual(report[collection]);
    }
    await client.ping();
  },
  30000,
);

cliTest(
  "distinguishes unsupported compression from corrupt files through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-unity-assets-fail-");
    const { client, call } = await connectLocalToolsMcp();
    const serialized = createSerializedFileFixture();
    for (const [name, bytes, expected] of [
      [
        "lzma",
        createUnityFsFixture(
          [{ path: "CAB-a", bytes: serialized.bytes, flags: 4 }],
          { compression: "lzma" },
        ).bytes,
        {
          code: "unsupported_target",
          details: { operation: "inspect_unity_assets" },
          message: expect.stringContaining("unsupported-compression"),
        },
      ],
      [
        "level0",
        serialized.bytes.subarray(0, -1),
        {
          code: "invalid_request",
          details: {
            operation: "inspect_unity_assets",
            issues: [
              {
                path: ["path"],
                reason: "invalid_format",
                message: expect.stringContaining("file-size-mismatch"),
              },
            ],
          },
        },
      ],
    ] as const) {
      const path = join(root, name);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-unity-assets", path, "--json"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject(expected);
      const response = await call("inspect_unity_assets", { path });
      expect(parseMcpToolError(response).error).toMatchObject(expected);
    }
    await client.ping();
  },
  30000,
);
