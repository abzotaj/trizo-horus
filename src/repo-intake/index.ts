import { existsSync, readdirSync, statSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

export type RepoInput = {
  /** Short name used as the `repo` field on steps, e.g. "acme-api-gateway". */
  name: string
  /** Absolute path to the repo on disk. */
  path: string
}

export type RepoFile = {
  path: string
  content: string
}

export type RepoSkipCounts = {
  asset: number
  sensitive: number
  tooLarge: number
  unreadable: number
}

export type RepoSnapshot = RepoInput & {
  files: RepoFile[]
  skipped: RepoSkipCounts
  /** True if MAX_FILES_PER_REPO was hit -- files.length no longer reflects the repo's true size. */
  truncated: boolean
}

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "vendor",
  ".venv",
  "__pycache__",
  ".terraform",
  ".terragrunt-cache",
])

// Terraform state/plan/vars files routinely hold plaintext secrets and resource
// attribute values (DB passwords, tokens, ...) pulled from providers -- unlike
// the *.tf definitions themselves, they add no journey-mapping signal worth the
// exposure of sending them to an external LLM API, so they're never read.
const SENSITIVE_FILE_PATTERN = /\.(tfstate(\.backup)?|tfvars(\.json)?|tfplan)$/i

// Binary media/asset files carry no journey-mapping signal, but reading them as
// "utf8" never throws (Node just decodes the bytes, garbled) -- without this
// filter they'd silently burn prompt budget as noise instead of being skipped
// like a genuinely unreadable file.
const DOCUMENT_EXTENSIONS = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf"]
const VIDEO_EXTENSIONS = ["mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "m4v", "mpg", "mpeg"]
const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma"]
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "bmp", "tiff", "tif", "webp", "ico", "heic", "heif"]
const VECTOR_EXTENSIONS = ["svg", "ai", "eps", "sketch", "fig", "xd", "indd"]

const SKIPPED_ASSET_EXTENSIONS = new Set(
  [...DOCUMENT_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS, ...VECTOR_EXTENSIONS].map(
    (ext) => `.${ext}`,
  ),
)

function isSkippedAssetFile(name: string): boolean {
  const dot = name.lastIndexOf(".")
  return dot !== -1 && SKIPPED_ASSET_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

const MAX_FILE_BYTES = 200_000
const MAX_FILES_PER_REPO = 4000

export type RepoSelection = {
  /** Explicit repo paths, scanned individually. */
  repos?: string[]
  /** A parent folder holding multiple repos as immediate subdirectories -- every one is scanned. */
  dir?: string
  /** Repo names (matched against the resolved RepoInput.name) to exclude from the scan. */
  skipRepos?: string[]
}

/**
 * Resolves --repos / --dir / --skipRepos to the concrete set of repos to scan.
 * GitHub sources (owner/repo) are not implemented yet -- see README "Roadmap".
 */
export function resolveRepoInputs(selection: RepoSelection): RepoInput[] {
  if (!selection.repos?.length && !selection.dir) {
    throw new Error("Provide --repos <paths...>, --dir <path>, or both.")
  }

  const byPath = new Map<string, RepoInput>()

  for (const input of selection.dir ? discoverReposInDir(selection.dir) : []) {
    byPath.set(input.path, input)
  }
  for (const input of resolveExplicitRepos(selection.repos ?? [])) {
    byPath.set(input.path, input)
  }

  const skip = new Set(selection.skipRepos ?? [])
  return Array.from(byPath.values()).filter((input) => !skip.has(input.name))
}

function resolveExplicitRepos(inputs: string[]): RepoInput[] {
  return inputs.map((raw) => {
    if (!existsSync(raw)) {
      throw new Error(
        `Repo path not found: "${raw}". Only local filesystem paths are supported right now -- ` +
          `clone the repo locally first. GitHub owner/repo sources are on the roadmap, not yet implemented.`,
      )
    }
    const stat = statSync(raw)
    if (!stat.isDirectory()) {
      throw new Error(`Repo path is not a directory: "${raw}"`)
    }
    const path = resolve(raw)
    const name = path.split("/").pop() ?? path
    return { name, path }
  })
}

/** Treats every immediate subdirectory of `dir` as one repo. */
function discoverReposInDir(dir: string): RepoInput[] {
  if (!existsSync(dir)) {
    throw new Error(`--dir not found: "${dir}"`)
  }
  if (!statSync(dir).isDirectory()) {
    throw new Error(`--dir is not a directory: "${dir}"`)
  }

  const root = resolve(dir)
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: join(root, entry.name) }))
}

/**
 * Walks a repo directory, returning readable text files up to a size cap.
 * No extension filtering on code/config -- app code, Terraform
 * (.tf/.tfvars.example), and shell/PowerShell (.sh/.ps1/.psm1) scripts are
 * all included. Excluded: the sensitive Terraform artifacts above, and
 * binary document/video/audio/image/vector assets (see
 * SKIPPED_ASSET_EXTENSIONS).
 */
export async function loadRepoSnapshot(input: RepoInput): Promise<RepoSnapshot> {
  const files: RepoFile[] = []
  const skipped: RepoSkipCounts = { asset: 0, sensitive: 0, tooLarge: 0, unreadable: 0 }
  let truncated = false

  async function walk(dir: string) {
    if (files.length >= MAX_FILES_PER_REPO) {
      truncated = true
      return
    }
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= MAX_FILES_PER_REPO) {
        truncated = true
        return
      }
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (SENSITIVE_FILE_PATTERN.test(entry.name)) {
        skipped.sensitive++
        continue
      }
      if (isSkippedAssetFile(entry.name)) {
        skipped.asset++
        continue
      }
      const stat = statSync(full)
      if (stat.size > MAX_FILE_BYTES) {
        skipped.tooLarge++
        continue
      }
      try {
        const content = await readFile(full, "utf8")
        files.push({ path: relative(input.path, full), content })
      } catch {
        skipped.unreadable++
      }
    }
  }

  await walk(input.path)
  return { ...input, files, skipped, truncated }
}
