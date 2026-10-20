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

   Each file also gets a deterministic pass of **fact extraction** (`src/ast`) before it ever
   reaches an LLM: real-AST analysis via the TypeScript compiler API for `.ts`/`.tsx`/`.js`/`.jsx`,
   and a real tree-sitter parse (`src/ast/tree-sitter.ts`, prebuilt WASM grammars -- no native
   build step) for PHP, Java, Python, Bash, and Terraform/HCL. PowerShell is the one exception --
   no mainstream prebuilt tree-sitter grammar exists for it -- so it stays on regex-pattern
   extraction (`src/ast/patterns.ts`). Being a real parse tree (not regex) means a route or call
   embedded in a comment or string literal is correctly ignored, and a declaration split across
   multiple lines is still captured as one fact. This produces a `CodeFact[]` per file -- route
   declarations, outbound HTTP/queue calls, Terraform resources, each with an exact file+line
   and the literal target string as written -- which rides alongside the raw file text into the
   surveyor prompt rather than replacing it (see step 2). It's a hint, not a verdict: mechanical,
   not exhaustive, and the surveyor still reads the actual code to decide what a fact means.

2. **Surveyor agents** (`src/agents/surveyor.ts`) -- one per repo, fanned out **in parallel**
   by the LangGraph graph in `src/graph.ts`. Each surveyor sees its own repo's raw file text
   *plus* the facts extracted from it, and produces a `RepoManifest`: every step found in that
   repo (pages, API endpoints, services, db reads/writes, queues, external vendor calls, infra
   resources/scripts), each with a file + line citation and a confidence rating, plus a list of
   `unresolvedCalls` -- outbound calls the repo makes whose destination lives elsewhere. A repo
   whose file content hasn't changed since a previous run with the same provider/model skips
   this LLM call entirely -- see "Cached incremental re-scan" below.

3. **Resolver agents** (`src/agents/resolver.ts`) -- once every surveyor finishes, this is
   where repo agents actually *talk to each other*: one resolver runs per repo (again fanned
   out in parallel), and each is handed every OTHER repo's manifest plus every edge confirmed
   so far, and tries to match its own `unresolvedCalls` to a step somewhere else. A match
   becomes an `Edge`; anything it can't match yet stays in `unresolvedCalls` for the next round.
   Repos that resolve everything skip the LLM call entirely on later rounds. This repeats --
   each round's edges become the next round's context -- until a round adds no new edges or
   `--max-rounds` (default `4`) is hit, whichever comes first.

4. **Correlator agent** (`src/agents/correlator.ts`) -- one lightweight final pass, not the
   from-scratch matcher it used to be. By the time it runs, the repo agents have already found
   and agreed on most edges themselves; the correlator only (a) catches anything the resolve
   rounds missed and (b) groups the now-mostly-complete edge graph into named journeys with a
   description/domain/tags.

5. **Output** (`src/output/writer.ts`) -- written to disk, not one file.

The graph (`src/graph.ts`) models this as: `START` fans out a `Send("survey", ...)` per repo;
once every parallel `survey` branch finishes (`manifests` merged via a per-repo-key reducer,
keyed by repo name so a later round can patch one repo without clobbering the rest), it fans
out a `Send("resolve", ...)` per repo, giving each branch a snapshot of every manifest and edge
as of that round's start. After each resolve round joins, `afterResolveRound` checks whether
`edges.length` grew since the previous round: if so (and the round cap isn't hit), it loops back
into another `resolve` round; otherwise it hands off to `correlate` once, which runs to `END`.

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

### Cheap and local models via `--provider openai-compatible`

Local runtimes (Ollama, LM Studio, vLLM, llama.cpp's server, LocalAI) and cheap hosted
providers (Groq, DeepSeek, OpenRouter, Together, Fireworks, Mistral's API) all speak the same
OpenAI chat-completions wire format. Rather than adding a provider class per tool, `openai-compatible`
points `ChatOpenAI` at any of them via a custom `--base-url`:

```bash
# Ollama (local) -- pull a model first: ollama pull llama3.1
trizo-horus scan --repos ./repo-a --provider openai-compatible \
  --base-url http://localhost:11434/v1 --model llama3.1

# LM Studio (local) -- start its local server first
trizo-horus scan --repos ./repo-a --provider openai-compatible \
  --base-url http://localhost:1234/v1 --model <model-loaded-in-lm-studio>

# Groq (cheap, hosted)
trizo-horus scan --repos ./repo-a --provider openai-compatible \
  --base-url https://api.groq.com/openai/v1 --model llama-3.3-70b-versatile \
  --api-key "$GROQ_API_KEY"
```

`--model` and `--base-url` are both required -- there's no sensible universal default model for
an arbitrary endpoint. `--api-key` (or `OPENAI_COMPATIBLE_API_KEY`) is optional; most local
servers ignore it, but a placeholder is sent regardless since the OpenAI SDK requires a
non-empty string to construct the client.

**Tradeoff to know before relying on this for real scans:** the whole surveyor/correlator
pipeline depends on `.withStructuredOutput()` reliably filling a nested schema
(`RepoManifest.steps[]`, `unresolvedCalls[]`, ...). Small/local models (roughly 7B–8B and below)
are noticeably worse at this than Claude/GPT/Gemini -- expect more malformed or truncated JSON,
missed steps, and silent retries. Worth a small test repo before trusting it on something large.

**Timeouts against local/networked servers:** the OpenAI SDK's own default request timeout is
10 minutes, which a local model under load can easily exceed -- a large repo's survey prompt on
a consumer GPU (or over your LAN to another machine) can genuinely take longer than that,
especially once several repos are surveyed in parallel against the *same* server. `--timeout
<minutes>` (default `20`) raises this; it's threaded through as an `AbortSignal` on every
model call (`src/agents/surveyor.ts`/`correlator.ts`), so it applies regardless of provider.
If you're still seeing timeouts (or things are just slow) after raising it, the more likely
cause is contention, not the timeout value itself: every repo is surveyed **in parallel**
(`src/graph.ts`'s `Send` fan-out), and most local servers -- Ollama included -- serialize or
sharply limit concurrent generations by default, so a multi-repo scan queues up behind itself
on one machine. Scanning fewer repos per run, or a faster/smaller model, will help more than a
bigger timeout once you're in that regime.

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

Test and mock content is excluded too, since it documents how a handler is expected to behave
rather than the handler itself, and roughly doubles file count for zero new journey steps.
Whole directories are skipped by name (`TEST_MOCK_DIR_NAMES`): `test`, `tests`, `__tests__`,
`__mocks__`, `__snapshots__`, `spec`, `specs`, `e2e`, `cypress`, `playwright-report`,
`test-results`, `fixtures`, `testdata` (Go's own convention -- `go build` already ignores it).
Co-located test files that sit next to the code they exercise (not caught by a directory rule)
are matched by naming convention instead (`TEST_MOCK_FILE_PATTERN`): `*.test.ts`/`*.spec.js`/
`*.mock.ts` (JS/TS), `*_test.go` (Go), `test_*.py`/`*_test.py` (Python), `*Test.java`/`*Spec.scala`/
`*Tests.cs` (JVM/.NET), and Jest `.snap` snapshots. The extension allowlist on the naming-pattern
half deliberately excludes `json`/`yaml`, so a real API spec file like `openapi.spec.json` is
never caught by the "spec" convention meant for test files -- it's kept, since it's actual
journey-mapping signal (the endpoints it documents).

### `MAX_FILES_PER_REPO` can mask what got excluded

`loadRepoSnapshot` caps at 4000 included files per repo (`MAX_FILES_PER_REPO`). If a repo has
more than 4000 eligible text files on its own, `files.length` reads exactly 4000 whether or not
any media/sensitive files were excluded -- the cap is the bottleneck, not the exclusion filters.
To make that visible instead of confusing, `RepoSnapshot` carries `skipped` (counts of files
excluded as `asset`, `sensitive`, `lockfile`, `testOrMock`, `tooLarge`, or `unreadable`) and
`truncated` (true if the cap was hit, meaning some eligible files were never scanned at all).
The per-repo scan log line prints both, e.g.:

```
acme-web: 4000 file(s) loaded (skipped 20 media, 0 sensitive, 1 lockfile, 40 test/mock, 3 too large, 0 unreadable) -- hit MAX_FILES_PER_REPO cap, some eligible files were NOT scanned
```

If you see `truncated`, raise `MAX_FILES_PER_REPO` in `src/repo-intake/index.ts`, or narrow
`--repos`/`--dir` to point at the subset of the repo that actually matters for journey mapping.

## Cached incremental re-scan

Every `scan` writes a per-repo cache entry to `--cache-dir` (default `.trizo-horus-cache/`,
gitignored -- it's a local, regenerable performance cache, not scan output): a content hash of
that repo's files plus the provider/model used, alongside the `RepoManifest` the surveyor
produced. On the next `scan`, a repo whose files hash the same (no content or path changes) *and*
was last surveyed with the same provider/model skips the surveyor's LLM call entirely and reuses
the cached manifest -- the resolve/correlate phases still run fresh every time over the full
current manifest set, since another repo's edits can change what resolves against an unchanged
repo's steps.

- `--no-cache` ignores any cache entries and re-surveys every repo, e.g. after changing the
  surveyor's prompt and wanting fresh output across the board.
- `--cache-dir <path>` points the cache somewhere else (e.g. to share it across CI runs).
- A cache hit logs `<repo>: unchanged since last scan -- reusing cached manifest, no LLM call`
  and contributes no entry to that run's token-usage table -- there's no LLM call to report.

## Token usage and cost

Every LLM call in the pipeline is tracked as a `StepUsage` record (`src/usage.ts`):
input/output/total tokens, plus an estimated USD cost. That's one call per repo surveyed, plus
one **resolve** call per repo per round it still has `unresolvedCalls` left (repos that resolve
everything are free on later rounds -- no LLM call at all), plus one final correlator call. Each
call's usage is captured via LangChain's `includeRaw: true` on `withStructuredOutput`, which
returns the underlying `AIMessage.usage_metadata` alongside the parsed result.

Worst-case resolve-round cost scales with `repos x --max-rounds` (default `4`) if calls never
resolve -- lower `--max-rounds` to bound cost/latency on a scan with many repos, at the risk of
leaving some cross-repo edges unresolved for the correlator to catch on its single final pass
instead.

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
- A tree-sitter grammar for PowerShell, if a mainstream prebuilt one ever appears -- it's the one
  remaining language on regex-pattern extraction (`src/ast/patterns.ts`).

## Setup

```bash
npm install
cp .env.example .env   # fill in the key for the provider you plan to use
npm run scan -- --dir /path/to/all-repos --skipRepos legacy-service --provider anthropic --out ./output
```

## Debugging in LangGraph Studio

`langgraph.json` points the LangGraph CLI at `src/graph.ts`'s compiled `graph` export, so the
pipeline can run and be inspected outside the CLI too -- step through the survey/resolve/correlate
nodes one at a time (including each resolve-round loop), replay a run, inspect the exact state at
each step.

```bash
npm run studio
```

This starts a local LangGraph API server (`langgraphjs dev`, from the `@langchain/langgraph-cli`
dev dependency) and prints a Studio URL (`https://smith.langchain.com/studio?baseUrl=...`) that
renders it in the browser -- no LangSmith account or network access required, everything runs
locally. Loads env vars from `.env`, same as the CLI.

The state schema Studio shows you for a new run is intentionally plain data --
`repoInputs`/`providerId`/`modelId`/`baseUrl` -- not a constructed LangChain model object,
since Studio invokes the graph over HTTP with JSON and can't serialize a live client instance.
Each node resolves its own model from those strings via `resolveModel()` (see
`src/providers/index.ts`); this is also why `--api-key`/API keys never appear in graph state --
they stay in env vars so they never show up in a Studio trace. A run through Studio needs the
same env vars as the CLI (`ANTHROPIC_API_KEY`, etc.) -- set them in `.env` first.

Example input to paste into a new Studio run (adjust the path to a real local repo):

```json
{
  "repoInputs": [{ "name": "my-repo", "path": "/absolute/path/to/my-repo" }],
  "providerId": "anthropic",
  "modelId": "claude-sonnet-5"
}
```

`timeoutMs` is optional too (milliseconds, not minutes -- defaults to 20 min if omitted); add it
directly to the JSON if you need a longer per-call timeout, e.g. `"timeoutMs": 2700000` for 45
minutes against a slow local model. `maxRounds` is also optional (defaults to `4`) -- caps how
many resolve rounds the repo agents get before being handed off to the correlator regardless of
convergence.

### `--dir` / `--skipRepos` and Studio

Studio invokes the compiled graph directly over HTTP -- it never runs the CLI's own
`resolveRepoInputs()`, so a `--dir`/`--skipRepos` folder-discovery step you'd normally pass to
`scan` has no equivalent in the Studio input box; `repoInputs` there has to already be the
concrete, resolved list. Rather than hand-building that list, `studio-input` resolves it the
same way `scan` would and prints the ready-to-paste JSON instead of running the graph:

```bash
npm run dev -- studio-input \
  --dir /path/to/all-repos --skipRepos legacy-service archived-repo \
  --provider openai-compatible --model llama3.1 --base-url http://localhost:11434/v1
```

Takes the same `--repos`/`--dir`/`--skipRepos`/`--provider`/`--model`/`--base-url` flags as
`scan` (no `--out`/`--api-key` -- those aren't part of the graph's input). Copy the printed
JSON straight into Studio's Input box.
