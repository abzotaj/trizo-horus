import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { ChatAnthropic}  from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { config } from "dotenv"

export type ProviderId = "anthropic" | "openai" | "google" | "openai-compatible"

const DEFAULT_MODEL: Partial<Record<ProviderId, string>> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.1",
  google: "gemini-2.5-pro",
  // No default for "openai-compatible" -- the model id is whatever the server
  // at --base-url calls it (an Ollama tag, a Groq/DeepSeek/OpenRouter model
  // name, ...), so there's no universally sensible choice.
}

export type ResolvedModel = {
  model: BaseChatModel
  providerId: ProviderId
  modelId: string
}

export type ResolveModelOptions = {
  /**
   * Required for "openai-compatible". Any server speaking the OpenAI
   * chat-completions wire format: local runtimes (Ollama, LM Studio, vLLM,
   * llama.cpp's server, LocalAI) and cheap hosted providers (Groq, DeepSeek,
   * OpenRouter, Together, Fireworks, Mistral) all qualify.
   * e.g. http://localhost:11434/v1 (Ollama), https://api.groq.com/openai/v1
   */
  baseUrl?: string
  /** Overrides OPENAI_COMPATIBLE_API_KEY. Most local servers ignore it entirely. */
  apiKey?: string
}

/**
 * Resolves a CLI-selected provider/model pair to a LangChain chat model.
 * Each provider package is imported lazily so a user only needs the API key
 * (and installed package) for the provider they actually picked.
 */
export async function resolveModel(
  providerId: ProviderId,
  modelId?: string,
  options: ResolveModelOptions = {},
): Promise<ResolvedModel> {
  console.log({providerId, modelId})
  const resolvedModelId = modelId ?? DEFAULT_MODEL[providerId];
  config();
  console.log({env: process.env});
  if (!resolvedModelId) {
    throw new Error(`--model is required for provider "${providerId}" -- there's no default model for a custom endpoint.`)
  }


  switch (providerId) {
    case "anthropic": {
      return { model: new ChatAnthropic({ model: resolvedModelId, apiKey: process.env.ANTHROPIC_API_KEY || '***REMOVED-LEAKED-ANTHROPIC-KEY***' }), providerId, modelId: resolvedModelId }
    }
    case "openai": {
      return { model: new ChatOpenAI({ model: resolvedModelId, apiKey: process.env.OPENAI_API_KEY || '***REMOVED-LEAKED-OPENAI-KEY***' }), providerId, modelId: resolvedModelId }
    }
    case "google": {
      // langchain's default env var is GOOGLE_API_KEY; kept GOOGLE_GENERATIVE_AI_API_KEY
      // (matching .env.example) by passing it through explicitly instead of renaming.
      return {
        model: new ChatGoogleGenerativeAI({ model: resolvedModelId, apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || '***REMOVED-LEAKED-OPENAI-KEY***' }),
        providerId,
        modelId: resolvedModelId,
      }
    }
    case "openai-compatible": {
      const baseUrl = options.baseUrl
      if (!baseUrl) {
        throw new Error(
          `--base-url is required for provider "openai-compatible" (e.g. http://localhost:11434/v1 for Ollama, ` +
            `https://api.groq.com/openai/v1 for Groq).`,
        )
      }
      return {
        model: new ChatOpenAI({
          model: resolvedModelId,
          // The OpenAI SDK requires a non-empty string even though most local
          // servers ignore it entirely -- "not-needed" is a common placeholder.
          apiKey: options.apiKey ?? process.env.OPENAI_COMPATIBLE_API_KEY ?? "not-needed",
          configuration: { baseURL: baseUrl },
        }),
        providerId,
        modelId: resolvedModelId,
      }
    }
    default:
      throw new Error(`Unknown provider: ${providerId satisfies never}`)
  }
}
