/** The explicitly opted-in API backend. Provider responses never enter errors. */
import { WazapError } from "../errors.js";
import { discardResponse, readBoundedJson } from "../http-response.js";
import type { EmbedApiSettings } from "./types.js";

export class EmbedApi {
  private readonly stopped = new AbortController();

  constructor(private readonly settings: EmbedApiSettings) {}

  async embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    const settings = this.settings;
    const purpose = settings.inputType === "direct" ? { input_type: kind }
      : settings.inputType === "extra_params" ? { extra_params: { input_type: kind } } : {};
    let response: Response;
    try {
      response = await fetch(`${settings.url}/embeddings`, {
        method: "POST", redirect: "error",
        headers: { "content-type": "application/json", [settings.authHeader]: settings.authHeader === "Authorization" ? `Bearer ${settings.key}` : settings.key,
          ...(settings.inputType === "extra_params" ? { "x-bf-passthrough-extra-params": "true" } : {}) },
        // dimensions is deliberately omitted: many compatible models reject it.
        body: JSON.stringify({ model: settings.model, input: texts, encoding_format: "float", ...purpose }),
        signal: AbortSignal.any([this.stopped.signal, AbortSignal.timeout(60_000)]),
      });
    } catch {
      throw new WazapError("RECALL_FAILED", "Embedding API request failed.", "Check the embedding API configuration and connection");
    }
    if (!response.ok) {
      await discardResponse(response);
      const code = [400, 413, 422].includes(response.status) ? "RECALL_BAD_INPUT" : "RECALL_FAILED";
      throw new WazapError(code, `Embedding API returned HTTP ${response.status}.`);
    }
    let reply: unknown;
    try {
      reply = await readBoundedJson(response, 4 * 1024 * 1024);
    } catch {
      throw new WazapError("RECALL_FAILED", "Embedding API response was invalid, interrupted or too large.");
    }
    const invalid = () => new WazapError("RECALL_FAILED", "Embedding API returned invalid vectors.");
    if (reply === null || typeof reply !== "object" || !("data" in reply) || !Array.isArray(reply.data) || reply.data.length !== texts.length) throw invalid();
    const vectors: number[][] = new Array(texts.length);
    for (const row of reply.data) {
      if (row === null || typeof row !== "object") throw invalid();
      const { index, embedding } = row as { index?: unknown; embedding?: unknown };
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= texts.length || vectors[index] !== undefined) throw invalid();
      if (!Array.isArray(embedding) || embedding.length !== settings.dims || embedding.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n)) || !embedding.some((n: number) => n !== 0)) throw invalid();
      // The durable store normalizes using this sum: extreme finite coordinates
      // can overflow or underflow it and otherwise silently store a zero vector.
      const squaredNorm = embedding.reduce((sum: number, n: number) => sum + n * n, 0);
      if (!Number.isFinite(squaredNorm) || squaredNorm === 0) throw invalid();
      vectors[index] = embedding as number[];
    }
    return vectors;
  }

  stop(): void {
    this.stopped.abort();
  }
}
