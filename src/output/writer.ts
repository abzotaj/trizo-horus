import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Journey, JourneySummary, ScanIndex, ScanMeta } from "../types/journey.js"
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
