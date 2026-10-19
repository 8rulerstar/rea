import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { z } from "incur";
import { writeFile } from "node:fs/promises";
import {
  ghidraDefaultBase,
  il2cppGhidraSeeds,
} from "../domain/il2cpp/il2cppGhidraSeeds.js";
import { il2cppMetadataSchema } from "../domain/il2cpp/il2cppMetadata.js";
import { createIl2cppMetadataService } from "../composition/il2cpp.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** Write seeds for a linked report at Ghidra's default load base unless overridden. */
const writeSeeds = async (
  result: unknown,
  path: string,
  seedBase: string | undefined,
) => {
  const report = il2cppMetadataSchema.parse(result);
  if (report.binary === null)
    throw new Error("--ghidra-seeds needs --binary to link method addresses");
  const seeds = il2cppGhidraSeeds(
    report,
    seedBase === undefined
      ? ghidraDefaultBase(report.binary)
      : BigInt(seedBase),
  );
  await writeFile(path, seeds.text, { flag: "wx" });
};

/** Resolve caller paths and inspect IL2CPP metadata names through the shared workflow. */
export const registerIl2cppCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectIl2cppMetadata, {
    description:
      "Inventory IL2CPP global-metadata.dat images, types and methods, optionally linking method addresses from the native binary, without decryption or target execution",
    args: z.object({
      path: z
        .string()
        .describe("Local global-metadata.dat (version 24, 27, 29, 31 or 39)"),
    }),
    options: z.object({
      binary: z
        .string()
        .optional()
        .describe(
          "Matching native binary (Mach-O GameAssembly.dylib, PE GameAssembly.dll or ELF libil2cpp.so) to link method addresses; read only",
        ),
      architecture: z
        .enum(["arm64", "amd64"])
        .optional()
        .describe("Slice of a universal Mach-O binary"),
      ghidraSeeds: z
        .string()
        .optional()
        .describe(
          "Also write REA_GHIDRA_SEED_FILE function seeds named Type$$Method for every linked method; needs --binary",
        ),
      seedBase: z
        .string()
        .regex(/^0x[0-9a-fA-F]{1,16}$/u)
        .optional()
        .describe(
          "Address Ghidra loads the binary at; seeds are seed-base + RVA (default: Ghidra's loader default, 0x100000 for an ELF linked at 0, else the link base)",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const service = createIl2cppMetadataService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectIl2cppMetadata,
          async () =>
            finishAnalysisCommand(
              async () => {
                const result = await service.inspect(
                  // One-shot CLI runs retain no Evidence for later views.
                  {
                    path: absoluteCallerPath(args.path),
                    detail: "complete",
                    ...(options.binary === undefined
                      ? {}
                      : { binary_path: absoluteCallerPath(options.binary) }),
                    ...(options.architecture === undefined
                      ? {}
                      : { binary_architecture: options.architecture }),
                  },
                  { signal },
                );
                if (result.ok && options.ghidraSeeds !== undefined)
                  await writeSeeds(
                    result.value.normalized_result,
                    absoluteCallerPath(options.ghidraSeeds),
                    options.seedBase,
                  );
                return result;
              },
              service,
              "il2cpp-metadata",
              "inspect_il2cpp_metadata",
              signal,
            ),
        );
      }),
  });
};
