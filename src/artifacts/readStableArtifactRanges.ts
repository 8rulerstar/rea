import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import type { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";

/** Positioned reads over the admitted descriptor of one stable file. */
export interface StableArtifactRangeSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

const unchanged = (initial: BigIntStats, stat: BigIntStats) =>
  stat.isFile() &&
  stat.dev === initial.dev &&
  stat.ino === initial.ino &&
  stat.size === initial.size &&
  stat.mtimeNs === initial.mtimeNs &&
  stat.ctimeNs === initial.ctimeNs;

const cancelled = (signal: AbortSignal | undefined) => {
  if (signal?.aborted)
    throw new ArtifactReaderFailure("cancelled", "Artifact read cancelled", {
      cause: signal.reason,
    });
};

const changed = async <T>(
  path: string,
  stage: string,
  read: () => Promise<T>,
) => {
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
        {
          cause,
        },
      );
    throw cause;
  }
};

/**
 * Decode selected ranges of one regular file without loading it, then hash
 * the whole file through the same descriptor. Like readStableArtifact it
 * rejects symlinks and any replacement or in-place change, so the returned
 * SHA-256 identifies exactly the bytes the ranges came from.
 */
export const readStableArtifactRanges = async <T>(
  path: string,
  decode: (source: StableArtifactRangeSource) => Promise<T>,
  signal?: AbortSignal,
  resourceScope?: ArtifactResourceScope,
): Promise<{
  readonly result: T;
  readonly sha256: string;
  readonly bytes: number;
}> => {
  cancelled(signal);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    throw new ArtifactReaderFailure(
      "path",
      `Expected a regular file without a symlink: ${path}`,
    );
  const file: FileHandle = await changed(path, "before open", () =>
    open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ),
  );
  const owner =
    resourceScope === undefined ? undefined : new OwnedFileHandle(file);
  let failure: unknown;
  try {
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
    if (initial.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ArtifactReaderFailure(
        "limit",
        `Selected artifact is too large to address: ${path}`,
      );
    const size = Number(initial.size);
    const source: StableArtifactRangeSource = {
      size,
      read: async (offset, length) => {
        cancelled(signal);
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
    };
    const result = await decode(source);
    cancelled(signal);
    const hash = createHash("sha256");
    let count = 0;
    for await (const chunk of file.createReadStream({
      autoClose: false,
      start: 0,
      highWaterMark: 1024 * 1024,
    })) {
      cancelled(signal);
      const bytes: unknown = chunk;
      if (!Buffer.isBuffer(bytes))
        throw new ArtifactReaderFailure(
          "format",
          `Artifact stream did not return bytes: ${path}`,
        );
      count += bytes.length;
      hash.update(bytes);
    }
    const after = await file.stat({ bigint: true });
    const current = await changed(path, "during read", () =>
      lstat(path, { bigint: true }),
    );
    if (
      !unchanged(initial, after) ||
      !unchanged(initial, current) ||
      count !== size
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Artifact changed during read: ${path}`,
      );
    cancelled(signal);
    return { result, sha256: hash.digest("hex"), bytes: size };
  } catch (cause: unknown) {
    failure = cause;
    throw cause;
  } finally {
    if (owner === undefined || resourceScope === undefined) await file.close();
    else {
      const cleanup = await resourceScope.release({
        kind: "file-handle",
        resource: path,
        handle: owner,
      });
      if (cleanup.kind === "failed")
        throw ArtifactReaderFailure.withCleanup(
          failure ?? cleanup.cause,
          ArtifactReaderFailure.cleanupObservation(cleanup.cause, path),
        );
    }
  }
};
