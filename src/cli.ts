#!/usr/bin/env node
import "dotenv/config"
import { Command } from "commander"
import { buildScanGraph } from "./graph.js"
import { resolveModel, type ProviderId } from "./providers/index.js"
import { resolveRepoInputs } from "./repo-intake/index.js"
import { writeScanOutput, writeUsageReport } from "./output/writer.js"
import { ScanMeta } from "./types/journey.js"
import type { StepUsage } from "./usage.js"

const SCANNER_VERSION = "0.1.0"

const program = new Command()

program
  .name("trizo-horus")
  .description("Scan repositories and generate cross-repo user-journey data for user-journey-finder")

/** Repo-selection + provider flags shared by `scan` and `studio-input`. */
function addScanOptions(cmd: Command): Command {
  return cmd
    .option("--repos <paths...>", "local filesystem paths to individual repos to scan")
    .option("--dir <path>", "a folder holding multiple repos as immediate subdirectories -- every one is scanned")
    .option("--skipRepos <names...>", "repo names to exclude from the scan (matched against each repo's directory name)")
    .option("--provider <provider>", "anthropic | openai | google | openai-compatible", "anthropic")
    .option("--model <model>", "override the provider's default model (required for openai-compatible)")
    .option(
      "--base-url <url>",
      "OpenAI-compatible endpoint for --provider openai-compatible, e.g. http://localhost:11434/v1 (Ollama), " +
        "https://api.groq.com/openai/v1 (Groq)",
    )
    .option(
      "--timeout <minutes>",
      "per-call timeout in minutes -- raise this for local/networked models (Ollama, LM Studio, ...), " +
        "which can be far slower than a hosted API and may need much longer than the 10 min SDK default",
      "20",
    )
}

type ScanOptions = {
  repos?: string[]
  dir?: string
  skipRepos?: string[]
  provider: ProviderId
  model?: string
  baseUrl?: string
  timeout: string
}

addScanOptions(program.command("scan").description("Scan repos and write journeys to --out. Pass --repos, --dir, or both."))
  .option("--api-key <key>", "API key for --provider openai-compatible (most local servers ignore it)")
  .option("--out <dir>", "output directory", "./output")
  .action(async (opts: ScanOptions & { apiKey?: string; out: string }) => {
    const inputs = resolveRepoInputs({ repos: opts.repos, dir: opts.dir, skipRepos: opts.skipRepos })
    // Resolved here only to validate the provider/model/base-url combo and apply
    // defaults up front -- the graph re-resolves the actual client itself from
    // these plain strings in each node (see src/graph.ts), so it never needs a
    // live model instance passed through state.
    const { providerId, modelId } = await resolveModel(opts.provider, opts.model, {
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
    })

    // The graph resolves its own model from env vars, not from state (see above) --
    // reflect --api-key there so it isn't silently dropped in the graph's own resolve.
    if (opts.apiKey) process.env.OPENAI_COMPATIBLE_API_KEY = opts.apiKey

    console.log(`Surveying ${inputs.length} repo(s) in parallel with ${providerId}:${modelId}...`)
    const scan = buildScanGraph()
    const result = await scan.invoke({
      repoInputs: inputs,
      providerId,
      modelId,
      baseUrl: opts.baseUrl,
      timeoutMs: parseTimeoutMinutes(opts.timeout),
    })

    const meta = ScanMeta.parse({
      generatedAt: new Date().toISOString(),
      scannerVersion: SCANNER_VERSION,
      provider: `${providerId}:${modelId}`,
      reposScanned: inputs.map((i) => i.name),
    })

    await writeScanOutput(opts.out, meta, result.journeys)
    await writeUsageReport(opts.out, result.usage)
    printUsageReport(result.usage)
    console.log(`Wrote ${result.journeys.length} journey(s) to ${opts.out}/`)
  })

addScanOptions(
  program
    .command("studio-input")
    .description(
      "Print the JSON to paste into LangGraph Studio's Input box (npm run studio). Studio invokes the " +
        "compiled graph directly over HTTP, so it can't run the --dir/--skipRepos repo-discovery step itself -- " +
        "this resolves it the same way `scan` would and prints the result instead of running the graph.",
    ),
).action(async (opts: ScanOptions) => {
  const inputs = resolveRepoInputs({ repos: opts.repos, dir: opts.dir, skipRepos: opts.skipRepos })
  const { providerId, modelId } = await resolveModel(opts.provider, opts.model, { baseUrl: opts.baseUrl })
  console.log(
    JSON.stringify(
      {
        repoInputs: inputs,
        providerId,
        modelId,
        baseUrl: opts.baseUrl,
        timeoutMs: parseTimeoutMinutes(opts.timeout),
      },
      null,
      2,
    ),
  )
})

function parseTimeoutMinutes(minutes: string): number {
  const parsed = Number(minutes)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--timeout must be a positive number of minutes, got "${minutes}"`)
  }
  return parsed * 60_000
}

function printUsageReport(usage: StepUsage[]): void {
  console.log("\nToken usage by step:")
  console.table(
    usage.map((u) => ({
      step: u.step,
      model: u.model,
      "input tokens": u.inputTokens,
      "output tokens": u.outputTokens,
      "cost (usd)": u.costUsd !== null ? `$${u.costUsd.toFixed(4)}` : "unknown",
    })),
  )

  const totalTokens = usage.reduce((sum, u) => sum + u.totalTokens, 0)
  const knownCosts = usage.filter((u) => u.costUsd !== null)
  const totalCostUsd = knownCosts.length ? knownCosts.reduce((sum, u) => sum + (u.costUsd ?? 0), 0) : null
  console.log(
    `Total: ${totalTokens.toLocaleString()} tokens, ${
      totalCostUsd !== null ? `$${totalCostUsd.toFixed(4)}` : "cost unknown for this model"
    }`,
  )
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
