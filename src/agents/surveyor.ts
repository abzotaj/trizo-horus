import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { z } from "zod"
import type { ProviderId } from "../providers/index.js"
import type { RepoSnapshot } from "../repo-intake/index.js"
import { RepoManifest } from "../types/journey.js"
import { recordUsage, type StepUsage } from "../usage.js"

// Naive v1 cap on how much source text goes into a single prompt. Real
// chunking (splitting a large repo across multiple surveyor calls and
// merging the results) is a roadmap item -- see README.
const MAX_PROMPT_CHARS = 300_000

const SYSTEM_PROMPT = `You are a code archaeologist. You are given the full text of every source file in a
single repository -- application code as well as infrastructure-as-code (Terraform HCL) and
provisioning/deployment scripts (bash, PowerShell). Identify every distinct "step" a user
journey could pass through in this repo, and every outbound call this repo makes that likely
continues in ANOTHER repo.

A step is one of:
- page: a client-rendered page/route/screen
- api: an externally-reachable API endpoint (HTTP/gRPC controller, cron entry point)
- service: an internal handler/use-case/saga invoked by an api step or a queue consumer
- db: a read or write against a datastore (Postgres, MySQL, Redis, OpenSearch, Snowflake, ...)
- queue: a topic/queue this repo publishes to or consumes from
- external: a call to a third-party vendor API (Stripe, SendGrid, Zendesk, ...)
- infra: a piece of infrastructure-as-code (a Terraform resource/module) or a provisioning
  script (bash/PowerShell) that provisions or operates a component another step depends on --
  e.g. the Terraform resource that creates the S3 bucket a step uploads to, the queue/topic a
  step publishes to, the database a step reads from, or the script that deploys a service.
  Only report infra steps that back a component another step in this scan actually touches;
  don't enumerate unrelated infrastructure.

For each step, cite the exact file and line range you found it in, and rate your confidence
(low/medium/high) based on how directly the code supports the inference.

Separately, list "unresolvedCalls": outbound calls (HTTP requests to another service, event
publishes, gRPC client calls) that this repo makes but does NOT itself handle -- these are
candidates to be matched against another repo's steps later. Do not guess which repo receives
them; just describe the call (target endpoint/topic/method string) as precisely as the code
allows.

Only report what the code actually supports. Do not invent steps for typical patterns you'd
expect but didn't see.`

export async function surveyRepo(
  model: BaseChatModel,
  providerId: ProviderId,
  modelId: string,
  snapshot: RepoSnapshot,
  timeoutMs: number,
): Promise<{ manifest: RepoManifest; usage: StepUsage }> {
  const fileList = snapshot.files.map((f) => f.path).join("\n")
  let body = snapshot.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n")
  if (body.length > MAX_PROMPT_CHARS) {
    body = body.slice(0, MAX_PROMPT_CHARS) + "\n\n[... truncated, repo exceeds single-pass prompt budget ...]"
  }

  const structuredModel = model.withStructuredOutput(
    z.object({
      steps: RepoManifest.shape.steps,
      unresolvedCalls: RepoManifest.shape.unresolvedCalls,
    }),
    { includeRaw: true },
  )

  const { raw, parsed } = await structuredModel.invoke(
    [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(`Repository: ${snapshot.name}\n\nFile list:\n${fileList}\n\nFile contents:\n${body}`),
    ],
    { signal: AbortSignal.timeout(timeoutMs) },
  )

  const manifest = RepoManifest.parse({ repo: snapshot.name, ...parsed })
  const usage = recordUsage(`survey:${snapshot.name}`, providerId, modelId, raw)
  return { manifest, usage }
}
