import type { LanguageModel } from "ai"
import { generateObject } from "ai"
import { z } from "zod"
import type { RepoSnapshot } from "../repo-intake/index.js"
import { RepoManifest } from "../types/journey.js"

// Naive v1 cap on how much source text goes into a single prompt. Real
// chunking (splitting a large repo across multiple surveyor calls and
// merging the results) is a roadmap item -- see README.
const MAX_PROMPT_CHARS = 300_000

const SYSTEM_PROMPT = `You are a code archaeologist. You are given the full text of every source file in a
single repository. Identify every distinct "step" a user journey could pass through in this
repo, and every outbound call this repo makes that likely continues in ANOTHER repo.

A step is one of:
- page: a client-rendered page/route/screen
- api: an externally-reachable API endpoint (HTTP/gRPC controller, cron entry point)
- service: an internal handler/use-case/saga invoked by an api step or a queue consumer
- db: a read or write against a datastore (Postgres, MySQL, Redis, OpenSearch, Snowflake, ...)
- queue: a topic/queue this repo publishes to or consumes from
- external: a call to a third-party vendor API (Stripe, SendGrid, Zendesk, ...)

For each step, cite the exact file and line range you found it in, and rate your confidence
(low/medium/high) based on how directly the code supports the inference.

Separately, list "unresolvedCalls": outbound calls (HTTP requests to another service, event
publishes, gRPC client calls) that this repo makes but does NOT itself handle -- these are
candidates to be matched against another repo's steps later. Do not guess which repo receives
them; just describe the call (target endpoint/topic/method string) as precisely as the code
allows.

Only report what the code actually supports. Do not invent steps for typical patterns you'd
expect but didn't see.`

export async function surveyRepo(model: LanguageModel, snapshot: RepoSnapshot): Promise<RepoManifest> {
  const fileList = snapshot.files.map((f) => f.path).join("\n")
  let body = snapshot.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n")
  if (body.length > MAX_PROMPT_CHARS) {
    body = body.slice(0, MAX_PROMPT_CHARS) + "\n\n[... truncated, repo exceeds single-pass prompt budget ...]"
  }

  const { object } = await generateObject({
    model,
    system: SYSTEM_PROMPT,
    prompt: `Repository: ${snapshot.name}\n\nFile list:\n${fileList}\n\nFile contents:\n${body}`,
    schema: z.object({
      steps: RepoManifest.shape.steps,
      unresolvedCalls: RepoManifest.shape.unresolvedCalls,
    }),
  })

  return RepoManifest.parse({ repo: snapshot.name, ...object })
}
