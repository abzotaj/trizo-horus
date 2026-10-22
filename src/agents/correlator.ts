import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { ProviderId } from "../providers/index.js";
import { Edge, LooseEdges, type Journey, type RepoManifest, type Step } from "../types/journey.js";
import { recordUsage, type StepUsage } from "../usage.js";
import { condenseManifest } from "./condense.js";
import { invokeStructured } from "./structured.js";

const SYSTEM_PROMPT = `You are given a condensed view of the final manifests from every repo scanned (each step's
id, repo, kind, label and endpoint/datastore/vendor; each repo's still-unresolved outbound
calls), plus the edges the repos' own agents already confirmed during a multi-round cross-repo
resolution exchange (each repo agent matching its own outbound calls to the steps elsewhere
that receive them).

Your job:
1. Look for any edges the resolution exchange missed -- an unresolvedCall still left on a
   manifest that you can now confidently match to a step in ANOTHER repo's manifest, or any other
   clear connection between two steps the exchange didn't already capture. Return those as
   "newEdges". Don't invent a destination that isn't actually present in the given steps.
2. Group steps (from any number of repos) that are connected -- via the confirmed edges plus
   whatever you add in step 1 -- into "journeys": contiguous flows describing something one actor
   of the system does end-to-end (e.g. "Registration", "Checkout & payment"). Pick a stable id
   (kebab-case), name, domain, description, tags, and an "entry" step id (the step that starts
   the journey) for each, and list the ids of the steps that belong to it in "stepIds".
3. A step can belong to at most one journey. You don't need to list steps that have no edges
   to or from anything else -- each of those automatically becomes its own single-step journey.

Refer to steps ONLY by the exact "id" strings given; never rewrite or invent ids, and never
repeat the step objects themselves.`;

/** What the model is asked for: journey metadata + step ids, not the steps themselves (those are joined back in from the manifests). */
const JourneyGrouping = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  description: z.string(),
  entry: z.string(),
  tags: z.array(z.string()),
  stepIds: z.array(z.string()),
});

const looseStringList = z.preprocess((value) => {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter((item) => item != null).map(String);
  if (typeof value === "string")
    return value
      .split(/[,\n;]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  return [String(value)];
}, z.array(z.string()));

const LooseJourneyGrouping = z.object({
  id: z.preprocess((v) => (v == null ? v : String(v)), z.string()),
  name: z.preprocess((v) => (v == null ? "" : String(v)), z.string()),
  domain: z.preprocess((v) => (v == null ? "" : String(v)), z.string()),
  description: z.preprocess((v) => (v == null ? "" : String(v)), z.string()),
  entry: z.preprocess((v) => (v == null ? "" : String(v)), z.string()),
  tags: looseStringList,
  stepIds: looseStringList,
});

const CorrelatorOutput = z.object({
  journeys: z.array(JourneyGrouping),
  newEdges: z.array(Edge),
});

const LooseCorrelatorOutput = z.object({
  journeys: z.preprocess((v) => (v == null ? [] : v), z.array(LooseJourneyGrouping)),
  newEdges: LooseEdges,
});

type JourneyGrouping = z.infer<typeof JourneyGrouping>;

export async function correlateJourneys(
  model: BaseChatModel,
  providerId: ProviderId,
  modelId: string,
  manifests: RepoManifest[],
  confirmedEdges: Edge[],
  timeoutMs: number,
): Promise<{ journeys: Journey[]; usage: StepUsage }> {
  const { output, raws } = await invokeStructured({
    model,
    label: "correlate",
    timeoutMs,
    schema: CorrelatorOutput,
    parser: LooseCorrelatorOutput,
    messages: [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(
        `Repo manifests (condensed):\n${JSON.stringify(manifests.map(condenseManifest), null, 1)}\n\n` +
          `Edges already confirmed by the repos' own agents:\n${JSON.stringify(confirmedEdges, null, 1)}`,
      ),
    ],
  });

  const usage = recordUsage("correlate", providerId, modelId, raws);
  const journeys = assembleJourneys(manifests, confirmedEdges, output.journeys, output.newEdges);
  return { journeys, usage };
}

/**
 * Turns the model's groupings (step ids) back into full Journey objects by
 * joining the steps and edges in from the manifests. Deterministic, so every
 * step field survives verbatim by construction, and robust to the model's
 * usual slips: unknown or duplicated step ids are dropped with a warning,
 * edges pointing at steps that don't exist are discarded, a journey's entry
 * is forced to be one of its own steps, and any step the model left out is
 * pulled into the journey it's connected to (or grouped with whatever else
 * it's connected to, or stands alone) rather than silently vanishing.
 */
export function assembleJourneys(
  manifests: RepoManifest[],
  confirmedEdges: Edge[],
  groupings: JourneyGrouping[],
  newEdges: Edge[],
): Journey[] {
  const stepsById = new Map<string, Step>();
  for (const manifest of manifests) {
    for (const step of manifest.steps) {
      if (stepsById.has(step.id)) {
        console.warn(
          `  correlate: duplicate step id "${step.id}" (${stepsById.get(step.id)!.repo} and ${manifest.repo}); keeping the first`,
        );
        continue;
      }
      stepsById.set(step.id, step);
    }
  }

  const edges: Edge[] = [];
  const seenEdges = new Set<string>();
  for (const [source, candidates] of [
    ["confirmed", confirmedEdges],
    ["correlator", newEdges],
  ] as const) {
    for (const edge of candidates) {
      if (!stepsById.has(edge.from) || !stepsById.has(edge.to)) {
        console.warn(
          `  correlate: dropping ${source} edge ${edge.from} -> ${edge.to}: ${!stepsById.has(edge.from) ? "source" : "target"} step does not exist`,
        );
        continue;
      }
      const key = `${edge.from}\0${edge.to}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push(edge);
    }
  }

  type Draft = { meta: Omit<JourneyGrouping, "stepIds">; steps: Step[] };
  const drafts: Draft[] = [];
  const draftOfStep = new Map<string, Draft>();
  const place = (draft: Draft, step: Step) => {
    draftOfStep.set(step.id, draft);
    draft.steps.push(step);
  };

  for (const grouping of groupings) {
    const draft: Draft = { meta: grouping, steps: [] };
    for (const stepId of grouping.stepIds) {
      const step = stepsById.get(stepId);
      if (!step) {
        console.warn(
          `  correlate: journey "${grouping.id}" names unknown step "${stepId}"; dropping it`,
        );
        continue;
      }
      if (draftOfStep.has(stepId)) {
        console.warn(
          `  correlate: step "${stepId}" is already in another journey; leaving it out of "${grouping.id}"`,
        );
        continue;
      }
      place(draft, step);
    }
    if (draft.steps.length === 0) {
      console.warn(`  correlate: journey "${grouping.id}" has no valid steps; dropping it`);
      continue;
    }
    drafts.push(draft);
  }

  // A step the model didn't place but that's connected to a placed step
  // belongs with it -- otherwise the edge between them would be lost, since
  // a journey can only carry edges between its own steps.
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of edges) {
      const from = draftOfStep.get(edge.from);
      const to = draftOfStep.get(edge.to);
      if (from && !to) place(from, stepsById.get(edge.to)!);
      else if (to && !from) place(to, stepsById.get(edge.from)!);
      else continue;
      changed = true;
    }
  }

  // Whatever is still unplaced is connected only to other unplaced steps (or
  // to nothing): each such cluster becomes its own journey, per the "no step
  // is dropped" rule.
  const leftover = [...stepsById.values()].filter((step) => !draftOfStep.has(step.id));
  for (const component of connectedComponents(leftover, edges)) {
    const entry =
      component.find((step) => !edges.some((e) => e.to === step.id && e.from !== step.id)) ??
      component[0]!;
    const draft: Draft = {
      meta: {
        id: entry.id,
        name: entry.label,
        domain: entry.repo,
        description:
          component.length === 1
            ? "Single step not connected to any other step in the scan."
            : "Connected steps the correlator did not place in a named journey.",
        entry: entry.id,
        tags: [...new Set(component.map((step) => step.repo))],
      },
      steps: [],
    };
    for (const step of component) place(draft, step);
    drafts.push(draft);
  }

  const usedJourneyIds = new Set<string>();
  return drafts.map(({ meta, steps }) => {
    const stepIds = new Set(steps.map((step) => step.id));
    const entry = stepIds.has(meta.entry) ? meta.entry : steps[0]!.id;
    return {
      id: uniqueJourneyId(meta.id || entry, usedJourneyIds),
      name: meta.name || steps[0]!.label,
      domain: meta.domain || steps[0]!.repo,
      description: meta.description,
      entry,
      tags: meta.tags,
      steps,
      edges: edges.filter((edge) => stepIds.has(edge.from) && stepIds.has(edge.to)),
    };
  });
}

/** Groups `steps` into clusters joined by `edges` (edges to steps outside the set are ignored), preserving input order within each cluster. */
function connectedComponents(steps: Step[], edges: Edge[]): Step[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (const step of steps) parent.set(step.id, step.id);
  for (const edge of edges) {
    if (!parent.has(edge.from) || !parent.has(edge.to)) continue;
    parent.set(find(edge.from), find(edge.to));
  }
  const components = new Map<string, Step[]>();
  for (const step of steps) {
    const root = find(step.id);
    const bucket = components.get(root);
    if (bucket) bucket.push(step);
    else components.set(root, [step]);
  }
  return [...components.values()];
}

/** Kebab-cases a candidate journey id (it becomes a file name) and de-duplicates it with a numeric suffix. */
function uniqueJourneyId(candidate: string, used: Set<string>): string {
  const base =
    candidate
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "journey";
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}
