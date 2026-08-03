import { generateText } from "ai";
import { PROVIDER_OPTIONS, resolveModel } from "./providers";

const DEFAULT_MODEL = "openai:gpt-4o-mini";
// Backstop so a stalled provider can't hang a /generate route forever. Single
// turn, ≤1024 tokens — 60s is generous. The loop's streaming call uses its own
// (longer) timeout: LLM_STREAM_TIMEOUT_MS in src/agent/loop.ts.
const DEFAULT_TIMEOUT_MS = 60_000;

export async function singleShotLlm(
  prompt: string,
  opts?: { model?: string; maxTokens?: number; temperature?: number; timeoutMs?: number },
): Promise<string> {
  const model = resolveModel(opts?.model ?? DEFAULT_MODEL);
  const result = await generateText({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: opts?.temperature ?? 0.1,
    maxOutputTokens: opts?.maxTokens ?? 1024,
    providerOptions: PROVIDER_OPTIONS,
    abortSignal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  return result.text.trim();
}

export function parseJsonResponse<T>(raw: string, fallback: T): T {
  const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return fallback;
  }
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
