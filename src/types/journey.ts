import { z } from "zod"

/**
 * Schema for the data trizo-horus produces and user-journey-finder consumes.
 * Kept close to user-journey-finder's original hand-authored lib/journeys.ts
 * shape, with provenance/confidence fields added since this data is inferred
 * by an LLM reading source code rather than written by a human.
 */

export const StepKind = z.enum(["page", "api", "service", "db", "queue", "external", "infra"])
export type StepKind = z.infer<typeof StepKind>

export const Confidence = z.enum(["low", "medium", "high"])
export type Confidence = z.infer<typeof Confidence>

export const Transport = z.enum(["http", "https", "grpc", "event", "sql", "websocket"])
export type Transport = z.infer<typeof Transport>

export const SourceRef = z.object({
  file: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
})
export type SourceRef = z.infer<typeof SourceRef>

export const Step = z.object({
  id: z.string(),
  repo: z.string(),
  kind: StepKind,
  label: z.string(),
  file: z.string(),
  sourceRef: SourceRef.optional().nullable(),
  confidence: Confidence,
  tech: z.string().optional().nullable(),
  endpoint: z.string().optional().nullable(),
  datastore: z.string().optional().nullable(),
  tables: z.array(z.string()).optional().nullable(),
  vendor: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
})
export type Step = z.infer<typeof Step>

export const Edge = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string(),
  transport: Transport,
  confidence: Confidence,
})
export type Edge = z.infer<typeof Edge>

export const Journey = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  description: z.string(),
  entry: z.string(),
  tags: z.array(z.string()),
  steps: z.array(Step),
  edges: z.array(Edge),
})
export type Journey = z.infer<typeof Journey>

/** Lightweight per-journey summary kept in the index file. */
export const JourneySummary = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  repos: z.array(z.string()),
  stepCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  file: z.string(),
})
export type JourneySummary = z.infer<typeof JourneySummary>

export const ScanMeta = z.object({
  generatedAt: z.string(),
  scannerVersion: z.string(),
  provider: z.string(),
  reposScanned: z.array(z.string()),
})
export type ScanMeta = z.infer<typeof ScanMeta>

/** output-open-ai/index.json */
export const ScanIndex = z.object({
  meta: ScanMeta,
  journeys: z.array(JourneySummary),
})
export type ScanIndex = z.infer<typeof ScanIndex>

/**
 * Intermediate, per-repo artifact produced by a surveyor agent. Not consumed
 * by user-journey-finder directly -- the correlator agent consumes an array
 * of these to produce the final Journey[].
 */
export const RepoManifest = z.object({
  repo: z.string(),
  steps: z.array(Step),
  /**
   * Calls this repo makes outward that couldn't be resolved to a step within
   * the same repo -- candidates for the correlator to match against another
   * repo's inbound steps (e.g. an HTTP call's endpoint string, a topic name
   * a consumer elsewhere subscribes to, a gRPC method another service
   * implements).
   */
  unresolvedCalls: z.array(
    z.object({
      fromStepId: z.string(),
      label: z.string(),
      transport: Transport,
      target: z.string(),
      confidence: Confidence,
    }),
  ),
})
export type RepoManifest = z.infer<typeof RepoManifest>
