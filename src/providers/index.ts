import type { LanguageModel } from "ai"

export type ProviderId = "anthropic" | "openai" | "google"

const DEFAULT_MODEL: Record<ProviderId, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.1",
  google: "gemini-2.5-pro",
}

/**
 * Resolves a CLI-selected provider/model pair to an `ai` SDK LanguageModel.
 * Each provider package is imported lazily so a user only needs the API key
 * (and installed package) for the provider they actually picked.
 */
export async function resolveModel(providerId: ProviderId, modelId?: string): Promise<LanguageModel> {
  const model = modelId ?? DEFAULT_MODEL[providerId]

  switch (providerId) {
    case "anthropic": {
      const { anthropic } = await import("@ai-sdk/anthropic")
      return anthropic(model)
    }
    case "openai": {
      const { openai } = await import("@ai-sdk/openai")
      return openai(model)
    }
    case "google": {
      const { google } = await import("@ai-sdk/google")
      return google(model)
    }
    default:
      throw new Error(`Unknown provider: ${providerId satisfies never}`)
  }
}
