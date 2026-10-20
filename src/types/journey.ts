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

/** output/index.json */
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

// ---------------------------------------------------------------------------
// Lenient variants for parsing raw model output.
//
// The strict schemas above are what the model is *asked* for (they become
// the tool / JSON schema in the request) and what gets stored and emitted.
// But models -- smaller and OpenAI-compatible ones in particular -- routinely
// drift on details that don't change the meaning: a single-element list
// emitted as a bare string ("tables": "users"), line numbers as strings, an
// enum value in the wrong case, a synonym for a transport ("REST"). Rejecting
// a whole repo's survey over that throws away a 300k-char LLM call, so raw
// output is validated with these variants instead. They normalise what can
// be normalised and leave everything else to the strict rules, and their
// output type is identical to the strict schema's: a value that passes here
// is a valid Step / Edge / Journey.
// ---------------------------------------------------------------------------

/** Accepts a JSON array, a comma/newline/semicolon-separated string, or a bare scalar where a string list is expected. */
function looseStringList<T extends z.ZodType>(inner: T) {
  return z.preprocess((value) => {
    if (value == null) return value
    if (Array.isArray(value)) return value.filter((item) => item != null).map(String)
    if (typeof value === "string") {
      return value
        .split(/[,\n;]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    }
    return [String(value)]
  }, inner)
}

/** A list that may be omitted or null entirely (-> []), or given as a single object instead of an array. */
function looseArray<T extends z.ZodType>(item: T) {
  return z.preprocess((value) => {
    if (value == null) return []
    return Array.isArray(value) ? value : [value]
  }, z.array(item))
}

/** A string that models sometimes emit as a number or a one-element array. */
const looseScalar = (value: unknown) => {
  if (value == null || typeof value === "string") return value
  if (Array.isArray(value)) return value.map(String).join(", ")
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return value
}
const looseString = z.preprocess(looseScalar, z.string())
const looseOptionalString = z.preprocess(looseScalar, z.string().optional().nullable())

/** Case-insensitive enum with synonyms; `fallback` (if given) replaces any value that still doesn't match. */
function looseEnum<T extends z.ZodType>(schema: T, synonyms: Record<string, string>, fallback?: string) {
  const allowed = new Set(Object.values(synonyms))
  return z.preprocess((value) => {
    if (typeof value !== "string") return value
    const normalised = value.trim().toLowerCase().replace(/[\s_-]+/g, "")
    const mapped = synonyms[normalised] ?? normalised
    if (fallback !== undefined && !allowed.has(mapped) && !schema.safeParse(mapped).success) return fallback
    return mapped
  }, schema)
}

const LooseStepKind = looseEnum(StepKind, {
  endpoint: "api", route: "api", controller: "api", handler: "api", rest: "api", graphql: "api", cron: "api",
  usecase: "service", saga: "service", worker: "service", job: "service", internal: "service",
  database: "db", datastore: "db", table: "db", store: "db", cache: "db",
  topic: "queue", event: "queue", events: "queue", consumer: "queue", publisher: "queue", stream: "queue",
  vendor: "external", thirdparty: "external", integration: "external",
  ui: "page", screen: "page", view: "page", component: "page", frontend: "page",
  terraform: "infra", iac: "infra", infrastructure: "infra", script: "infra", deployment: "infra",
})

const LooseConfidence = looseEnum(
  Confidence,
  { veryhigh: "high", certain: "high", med: "medium", moderate: "medium", verylow: "low", uncertain: "low" },
  // Whatever the model meant by a value we can't read, we shouldn't be *more* sure of it.
  "low",
)

const LooseTransport = looseEnum(Transport, {
  rest: "http", api: "http", fetch: "http", axios: "http", webhook: "http",
  kafka: "event", sns: "event", sqs: "event", pubsub: "event", queue: "event", events: "event", topic: "event",
  eventbridge: "event", rabbitmq: "event", amqp: "event", message: "event",
  postgres: "sql", postgresql: "sql", mysql: "sql", db: "sql", database: "sql", query: "sql", jdbc: "sql",
  ws: "websocket", wss: "websocket", socket: "websocket", socketio: "websocket",
  grpcs: "grpc", protobuf: "grpc",
})

/** Accepts "12" as well as 12; rounds to an int and clamps to the 1-based line range the strict schema wants. */
const looseLine = z.preprocess((value) => {
  const n = typeof value === "string" ? Number(value.trim()) : value
  return typeof n === "number" && Number.isFinite(n) ? Math.max(1, Math.round(n)) : n
}, z.number().int().positive())

/** A source ref that can't be read (no file, no lines) becomes null -- the step keeps its own `file` field for provenance. */
const LooseSourceRef = z.preprocess((value) => {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null
  const ref = { ...(value as Record<string, unknown>) }
  if (ref.startLine == null && ref.line != null) ref.startLine = ref.line
  if (ref.endLine == null) ref.endLine = ref.startLine
  if (typeof ref.file !== "string" || ref.startLine == null) return null
  const start = Number(ref.startLine)
  const end = Number(ref.endLine)
  if (Number.isFinite(start) && Number.isFinite(end) && end < start) ref.endLine = ref.startLine
  return ref
}, SourceRef.extend({ startLine: looseLine, endLine: looseLine }).optional().nullable())

export const LooseStep = z.object({
  id: looseString,
  repo: looseString,
  kind: LooseStepKind,
  label: looseString,
  file: looseString,
  sourceRef: LooseSourceRef,
  confidence: LooseConfidence,
  tech: looseOptionalString,
  endpoint: looseOptionalString,
  datastore: looseOptionalString,
  tables: looseStringList(z.array(z.string()).optional().nullable()),
  vendor: looseOptionalString,
  notes: looseOptionalString,
})

export const LooseEdge = z.object({
  from: looseString,
  to: looseString,
  label: looseString,
  transport: LooseTransport,
  confidence: LooseConfidence,
})

export const LooseUnresolvedCall = z.object({
  fromStepId: looseString,
  label: looseString,
  transport: LooseTransport,
  target: looseString,
  confidence: LooseConfidence,
})

export const LooseJourney = z.object({
  id: looseString,
  name: looseString,
  domain: looseString,
  description: looseString,
  entry: looseString,
  tags: looseStringList(z.array(z.string()).optional().nullable()).transform((tags) => tags ?? []),
  steps: z.array(LooseStep),
  edges: looseArray(LooseEdge),
})

/** `unresolvedCalls` / `remainingUnresolvedCalls` / `edges` lists a model may leave out entirely when it has none. */
export const LooseUnresolvedCalls = looseArray(LooseUnresolvedCall)
export const LooseEdges = looseArray(LooseEdge)
