import { expect, it } from "vitest";
import {
  Il2cppBinaryFormatFailure,
  linkIl2cppBinary,
} from "../../../src/il2cpp/Il2cppBinaryFile.js";
import { readIl2cppMetadataForLinking } from "../../../src/il2cpp/Il2cppMetadataFile.js";
import {
  createElfFixture,
  createIl2cppBinaryFixture,
  createUniversalFixture,
  FIXTURE_BINARY_BASE,
  FIXTURE_METHOD_ADDRESSES,
  FIXTURE_RETURN_TYPE_NAME,
  type Il2cppBinaryFixtureOptions,
} from "../../fixtures/il2cpp/binary.js";
import { createIl2cppMetadataFixture } from "../../fixtures/il2cpp/metadata.js";

const { metadata, link: facts } = readIl2cppMetadataForLinking(
  createIl2cppMetadataFixture().bytes,
);
const link = (bytes: Buffer, architecture?: string) =>
  linkIl2cppBinary(bytes, metadata, facts, architecture);
const failure = (bytes: Buffer, architecture?: string) => {
  try {
    link(bytes, architecture);
  } catch (cause) {
    if (cause instanceof Il2cppBinaryFormatFailure)
      return { reason: cause.reason, kind: cause.kind };
    throw cause;
  }
  throw new Error("expected a link failure");
};

it("links methods to code through module tokens, not metadata order", () => {
  const linked = link(createIl2cppBinaryFixture());
  expect(linked).toMatchObject({
    format: "macho",
    architecture: "arm64",
    image_base: FIXTURE_BINARY_BASE,
    code_gen_modules_field: FIXTURE_BINARY_BASE + 0x600n,
    code_gen_modules: [
      {
        image: 0,
        address: FIXTURE_BINARY_BASE + 0x400n,
        method_pointer_count: 3,
      },
      {
        image: 1,
        address: FIXTURE_BINARY_BASE + 0x440n,
        method_pointer_count: 2,
      },
    ],
  });
  expect(linked.method_addresses).toEqual(FIXTURE_METHOD_ADDRESSES);
  expect(linked).toMatchObject({
    types_field: FIXTURE_BINARY_BASE + 0x830n,
    types_count: 4,
  });
  expect(linked.return_types).toEqual(
    Array.from({ length: 5 }, () => ({
      type: 0,
      name: FIXTURE_RETURN_TYPE_NAME,
    })),
  );
});

it("requires an explicit slice of a universal Mach-O and reads only that slice", () => {
  const thin = createIl2cppBinaryFixture();
  const universal = createUniversalFixture([
    { cpu: 0x01000007, bytes: Buffer.alloc(0x100) },
    { cpu: 0x0100000c, bytes: thin },
  ]);
  expect(failure(universal)).toEqual({
    reason: "slice-selection-required",
    kind: "unsupported",
  });
  expect(link(universal, "arm64").method_addresses).toEqual(
    FIXTURE_METHOD_ADDRESSES,
  );
  expect(failure(universal, "ppc64").reason).toBe("slice-not-found");
  expect(failure(thin, "arm64").reason).toBe("slice-not-found");
});

it.each<
  [string, Il2cppBinaryFixtureOptions, string, "unsupported" | "malformed"]
>([
  [
    "a method count mismatch",
    { firstModuleCount: 4 },
    "code-gen-modules-not-found",
    "malformed",
  ],
  [
    "two matching module records",
    { duplicateModule: true },
    "ambiguous-code-gen-module",
    "malformed",
  ],
  [
    "no CodeRegistration module table",
    { codeRegistration: false },
    "code-registration-not-found",
    "malformed",
  ],
  [
    "no MetadataRegistration type table",
    { metadataRegistration: false },
    "metadata-registration-not-found",
    "malformed",
  ],
  [
    "chained fixups",
    { chainedFixups: true },
    "unsupported-pointer-encoding",
    "unsupported",
  ],
])("rejects %s without partial addresses", (_, options, reason, kind) => {
  expect(failure(createIl2cppBinaryFixture(options))).toEqual({ reason, kind });
});

it("links an ELF shared object after applying its RELATIVE relocations", () => {
  const elf = createElfFixture(createIl2cppBinaryFixture());
  const fromMacho = link(createIl2cppBinaryFixture());
  expect(link(elf)).toEqual({ ...fromMacho, format: "elf" });
});

it.each([
  [{ dynamic: false }, "unsupported-container"],
  [{ machine: 243 }, "unsupported-container"],
  [{ androidPacked: true }, "unsupported-pointer-encoding"],
] as const)(
  "refuses ELF relocations it cannot apply (%o)",
  (options, reason) => {
    expect(
      failure(createElfFixture(createIl2cppBinaryFixture(), options)),
    ).toEqual({
      reason,
      kind: "unsupported",
    });
  },
);
