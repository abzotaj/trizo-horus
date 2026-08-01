import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Journey, JourneySummary, ScanIndex, ScanMeta } from "../types/journey.js"
import type { StepUsage } from "../usage.js"
import { journeyRepos } from "./journey-utils.js"

/**
 * Splits scan output across files instead of one large JSON blob:
 *   output/index.json          -- meta + lightweight JourneySummary[]
 *   output/journeys/<id>.json  -- one full Journey per file
 *
 * A single combined file grows unbounded with every repo/journey added and
 * risks crossing the ~1MB range for large scans. Per-journey files keep each
 * read small, let user-journey-finder lazy-load a journey on selection
 * instead of parsing everything up front, and let a re-scan touch only the
 * journeys that changed (smaller diffs, easier to review in git).
 */
export async function writeScanOutput(outDir: string, meta: ScanMeta, journeys: Journey[]): Promise<void> {
  const journeysDir = join(outDir, "journeys")
  await mkdir(journeysDir, { recursive: true })

  const summaries: JourneySummary[] = []

  for (const journey of journeys) {
    const file = `journeys/${journey.id}.json`
    await writeFile(join(outDir, file), JSON.stringify(journey, null, 2), "utf8")
    summaries.push({
      id: journey.id,
      name: journey.name,
      domain: journey.domain,
      description: journey.description,
      tags: journey.tags,
      repos: journeyRepos(journey),
      stepCount: journey.steps.length,
      edgeCount: journey.edges.length,
      file,
    })
  }

  const index: ScanIndex = { meta, journeys: summaries }
  await writeFile(join(outDir, "index.json"), JSON.stringify(index, null, 2), "utf8")
}

/** Per-step (per-repo survey + correlate) token usage and estimated cost for one scan run. */
export async function writeUsageReport(outDir: string, usage: StepUsage[]): Promise<void> {
  const totalTokens = usage.reduce((sum, u) => sum + u.totalTokens, 0)
  const knownCosts = usage.filter((u) => u.costUsd !== null)
  const totalCostUsd = knownCosts.length ? knownCosts.reduce((sum, u) => sum + (u.costUsd ?? 0), 0) : null

  await mkdir(outDir, { recursive: true })
  await writeFile(
    join(outDir, "usage.json"),
    JSON.stringify({ steps: usage, totalTokens, totalCostUsd }, null, 2),
    "utf8",
  )
}
