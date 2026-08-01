import type { BaseChatModel } from "@langchain/core/language_models/chat_models"

export type ProviderId = "anthropic" | "openai" | "google"

const DEFAULT_MODEL: Record<ProviderId, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.1",
  google: "gemini-2.5-pro",
}

export type ResolvedModel = {
  model: BaseChatModel
  providerId: ProviderId
  modelId: string
}

/**
 * Resolves a CLI-selected provider/model pair to a LangChain chat model.
 * Each provider package is imported lazily so a user only needs the API key
 * (and installed package) for the provider they actually picked.
 */
export async function resolveModel(providerId: ProviderId, modelId?: string): Promise<ResolvedModel> {
  const resolvedModelId = modelId ?? DEFAULT_MODEL[providerId]

  switch (providerId) {
    case "anthropic": {
      const { ChatAnthropic } = await import("@langchain/anthropic")
      return { model: new ChatAnthropic({ model: resolvedModelId }), providerId, modelId: resolvedModelId }
    }
    case "openai": {
      const { ChatOpenAI } = await import("@langchain/openai")
      return { model: new ChatOpenAI({ model: resolvedModelId }), providerId, modelId: resolvedModelId }
    }
    case "google": {
      const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai")
      // langchain's default env var is GOOGLE_API_KEY; kept GOOGLE_GENERATIVE_AI_API_KEY
      // (matching .env.example) by passing it through explicitly instead of renaming.
      return {
        model: new ChatGoogleGenerativeAI({ model: resolvedModelId, apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY }),
        providerId,
        modelId: resolvedModelId,
      }
    }
    default:
      throw new Error(`Unknown provider: ${providerId satisfies never}`)
  }
}
