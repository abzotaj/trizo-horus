import type { AIMessage, BaseMessage } from "@langchain/core/messages"
import { estimateCostUsd } from "./pricing.js"

export type StepUsage = {
  step: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUsd: number | null
}

/**
 * Builds a StepUsage record from a structured-output call's raw AIMessage(s)
 * (includeRaw: true). A step that needed a repair round (see
 * src/agents/structured.ts) passes every attempt's message so the tokens the
 * retries cost are counted too.
 */
export function recordUsage(step: string, provider: string, model: string, raw: BaseMessage | BaseMessage[]): StepUsage {
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  for (const message of Array.isArray(raw) ? raw : [raw]) {
    const usage = (message as AIMessage).usage_metadata
    const input = usage?.input_tokens ?? 0
    const output = usage?.output_tokens ?? 0
    inputTokens += input
    outputTokens += output
    totalTokens += usage?.total_tokens ?? input + output
  }

  return {
    step,
    provider,
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: estimateCostUsd(model, inputTokens, outputTokens),
  }
}
