import { z } from "incur";
import { resolve } from "node:path";
import { createIl2cppMetadataService } from "../composition/il2cpp.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

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
          "Matching native binary (Mach-O GameAssembly.dylib or PE GameAssembly.dll) to link method addresses; read only",
        ),
      architecture: z
        .enum(["arm64", "amd64"])
        .optional()
        .describe("Slice of a universal Mach-O binary"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const service = createIl2cppMetadataService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectIl2cppMetadata,
          async () =>
            finishAnalysisCommand(
              () =>
                service.inspect(
                  // One-shot CLI runs retain no Evidence for later views.
                  {
                    path: resolve(args.path),
                    detail: "complete",
                    ...(options.binary === undefined
                      ? {}
                      : { binary_path: resolve(options.binary) }),
                    ...(options.architecture === undefined
                      ? {}
                      : { binary_architecture: options.architecture }),
                  },
                  { signal },
                ),
              service,
              "il2cpp-metadata",
              "inspect_il2cpp_metadata",
            ),
        );
      }),
  });
};
