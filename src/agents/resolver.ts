import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { z } from "zod"
import type { ProviderId } from "../providers/index.js"
import { Edge, RepoManifest } from "../types/journey.js"
import { recordUsage, type StepUsage } from "../usage.js"

const SYSTEM_PROMPT = `You are one repo's agent in a multi-round exchange between repo agents that are jointly
mapping cross-repo user journeys. Every repo has already been surveyed independently, so every
repo's steps are already known -- what's still missing is matching each repo's own unresolved
outbound calls to the step elsewhere that actually receives them.

You are given:
1. Your own repo's remaining "unresolvedCalls" -- outbound calls (HTTP requests, event publishes,
   gRPC calls) your repo makes but doesn't itself handle.
2. Every OTHER repo's manifest (their steps only).
3. Edges already confirmed by any repo's agent in earlier rounds of this exchange, for context --
   e.g. to help break a tie between two similarly-named candidate targets.

For each of your unresolvedCalls, decide if you can now confidently match it to a step in one of
the other repos' manifests (by endpoint/topic/method name, or clear semantic equivalence).
- If yes: propose an Edge (from: the call's fromStepId, to: the matched step's id, a label, the
  transport, and your confidence) and drop that call.
- If no: keep it in remainingUnresolvedCalls unchanged -- a later round may add information that
  resolves it, or it may simply never resolve.

Only propose edges you're reasonably confident about; never invent a destination that isn't
actually present in the other repos' steps.`

export async function resolveRepoCalls(
  model: BaseChatModel,
  providerId: ProviderId,
  modelId: string,
  ownManifest: RepoManifest,
  otherManifests: RepoManifest[],
  confirmedEdges: Edge[],
  timeoutMs: number,
): Promise<{ edges: Edge[]; remainingUnresolvedCalls: RepoManifest["unresolvedCalls"]; usage: StepUsage }> {
  const structuredModel = model.withStructuredOutput(
    z.object({
      edges: z.array(Edge),
      remainingUnresolvedCalls: RepoManifest.shape.unresolvedCalls,
    }),
    { includeRaw: true },
  )

  const { raw, parsed } = await structuredModel.invoke(
    [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(
        `Your repo: ${ownManifest.repo}\n\n` +
          `Your unresolvedCalls:\n${JSON.stringify(ownManifest.unresolvedCalls, null, 2)}\n\n` +
          `Other repos' steps:\n${JSON.stringify(
            otherManifests.map((m) => ({ repo: m.repo, steps: m.steps })),
            null,
            2,
          )}\n\n` +
          `Edges already confirmed so far:\n${JSON.stringify(confirmedEdges, null, 2)}`,
      ),
    ],
    { signal: AbortSignal.timeout(timeoutMs) },
  )

  const usage = recordUsage(`resolve:${ownManifest.repo}`, providerId, modelId, raw)
  return { edges: parsed.edges, remainingUnresolvedCalls: parsed.remainingUnresolvedCalls, usage }
}
