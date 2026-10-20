# Unity IL2CPP metadata demo: 2026-10-20

A reproducible scenario for issue #778, using the merged
`inspect_il2cpp_metadata` inventory, its native address linking and
`inspect_analysis_view` queries ([IL2CPP metadata](../il2cpp-metadata.md)). The adjacent JSON records the exact
inputs, Evidence IDs and measurements.

#### Dxx (Unity IL2CPP): which assembly and type declare a game script's methods?

- Status / owner: Verified on one host (macOS arm64); not recorded.
- Analyst question / expected answer: In a Unity IL2CPP player build, which
  assembly image and type declare the `Update` method of the game script
  `Sample.Player`, and what does its nested type declare? Expected: image
  `Assembly-CSharp.dll`, type `Sample.Player` with `Update` and `.ctor`, and
  nested type `Slot` (declared by `Player`) with `Add` and `.ctor`. The members
  step adds fields `slot` (on `Player`) and `Count` (on `Slot`), and no
  parameters for `Add`.
- Why select it / coverage added: a new domain. The issue's D05 row lists IL2CPP
  decoding as outside the managed parser; `inspect_il2cpp_metadata` now covers
  the metadata half and links methods to native addresses. The metadata
  questions need one file, one decode and a few retained Evidence queries; the
  address step adds the player's `GameAssembly.dylib`. No Unity installation or
  disassembler is needed for either.
- Target source, license, digest and generation procedure: a self-authored
  Unity project of three text files, built below. The built player and its metadata are not
  committed: the repository does not accept binaries, and the metadata also
  names Unity engine assemblies. Three builds produced the same metadata
  digest: the original project and two fresh folders, one with exactly these
  three files.
- Public REA operations / CLI recipe: see [Run the demo](#run-the-demo).
- Host, REA artifact and provider prerequisites: macOS 27.0.1 (26A434) arm64,
  Node.js 26.5.0, REA 6.7.0 built from main
  `d0067ba34a39ea47dd7e11bb2e6169bc0938cc3f` (`node scripts/rea.mjs`). The MCP
  sizes below were measured on an earlier build (`c374c2fe7`) and not rerun. Unity
  2022.3.62f3 (`96770f904ca7`) with macOS IL2CPP build support is needed only to
  generate the target. No analysis provider is used.
- Independent oracle / meaningful unknown or control: the C# source below. A
  control query for the editor-only build class `CiBuild` returns no rows,
  because editor scripts are not compiled into the player. This demo has no
  independent oracle for the [native addresses](#native-addresses); no
  second tool was run on this build.
- Estimated cost; measured time, CPU/RSS, temporary/output space: see
  [Measurements](#measurements).
- Lifecycle and cleanup result: metadata inspection reads one file and starts no
  target process; there is no provider session to close. The complete Evidence
  export is a new file the reader deletes after the queries.
- Verification command / report:
  `npm run verify:il2cpp:metadata -- --metadata PATH` passed; this file and the
  adjacent JSON.
- Script, recording, documentation and PR links: no recording. Tool guide:
  [IL2CPP metadata](../il2cpp-metadata.md).
- Blocker or next action: record a terminal capture and an agent transcript.
  `analyze_function` on `Update` is not yet measured: on this host the Ghidra
  12.1.4 install has no native decompiler for macOS arm64, so `open_binary`
  rejected the provider (`executable_missing`).

## Build the target

Create an empty folder with these three files. Unity creates the remaining
project files during the first batch build.

`ProjectSettings/ProjectVersion.txt`:

```text
m_EditorVersion: 2022.3.62f3
m_EditorVersionWithRevision: 2022.3.62f3 (96770f904ca7)
```

`Assets/Scripts/Sample.cs`:

```csharp
using UnityEngine;

namespace Sample
{
    public class Player : MonoBehaviour
    {
        public class Slot
        {
            public int Count;
            public void Add() { Count++; }
        }

        private readonly Slot slot = new Slot();

        private void Update() { slot.Add(); }
    }
}
```

`Assets/Editor/CiBuild.cs`:

```csharp
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class CiBuild
{
    public static void Build()
    {
        var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects);
        new GameObject("Player").AddComponent<Sample.Player>();
        EditorSceneManager.SaveScene(scene, "Assets/Main.unity");
        PlayerSettings.SetScriptingBackend(BuildTargetGroup.Standalone, ScriptingImplementation.IL2CPP);
        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = new[] { "Assets/Main.unity" },
            locationPathName = "Build/Sample.app",
            target = BuildTarget.StandaloneOSX,
            options = BuildOptions.None,
        });
        EditorApplication.Exit(report.summary.result == BuildResult.Succeeded ? 0 : 1);
    }
}
```

Build in batch mode:

```sh
/Applications/Unity/Hub/Editor/2022.3.62f3/Unity.app/Contents/MacOS/Unity \
  -batchmode -nographics -projectPath "$PWD" -executeMethod CiBuild.Build
shasum -a 256 Build/Sample.app/Contents/Resources/Data/il2cpp_data/Metadata/global-metadata.dat
```

Expected metadata: 1,912,344 bytes, SHA-256
`2875f161ae0da99b83932b52aace567747070a45af9d696bc52a725a58c358b7`, version 31.
Source digests are in the JSON record. A different Unity release, target
platform or project setting changes the metadata; record the new digest instead
of comparing to this one.

## Run the demo

Set `M` to the absolute metadata path. Decode once, keep the summary and export
the complete Evidence to a new file:

```sh
rea inspect-il2cpp-metadata "$M" \
  --detail summary --evidence_output /tmp/il2cpp-demo-evidence.json --json
```

The summary reports metadata version 31, 4-byte index widths and counts of 31
sections, 38 images, 2,478 types, 12,501 methods, 574 nested types, 8,914
fields, 1,930 properties, 5 events, 15,571 parameters and 3,561 string
literals.

Each question is one view over that Evidence; the file is not decoded again:

```sh
view() {
  jq -c --argjson v "$1" \
    '{source: {kind: "inline", evidence: .records[0]}, view: ({kind: "il2cpp-metadata"} + $v)}' \
    /tmp/il2cpp-demo-evidence.json > /tmp/il2cpp-demo-query.json
  rea inspect-analysis-view /tmp/il2cpp-demo-query.json --json |
    jq -c '{items: .normalized_result.items, coverage: .normalized_result.coverage.status}'
}
view '{"collection": "images", "names": ["Assembly-CSharp.dll"]}'
view '{"collection": "types", "namespaces": ["Sample"]}'
view '{"collection": "types", "declaring_types": [2459]}'
view '{"collection": "methods", "declaring_types": [2459, 2458], "fields": ["name", "declaring_type"]}'
view '{"collection": "types", "names": ["CiBuild"]}'
```

Then the members of the two types, and the parameters of `Add` (method 12479)
selected by method index:

```sh
view '{"collection": "fields", "declaring_types": [2459, 2458]}'
view '{"collection": "parameters", "method_indices": [12479]}'
```

Results (each `coverage` is `page` and exhausted, except the two empty results):

| Query                       | Returned rows                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------- |
| Image `Assembly-CSharp.dll` | index 35, `type_start` 2455, `type_count` 8                                            |
| Namespace `Sample`          | type 2459 `Player`, `method_start` 12477, `method_count` 2, one nested type, top level |
| Declared by type 2459       | type 2458 `Slot`, namespace empty, `method_start` 12479, `method_count` 2              |
| Methods of 2459 and 2458    | 12477 `Update` and 12478 `.ctor` (2459); 12479 `Add` and 12480 `.ctor` (2458)          |
| Type `CiBuild` (control)    | none, coverage `empty`                                                                 |
| Fields of 2459 and 2458     | 8906 `slot` (2459); 8907 `Count` (2458)                                                |
| Parameters of method 12479  | none, coverage `empty`                                                                 |

Type 2459 lies inside image 35's range 2455 to 2462, so `Assembly-CSharp.dll`
declares `Sample.Player`. Listing that image (`image_indices: [35]`) also returns
the compiler-generated `<Module>`, `<PrivateImplementationDetails>`, two
`__StaticArrayInitTypeSize` types and Unity's
`UnitySourceGeneratedAssemblyMonoScriptTypes_v1` with nested `MonoScriptData`,
none of which appear in the C# source.

The fields match the source: the private `slot` on `Player` and the public
`Count` on `Slot`. The empty parameter result is the expected answer, since
`Add()` takes no arguments; it shows the `method_indices` lookup without
paging the 15,571-row parameter table.

The same steps over MCP use `inspect_il2cpp_metadata` with the absolute `path`,
then `inspect_analysis_view` with
`{"kind": "retained-evidence", "evidence_id": "<parent_evidence_id>"}` as the
source and the same views. An MCP run on this host returned identical rows; the
summary was 3,925 bytes and each of the seven views 3,200 to 3,503 bytes,
against 2,200,187 bytes of complete Evidence (measured at `c374c2fe7`).

## What this shows and does not show

Observed: the image, type, method and field names, their indices, the
nesting relationship and the (empty) parameter list of `Add`, as recorded in the metadata file. The source code is the
independent oracle for those facts.

Not shown: that `Update` runs, how often, or what its native code does. The
linked address shows where the code registration points, not runtime use. Field types, signatures and return types are outside the
current tool.

## Native addresses

Pass the player's native binary from the same build. `GameAssembly.dylib` is a
universal Mach-O, so the slice is named:

```sh
B=Build/Sample.app/Contents/Frameworks/GameAssembly.dylib
rea inspect-il2cpp-metadata "$M" --binary "$B" --architecture arm64 \
  --ghidra-seeds /tmp/il2cpp-demo-seeds.tsv \
  --detail summary --evidence_output /tmp/il2cpp-demo-native.json --json
view '{"collection": "method_addresses", "indices": [12477, 12478, 12479, 12480]}'
```

(`view` reads `/tmp/il2cpp-demo-evidence.json`; point it at the new export.)
The summary adds `binary` (Mach-O, arm64, `image_base` `0x0`, 38 code-gen
modules) and counts 12,501 method addresses: 11,022 `code`, 1,479 `no-body`
and 0 `unknown`.

| Method                     | Index | State  | Address    |
| -------------------------- | ----- | ------ | ---------- |
| `Sample.Player.Update`     | 12477 | `code` | `0x153560` |
| `Sample.Player..ctor`      | 12478 | `code` | `0x153594` |
| `Sample.Player.Slot.Add`   | 12479 | `code` | `0x153584` |
| `Sample.Player.Slot..ctor` | 12480 | `code` | `0x15360c` |

The seed file names the same four addresses (`Sample.Player$$Update` and so on)
among 11,022 seeds, after header lines recording both SHA-256 digests,
`link_base 0x0` and `seed_base 0x0`.

The binary is not byte-identical across builds: three builds of the same
project gave three different `GameAssembly.dylib` digests at the same size
(15,914,406 bytes). The rows above come from the fresh three-file build,
SHA-256 `2068a79f5acc50dc19a62fee343b1c1e2c65f06e5269dc4fada1f701ff25e4de`.
Whether the method addresses also match in the other two builds is unmeasured.

The next step, `REA_GHIDRA_SEED_FILE=/tmp/il2cpp-demo-seeds.tsv` with
`rea function "$B" 0x153560 --provider ghidra` (`open_binary`, then
`analyze_function`, then `close_binary`), is not recorded here; see the blocker
above. Addresses are static links from the code registration, not proof that
the player runs this code.

## Measurements

Single runs on the host above; not averaged.

| Step                                            | Wall time | Peak RSS   | Output                                                             |
| ----------------------------------------------- | --------- | ---------- | ------------------------------------------------------------------ |
| Unity batch build (clean project, first import) | 77.2 s    | 1,719 MB   | player; metadata 1.91 MB                                           |
| `npm run verify:il2cpp:metadata` (cached build) | 10.0 s    | 887 MB     | none retained                                                      |
| Verifier's complete CLI decode                  | 1.26 s    | unmeasured | Evidence 2,200,749 bytes                                           |
| Decode with `--binary` and `--ghidra-seeds`     | 1.30 s    | 498 MB     | Evidence 4,302,254 bytes; seeds 724,043 bytes; summary 6,975 bytes |

Unity's RSS is the editor process only. The verifier's RSS is the `npm`
process family as reported by `/usr/bin/time -l`, which counts only the largest
process. Other jobs were running on the host during the `d0067ba34` runs.
Per-query CLI time and agent token cost are unmeasured.
