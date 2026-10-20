import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { z } from "zod"
import type { ProviderId } from "../providers/index.js"
import { Edge, Journey, LooseJourney, type RepoManifest } from "../types/journey.js"
import { recordUsage, type StepUsage } from "../usage.js"
import { invokeStructured } from "./structured.js"

const SYSTEM_PROMPT = `You are given the final manifests from every repo scanned, plus the edges the repos' own
agents already confirmed during a multi-round cross-repo resolution exchange (each repo agent
matching its own outbound calls to the steps elsewhere that receive them).

Your job:
1. Look for any edges the resolution exchange missed -- an unresolvedCall still left on a
   manifest that you can now confidently match to a step in ANOTHER repo's manifest, or any other
   clear connection between two steps the exchange didn't already capture. Don't invent a
   destination that isn't actually present in the given steps.
2. Group steps (from any number of repos) that are connected -- via the confirmed edges plus
   whatever you add in step 1 -- into "journeys": contiguous flows describing something one actor
   of the system does end-to-end (e.g. "Registration", "Checkout & payment"). Pick a stable id
   (kebab-case), name, domain, description, and an "entry" step id (the step that starts the
   journey) for each.
3. A step can belong to at most one journey. A step with no edges to/from anything else in the
   scan still forms its own single-step journey rather than being dropped.
4. Preserve every field already present on each step and edge (confidence, sourceRef, etc.)
   verbatim -- only add the edges you infer in step 1.`

export async function correlateJourneys(
  model: BaseChatModel,
  providerId: ProviderId,
  modelId: string,
  manifests: RepoManifest[],
  confirmedEdges: Edge[],
  timeoutMs: number,
): Promise<{ journeys: Journey[]; usage: StepUsage }> {
  const { output, raws } = await invokeStructured({
    model,
    label: "correlate",
    timeoutMs,
    schema: z.object({ journeys: z.array(Journey) }),
    parser: z.object({ journeys: z.array(LooseJourney) }),
    messages: [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(
        `Repo manifests:\n${JSON.stringify(manifests, null, 2)}\n\n` +
          `Edges already confirmed by the repos' own agents:\n${JSON.stringify(confirmedEdges, null, 2)}`,
      ),
    ],
  })

  const usage = recordUsage("correlate", providerId, modelId, raws)
  return { journeys: output.journeys, usage }
}
