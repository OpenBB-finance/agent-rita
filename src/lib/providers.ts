import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { JSONValue, LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { getLogger } from "./logger";

interface ModelEntry {
  id: string;
  name: string;
}

interface ProviderEntry {
  prefix: string;
  models: ModelEntry[];
  resolve: (modelId: string) => LanguageModel;
}

const providers: ProviderEntry[] = [];

/**
 * Provider options sent with every model call.
 *
 * OpenAI's Responses API stores reasoning items server-side and lets a
 * follow-up request cite them by id. This harness rebuilds the whole message
 * list on each turn and never sends `previousResponseId`, so that storage buys
 * nothing — and it breaks outright for Zero Data Retention organizations,
 * where the items are discarded immediately and the next tool round-trip fails
 * with "Item with id 'rs_...' not found". Opting out of storage and carrying
 * the reasoning inline as encrypted content keeps multi-step tool turns
 * working on every account type. Non-OpenAI providers ignore this key.
 */
export const PROVIDER_OPTIONS: Record<string, Record<string, JSONValue>> = {
  openai: { store: false, include: ["reasoning.encrypted_content"] },
};

const openaiKey = process.env.OPENAI_API_KEY;
if (openaiKey) {
  const openai = createOpenAI({ apiKey: openaiKey });
  providers.push({
    prefix: "openai",
    models: [
      { id: "openai:gpt-5.5", name: "OpenAI: GPT-5.5" },
      { id: "openai:gpt-5.4", name: "OpenAI: GPT-5.4" },
      { id: "openai:gpt-5.4-mini", name: "OpenAI: GPT-5.4 Mini" },
      { id: "openai:gpt-5.4-nano", name: "OpenAI: GPT-5.4 Nano" },
      { id: "openai:gpt-5", name: "OpenAI: GPT-5" },
      { id: "openai:gpt-4.1", name: "OpenAI: GPT-4.1" },
      { id: "openai:gpt-4o", name: "OpenAI: GPT-4o" },
      { id: "openai:gpt-4o-mini", name: "OpenAI: GPT-4o Mini" },
    ],
    resolve: (id) => openai(id),
  });
}

const openrouterKey = process.env.OPENROUTER_API_KEY;
if (openrouterKey) {
  const openrouter = createOpenRouter({ apiKey: openrouterKey });
  providers.push({
    prefix: "openrouter",
    models: [
      { id: "openrouter:anthropic/claude-sonnet-4.6", name: "OpenRouter: Claude Sonnet 4.6" },
      { id: "openrouter:google/gemini-3.5-flash", name: "OpenRouter: Gemini 3.5 Flash" },
      { id: "openrouter:google/gemini-3-flash-preview", name: "OpenRouter: Gemini 3 Flash" },
      { id: "openrouter:google/gemini-3.1-pro-preview", name: "OpenRouter: Gemini 3.1 Pro" },
      { id: "openrouter:deepseek/deepseek-v3.2", name: "OpenRouter: DeepSeek V3.2" },
      { id: "openrouter:minimax/minimax-m2.7", name: "OpenRouter: MiniMax M2.7" },
      { id: "openrouter:qwen/qwen3.5-9b", name: "OpenRouter: Qwen 3.5 9B" },
      { id: "openrouter:z-ai/glm-5v-turbo", name: "OpenRouter: GLM-5V Turbo" },
      { id: "openrouter:openai/gpt-oss-120b", name: "OpenRouter: GPT-OSS 120B" },
      { id: "openrouter:openai/gpt-oss-20b", name: "OpenRouter: GPT-OSS 20B" },
      { id: "openrouter:z-ai/glm-5.1", name: "OpenRouter: GLM-5.1" },
    ],
    resolve: (id) => openrouter(id),
  });
}

const groqKey = process.env.GROQ_API_KEY;
if (groqKey) {
  const groq = createGroq({ apiKey: groqKey });
  providers.push({
    prefix: "groq",
    models: [
      { id: "groq:llama-3.3-70b-versatile", name: "Groq: Llama 3.3 70B" },
      { id: "groq:llama-3.1-8b-instant", name: "Groq: Llama 3.1 8B Instant" },
      { id: "groq:meta-llama/llama-4-scout-17b-16e-instruct", name: "Groq: Llama 4 Scout 17B" },
      { id: "groq:meta-llama/llama-4-maverick-17b-128e-instruct", name: "Groq: Llama 4 Maverick 17B" },
      { id: "groq:deepseek-r1-distill-llama-70b", name: "Groq: DeepSeek R1 Distill 70B" },
      { id: "groq:qwen-qwq-32b", name: "Groq: Qwen QwQ 32B" },
      { id: "groq:openai/gpt-oss-120b", name: "Groq: GPT-OSS 120B" },
      { id: "groq:openai/gpt-oss-20b", name: "Groq: GPT-OSS 20B" },
    ],
    resolve: (id) => groq(id),
  });
}

const ollama = createOllama({
  baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/api",
});
providers.push({
  prefix: "ollama",
  models: [
    { id: "ollama:gpt-oss:20b", name: "Ollama: GPT-OSS 20B" },
    { id: "ollama:qwen3.5:9b", name: "Ollama: Qwen 3.5 9B" },
    { id: "ollama:gemma4:e4b", name: "Ollama: Gemma 4 4B" },
  ],
  resolve: (id) => ollama(id),
});

export function resolveModel(rawModelId: string): LanguageModel {
  for (const p of providers) {
    if (rawModelId.startsWith(`${p.prefix}:`)) {
      return p.resolve(rawModelId.slice(p.prefix.length + 1));
    }
  }
  const fallback = providers.find((p) => p.prefix === "openai");
  if (fallback) return fallback.resolve(rawModelId.replace(/^openai:/, ""));
  throw new Error(`No provider available for model: ${rawModelId}`);
}

export function allModels(): ModelEntry[] {
  return providers.flatMap((p) => p.models);
}

const logger = getLogger(["app", "providers"]);

if (providers.length === 0) {
  logger.error("No AI providers configured. Set at least one API key (OPENAI_API_KEY, OPENROUTER_API_KEY) or use Ollama.");
}

const available = providers.map((p) => p.prefix).join(", ");
logger.info("Providers available", { providers: available, modelCount: allModels().length });
