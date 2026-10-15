import { z } from "zod";
import { il2cppMetadataSummaryViewResultSchema } from "../../domain/analysisView/analysisView.js";
import {
  il2cppMetadataSchema,
  inspectIl2cppMetadataInputSchema,
} from "../../domain/il2cpp/il2cppMetadata.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static IL2CPP metadata is independent of native-analysis providers and Unity installations. */
export const IL2CPP_TOOL_CONTRACTS = [
  {
    name: "inspect_il2cpp_metadata",
    ...toolContractMetadata("inspect_il2cpp_metadata"),
    kind: "artifact-provider",
    description:
      'Inspect an explicit local Unity IL2CPP global-metadata.dat (metadata versions 24, 27, 29, 31 and 39) and return its assembly images, type definitions, method definitions, field/property/event/parameter names with their owners, and managed string literals by name, namespace, index range and count, plus header sections and serialized index widths. Type declaring_type comes from the nestedTypes section; row positions are metadata indices, except nested_type_start, which indexes the unreturned nestedTypes table (find nested types by declaring_type). A large game returns megabytes of rows, so omitted or summary detail returns identity, sections and counts. It retains complete Evidence; page images/types/methods/fields/properties/events/parameters/string_literals/method_addresses with inspect_analysis_view kind il2cpp-metadata and normalized_result.parent_evidence_id. detail: "complete" returns every row inline when it fits the transport. With binary_path naming the matching Mach-O GameAssembly.dylib (binary_architecture selects a universal slice) or 64-bit PE GameAssembly.dll, it reads (never runs) the binary, locates the CodeRegistration code-generation modules by image name and method count, and returns binary (registration addresses) plus method_addresses: one {address, rva} row per method index, null when the module records no body; ELF, chained fixups and generic instances are not linked. Runs no Unity, IL2CPP binary or disassembler, does not decrypt, and does not recover field or parameter types, signatures or runtime behavior. Unrecognized magic and other versions are unsupported; damaged headers, overlapping sections, inconsistent record sizes, out-of-range indices, inconsistent nesting, method ownership or image ranges and invalid strings are rejected with a reason and no partial success. Resource guards bound files to 256 MiB and the complete report to 64 MiB.',
    inputSchema: inspectIl2cppMetadataInputSchema,
    outputSchema: evidenceResultOf(
      z.union([il2cppMetadataSchema, il2cppMetadataSummaryViewResultSchema]),
    ),
    examples: [
      {
        title: "Summarize metadata and retain rows for paging",
        input: {
          path: "/artifacts/Data/Managed/Metadata/global-metadata.dat",
        },
      },
      {
        title: "Link method addresses from a universal macOS binary",
        input: {
          path: "/artifacts/Game.app/Contents/Resources/Data/il2cpp_data/Metadata/global-metadata.dat",
          binary_path:
            "/artifacts/Game.app/Contents/Frameworks/GameAssembly.dylib",
          binary_architecture: "arm64",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
