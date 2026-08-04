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

/** Builds a StepUsage record from a structured-output call's raw AIMessage (includeRaw: true). */
export function recordUsage(step: string, provider: string, model: string, raw: BaseMessage): StepUsage {
  const usage = (raw as AIMessage).usage_metadata
  const inputTokens = usage?.input_tokens ?? 0
  const outputTokens = usage?.output_tokens ?? 0
  const totalTokens = usage?.total_tokens ?? inputTokens + outputTokens

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
