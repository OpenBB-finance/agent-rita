import { describe, it, expect } from "bun:test";
import { PROVIDER_OPTIONS, providerOptionsFor } from "../../../../src/lib/providers";

describe("providerOptionsFor", () => {
  // OpenAI routes requests to machines holding a matching prefix; without a
  // stable prompt_cache_key that routing is effectively random, so a shared
  // prefix only caches by luck. Measured before this existed: identical
  // back-to-back requests hit 99%, but ANY variation (even just a different
  // user message) dropped to 0% cached.
  it("sets promptCacheKey so a chat's requests route to the same machine", () => {
    const out = providerOptionsFor("chat-abc");
    expect(out.openai?.promptCacheKey).toBe("chat-abc");
  });

  it("preserves the existing provider options", () => {
    const out = providerOptionsFor("chat-abc");
    expect(out.openai?.store).toBe(PROVIDER_OPTIONS.openai!.store!);
    expect(out.openai?.include).toEqual(PROVIDER_OPTIONS.openai!.include!);
  });

  it("omits the key when there is no conversation id", () => {
    // Better no key than a constant one shared by every chat, which would
    // funnel unrelated traffic onto one machine.
    expect(providerOptionsFor(undefined).openai?.promptCacheKey).toBeUndefined();
    expect(providerOptionsFor("").openai?.promptCacheKey).toBeUndefined();
  });

  it("does not mutate the shared PROVIDER_OPTIONS constant", () => {
    providerOptionsFor("chat-xyz");
    expect(PROVIDER_OPTIONS.openai?.promptCacheKey).toBeUndefined();
  });
});
