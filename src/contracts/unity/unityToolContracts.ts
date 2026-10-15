import { z } from "zod";
import { unityAssetsSummaryViewResultSchema } from "../../domain/analysisView/analysisView.js";
import {
  inspectUnityAssetsInputSchema,
  unityAssetsSchema,
} from "../../domain/unity/unityAssets.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static Unity asset inventories are independent of Unity installations and native providers. */
export const UNITY_TOOL_CONTRACTS = [
  {
    name: "inspect_unity_assets",
    ...toolContractMetadata("inspect_unity_assets"),
    kind: "artifact-provider",
    description:
      'Inventory an explicit local Unity SerializedFile (globalgamemanagers, *.assets, level*, sharedassets*; format versions 9 to 22, either endianness) or UnityFS AssetBundle (format 6 to 8, uncompressed or LZ4/LZ4HC blocks). Returns the bundle header, storage blocks and directory entries, and for every SerializedFile its header, Unity version, target platform, TypeTree presence, serialized types (class ID, script type index, TypeTree root name when stored locally), object table (path ID as a decimal string, class ID, byte offset and size inside that SerializedFile), script types and external references. Rows carry file, the serialized_files row. Omitted or summary detail returns container identity, SerializedFile headers and counts; it retains complete Evidence and pages blocks/entries/serialized_files/types/objects/scripts/externals with inspect_analysis_view kind unity-assets and normalized_result.parent_evidence_id. detail: "complete" returns every row inline. Does not decode object bodies, names, textures or scripts, run Unity, or decrypt. LZMA bundles, encrypted bundles, legacy UnityWeb/UnityRaw containers and other versions are unsupported; truncated headers, out-of-range counts, indices, objects, blocks or entries, invalid strings and invalid LZ4 are corrupt; every failure carries a reason code and no partial success. Resource guards bound input to 256 MiB, decompressed bundle data to 512 MiB, compressed blocks to a 256:1 ratio and output to 64 MiB.',
    inputSchema: inspectUnityAssetsInputSchema,
    outputSchema: evidenceResultOf(
      z.union([unityAssetsSchema, unityAssetsSummaryViewResultSchema]),
    ),
    examples: [
      {
        title: "Summarize a player data file and retain rows for paging",
        input: {
          path: "/artifacts/Game.app/Contents/Resources/Data/level0",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
