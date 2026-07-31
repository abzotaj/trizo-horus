import type { LanguageModel } from "ai"
import { generateObject } from "ai"
import { z } from "zod"
import { Journey, type RepoManifest } from "../types/journey.js"

const SYSTEM_PROMPT = `You are given the manifests produced by scanning several repositories independently. Each
manifest lists the steps found in one repo (pages, api endpoints, services, db reads/writes,
queues, external calls) and that repo's unresolvedCalls -- outbound calls whose destination
lives in a repo other than the one that made them.

Your job:
1. Match each unresolvedCall to a step in ANOTHER repo's manifest (by endpoint/topic/method
   name, or clear semantic equivalence). A match becomes an Edge between the calling step and
   the matched step. If nothing matches with reasonable confidence, drop the call rather than
   inventing a destination.
2. Group steps (from any number of repos) that are connected by edges into "journeys" --
   contiguous flows describing something one actor of the system does end-to-end (e.g.
   "Registration", "Checkout & payment"). Pick a stable id (kebab-case), name, domain,
   description, and an "entry" step id (the step that starts the journey) for each.
3. A step can belong to at most one journey. A step with no edges to/from anything else in
   the scan still forms its own single-step journey rather than being dropped.
4. Preserve every field already present on each step (confidence, sourceRef, etc.) verbatim --
   only add the edges you infer.`

export async function correlateJourneys(model: LanguageModel, manifests: RepoManifest[]): Promise<Journey[]> {
  const { object } = await generateObject({
    model,
    system: SYSTEM_PROMPT,
    prompt: `Repo manifests:\n${JSON.stringify(manifests, null, 2)}`,
    schema: z.object({ journeys: z.array(Journey) }),
  })

  return object.journeys
}
