import { createHash } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  analysisViewResultSchema,
  il2cppMetadataSummaryViewResultSchema,
} from "../../src/domain/analysisView/analysisView.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { il2cppMetadataSchema } from "../../src/domain/il2cpp/il2cppMetadata.js";
import {
  createIl2cppMetadataFixture,
  FIXTURE_IMAGES,
  FIXTURE_METHODS,
  FIXTURE_TYPES,
} from "../fixtures/il2cpp/metadata.js";
import {
  createIl2cppBinaryFixture,
  createUniversalFixture,
  FIXTURE_BINARY_BASE,
  FIXTURE_METHOD_ADDRESSES,
  FIXTURE_RETURN_TYPE_NAME,
} from "../fixtures/il2cpp/binary.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "returns identical complete inventories through CLI and MCP and pages a retained summary after removal",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-metadata-");
    const path = join(root, "global-metadata.dat");
    const { bytes } = createIl2cppMetadataFixture({ typeIndexWidth: 2 });
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-il2cpp-metadata", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_il2cpp_metadata").outputSchema.parse(
      result.json,
    );
    const report = il2cppMetadataSchema.parse(evidence.normalized_result);
    expect(report.artifact).toEqual({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    expect(report.images).toEqual(FIXTURE_IMAGES);
    expect(report.types).toEqual(FIXTURE_TYPES);
    expect(report.methods).toEqual(FIXTURE_METHODS);
    expect(evidence.parameters).toEqual({ path });

    const { client, call } = await connectLocalToolsMcp();
    const complete = await call("inspect_il2cpp_metadata", {
      path,
      detail: "complete",
    });
    expect(complete.isError, JSON.stringify(complete)).not.toBe(true);
    expect(parseEvidence(complete.structuredContent).normalized_result).toEqual(
      report,
    );

    // Summary is the default MCP delivery.
    const summarized = await call("inspect_il2cpp_metadata", { path });
    expect(summarized.isError, JSON.stringify(summarized)).not.toBe(true);
    const view = il2cppMetadataSummaryViewResultSchema.parse(
      parseEvidence(summarized.structuredContent).normalized_result,
    );
    expect(view.summary.counts).toEqual({
      images: 2,
      types: 4,
      methods: 5,
      nested_types: 1,
      fields: 2,
      properties: 0,
      events: 0,
      parameters: 1,
      string_literals: 2,
      method_addresses: 0,
      return_types: 0,
      field_types: 0,
      parameter_types: 0,
    });
    expect(view.summary.binary).toBeNull();
    expect(view.summary.sections).toEqual(report.sections);
    expect(view.summary.index_widths).toEqual(report.index_widths);

    // Pages come from retained Evidence, not the file.
    await unlink(path);
    for (const collection of ["images", "types", "methods"] as const) {
      const rows: unknown[] = [];
      let offset = 0;
      do {
        const page = await call("inspect_analysis_view", {
          source: {
            kind: "retained-evidence",
            evidence_id: view.parent_evidence_id,
          },
          view: { kind: "il2cpp-metadata", collection, offset, limit: 2 },
        });
        expect(page.isError, JSON.stringify(page)).not.toBe(true);
        const projected = analysisViewResultSchema.parse(
          parseEvidence(page.structuredContent).normalized_result,
        );
        if (projected.kind !== "il2cpp-metadata")
          throw new Error("Wrong IL2CPP page kind");
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
  "distinguishes unsupported versions from corrupt metadata through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-metadata-fail-");
    const { client, call } = await connectLocalToolsMcp();
    const fixture = createIl2cppMetadataFixture();
    const unsupported = Buffer.from(fixture.bytes);
    unsupported.writeInt32LE(26, 4);
    const corrupt = Buffer.from(fixture.bytes);
    corrupt.writeInt32LE(
      fixture.section("typeDefinitions").offset + 4,
      fixture.header("images", "offset"),
    );
    for (const [name, bytes, expected] of [
      [
        "v26.dat",
        unsupported,
        {
          code: "unsupported_target",
          details: { operation: "inspect_il2cpp_metadata" },
          message: expect.stringContaining("unsupported-version"),
        },
      ],
      [
        "overlap.dat",
        corrupt,
        {
          code: "invalid_request",
          details: {
            operation: "inspect_il2cpp_metadata",
            issues: [
              {
                path: ["path"],
                reason: "invalid_format",
                message: expect.stringContaining("section-overlap"),
              },
            ],
          },
        },
      ],
    ] as const) {
      const path = join(root, name);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-il2cpp-metadata", path, "--json"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject(expected);
      const response = await call("inspect_il2cpp_metadata", { path });
      expect(parseMcpToolError(response).error).toMatchObject(expected);
    }
    await client.ping();
  },
  30000,
);

cliTest(
  "links method addresses from a selected binary slice through CLI and MCP pages",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-binary-");
    const path = join(root, "global-metadata.dat");
    const binaryPath = join(root, "GameAssembly.dylib");
    await writeFile(path, createIl2cppMetadataFixture().bytes);
    await writeFile(
      binaryPath,
      createUniversalFixture([
        { cpu: 0x0100000c, bytes: createIl2cppBinaryFixture() },
      ]),
    );
    const expected = FIXTURE_METHOD_ADDRESSES.map((address) =>
      address === null
        ? { address: null, rva: null }
        : {
            address: `0x${address.toString(16)}`,
            rva: `0x${(address - FIXTURE_BINARY_BASE).toString(16)}`,
          },
    );
    const result = await cli.run({
      arguments: [
        "inspect-il2cpp-metadata",
        path,
        "--binary",
        binaryPath,
        "--architecture",
        "arm64",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = il2cppMetadataSchema.parse(
      toolContract("inspect_il2cpp_metadata").outputSchema.parse(result.json)
        .normalized_result,
    );
    expect(report.method_addresses).toEqual(expected);
    expect(report.return_types.map((row) => row.name)).toEqual(
      Array.from({ length: 5 }, () => FIXTURE_RETURN_TYPE_NAME),
    );
    expect(report.binary).toMatchObject({
      format: "macho",
      architecture: "arm64",
      image_base: "0x100000000",
    });

    const { client, call } = await connectLocalToolsMcp();
    const missing = await call("inspect_il2cpp_metadata", {
      path,
      binary_path: binaryPath,
    });
    expect(parseMcpToolError(missing).error).toMatchObject({
      code: "unsupported_target",
      message: expect.stringContaining("slice-selection-required"),
    });
    const summarized = await call("inspect_il2cpp_metadata", {
      path,
      binary_path: binaryPath,
      binary_architecture: "arm64",
    });
    expect(summarized.isError, JSON.stringify(summarized)).not.toBe(true);
    const view = il2cppMetadataSummaryViewResultSchema.parse(
      parseEvidence(summarized.structuredContent).normalized_result,
    );
    expect(view.summary.counts.method_addresses).toBe(5);
    const page = await call("inspect_analysis_view", {
      source: {
        kind: "retained-evidence",
        evidence_id: view.parent_evidence_id,
      },
      view: {
        kind: "il2cpp-metadata",
        collection: "method_addresses",
        offset: 2,
      },
    });
    const projected = analysisViewResultSchema.parse(
      parseEvidence(page.structuredContent).normalized_result,
    );
    if (projected.kind !== "il2cpp-metadata")
      throw new Error("Wrong IL2CPP page kind");
    expect(projected.items).toEqual(expected.slice(2));
    await client.ping();
  },
  30000,
);
