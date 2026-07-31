import { existsSync, statSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"

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

export type RepoSnapshot = RepoInput & {
  files: RepoFile[]
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

const MAX_FILE_BYTES = 200_000
const MAX_FILES_PER_REPO = 4000

/**
 * Resolves the --repos CLI input to concrete local paths. GitHub sources
 * (owner/repo) are not implemented yet -- see README "Roadmap".
 */
export function resolveRepoInputs(inputs: string[]): RepoInput[] {
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
    const name = raw.replace(/\/+$/, "").split("/").pop() ?? raw
    return { name, path: raw }
  })
}

/**
 * Walks a repo directory, returning readable text files up to a size cap.
 * No extension filtering -- app code, Terraform (.tf/.tfvars.example), and
 * shell/PowerShell (.sh/.ps1/.psm1) scripts are all included, except the
 * sensitive Terraform artifacts excluded above.
 */
export async function loadRepoSnapshot(input: RepoInput): Promise<RepoSnapshot> {
  const files: RepoFile[] = []

  async function walk(dir: string) {
    if (files.length >= MAX_FILES_PER_REPO) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= MAX_FILES_PER_REPO) return
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (SENSITIVE_FILE_PATTERN.test(entry.name)) continue
      const stat = statSync(full)
      if (stat.size > MAX_FILE_BYTES) continue
      try {
        const content = await readFile(full, "utf8")
        files.push({ path: relative(input.path, full), content })
      } catch {
        // Binary or unreadable file -- skip.
      }
    }
  }

  await walk(input.path)
  return { ...input, files }
}
