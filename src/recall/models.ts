/**
 * The embedding model table. Same shape as the whisper table: alias, file,
 * size and digest, so a download verifies against a pinned sha256 rather than
 * trusting whatever the network returned.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WazapError } from "../errors.js";
import { downloadFile, type DownloadProgress, type DownloadResult } from "../model-download.js";
import type { EmbedModelAlias } from "./types.js";

/** The most characters of one message the index ever embedded, whatever the model's window. */
export const RECALL_TEXT_CAP = 2048;

export interface EmbedModelSpec {
  alias: EmbedModelAlias;
  file: string;
  bytes: number;
  sha256: string;
  /** Vector length this model emits; a mismatch against the index forces a rebuild. */
  dims: number;
  url: string;
  /**
   * The task prefixes the model was trained with, prepended at embed time.
   * Queries and documents live on different sides of a retrieval pair — the
   * prefix is what tells the model which side a text is on.
   */
  prompts: { query: string; document: string };
  /**
   * Characters of a message the model may see, set by its context size: one
   * over-context text is a deterministic 400 that must never reach the
   * server. Romanian runs ~2.3 chars/token once the task prompt is counted,
   * so e5's 512-token window only fits ~800 chars while gemma's much larger
   * context keeps the store's own cap.
   */
  maxChars: number;
  /**
   * Cosine floor a recall hit must clear when WAZAP_RECALL_MIN_SIMILARITY is
   * unset. Each model's prompted space prices similarity differently — a score
   * that means "real match" for one is noise for another — so the floor
   * travels with the spec. `floorCalibrated` is false while the value is a
   * placeholder rather than a measurement on a real index; doctor says so.
   */
  defaultMinSimilarity: number;
  floorCalibrated: boolean;
}

/**
 * Digests read from the Hugging Face LFS pointers at
 * https://huggingface.co/<repo>/raw/main/<file>, then confirmed against a
 * real download. Verified 2026-09-13.
 * embeddinggemma needs llama.cpp with gemma-embedding support (b6800+; Homebrew
 * 0.4.0 runs it); e5-base is the safe fallback for an older llama.cpp.
 */
export const EMBED_MODELS: Record<EmbedModelAlias, EmbedModelSpec> = {
  "embeddinggemma-300m": {
    alias: "embeddinggemma-300m",
    file: "embeddinggemma-300M-Q8_0.gguf",
    bytes: 333590944,
    sha256: "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63",
    dims: 768,
    url: "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf",
    // EmbeddingGemma's own retrieval task, from its model card.
    prompts: { query: "task: search result | query: ", document: "title: none | text: " },
    maxChars: 2048,
    // Measured on a real index under those prompts: noise tops out ~0.31,
    // real paraphrases start ~0.35.
    defaultMinSimilarity: 0.35,
    floorCalibrated: true,
  },
  "e5-base-multilingual": {
    alias: "e5-base-multilingual",
    file: "multilingual-e5-base-q8_0.gguf",
    bytes: 303138624,
    sha256: "548c31b068947aa26b86c8bbfc1f2fabe5233f6d0e1241319832b20a01e5968a",
    dims: 768,
    url: "https://huggingface.co/dinab/multilingual-e5-base-Q8_0-GGUF/resolve/main/multilingual-e5-base-q8_0.gguf",
    // e5's documented asymmetric prefixes.
    prompts: { query: "query: ", document: "passage: " },
    // e5's context window is 512 tokens; the cap leaves headroom for the
    // document prefix and diacritic-heavy text.
    maxChars: 800,
    // Measured on a real 12k-message index: noise tops out ~0.84 while real
    // paraphrases run 0.82-0.88 — the bands overlap, so no floor separates
    // cleanly. 0.85 deliberately errs toward silence: a missed hit answers
    // "nothing found", a false hit is a wrong memory an agent will repeat.
    // Gemma stays the recommended model; e5 remains the fallback for a
    // llama.cpp too old for gemma embeddings.
    defaultMinSimilarity: 0.85,
    floorCalibrated: true,
  },
  "bge-m3": {
    alias: "bge-m3",
    file: "bge-m3-Q8_0.gguf",
    bytes: 634553760,
    sha256: "950f4a8e5e19477a6d3c26d2f162233c20002c601f75e4b002e3239997821167",
    dims: 1024,
    url: "https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf",
    // bge-m3 takes no task prefix; the GGUF names its own CLS pooling.
    prompts: { query: "", document: "" },
    maxChars: RECALL_TEXT_CAP,
    // Measured 2026-10-10 on 3,000 real Romanian and English messages: a
    // question with no answer in them tops out at 0.44-0.64, real answers sit
    // at 0.58-0.77, across languages too ("where is my package" → "A ajuns
    // coletul?" 0.63, gemma 0.31). Twice gemma's size and embed time; the
    // model for a history written in more than one language.
    defaultMinSimilarity: 0.55,
    floorCalibrated: true,
  },
};

export function embedModelSpec(name: string): EmbedModelSpec {
  const spec = (EMBED_MODELS as Record<string, EmbedModelSpec | undefined>)[name];
  if (spec === undefined) {
    throw new WazapError(
      "INVALID_ID",
      `Unknown embedding model "${name}".`,
      `Pick one of: ${Object.keys(EMBED_MODELS).join(", ")}`
    );
  }
  return spec;
}

export function embedModelPath(modelsDir: string, spec: EmbedModelSpec): string {
  return join(modelsDir, spec.file);
}

/**
 * The shared verified downloader, pointed at this table's URL. Its errors are
 * transcribe-flavoured, so they are re-coded here: the fix must name the
 * command the user actually ran.
 */
export async function downloadEmbed(
  modelsDir: string,
  spec: EmbedModelSpec,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<DownloadResult> {
  await mkdir(modelsDir, { recursive: true });
  try {
    return await downloadFile({
      url: spec.url,
      path: embedModelPath(modelsDir, spec),
      sha256: spec.sha256,
      bytes: spec.bytes,
      onProgress,
      signal,
      command: "wazap embed download",
    });
  } catch (err) {
    if (err instanceof WazapError) {
      throw new WazapError("RECALL_FAILED", err.message, err.fix ?? "Run `wazap embed download` again");
    }
    throw err;
  }
}
