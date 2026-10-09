/** The shapes semantic recall is built from. No logic lives here. */

/** The embedding model aliases wazap knows how to fetch and run. */
export type EmbedModelAlias = "embeddinggemma-300m" | "e5-base-multilingual" | "bge-m3";

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
