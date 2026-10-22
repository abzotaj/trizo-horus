import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoFile } from "../repo-intake/index.js";
import { RepoManifest } from "../types/journey.js";

/**
 * A per-repo cache of the surveyor's output, keyed by a content hash of that
 * repo's files plus the provider/model used. Lets a re-scan skip the LLM
 * survey call entirely for repos that haven't changed since the last run
 * (and were surveyed with the same provider/model) -- the resolve/correlate
 * phases still run fresh every scan over the full current manifest set,
 * since another repo's edits can change what resolves against an unchanged
 * repo's steps.
 */
export const DEFAULT_CACHE_DIR = ".trizo-horus-cache";

export type RepoCacheEntry = {
  hash: string;
  providerId: string;
  modelId: string;
  manifest: RepoManifest;
  cachedAt: string;
};

/** Content hash of a repo's files -- order-independent, detects any change to path or content. */
export function hashRepoFiles(files: RepoFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function cacheFilePath(cacheDir: string, repoName: string): string {
  return join(cacheDir, `${repoName}.json`);
}

/** Returns the cached manifest only if it matches both the file hash and the provider/model -- null on any mismatch or miss. */
export async function readRepoCache(
  cacheDir: string,
  repoName: string,
  hash: string,
  providerId: string,
  modelId: string,
): Promise<RepoManifest | null> {
  const file = cacheFilePath(cacheDir, repoName);
  if (!existsSync(file)) return null;

  try {
    const entry = JSON.parse(await readFile(file, "utf8")) as RepoCacheEntry;
    if (entry.hash !== hash || entry.providerId !== providerId || entry.modelId !== modelId)
      return null;
    return RepoManifest.parse(entry.manifest);
  } catch {
    // Corrupt or incompatible cache entry -- treat as a miss rather than failing the scan.
    return null;
  }
}

export async function writeRepoCache(
  cacheDir: string,
  repoName: string,
  hash: string,
  providerId: string,
  modelId: string,
  manifest: RepoManifest,
): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const entry: RepoCacheEntry = {
    hash,
    providerId,
    modelId,
    manifest,
    cachedAt: new Date().toISOString(),
  };
  await writeFile(cacheFilePath(cacheDir, repoName), JSON.stringify(entry, null, 2), "utf8");
}
