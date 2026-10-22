import type { RepoManifest } from "../types/journey.js";

/**
 * The slice of a manifest that matching and grouping actually need: enough
 * to recognise a step (id, kind, label, endpoint/datastore/vendor) and an
 * outbound call (source step, label, transport, target). Everything else
 * (file, sourceRef, notes, confidence, ...) stays in the full manifest and
 * is joined back in by id afterwards, so it neither costs prompt tokens nor
 * has to be echoed back by the model.
 */
export function condenseManifest(manifest: RepoManifest) {
  return {
    repo: manifest.repo,
    steps: condenseSteps(manifest),
    unresolvedCalls: manifest.unresolvedCalls.map((call) => ({
      fromStepId: call.fromStepId,
      label: call.label,
      transport: call.transport,
      target: call.target,
    })),
  };
}

export function condenseSteps(manifest: RepoManifest) {
  return manifest.steps.map((step) => ({
    id: step.id,
    kind: step.kind,
    label: step.label,
    ...(step.endpoint ? { endpoint: step.endpoint } : {}),
    ...(step.datastore ? { datastore: step.datastore } : {}),
    ...(step.vendor ? { vendor: step.vendor } : {}),
  }));
}
