import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph"
import { correlateJourneys } from "./agents/correlator.js"
import { resolveRepoCalls } from "./agents/resolver.js"
import { surveyRepo } from "./agents/surveyor.js"
import { resolveModel, type ProviderId } from "./providers/index.js"
import { loadRepoSnapshot, type RepoInput } from "./repo-intake/index.js"
import type { Edge, Journey, RepoManifest } from "./types/journey.js"
import type { StepUsage } from "./usage.js"

// Local/networked models (Ollama, LM Studio, ...) can take far longer per
// call than a hosted API -- a large repo's survey prompt on a slow or
// contended local server can genuinely take tens of minutes. This is well
// above the OpenAI SDK's own default (10 min), which is what surfaces as
// "Request timed out" against a local endpoint under load.
const DEFAULT_TIMEOUT_MS = 20 * 60_000

// Cap on how many resolve rounds the repo agents get to exchange edges
// before we hand off to the correlator regardless -- bounds worst-case LLM
// call volume (repos x rounds) against repos whose calls never resolve.
const DEFAULT_MAX_ROUNDS = 4

/**
 * The scan pipeline as a LangGraph graph:
 *
 * 1. "survey": one node instance per repo (fanned out via Send), each
 *    independently reading its own repo and producing a RepoManifest --
 *    its steps, plus "unresolvedCalls" (outbound calls it can't place
 *    itself).
 * 2. "resolve": once every survey finishes, one node instance per repo
 *    (again via Send) is given every OTHER repo's manifest and tries to
 *    match its own unresolvedCalls to a step elsewhere, proposing Edges.
 *    This is the repo agents "communicating" -- each repo's agent reads
 *    what every other repo's agent has published on the shared blackboard
 *    (graph state) so far and answers its own open questions. Repos whose
 *    calls resolve are cheap on the next round (no unresolvedCalls left ->
 *    no LLM call at all); repos whose calls didn't resolve get to try
 *    again once more edges (and thus more context) exist. This repeats
 *    until a round makes no further progress or DEFAULT_MAX_ROUNDS is hit.
 * 3. "correlate": a single lightweight final pass over the fully-resolved
 *    manifests and the edges the repo agents already confirmed -- it only
 *    catches anything the exchange missed and groups/names the resulting
 *    journeys, rather than discovering all cross-repo edges from scratch.
 *
 * State carries only JSON-serializable data (providerId/modelId/baseUrl
 * strings, not a live model instance) so this graph can be invoked from the
 * LangGraph API server / Studio dashboard, not just the CLI -- see
 * langgraph.json. Each node resolves its own model from those strings;
 * API keys stay in env vars (never in state, so they never end up in a
 * Studio trace).
 */
const ScanState = Annotation.Root({
  repoInputs: Annotation<RepoInput[]>,
  providerId: Annotation<ProviderId>,
  modelId: Annotation<string>,
  /** Only meaningful for providerId "openai-compatible" -- see src/providers/index.ts. */
  baseUrl: Annotation<string | undefined>,
  /** Per-call abort timeout, in ms. Defaults to DEFAULT_TIMEOUT_MS if omitted. */
  timeoutMs: Annotation<number>({
    reducer: (_existing, update) => update,
    default: () => DEFAULT_TIMEOUT_MS,
  }),
  /** Max resolve rounds before forcing a handoff to the correlator regardless of convergence. */
  maxRounds: Annotation<number>({
    reducer: (_existing, update) => update,
    default: () => DEFAULT_MAX_ROUNDS,
  }),
  /** Which repo this branch is responsible for -- only set inside a "resolve" Send. */
  repoName: Annotation<string | undefined>({
    reducer: (_existing, update) => update,
    default: () => undefined,
  }),
  /** Keyed by repo name so a resolve round can patch one repo's entry without clobbering the rest. */
  manifests: Annotation<Record<string, RepoManifest>>({
    reducer: (existing, update) => ({ ...existing, ...update }),
    default: () => ({}),
  }),
  /** Edges proposed by repo agents' resolve rounds (plus any the correlator adds at the end). */
  edges: Annotation<Edge[]>({
    reducer: (existing, update) => existing.concat(update),
    default: () => [],
  }),
  /** How many resolve rounds have completed -- checked against maxRounds. */
  round: Annotation<number>({
    reducer: (_existing, update) => update,
    default: () => 0,
  }),
  /** edges.length as of the end of the previous round -- used to detect a round with no progress. */
  previousEdgeTotal: Annotation<number>({
    reducer: (_existing, update) => update,
    default: () => 0,
  }),
  usage: Annotation<StepUsage[]>({
    reducer: (existing, update) => existing.concat(update),
    default: () => [],
  }),
  journeys: Annotation<Journey[]>,
})

async function surveyNode(state: typeof ScanState.State) {
  // Send() scopes repoInputs down to a single repo for this branch -- see dispatchSurveys.
  const [repo] = state.repoInputs
  const snapshot = await loadRepoSnapshot(repo)
  const { skipped, truncated } = snapshot
  console.log(
    `  ${repo.name}: ${snapshot.files.length} file(s) loaded` +
      ` (skipped ${skipped.asset} media, ${skipped.sensitive} sensitive, ${skipped.lockfile} lockfile, ${skipped.testOrMock} test/mock, ${skipped.tooLarge} too large, ${skipped.unreadable} unreadable)` +
      (truncated ? " -- hit MAX_FILES_PER_REPO cap, some eligible files were NOT scanned" : ""),
  )
  const { model } = await resolveModel(state.providerId, state.modelId, { baseUrl: state.baseUrl })
  const { manifest, usage } = await surveyRepo(model, state.providerId, state.modelId, snapshot, state.timeoutMs)
  return { manifests: { [repo.name]: manifest }, usage: [usage] }
}

async function resolveNode(state: typeof ScanState.State) {
  // Send() scopes repoName + a snapshot of manifests/edges as of round start -- see buildResolveSends.
  const repoName = state.repoName!
  const manifest = state.manifests[repoName]
  if (!manifest || manifest.unresolvedCalls.length === 0) {
    // Nothing left to resolve for this repo -- skip the LLM call entirely.
    return {}
  }

  const others = Object.values(state.manifests).filter((m) => m.repo !== repoName)
  const { model } = await resolveModel(state.providerId, state.modelId, { baseUrl: state.baseUrl })
  const { edges, remainingUnresolvedCalls, usage } = await resolveRepoCalls(
    model,
    state.providerId,
    state.modelId,
    manifest,
    others,
    state.edges,
    state.timeoutMs,
  )
  console.log(
    `  resolve ${repoName}: ${edges.length} edge(s) matched, ${remainingUnresolvedCalls.length} call(s) still unresolved`,
  )
  return {
    manifests: { [repoName]: { ...manifest, unresolvedCalls: remainingUnresolvedCalls } },
    edges,
    usage: [usage],
  }
}

async function afterResolveRoundNode(state: typeof ScanState.State) {
  console.log(`  resolve round ${state.round + 1} complete: ${state.edges.length} edge(s) confirmed so far`)
  return { round: state.round + 1, previousEdgeTotal: state.edges.length }
}

async function correlateNode(state: typeof ScanState.State) {
  const { model } = await resolveModel(state.providerId, state.modelId, { baseUrl: state.baseUrl })
  const { journeys, usage } = await correlateJourneys(
    model,
    state.providerId,
    state.modelId,
    Object.values(state.manifests),
    state.edges,
    state.timeoutMs,
  )
  return { journeys, usage: [usage] }
}

function dispatchSurveys(state: typeof ScanState.State) {
  return state.repoInputs.map(
    (repo) =>
      new Send("survey", {
        repoInputs: [repo],
        providerId: state.providerId,
        modelId: state.modelId,
        baseUrl: state.baseUrl,
        timeoutMs: state.timeoutMs,
      }),
  )
}

/** One Send per repo, giving each repo's resolve branch a snapshot of every manifest + edge so far. */
function buildResolveSends(state: typeof ScanState.State) {
  return Object.keys(state.manifests).map(
    (repoName) =>
      new Send("resolve", {
        repoName,
        manifests: state.manifests,
        edges: state.edges,
        providerId: state.providerId,
        modelId: state.modelId,
        baseUrl: state.baseUrl,
        timeoutMs: state.timeoutMs,
      }),
  )
}

function dispatchFirstResolveRound(state: typeof ScanState.State) {
  return buildResolveSends(state)
}

/** Loops back into another resolve round if the last one made progress and we're under the cap; otherwise done. */
function routeAfterResolve(state: typeof ScanState.State): "correlate" | Send[] {
  const madeProgress = state.edges.length > state.previousEdgeTotal
  const hasRoundsLeft = state.round < state.maxRounds
  if (madeProgress && hasRoundsLeft) {
    return buildResolveSends(state)
  }
  return "correlate"
}

export function buildScanGraph() {
  const graph = new StateGraph(ScanState)
    .addNode("survey", surveyNode)
    .addNode("resolve", resolveNode)
    .addNode("afterResolveRound", afterResolveRoundNode)
    .addNode("correlate", correlateNode)
    .addConditionalEdges(START, dispatchSurveys, ["survey"])
    .addConditionalEdges("survey", dispatchFirstResolveRound, ["resolve"])
    .addEdge("resolve", "afterResolveRound")
    .addConditionalEdges("afterResolveRound", routeAfterResolve, ["resolve", "correlate"])
    .addEdge("correlate", END)
    .compile()
  graph.name = "TrizoHorus"
  return graph
}

// Referenced by langgraph.json ("./src/graph.ts:graph") so `langgraphjs dev`
// can load a compiled graph without any CLI-specific setup.
export const graph = buildScanGraph()
