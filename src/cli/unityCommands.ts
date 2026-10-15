import { z } from "incur";
import { resolve } from "node:path";
import { createUnityAssetsService } from "../composition/unityAssets.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** Resolve caller paths and inventory Unity asset files through the shared workflow. */
export const registerUnityCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectUnityAssets, {
    description:
      "Inventory a Unity SerializedFile or UnityFS AssetBundle: headers, types, objects and externals, without running Unity",
    args: z.object({
      path: z
        .string()
        .describe(
          "Local SerializedFile (globalgamemanagers, *.assets, level*) or UnityFS bundle",
        ),
    }),
    run: ({ args }) =>
      withCommandCancellation(async (signal) => {
        const service = createUnityAssetsService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectUnityAssets,
          async () =>
            finishAnalysisCommand(
              () =>
                service.inspect(
                  // One-shot CLI runs retain no Evidence for later views.
                  { path: resolve(args.path), detail: "complete" },
                  { signal },
                ),
              service,
              "unity-assets",
              "inspect_unity_assets",
            ),
        );
      }),
  });
};
