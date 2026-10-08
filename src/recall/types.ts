/** The shapes semantic recall is built from. No logic lives here. */

/** The embedding model aliases wazap knows how to fetch and run. */
export type EmbedModelAlias = "embeddinggemma-300m" | "e5-base-multilingual";

export type RecallState = "off" | "indexing" | "ready" | "degraded";

/** What get_status and the tool report about the index. */
export interface RecallStatus {
  state: RecallState;
  indexed: number;
  pending: number;
  detail?: string;
  fix?: string;
}

/** The whole recall environment, parsed once at the boundary. */
export interface RecallSettings {
  /** false means recall is off and nothing downstream may run. */
  enabled: boolean;
  model: EmbedModelAlias;
  /** API configuration only exists in the explicit openai mode. Never log it. */
  api?: EmbedApiSettings;
  /** Durable vector space identity; excludes authentication credentials. */
  indexModel?: string;
  /** WAZAP_EMBED_BIN override. */
  embedBin: string | null;
  /** WAZAP_EMBED_URL: an already-running server; the test seam, not a user option. */
  embedUrl: string | null;
  modelsDir: string;
  /** In ms: the shared sidecar is reaped after this long without an embed; 0 (tests only) keeps it resident. */
  embedIdleMs: number;
  /** Cosine floor for a hit to count; model-dependent, tuned on the default. */
  minSimilarity: number;
}

export interface EmbedApiSettings {
  url: string;
  key: string;
  model: string;
  dims: number;
  authHeader: "Authorization" | "x-bf-vk";
  /** Retrieval-purpose wire format; omitted by default for OpenAI compatibility. */
  inputType: "none" | "direct" | "extra_params";
}
