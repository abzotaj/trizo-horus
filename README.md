# trizo-horus

A CLI that scans a set of repositories and generates cross-repo **user journey** data --
which page/API/service/database/queue/vendor a request touches, across however many
repos it takes -- for [user-journey-finder](https://github.com/abzotaj/user-journey-finder)
to render.

## Pipeline

```
# individual repos
trizo-horus scan --repos ./repo-a ./repo-b ./repo-c --provider anthropic --out ./output

# every repo under a parent folder, skipping a couple by name
trizo-horus scan --dir ./all-repos --skipRepos legacy-monolith archived-service --out ./output

# both at once (deduped by path)
trizo-horus scan --dir ./all-repos --repos ../elsewhere/extra-repo --out ./output
```

1. **Repo intake** (`src/repo-intake`) -- resolves `--repos` and/or `--dir` to local
   filesystem paths, then walks each one into a `RepoSnapshot` (file list + contents,
   skipping `node_modules`, `.git`, build output, etc.). `--dir <path>` treats every
   immediate subdirectory of `<path>` as one repo -- the common case when all your repos
   live under one parent folder; `--skipRepos <names...>` excludes repos by directory name
   from either source. `--repos` and `--dir` can be combined (deduped by resolved path); at
   least one of the two is required. GitHub sources (`--repos owner/repo`, cloned
   automatically) are on the roadmap, not implemented yet -- clone locally first.

2. **Surveyor agents** (`src/agents/surveyor.ts`) -- one per repo, fanned out **in parallel**
   by the LangGraph graph in `src/graph.ts`. Each surveyor only sees its own repo and
   extracts a `RepoManifest`: every step found in that repo (pages, API endpoints, services,
   db reads/writes, queues, external vendor calls, infra resources/scripts), each with a file
   + line citation and a confidence rating, plus a list of `unresolvedCalls` -- outbound calls
   the repo makes whose destination lives elsewhere.

3. **Correlator agent** (`src/agents/correlator.ts`) -- a single final pass over every
   manifest. It matches each repo's `unresolvedCalls` against another repo's steps to build
   edges, groups connected steps into named journeys, and fills in each journey's
   description/domain/tags.

4. **Output** (`src/output/writer.ts`) -- written to disk, not one file.

The graph (`src/graph.ts`) models this as: `START` fans out a `Send("survey", ...)` per repo,
LangGraph waits for every parallel `survey` branch to finish (their `manifests` updates are
merged via a concat reducer), then runs `correlate` once over the accumulated manifests.

## Why the output is split across files

A single `journeys.json` array grows without bound as more repos/journeys get scanned and
risks landing in the megabyte range, which is slow to parse and produces unreadable diffs on
re-scan. Instead:

```
output/
  index.json            -- ScanMeta + a JourneySummary[] (id, name, domain, tags,
                            repos, step/edge counts, file path). Small, always loaded first.
  journeys/
    registration.json    -- one full Journey (steps + edges) per file
    checkout.json
    ...
```

user-journey-finder can load `index.json` for the sidebar/list instantly, then fetch an
individual journey file only when it's selected. A re-scan that only changes one journey
produces a one-file diff instead of rewriting a monolith.

## Schema (`src/types/journey.ts`)

Close to user-journey-finder's original hand-authored `Journey`/`Step`/`Edge` shape, with
provenance added since this data is inferred rather than written by hand:

- `Step.sourceRef` -- `{ file, startLine, endLine }` citing where the step was found.
- `Step.confidence` / `Edge.confidence` -- `"low" | "medium" | "high"`, since matching an
  outbound call to a destination step is inference, not certainty.
- `Step.kind` includes `"infra"` alongside the original `page`/`api`/`service`/`db`/`queue`/
  `external` -- a Terraform resource/module or provisioning script that backs a component
  another step touches (e.g. the resource that creates a queue a step publishes to). **Note:**
  user-journey-finder's `KIND_META`/`KIND_ICON`/`KIND_STYLE` don't have an `"infra"` entry yet
  -- add one there before rendering scan output that includes infra steps, or it'll throw on
  an undefined icon lookup.
- `ScanMeta` -- `generatedAt`, `scannerVersion`, `provider`, `reposScanned`, carried in
  `index.json` so the viewer can show scan provenance ("last scanned 2h ago, 6 repos").

All types are defined once as Zod schemas and inferred to TS types, so scanner output is
validated (`schema.parse(...)`) before it's ever written to disk.

## LLM providers

Provider-agnostic by design (`src/providers/index.ts`) via [LangChain.js](https://js.langchain.com/)
chat models, which give structured-output generation (`.withStructuredOutput(zodSchema)`)
uniformly across providers. Currently wired: `anthropic` (`@langchain/anthropic`), `openai`
(`@langchain/openai`), `google` (`@langchain/google-genai`). Select with `--provider` and
optionally `--model`; the corresponding `*_API_KEY` env var must be set (see `.env.example`).

## Repo file coverage

`src/repo-intake` reads every text file in a repo regardless of extension -- application code,
Terraform (`.tf`), and shell/PowerShell (`.sh`/`.ps1`/`.psm1`) scripts are all included, so a
repo that only holds infrastructure (e.g. a Terraform root that provisions the queues/buckets/
databases other repos use) can be scanned like any other. Excluded for safety, not just noise:
`*.tfstate`, `*.tfstate.backup`, `*.tfvars`, `*.tfvars.json`, and `*.tfplan` are never read --
they routinely contain plaintext secrets and resolved resource attributes pulled from cloud
providers, and sending that to an external LLM API would be a real exposure for no
journey-mapping benefit (the `.tf` definitions already describe the resource shape). The
`.terraform/` and `.terragrunt-cache/` provider-plugin/cache directories are skipped too.

Binary media/design assets are excluded too, by extension, regardless of size: documents (pdf,
doc/docx, xls/xlsx, ppt/pptx, odt/ods/odp, rtf), video (mp4, mov, avi, mkv, webm, flv, wmv, m4v,
mpg/mpeg), audio (mp3, wav, flac, ogg, m4a, aac, wma), images (png, jpg/jpeg, gif, bmp, tiff/tif,
webp, ico, heic/heif), and vector/design files (svg, ai, eps, sketch, fig, xd, indd). Reading a
file as `utf8` never throws even on binary content -- Node just decodes the bytes into garbled
text -- so without this filter these would silently burn prompt budget as noise rather than
being skipped like a genuinely unreadable file. See `SKIPPED_ASSET_EXTENSIONS` in
`src/repo-intake/index.ts` to adjust the list.

Package-manager lock files are excluded by exact filename too: `package-lock.json` /
`npm-shrinkwrap.json` / `yarn.lock` / `pnpm-lock.yaml` / `bun.lock(b)` (JS), `composer.lock`
(PHP), `Gemfile.lock` (Ruby), `Pipfile.lock` / `poetry.lock` / `uv.lock` (Python), `Cargo.lock`
(Rust), `go.sum` (Go), `mix.lock` (Elixir), `Podfile.lock` (CocoaPods), `packages.lock.json` /
`paket.lock` (.NET), `conda-lock.yml`, `flake.lock` (Nix). These are large, auto-generated, and
describe pinned dependency hashes -- no journey-mapping signal, and often big enough on their
own to burn through the file-count/size budget for nothing. The manifest they lock (`package.json`,
`Gemfile`, `Cargo.toml`, ...) is still read normally -- that's where the actual dependency/script
signal lives. See `LOCK_FILE_NAMES` in `src/repo-intake/index.ts` to adjust the list.

### `MAX_FILES_PER_REPO` can mask what got excluded

`loadRepoSnapshot` caps at 4000 included files per repo (`MAX_FILES_PER_REPO`). If a repo has
more than 4000 eligible text files on its own, `files.length` reads exactly 4000 whether or not
any media/sensitive files were excluded -- the cap is the bottleneck, not the exclusion filters.
To make that visible instead of confusing, `RepoSnapshot` carries `skipped` (counts of files
excluded as `asset`, `sensitive`, `lockfile`, `tooLarge`, or `unreadable`) and `truncated` (true
if the cap was hit, meaning some eligible files were never scanned at all). The per-repo scan
log line prints both, e.g.:

```
acme-web: 4000 file(s) loaded (skipped 20 media, 0 sensitive, 1 lockfile, 3 too large, 0 unreadable) -- hit MAX_FILES_PER_REPO cap, some eligible files were NOT scanned
```

If you see `truncated`, raise `MAX_FILES_PER_REPO` in `src/repo-intake/index.ts`, or narrow
`--repos`/`--dir` to point at the subset of the repo that actually matters for journey mapping.

## Token usage and cost

Every LLM call in the pipeline -- one per repo surveyed, plus one for the correlator -- is
tracked as a `StepUsage` record (`src/usage.ts`): input/output/total tokens, plus an estimated
USD cost. Each survey call's usage is captured via LangChain's `includeRaw: true` on
`withStructuredOutput`, which returns the underlying `AIMessage.usage_metadata` alongside the
parsed result; the correlator call is tracked the same way.

- Printed as a table after every `scan` run, with a grand total.
- Persisted to `output/usage.json` (`{ steps, totalTokens, totalCostUsd }`) alongside the
  journey data, so cost is part of the scan's record, not just console output.
- Pricing (`src/pricing.ts`) is hardcoded for the Anthropic models this project targets by
  default (Opus 5, Sonnet 5, Haiku 4.5, Fable 5) and accurate as of this file's last update --
  verify against current Anthropic pricing before relying on it for billing. OpenAI/Google
  pricing is intentionally left unset (`costUsd: null`, surfaced as "unknown") rather than
  hardcoding numbers this project has no live source for and that would silently go stale --
  fill in `EXTRA_PRICING` in `src/pricing.ts` with current rates to get real cost estimates for
  those providers.

## Status

This is the initial scaffold: schema, repo intake, output writer, and the surveyor/correlator
prompts are in place and type-check, but the pipeline hasn't been run end-to-end against a
real repo + API key yet. Treat the surveyor/correlator prompts as a first draft to iterate on
once real output can be reviewed.

## Roadmap

- GitHub repo sources (clone-on-demand instead of requiring a local checkout).
- Chunking for repos too large for a single surveyor prompt (currently truncated naively at
  `MAX_PROMPT_CHARS`).
- Incremental re-scan (only re-survey repos that changed since the last scan).

## Setup

```bash
npm install
cp .env.example .env   # fill in the key for the provider you plan to use
npm run scan -- --dir /path/to/all-repos --skipRepos legacy-service --provider anthropic --out ./output
```
