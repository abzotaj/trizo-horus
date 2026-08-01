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

program
  .command("scan")
  .description("Scan repos and write journeys to --out. Pass --repos, --dir, or both.")
  .option("--repos <paths...>", "local filesystem paths to individual repos to scan")
  .option("--dir <path>", "a folder holding multiple repos as immediate subdirectories -- every one is scanned")
  .option("--skipRepos <names...>", "repo names to exclude from the scan (matched against each repo's directory name)")
  .option("--provider <provider>", "anthropic | openai | google", "anthropic")
  .option("--model <model>", "override the provider's default model")
  .option("--out <dir>", "output directory", "./output")
  .action(
    async (opts: {
      repos?: string[]
      dir?: string
      skipRepos?: string[]
      provider: ProviderId
      model?: string
      out: string
    }) => {
      const inputs = resolveRepoInputs({ repos: opts.repos, dir: opts.dir, skipRepos: opts.skipRepos })
      const { model, providerId, modelId } = await resolveModel(opts.provider, opts.model)

      console.log(`Surveying ${inputs.length} repo(s) in parallel with ${providerId}:${modelId}...`)
      const scan = buildScanGraph()
      const result = await scan.invoke({ repoInputs: inputs, model, providerId, modelId })

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
    },
  )

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
