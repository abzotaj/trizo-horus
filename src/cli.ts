#!/usr/bin/env node
import "dotenv/config"
import { Command } from "commander"
import { correlateJourneys } from "./agents/correlator.js"
import { surveyRepo } from "./agents/surveyor.js"
import { resolveModel, type ProviderId } from "./providers/index.js"
import { loadRepoSnapshot, resolveRepoInputs } from "./repo-intake/index.js"
import { writeScanOutput } from "./output/writer.js"
import { ScanMeta } from "./types/journey.js"

const SCANNER_VERSION = "0.1.0"

const program = new Command()

program
  .name("trizo-horus")
  .description("Scan repositories and generate cross-repo user-journey data for user-journey-finder")

program
  .command("scan")
  .description("Scan a set of local repos and write journeys to --out")
  .requiredOption("--repos <paths...>", "local filesystem paths to the repos to scan")
  .option("--provider <provider>", "anthropic | openai | google", "anthropic")
  .option("--model <model>", "override the provider's default model")
  .option("--out <dir>", "output directory", "./output")
  .action(async (opts: { repos: string[]; provider: ProviderId; model?: string; out: string }) => {
    const inputs = resolveRepoInputs(opts.repos)
    const model = await resolveModel(opts.provider, opts.model)

    console.log(`Surveying ${inputs.length} repo(s) in parallel...`)
    const manifests = await Promise.all(
      inputs.map(async (input) => {
        const snapshot = await loadRepoSnapshot(input)
        console.log(`  ${input.name}: ${snapshot.files.length} file(s) loaded`)
        return surveyRepo(model, snapshot)
      }),
    )

    console.log("Correlating manifests into journeys...")
    const journeys = await correlateJourneys(model, manifests)

    const meta = ScanMeta.parse({
      generatedAt: new Date().toISOString(),
      scannerVersion: SCANNER_VERSION,
      provider: opts.model ? `${opts.provider}:${opts.model}` : opts.provider,
      reposScanned: inputs.map((i) => i.name),
    })

    await writeScanOutput(opts.out, meta, journeys)
    console.log(`Wrote ${journeys.length} journey(s) to ${opts.out}/`)
  })

program.parseAsync(process.argv)
