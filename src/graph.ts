import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph"
import { correlateJourneys } from "./agents/correlator.js"
import { surveyRepo } from "./agents/surveyor.js"
import { resolveModel, type ProviderId } from "./providers/index.js"
import { loadRepoSnapshot, type RepoInput } from "./repo-intake/index.js"
import type { Journey, RepoManifest } from "./types/journey.js"
import type { StepUsage } from "./usage.js"

/**
 * The scan pipeline as a LangGraph graph: a "survey" node is fanned out to
 * run once per repo in parallel (via Send), and a single "correlate" node
 * joins once every survey branch has finished.
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
  manifests: Annotation<RepoManifest[]>({
    reducer: (existing, update) => existing.concat(update),
    default: () => [],
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
  const { manifest, usage } = await surveyRepo(model, state.providerId, state.modelId, snapshot)
  return { manifests: [manifest], usage: [usage] }
}

async function correlateNode(state: typeof ScanState.State) {
  const { model } = await resolveModel(state.providerId, state.modelId, { baseUrl: state.baseUrl })
  const { journeys, usage } = await correlateJourneys(model, state.providerId, state.modelId, state.manifests)
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
      }),
  )
}

export function buildScanGraph() {
  const graph = new StateGraph(ScanState)
    .addNode("survey", surveyNode)
    .addNode("correlate", correlateNode)
    .addConditionalEdges(START, dispatchSurveys, ["survey"])
    .addEdge("survey", "correlate")
    .addEdge("correlate", END)
    .compile()
  graph.name = "TrizoHorus"
  return graph
}

// Referenced by langgraph.json ("./src/graph.ts:graph") so `langgraphjs dev`
// can load a compiled graph without any CLI-specific setup.
export const graph = buildScanGraph()
