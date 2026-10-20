import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { HumanMessage, type AIMessage, type BaseMessage } from "@langchain/core/messages"
import { z } from "zod"

/**
 * One structured-output model call, validated the way this project needs
 * rather than the way LangChain does it by default.
 *
 * `model.withStructuredOutput(schema, { includeRaw: true })` turns the strict
 * schema into the tool / JSON schema the model is asked to fill, but when the
 * reply doesn't validate it silently returns `parsed: null` instead of
 * throwing -- which is how a model writing `"tables": "users"` used to
 * surface as the baffling `steps: expected array, received undefined` from
 * the caller's own parse. This helper:
 *
 *  1. pulls the model's actual answer out of the raw message when LangChain
 *     gave up on it (the tool-call args, or JSON in the text content);
 *  2. validates it with the caller's *lenient* parser (see the Loose* schemas
 *     in src/types/journey.ts), which fixes the harmless drift on its own;
 *  3. if that still fails, sends the validation errors back to the model
 *     and asks for a corrected answer -- up to `maxRepairs` times;
 *  4. only then throws, with an error that says which call failed, what was
 *     wrong, and what the model actually returned.
 *
 * Every attempt's raw message is returned so the caller can account for all
 * the tokens it cost, not just the last call's.
 */
export type StructuredCall<S extends z.ZodType, L extends z.ZodType> = {
  model: BaseChatModel
  /** What the model is asked for: becomes the tool / JSON schema in the request. Keep it strict so the model sees the real contract. */
  schema: S
  /** What the model's raw answer is validated with. Must produce the same output type as `schema`. */
  parser: L
  messages: BaseMessage[]
  /** Used in warnings and errors, e.g. "survey:det-ttg-api". */
  label: string
  timeoutMs: number
  /** How many times the validation errors get sent back to the model for a corrected answer before giving up. */
  maxRepairs?: number
}

const DEFAULT_MAX_REPAIRS = 1
const PREVIEW_CHARS = 2_000
// Above this, the previous answer isn't echoed back in the repair prompt (it
// would be a large share of the context budget); the errors alone still
// tell the model what to fix.
const MAX_ECHOED_ANSWER_CHARS = 150_000

export async function invokeStructured<S extends z.ZodType, L extends z.ZodType>(
  call: StructuredCall<S, L>,
): Promise<{ output: z.output<L>; raws: AIMessage[] }> {
  const maxRepairs = call.maxRepairs ?? DEFAULT_MAX_REPAIRS
  const structuredModel = call.model.withStructuredOutput(call.schema, { includeRaw: true })
  const raws: AIMessage[] = []
  let messages = call.messages

  for (let attempt = 1; ; attempt++) {
    const { raw, parsed } = await structuredModel.invoke(messages, { signal: AbortSignal.timeout(call.timeoutMs) })
    const message = raw as AIMessage
    raws.push(message)

    const candidate = parsed ?? extractCandidate(message)
    const result = call.parser.safeParse(candidate)
    if (result.success) {
      if (attempt > 1) console.warn(`[${call.label}] corrected answer accepted on attempt ${attempt}`)
      return { output: result.data, raws }
    }

    const issues = z.prettifyError(result.error)
    const answer = candidate === undefined ? "" : JSON.stringify(candidate)
    if (attempt > maxRepairs) {
      throw new Error(
        `[${call.label}] model output failed schema validation after ${attempt} attempt(s).\n` +
          `Validation errors:\n${issues}\n\n` +
          (answer
            ? `Model output (first ${PREVIEW_CHARS} of ${answer.length} chars):\n${answer.slice(0, PREVIEW_CHARS)}`
            : `The model returned no structured output at all (no tool call and no JSON in the reply).`),
      )
    }

    console.warn(
      `[${call.label}] model output failed schema validation (${result.error.issues.length} issue(s)); ` +
        `asking for a corrected answer (repair ${attempt}/${maxRepairs}):\n${indent(issues)}`,
    )
    messages = [...call.messages, new HumanMessage(repairPrompt(answer, issues))]
  }
}

/** The model's answer when LangChain's own strict parse rejected it: the tool-call args, else JSON from the text. */
function extractCandidate(message: AIMessage): unknown {
  const toolArgs = message.tool_calls?.find((call) => call.args && Object.keys(call.args).length > 0)?.args
  if (toolArgs) return toolArgs

  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
          .join("\n")
  return parseJsonLoosely(text)
}

/** Parses JSON that may be wrapped in a ```json fence or surrounded by prose. Returns undefined if there's none. */
function parseJsonLoosely(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidates = [fenced?.[1], text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next, looser slice
    }
  }
  return undefined
}

function repairPrompt(answer: string, issues: string): string {
  const echoed =
    answer && answer.length <= MAX_ECHOED_ANSWER_CHARS
      ? `Your previous answer was:\n${answer}\n\n`
      : answer
        ? `(Your previous answer is too long to repeat here; regenerate it from the material above.)\n\n`
        : `Your previous reply contained no structured output at all.\n\n`
  return (
    `Your previous answer did not match the required output schema. Validation errors (JSON path, then problem):\n` +
    `${issues}\n\n` +
    echoed +
    `Return the COMPLETE corrected answer through the same structured output format -- every step/call/edge, ` +
    `not just the ones that failed. Keep everything that was already valid exactly as it was. In particular: ` +
    `list-valued fields (such as "tables" and "tags") must be JSON arrays even when they hold a single item; ` +
    `line numbers must be integers; enum fields must use exactly one of the allowed values.`
  )
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
}
