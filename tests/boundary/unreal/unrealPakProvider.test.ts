import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { UnrealPakService } from "../../../src/application/unreal/UnrealPakService.js";
import { UnrealPakProvider } from "../../../src/unreal/UnrealPakProvider.js";
import { createPakFixture } from "../../fixtures/unreal/pak.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const writePak = async (name: string, bytes: Buffer) => {
  const root = await createTestTempDirectory("rea-unreal-provider-");
  const path = join(root, name);
  await writeFile(path, bytes);
  return { root, path };
};

it("refuses a report above the output budget from the entry count, before entries exist", async () => {
  const { path } = await writePak(
    "big.pak",
    createPakFixture({ layout: "v11" }).bytes,
  );
  const provider = new UnrealPakProvider(100);
  const result = await provider.inspect({ path });
  await provider.close();
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error).toMatchObject({
      message: expect.stringContaining("exceeds the inline output budget"),
    });
});

it("rejects a symlink instead of following it", async () => {
  const { root, path } = await writePak(
    "real.pak",
    createPakFixture({ layout: "v11" }).bytes,
  );
  const link = join(root, "link.pak");
  await symlink(path, link);
  const provider = new UnrealPakProvider();
  const result = await provider.inspect({ path: link });
  await provider.close();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toMatch(/symlink|invalid/iu);
});

it("refuses relative paths and unretained summaries before reading", async () => {
  const service = new UnrealPakService(new UnrealPakProvider());
  const relative = await service.inspect({ path: "Game.pak" });
  expect(relative.ok).toBe(false);
  const { path } = await writePak(
    "ok.pak",
    createPakFixture({ layout: "v11" }).bytes,
  );
  const summary = await service.inspect({ path, detail: "summary" });
  expect(summary.ok).toBe(false);
  const complete = await service.inspect({ path });
  expect(complete.ok && complete.value.operation).toBe("inspect_unreal_pak");
  await service.close();
});
