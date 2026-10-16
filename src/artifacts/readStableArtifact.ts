import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import type { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import {
  withArtifactFileHandle,
  assertArtifactReadActive,
} from "./ArtifactFileOperation.js";

/** Exact physical read completed before descriptor finalization. */
export interface StableArtifactSnapshot {
  readonly bytes: Buffer;
  readonly sha256: string;
}

/** Filesystem boundary for stable reads, including deterministic replacement probes. */
export interface StableArtifactFileSystem {
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number): Promise<FileHandle>;
}

/** Positioned reads over the admitted descriptor of one stable file. */
export interface StableArtifactRangeSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

const FILE_SYSTEM: StableArtifactFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  open,
};

const afterValidation = async <T>(
  path: string,
  stage: string,
  read: () => Promise<T>,
): Promise<T> => {
  try {
    return await read();
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(cause.code))
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Artifact changed ${stage}: ${path}`,
        { cause },
      );
    throw cause;
  }
};

/** Stream every byte of the admitted descriptor through one consumer. */
const streamFile = async (
  file: FileHandle,
  path: string,
  signal: AbortSignal | undefined,
  consume: (bytes: Buffer, count: number) => void,
): Promise<number> => {
  let count = 0;
  for await (const chunk of file.createReadStream({
    autoClose: false,
    start: 0,
    highWaterMark: 65536,
  })) {
    assertArtifactReadActive(signal);
    const value: unknown = chunk;
    if (!Buffer.isBuffer(value))
      throw new ArtifactReaderFailure(
        "format",
        `Artifact stream did not return bytes: ${path}`,
      );
    count += value.length;
    consume(value, count);
  }
  return count;
};

/**
 * Admit one regular file without following a symlink, read it through one
 * descriptor, and reject replacement or in-place changes. `read` returns its
 * value and how many bytes it streamed; the count must equal the file size.
 */
const withStableArtifact = async <T>(
  path: string,
  signal: AbortSignal | undefined,
  fileSystem: StableArtifactFileSystem,
  resourceScope: ArtifactResourceScope | undefined,
  admit: (before: BigIntStats) => void,
  read: (
    file: FileHandle,
    initial: BigIntStats,
  ) => Promise<{ readonly value: T; readonly count: number }>,
): Promise<T> => {
  assertArtifactReadActive(signal);
  const before = await fileSystem.lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new ArtifactReaderFailure(
      "path",
      `Expected a regular file without a symlink: ${path}`,
    );
  admit(before);
  const file = await afterValidation(path, "before open", () =>
    fileSystem.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ),
  );
  return withArtifactFileHandle(
    path,
    file,
    resourceScope,
    signal,
    async (file) => {
      const initial = await file.stat({ bigint: true });
      if (
        !initial.isFile() ||
        initial.dev !== before.dev ||
        initial.ino !== before.ino
      )
        throw new ArtifactReaderFailure(
          "integrity",
          `Artifact changed before open: ${path}`,
        );
      const { value, count } = await read(file, initial);
      const after = await file.stat({ bigint: true });
      const current = await afterValidation(path, "during read", () =>
        fileSystem.lstat(path),
      );
      if (
        [after, current].some(
          (stat) =>
            !stat.isFile() ||
            stat.dev !== initial.dev ||
            stat.ino !== initial.ino ||
            stat.size !== initial.size ||
            stat.mtimeNs !== initial.mtimeNs ||
            stat.ctimeNs !== initial.ctimeNs,
        ) ||
        BigInt(count) !== initial.size
      )
        throw new ArtifactReaderFailure(
          "integrity",
          `Artifact changed during read: ${path}`,
        );
      assertArtifactReadActive(signal);
      return value;
    },
  );
};

/** Read one bounded regular file and reject replacement or in-place changes. */
export const readStableArtifact = async (
  path: string,
  maximumBytes: number,
  signal?: AbortSignal,
  fileSystem: StableArtifactFileSystem = FILE_SYSTEM,
  resourceScope?: ArtifactResourceScope,
): Promise<StableArtifactSnapshot> =>
  withStableArtifact(
    path,
    signal,
    fileSystem,
    resourceScope,
    (before) => {
      if (before.size > BigInt(maximumBytes))
        throw new ArtifactReaderFailure(
          "limit",
          `Selected artifact exceeds ${String(maximumBytes)} bytes: ${path}`,
          { boundary: "file-size" },
        );
    },
    async (file) => {
      const chunks: Buffer[] = [];
      const count = await streamFile(file, path, signal, (bytes, total) => {
        if (total > maximumBytes)
          throw new ArtifactReaderFailure(
            "limit",
            `Selected artifact grew beyond its byte limit: ${path}`,
            { boundary: "file-size" },
          );
        chunks.push(bytes);
      });
      const bytes = Buffer.concat(chunks, count);
      return {
        value: {
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        count,
      };
    },
  );

/**
 * Decode selected ranges of one regular file without loading it, then hash the
 * whole file through the same descriptor. The same admission and change checks
 * as readStableArtifact apply, so the SHA-256 identifies exactly the bytes the
 * ranges came from.
 */
export const readStableArtifactRanges = async <T>(
  path: string,
  decode: (source: StableArtifactRangeSource) => Promise<T>,
  signal?: AbortSignal,
  resourceScope?: ArtifactResourceScope,
  fileSystem: StableArtifactFileSystem = FILE_SYSTEM,
): Promise<{
  readonly result: T;
  readonly sha256: string;
  readonly bytes: number;
}> =>
  withStableArtifact(
    path,
    signal,
    fileSystem,
    resourceScope,
    (before) => {
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER))
        throw new ArtifactReaderFailure(
          "limit",
          `Selected artifact is too large to address: ${path}`,
        );
    },
    async (file, initial) => {
      const size = Number(initial.size);
      const result = await decode({
        size,
        read: async (offset, length) => {
          assertArtifactReadActive(signal);
          if (offset < 0 || length < 0 || offset + length > size)
            throw new RangeError(
              `Read of ${length} bytes at ${offset} is outside ${size} bytes`,
            );
          const buffer = Buffer.alloc(length);
          let done = 0;
          while (done < length) {
            const { bytesRead } = await file.read(
              buffer,
              done,
              length - done,
              offset + done,
            );
            if (bytesRead === 0)
              throw new ArtifactReaderFailure(
                "integrity",
                `Artifact shrank during read: ${path}`,
              );
            done += bytesRead;
          }
          return buffer;
        },
      });
      assertArtifactReadActive(signal);
      const hash = createHash("sha256");
      const count = await streamFile(file, path, signal, (bytes) =>
        hash.update(bytes),
      );
      return {
        value: { result, sha256: hash.digest("hex"), bytes: size },
        count,
      };
    },
  );
