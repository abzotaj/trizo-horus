import type { Journey } from "../types/journey.js";

export function journeyRepos(journey: Journey): string[] {
  return Array.from(new Set(journey.steps.map((s) => s.repo)));
}
