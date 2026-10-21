import { expect, it } from "vitest";
import { readUnityAddressablesCatalogSteps } from "../../../src/unity/UnityAddressablesCatalog.js";
import { UnityAddressablesFormatFailure } from "../../../src/unity/UnityAddressablesFormat.js";
import type { UnityAddressablesReadOptions } from "../../../src/unity/UnityAddressablesShared.js";
import {
  ASSET_PROVIDER,
  BUNDLE_PROVIDER,
  binaryCatalog,
  jsonCatalog,
  sampleCatalog,
  type FixtureCatalog,
} from "../../fixtures/unity/addressables.js";

const decode = (bytes: Buffer, options?: UnityAddressablesReadOptions) => {
  const steps = readUnityAddressablesCatalogSteps(bytes, options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
};

const failure = (bytes: Buffer) => {
  try {
    decode(bytes);
  } catch (cause) {
    if (cause instanceof UnityAddressablesFormatFailure) return cause;
    throw cause;
  }
  throw new Error("expected a format failure");
};

/** Facts both formats must agree on, independent of storage details. */
const sharedFacts = (report: ReturnType<typeof decode>) => ({
  locator_id: report.locator_id,
  build_result_hash: report.build_result_hash,
  keys: report.keys,
  locations: report.locations.map(
    ({ offset: _offset, dependency_key: _key, dependency_hash, ...row }) => ({
      ...row,
      dependency_hash,
    }),
  ),
  providers: report.providers.map(({ role, id, type_name }) => ({
    role,
    id,
    type_name,
  })),
});

it("decodes every JSON key kind, location field, dependency and bundle option", () => {
  const report = decode(jsonCatalog());
  expect(report).toMatchObject({
    format: "json",
    format_version: null,
    dependency_basis: "key-locations",
    locator_id: "AddressablesMainContentCatalog",
    build_result_hash: "0123456789abcdef0123456789abcdef",
  });
  expect(report.keys.map(({ kind, value }) => [kind, value])).toEqual([
    ["string", "core_assets_all.bundle"],
    ["string", "ui/버튼_메모.bundle"],
    ["string", "Prefabs/Crate"],
    ["string", "UI/버튼 메모"],
    ["string", "hd"],
    ["int32", "-1025798400"],
    ["string", "Textures/Checker"],
  ]);
  expect(report.keys[4]!.locations).toEqual([2, 4]);
  expect(report.locations[2]).toEqual({
    primary_key: "Prefabs/Crate",
    internal_id: "Assets/Samples/Crate.prefab",
    provider_id: ASSET_PROVIDER,
    resource_type: "UnityEngine.GameObject",
    dependencies: [0, 1],
    dependency_key: 5,
    dependency_hash: -1899522878,
    data: null,
    offset: null,
  });
  expect(report.locations[1]!.data).toEqual({
    kind: "asset-bundle",
    hash: "9bb32e1bfa291acbaa3fd375886cabfe",
    crc: 7,
    bundle_name: "ui_버튼_메모",
    bundle_size: 1224,
  });
  expect(report.locations[3]!.data).toEqual({
    kind: "other",
    type_name:
      "UnityEngine.ResourceManagement.ResourceProviders.ProviderLoadRequestOptions",
  });
  expect(report.locations[4]!.dependencies).toEqual([]);
  expect(report.providers.map(({ role }) => role)).toEqual([
    "instance",
    "scene",
    "resource",
    "resource",
  ]);
});

it("decodes the remaining JSON key encodings with distinct values", () => {
  const catalog: FixtureCatalog = {
    keys: [
      { key: { kind: "uint16", value: 65535 }, locations: [0] },
      { key: { kind: "uint32", value: 4294967295 }, locations: [0] },
      {
        key: { kind: "hash128", value: "00112233445566778899aabbccddeeff" },
        locations: [0],
      },
      {
        key: { kind: "type", value: "5f6f7e4c-0000-0000-0000-000000000001" },
        locations: [0],
      },
      { key: { kind: "object", type_name: "Game.Key" }, locations: [0] },
    ],
    locations: [
      {
        primaryKey: 4,
        internalId: "a",
        provider: ASSET_PROVIDER,
        type: "UnityEngine.Object",
      },
    ],
  };
  const report = decode(jsonCatalog(catalog));
  expect(report.keys).toEqual([
    { kind: "uint16", value: "65535", type_name: null, locations: [0] },
    { kind: "uint32", value: "4294967295", type_name: null, locations: [0] },
    {
      kind: "hash128",
      value: "00112233445566778899aabbccddeeff",
      type_name: null,
      locations: [0],
    },
    {
      kind: "type",
      value: "5f6f7e4c-0000-0000-0000-000000000001",
      type_name: null,
      locations: [0],
    },
    { kind: "object", value: null, type_name: "Game.Key", locations: [0] },
  ]);
  // An object primary key has no text; the runtime prints its type.
  expect(report.locations[0]!.primary_key).toBe("Game.Key");
  expect(report.locator_id).toBeNull();
});

it("expands prefix-compressed internal ids and leaves unprefixed ones alone", () => {
  const prefixes = [
    "{UnityEngine.AddressableAssets.Addressables.RuntimePath}/StandaloneOSX/",
    "Assets/Samples/",
  ];
  const compressed = jsonCatalog(sampleCatalog(), { prefixes });
  expect(compressed.toString()).toContain('"1#Crate.prefab"');
  expect(decode(compressed).locations.map((row) => row.internal_id)).toEqual(
    decode(jsonCatalog()).locations.map((row) => row.internal_id),
  );
});

it.each([2, 3])(
  "decodes binary version %i with the same facts as the JSON catalog",
  (version) => {
    const report = decode(binaryCatalog(sampleCatalog(), { version }));
    expect(report).toMatchObject({
      format: "binary",
      format_version: version,
      dependency_basis: "location-records",
    });
    expect(sharedFacts(report)).toEqual(sharedFacts(decode(jsonCatalog())));
    expect(report.locations.every((row) => row.dependency_key === null)).toBe(
      true,
    );
    expect(
      report.locations.map((row) => row.offset).every((at) => at !== null),
    ).toBe(true);
  },
);

it("decodes binary Hash128 and unknown object keys and appends dependency-only locations", () => {
  const catalog: FixtureCatalog = {
    keys: [
      {
        key: { kind: "hash128", value: "ffeeddccbbaa99887766554433221100" },
        locations: [0],
      },
      { key: { kind: "object", type_name: "Game.Key" }, locations: [] },
      { key: { kind: "string", value: "dep" }, locations: [] },
    ],
    locations: [
      {
        primaryKey: 2,
        internalId: "a/b",
        provider: ASSET_PROVIDER,
        type: "UnityEngine.Object",
        dependencies: [1],
      },
      {
        primaryKey: 2,
        internalId: "only/a/dependency",
        provider: BUNDLE_PROVIDER,
        type: "UnityEngine.Object",
      },
    ],
  };
  // No key selects location 1; only the dependency array names it.
  const report = decode(binaryCatalog(catalog));
  expect(
    report.keys.map(({ kind, value, type_name }) => [kind, value, type_name]),
  ).toEqual([
    ["hash128", "ffeeddccbbaa99887766554433221100", null],
    ["object", null, "Game.Key"],
    ["string", "dep", null],
  ]);
  expect(report.locations).toHaveLength(2);
  expect(report.locations[0]!.dependencies).toEqual([1]);
  expect(report.locations[1]!.internal_id).toBe("only/a/dependency");
});

it("selects the decoder from content and preserves input bytes", () => {
  const bytes = jsonCatalog();
  const copy = Buffer.from(bytes);
  const padded = Buffer.concat([Buffer.from("﻿ \n", "utf8"), bytes]);
  expect(decode(padded).format).toBe("json");
  decode(bytes);
  expect(bytes.equals(copy)).toBe(true);
});

it.each([
  ["an unrelated file", Buffer.from("PK\u0003\u0004 not a catalog")],
  [
    "a wrong binary magic",
    binaryCatalog(sampleCatalog(), { magic: 0x12345678 }),
  ],
])("refuses %s as an unrecognized format", (_name, bytes) => {
  expect(failure(bytes)).toMatchObject({
    kind: "unsupported",
    reason: "unrecognized-format",
  });
});

it.each([1, 0, 4])("refuses binary version %i as unsupported", (version) => {
  expect(failure(binaryCatalog(sampleCatalog(), { version }))).toMatchObject({
    kind: "unsupported",
    reason: "unsupported-version",
  });
});

const patched = (patch: (catalog: Record<string, unknown>) => void) =>
  jsonCatalog(sampleCatalog(), { patch });
const entries =
  (
    edit: (data: Buffer) => void,
  ): ((catalog: Record<string, unknown>) => void) =>
  (catalog) => {
    const data = Buffer.from(catalog.m_EntryDataString as string, "base64");
    edit(data);
    catalog.m_EntryDataString = data.toString("base64");
  };

it.each([
  ["text that is not JSON", Buffer.from("{ not json"), "invalid-json"],
  [
    "a missing internal id table",
    patched((catalog) => delete catalog.m_InternalIds),
    "missing-field",
  ],
  [
    "non-canonical base64",
    patched((catalog) => (catalog.m_KeyDataString = "@@@@")),
    "invalid-base64",
  ],
  [
    "a key count that disagrees with the buckets",
    patched((catalog) => {
      const data = Buffer.from(catalog.m_KeyDataString as string, "base64");
      data.writeInt32LE(99, 0);
      catalog.m_KeyDataString = data.toString("base64");
    }),
    "index-out-of-range",
  ],
  [
    "entry data shorter than its count",
    patched(entries((data) => data.writeInt32LE(6, 0))),
    "truncated-record",
  ],
  [
    "a provider index past the provider table",
    patched(entries((data) => data.writeInt32LE(9, 4 + 4))),
    "index-out-of-range",
  ],
  [
    "a dependency key past the keys",
    patched(entries((data) => data.writeInt32LE(70, 4 + 8))),
    "index-out-of-range",
  ],
  [
    "an unknown object tag",
    patched((catalog) => {
      const data = Buffer.from(catalog.m_KeyDataString as string, "base64");
      data[4] = 9;
      catalog.m_KeyDataString = data.toString("base64");
    }),
    "invalid-object-tag",
  ],
  [
    "a bucket entry past the entries",
    patched((catalog) => {
      const data = Buffer.from(catalog.m_BucketDataString as string, "base64");
      data.writeInt32LE(50, 12);
      catalog.m_BucketDataString = data.toString("base64");
    }),
    "index-out-of-range",
  ],
])("refuses JSON with %s", (_name, bytes, reason) => {
  expect(failure(bytes).reason).toBe(reason);
});

it("refuses a prefix reference outside m_InternalIdPrefixes", () => {
  const bytes = jsonCatalog(sampleCatalog(), {
    prefixes: ["Assets/Samples/", "unused/"],
    patch: (catalog) => {
      catalog.m_InternalIds = (catalog.m_InternalIds as string[]).map((id) =>
        id.replace(/^0#/u, "7#"),
      );
    },
  });
  expect(failure(bytes)).toMatchObject({
    kind: "malformed",
    reason: "index-out-of-range",
  });
});

it("refuses bundle options without a CRC", () => {
  const text = jsonCatalog().toString("utf8");
  const catalog = JSON.parse(text) as Record<string, string>;
  const extra = Buffer.from(catalog.m_ExtraDataString!, "base64");
  const json = Buffer.from('"m_Crc":', "utf16le");
  const at = extra.indexOf(json);
  Buffer.from('"m_Crx":', "utf16le").copy(extra, at);
  catalog.m_ExtraDataString = extra.toString("base64");
  expect(failure(Buffer.from(JSON.stringify(catalog))).reason).toBe(
    "missing-field",
  );
});

const binary = (edit: (bytes: Buffer) => void) => {
  const bytes = binaryCatalog();
  edit(bytes);
  return bytes;
};

it.each([
  [
    "a header shorter than 32 bytes",
    binaryCatalog().subarray(0, 20),
    "offset-out-of-bounds",
  ],
  [
    "a key table outside the file",
    binary((bytes) => bytes.writeUInt32LE(bytes.length + 100, 8)),
    "offset-out-of-bounds",
  ],
  [
    "a key table whose size is not a record multiple",
    binary((bytes) => bytes.writeUInt32LE(7, bytes.readUInt32LE(8) - 4)),
    "truncated-record",
  ],
])("refuses binary with %s", (_name, bytes, reason) => {
  expect(failure(bytes).reason).toBe(reason);
});

it("refuses a dynamic string chain that loops back on itself", () => {
  const bytes = binaryCatalog();
  // The first location's internal id is a dynamic chain; point its last node at its first.
  const keys = bytes.readUInt32LE(8);
  const set = bytes.readUInt32LE(keys + 4);
  const location = bytes.readUInt32LE(set);
  const head = bytes.readUInt32LE(location + 4) & 0x3fffffff;
  let node = head;
  while (bytes.readUInt32LE(node + 4) !== 0xffffffff)
    node = bytes.readUInt32LE(node + 4) & 0x3fffffff;
  bytes.writeUInt32LE((head | 0x40000000) >>> 0, node + 4);
  expect(failure(bytes)).toMatchObject({
    kind: "malformed",
    reason: "string-chain-cycle",
  });
});

it.each([
  ["an odd UTF-16 length", 0x80000000, Buffer.from([0x41, 0, 0x42])],
  ["an ASCII-flagged non-ASCII byte", 0, Buffer.from([0x41, 0xc3, 0xa9])],
])("refuses a string with %s", (_name, flag, body) => {
  const bytes = binaryCatalog();
  const id = Buffer.alloc(4 + body.length);
  id.writeUInt32LE(body.length, 0);
  body.copy(id, 4);
  const at = bytes.length + 4;
  const patched = Buffer.concat([bytes, id]);
  // Replace the locator id string.
  patched.writeUInt32LE((at | flag) >>> 0, 12);
  expect(failure(patched).reason).toBe("invalid-string");
});

it("checks a dynamic string before joining it and charges rows before retention", () => {
  const events: string[] = [];
  decode(binaryCatalog(), {
    beforeRows: (counts) =>
      events.push(`rows ${counts.keys}/${counts.locations}`),
    beforeText: () => events.push("text"),
    onRow: () => events.push("row"),
  });
  expect(events[0]).toBe("rows 7/5");
  expect(events.indexOf("text")).toBeLessThan(events.indexOf("row"));
  expect(events.filter((event) => event === "row")).toHaveLength(7 + 5 + 4);
});

it("stops at the first text that exceeds the remaining budget", () => {
  const stop = new Error("over budget");
  let rows = 0;
  expect(() =>
    decode(jsonCatalog(), {
      beforeText: (bytes) => {
        if (bytes > 60) throw stop;
      },
      onRow: () => rows++,
    }),
  ).toThrow(stop);
  // Providers and keys fit; the first location's long data type name is refused before its row exists.
  expect(rows).toBe(4 + 7);
});

it("decodes a location set shared by many keys once and charges each key row", () => {
  const catalog = sampleCatalog();
  const shared = [0, 1, 2, 3, 4];
  for (let index = 0; index < 50; index++)
    catalog.keys.push({
      key: { kind: "int32", value: index },
      locations: shared,
    });
  const bytes = binaryCatalog(catalog);
  // Point every added key at the first added key's location set.
  const keys = bytes.readUInt32LE(8);
  const first = bytes.readUInt32LE(keys + 7 * 8 + 4);
  for (let index = 8; index < catalog.keys.length; index++)
    bytes.writeUInt32LE(first, keys + index * 8 + 4);
  const report = decode(bytes);
  expect(report.keys[7]!.locations).toEqual(shared);
  expect(report.keys[56]!.locations).toBe(report.keys[7]!.locations);
  let charged = 0;
  decode(bytes, { onRow: () => charged++ });
  expect(charged).toBe(4 + 57 + 5);
});

it("reports a binary string stored as no object and missing record strings as null", () => {
  const bytes = binaryCatalog();
  const keys = bytes.readUInt32LE(8);
  const keyObject = bytes.readUInt32LE(keys + 4 * 8);
  bytes.writeUInt32LE(0xffffffff, keyObject + 4);
  const set = bytes.readUInt32LE(keys + 4);
  const location = bytes.readUInt32LE(set);
  bytes.writeUInt32LE(0xffffffff, location + 4);
  const report = decode(bytes);
  expect(report.keys[4]).toMatchObject({ kind: "string", value: null });
  expect(report.locations[0]!.internal_id).toBeNull();
});
