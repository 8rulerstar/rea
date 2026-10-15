# IL2CPP metadata

`inspect_il2cpp_metadata` / `inspect-il2cpp-metadata` decodes one selected local
Unity IL2CPP `global-metadata.dat` file and returns its assembly images, type
definitions and method definitions by name, namespace, index range and count,
with the header sections and serialized index widths. It reads the file without
running it and requires no Unity installation, IL2CPP binary, active target,
Hopper, Ghidra or IDA.

Metadata versions 24, 27, 29, 31 and 39 are supported. For example, Unity 2019.4.41f2
wrote version 24, 2020.3.49f1 version 27, 2022.3.30f1
wrote version 29, 2022.3.62f3 wrote 31 and 6000.4.2f1 wrote 39; other Unity
releases that write these numbers have not been checked. Other versions are
rejected as unsupported. The path must name a regular file; directories and
symbolic links are rejected.

With `binary_path`, the tool also reads the matching native binary and links
each method to its code address. See [Native method addresses](#native-method-addresses).

## MCP

A large game produces megabytes of rows, so MCP delivers a summary by default
(`detail: "summary"`). MCP requires an absolute filesystem path:

```json
{
  "name": "inspect_il2cpp_metadata",
  "arguments": {
    "path": "/artifacts/Data/Managed/Metadata/global-metadata.dat"
  }
}
```

The summary retains the complete decoded Evidence in the session and returns a
linked `inspect_analysis_view` overview: artifact identity, metadata version,
index widths, sections and `counts` (`images`, `types`, `methods` and
`nested_types`) without rows. Use `normalized_result.parent_evidence_id` to page
the original rows without reopening or decoding the file:

```json
{
  "source": {
    "kind": "retained-evidence",
    "evidence_id": "<parent_evidence_id>"
  },
  "view": {
    "kind": "il2cpp-metadata",
    "collection": "types",
    "offset": 0,
    "limit": 64
  }
}
```

Collections are `images`, `types`, `methods`, `fields`, `properties`, `events`,
`parameters`, `string_literals`, `method_addresses`, `return_types`,
`field_types` and `parameter_types`. `limit` defaults to 64. The page
offset is the metadata index of the first returned row. `limit` has no cap of
its own beyond the MCP response budget. Select `detail: "complete"` to return
every row inline when the result fits that budget, as a small game's often does.

## CLI

```bash
rea inspect-il2cpp-metadata /absolute/path/global-metadata.dat --json
```

The CLI returns the complete result. It has no detail option. `--binary PATH`
links method addresses and `--architecture arm64|amd64` selects the slice of a
universal Mach-O.

## Observations

The result contains:

- `artifact`: path, SHA-256 and byte length;
- `metadata_version`: `24`, `27`, `29`, `31` or `39`;
- `index_widths`: the serialized widths (1, 2 or 4 bytes) of
  `type_definition`, `generic_container`, `parameter` and `type` indices, and
  `type_width_source`. Version 39 derives the type index width from the
  `interface-offsets-record` or the `type-definition-record`; versions 27, 29
  and 31 always use 4-byte indices (`fixed-width-version`);
- `sections`: all 31 header sections in header order, each with `offset`, `size`
  and `count`. Versions 24 to 31 record no counts, so `count` is `null` and
  record counts come from the section sizes;
- `images`: `name`, `type_start` and `type_count`;
- `types`: `name`, `namespace`, `method_start`, `method_count`,
  `nested_type_start`, `nested_type_count` and `declaring_type`;
- `methods`: `name` and `declaring_type`;
- `fields`, `properties` and `events`: `name` and `declaring_type`, the type
  whose member range holds the row (`-1` when none does);
- `parameters`: `name` and `method`, the method whose parameter range holds it;
- `string_literals`: managed string literals as `value`, or `value_base64` with
  the exact bytes when they are not valid UTF-8;
- `limitations`.

A row's position in its collection is its metadata index, so `type_start`,
`method_start` and `declaring_type` refer to positions in `types` or `methods`.
`nested_type_start` instead indexes the metadata's `nestedTypes` table, which is
not returned; each nested type's `declaring_type` carries that relationship.
A type's `declaring_type` is derived from the `nestedTypes` section and is `-1`
for top-level types. The start of an empty range can retain the original value
`-1`.

The complete inventory of a large game is several megabytes and can exceed
the MCP response budget; the default summary and paging avoid that. The tool has
no name search: page the collections, or filter the complete CLI JSON with a
tool such as `jq`.

## Native method addresses

`binary_path` names the native binary built with the metadata: macOS
`GameAssembly.dylib` (Mach-O) or Windows `GameAssembly.dll` (64-bit PE). A
universal Mach-O needs `binary_architecture` (`arm64` or `amd64`); a thin binary
rejects it. The file is read, never loaded or executed.

The binary's `Il2CppCodeRegistration` points to one `Il2CppCodeGenModule` per
assembly image. Each module record starts with its module name, its method
pointer count and its method pointer array. The reader finds, for every metadata
image, the single record whose name pointer reaches that image's name string and
whose count equals the image's method count. It then requires exactly one
`codeGenModulesCount`/`codeGenModules` pair that lists exactly those records. No
symbols are needed, so stripped builds work. A method's token row id selects its
slot in the module's method pointer array.

The result adds:

- `binary`: artifact identity, `format`, `architecture`, `image_base`,
  `code_gen_modules_field` (the address of `codeGenModulesCount`) and
  `code_gen_modules` (`image`, record `address`, `method_pointer_count`);
- `method_addresses`: one row per method index with `address` and `rva`
  (address minus `image_base`), both hexadecimal strings. Both are `null` when
  the module records no body, as for abstract, extern and most generic methods.

- `return_types`, `field_types` and `parameter_types`: one row per method,
  field and parameter index with `type`, the index into the binary's
  `Il2CppType` table, and `name`, rendered from that table: C# keywords for
  primitives (`int`, `string`, `object`), `Namespace.Outer+Inner` for type
  definitions, `T[]`, `T[,]` and `T*`, generic instances as
  `System.Collections.Generic.List<string>` and generic parameters by their
  metadata name (`TKey`). A trailing `&` marks a by-reference type. `name` is
  `null` only for type index `-1`.

`binary` also records `types_field` and `types_count`: the address of
`Il2CppMetadataRegistration.typesCount` and its value. That record is found as
the single place whose `fieldOffsetsCount` and `typeDefinitionsSizesCount` both
equal the metadata type-definition count and whose type table is file mapped.

Without `binary_path`, `binary` is `null` and the four binary collections are
empty.

Checked against Unity 2021.3.45f2, 2022.3.30f1, 2022.3.62f3 and 6000.0.84f1
macOS builds, both arm64 and x86_64 slices. PE linking follows the same rules
but has not been checked against a real Windows build.

| Reason                            | Category    | Meaning                                                                                 |
| --------------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `unsupported-container`           | unsupported | Not a 64-bit little-endian Mach-O or PE image.                                          |
| `slice-selection-required`        | unsupported | A universal Mach-O was given without `binary_architecture`.                             |
| `slice-not-found`                 | unsupported | The requested slice is absent, or a thin binary was given an architecture.              |
| `unsupported-pointer-encoding`    | unsupported | ELF (relocation addends) or Mach-O chained fixups; stored pointers not decoded.         |
| `malformed-container`             | input error | The container headers are damaged.                                                      |
| `code-gen-modules-not-found`      | input error | An image has no module record; often a binary from a different build.                   |
| `ambiguous-code-gen-module`       | input error | More than one record matches an image.                                                  |
| `code-registration-not-found`     | input error | No single module table lists exactly the located records.                               |
| `invalid-method-token`            | input error | A method token is not a method row inside its module's pointer count.                   |
| `invalid-method-pointer`          | input error | A pointer slot or a method address is not file mapped.                                  |
| `metadata-registration-not-found` | input error | No single MetadataRegistration matches the type-definition count.                       |
| `invalid-type`                    | input error | A type index or `Il2CppType` record is out of range, unmapped or of an unrendered kind. |

Binary failures report `binary_path` as the input field. There is no partial
linking: any failure returns no addresses. The binary is bounded to 1 GiB.

## Failures

A file whose magic is not `0xFAB11BAF` fails as an unsupported target with
`unrecognized-magic`. The file may be encrypted or may not be IL2CPP metadata.
A version other than 24, 27, 29, 31 or 39 fails as an unsupported target with
`unsupported-version`.

Damaged metadata returns an input error (`invalid_format`) whose
message names one reason:

| Reason                    | Meaning                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `truncated-header`        | The file is shorter than the header.                                                                             |
| `unexpected-header-size`  | `stringLiterals.offset` is not the header size: 264 bytes for version 24, 256 for 27, 29 and 31, 380 for 39.     |
| `section-out-of-bounds`   | A section extends beyond the file, or a non-empty section starts inside the header.                              |
| `section-overlap`         | Two sections overlap. Zero-size sections are exempt and gaps are allowed.                                        |
| `record-size-mismatch`    | A section size does not divide into its records, or the record size differs from the one the index widths imply. |
| `type-index-width`        | The record used to derive the type index width implies no 1, 2 or 4 byte width.                                  |
| `index-out-of-range`      | A serialized index or range points outside its target collection.                                                |
| `nested-type-conflict`    | A type is listed as nested in two types, in itself, or in a cycle of declaring types.                            |
| `declaring-type-mismatch` | A method inside a type's method range names a different type, or a method lies outside its type's range.         |
| `image-range-overlap`     | Two images claim the same type definitions.                                                                      |
| `invalid-string`          | A name index does not start a string, or the name is unterminated or not valid UTF-8.                            |

A version field that disagrees with the file's layout, for example a version
39 file relabeled as 29, usually surfaces as `unexpected-header-size` or
`record-size-mismatch`.

Two checks are stricter than the IL2CPP runtime: a name index must start a
string, and an empty range's start must lie between -1 and the collection size.
Every Unity-written file checked so far satisfies both; metadata rewritten by
other tools may be rejected.

There is no partial success. A file that changes during reading and a cancelled
request keep their own distinct errors. Resource guards bound the selected file
to 256 MiB and the complete report to 64 MiB. MCP also applies its
[response transport budget](mcp-contracts.md); a complete report within the
report limit can still require the summary and paging path.

## Outside this tool

- Decrypting or deobfuscating protected metadata.
- Linking ELF `libil2cpp.so` binaries and Mach-O binaries that use chained
  fixups; generic method instances, adjustor thunks and invokers.
- Fields, properties, signatures, parameters and generic instances.
- Ghidra or other disassembler integration. Use the
  [native workflow](native-investigation.md) for native code.
- Metadata versions other than 24, 27, 29, 31 and 39.

Names come from the metadata file only. They do not establish which methods
were compiled into the native binary or how they behave at runtime.

## Real producer verification

`npm run verify:il2cpp:metadata -- --metadata PATH` exercises a caller-supplied
`global-metadata.dat` through the public CLI and MCP. It is opt-in, like
`verify:pcap`, because no real game metadata ships with the repository. Normal
inspection does not need it.
