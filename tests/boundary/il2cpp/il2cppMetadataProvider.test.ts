import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AnalysisResourceConstraintError } from "../../../src/domain/analysisErrorCore.js";
import { Il2cppMetadataProvider } from "../../../src/il2cpp/Il2cppMetadataProvider.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Version 29 file whose methods all share one long name. */
const sharedNameMetadata = (nameBytes: number, methods: number) => {
  const name = Buffer.alloc(nameBytes + 1, "A");
  name[nameBytes] = 0;
  const records = Buffer.alloc(methods * 32);
  for (let index = 0; index < methods; index += 1)
    records.writeInt32LE(-1, index * 32 + 4);
  const header = Buffer.alloc(256);
  header.writeUInt32LE(0xfab11baf, 0);
  header.writeInt32LE(29, 4);
  let cursor = 256;
  for (let section = 0; section < 31; section += 1) {
    // strings is section 2 and methods is section 5.
    const content = section === 2 ? name : section === 5 ? records : undefined;
    header.writeInt32LE(cursor, 8 + section * 8);
    header.writeInt32LE(content?.length ?? 0, 12 + section * 8);
    cursor += content?.length ?? 0;
  }
  return Buffer.concat([header, name, records]);
};

it("refuses an oversized report from its row lower bound before serializing it", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-provider-budget-");
  const path = join(root, "global-metadata.dat");
  // About 2 KiB of input expands to more than 64 MiB of method names.
  await writeFile(path, sharedNameMetadata(65_536, 1_100));
  const stringify = vi.spyOn(JSON, "stringify");
  const provider = new Il2cppMetadataProvider();
  try {
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(
      stringify.mock.calls.some(
        ([value]) =>
          typeof value === "object" && value !== null && "methods" in value,
      ),
    ).toBe(false);
  } finally {
    await provider.close();
  }
});
