# Unity assets

`inspect_unity_assets` / `inspect-unity-assets` inventories one selected local
Unity SerializedFile or UnityFS AssetBundle. SerializedFiles are the player data
files such as `globalgamemanagers`, `globalgamemanagers.assets`, `level0`,
`sharedassets0.assets` and `resources.assets`. It reads the file without running
it and requires no Unity installation, active target, Hopper, Ghidra or IDA.

SerializedFile format versions 9 to 22 are decoded in either byte order,
including the 64-bit offsets of version 22. Unity 2021.3.45f2, 2022.3.30f1,
2022.3.62f3 and 6000.0.84f1 macOS players all wrote version 22; other releases
have not been checked. UnityFS bundles of format 6 to 8 are decoded when their
blocks are uncompressed, LZ4 or LZ4HC. LZ4 is decoded in-process; LZMA is not.

## MCP

A large game has many thousands of objects, so MCP delivers a summary by default
(`detail: "summary"`). MCP requires an absolute filesystem path:

```json
{
  "name": "inspect_unity_assets",
  "arguments": {
    "path": "/artifacts/Game.app/Contents/Resources/Data/level0"
  }
}
```

The summary retains the complete decoded Evidence in the session and returns a
linked `inspect_analysis_view` overview: artifact identity, container, the
bundle header, every SerializedFile header and per-collection `counts` without
rows. Use `normalized_result.parent_evidence_id` to page rows without reopening
or decoding the file:

```json
{
  "source": {
    "kind": "retained-evidence",
    "evidence_id": "<parent_evidence_id>"
  },
  "view": {
    "kind": "unity-assets",
    "collection": "objects",
    "offset": 0,
    "limit": 64
  }
}
```

Collections are `blocks`, `entries`, `serialized_files`, `types`, `objects`,
`scripts` and `externals`, in report order. `limit` defaults to 64. Select
`detail: "complete"` to return every row inline when the result fits the MCP
response budget.

## CLI

```bash
rea inspect-unity-assets /absolute/path/level0 --json
```

The CLI returns the complete result. It has no detail option.

## Observations

The result contains:

- `artifact`: path, SHA-256 and byte length;
- `container`: `serialized-file` or `unityfs`;
- `bundle`: for UnityFS, the format version, player version, Unity revision,
  declared size, flags, the blocks-info location, sizes and compression, the
  data offset and the decompressed stream size; `null` otherwise;
- `blocks`: each storage block's compressed and uncompressed size, compression
  and flags;
- `entries`: each directory entry's path, offset and size in the decompressed
  stream, flags, and `serialized_file`, the `serialized_files` row decoded from
  it (`-1` for raw data such as `.resS`);
- `serialized_files`: `entry` (`-1` for the selected file itself), format
  `version`, `big_endian`, `metadata_size`, `file_size`, `data_offset`,
  `unity_version`, `target_platform`, `type_tree_enabled`, row counts and
  `user_information`;
- `types`: `file`, `index`, `class_id`, `class_name`, `stripped`,
  `script_type_index`, `script_id`, `type_tree_nodes` and `type_tree_root`;
- `objects`: `file`, `path_id` (signed 64-bit, as a decimal string), `class_id`,
  `type_index` (`-1` before version 16), and the object's byte `offset` and
  `size` inside its SerializedFile;
- `scripts`: `file`, `file_index` and `path_id`;
- `externals`: `file`, `path`, `guid` and `type`. A PPtr `m_FileID` of 1 names
  the first external of its file;
- `limitations`.

Rows in `types`, `objects`, `scripts` and `externals` name their
`serialized_files` row in `file`. For a bundle, an object's offset is relative
to the start of its entry in the decompressed stream, not to the bundle file.

`class_name` comes from a partial built-in table of well-known class IDs and is
`null` for unlisted IDs. `type_tree_root` is read from the file's own TypeTree
string buffer; names stored in Unity's shared common-string table are `null`.
Player builds usually omit TypeTrees and bundles usually include them.

Object bodies are not decoded: there are no object names, field values,
textures, meshes, audio or script bindings.

## Failures

| Reason                    | Kind        | Meaning                                                                          |
| ------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `unrecognized-format`     | unsupported | Neither a UnityFS signature nor a plausible SerializedFile header.               |
| `unsupported-container`   | unsupported | A `UnityWeb`, `UnityRaw` or `UnityArchive` bundle that predates UnityFS.         |
| `unsupported-version`     | unsupported | SerializedFile version outside 9 to 22, or UnityFS format outside 6 to 8.        |
| `unsupported-compression` | unsupported | LZMA blocks, or a compression type REA does not know.                            |
| `encrypted-bundle`        | unsupported | The bundle flags mark encryption.                                                |
| `truncated-header`        | corrupt     | The file is shorter than its header, or the endianness marker is invalid.        |
| `metadata-out-of-bounds`  | corrupt     | Metadata extends past its declared size or the data offset.                      |
| `file-size-mismatch`      | corrupt     | The header's file or bundle size differs from the bytes available.               |
| `count-out-of-range`      | corrupt     | A row count cannot fit in the remaining bytes.                                   |
| `index-out-of-range`      | corrupt     | An object names a type index outside the type table.                             |
| `object-out-of-bounds`    | corrupt     | An object's range lies outside its SerializedFile.                               |
| `invalid-string`          | corrupt     | A string is unterminated or not valid UTF-8.                                     |
| `block-out-of-bounds`     | corrupt     | The blocks info or block data lie outside the file.                              |
| `block-size-mismatch`     | corrupt     | A block decodes to a size other than declared, or a stored block's sizes differ. |
| `lz4-invalid`             | corrupt     | An LZ4 sequence runs past its input or output or references before the output.   |
| `entry-out-of-bounds`     | corrupt     | A directory entry lies outside the decompressed stream.                          |

Unsupported reasons return an unsupported-target error. Corrupt reasons return
an input error (`invalid_format`) naming the reason. Three guards return a
resource-constraint error before any expansion: `decompressed-size` (more than
512 MiB of declared blocks), `compression-ratio` (a compressed block declaring
more than 256 times its size; LZ4 cannot exceed about 255:1) and `block-count`
(more than 1,048,576 blocks).

There is no partial success: an LZMA bundle returns no directory, and a bundle
with one damaged SerializedFile entry returns nothing. Resource guards bound the
selected file to 256 MiB and the complete report to 64 MiB.
