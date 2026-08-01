import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph"
import { correlateJourneys } from "./agents/correlator.js"
import { surveyRepo } from "./agents/surveyor.js"
import type { ProviderId } from "./providers/index.js"
import { loadRepoSnapshot, type RepoInput } from "./repo-intake/index.js"
import type { Journey, RepoManifest } from "./types/journey.js"
import type { StepUsage } from "./usage.js"

/**
 * The scan pipeline as a LangGraph graph: a "survey" node is fanned out to
 * run once per repo in parallel (via Send), and a single "correlate" node
 * joins once every survey branch has finished.
 */
const ScanState = Annotation.Root({
  repoInputs: Annotation<RepoInput[]>,
  model: Annotation<BaseChatModel>,
  providerId: Annotation<ProviderId>,
  modelId: Annotation<string>,
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
      ` (skipped ${skipped.asset} media, ${skipped.sensitive} sensitive, ${skipped.tooLarge} too large, ${skipped.unreadable} unreadable)` +
      (truncated ? " -- hit MAX_FILES_PER_REPO cap, some eligible files were NOT scanned" : ""),
  )
  const { manifest, usage } = await surveyRepo(state.model, state.providerId, state.modelId, snapshot)
  return { manifests: [manifest], usage: [usage] }
}

async function correlateNode(state: typeof ScanState.State) {
  const { journeys, usage } = await correlateJourneys(state.model, state.providerId, state.modelId, state.manifests)
  return { journeys, usage: [usage] }
}

function dispatchSurveys(state: typeof ScanState.State) {
  return state.repoInputs.map(
    (repo) =>
      new Send("survey", { repoInputs: [repo], model: state.model, providerId: state.providerId, modelId: state.modelId }),
  )
}

export function buildScanGraph() {
  return new StateGraph(ScanState)
    .addNode("survey", surveyNode)
    .addNode("correlate", correlateNode)
    .addConditionalEdges(START, dispatchSurveys, ["survey"])
    .addEdge("survey", "correlate")
    .addEdge("correlate", END)
    .compile()
}
