/**
 * Semantic Search — Amplifier 1.5 prototype
 * =========================================
 *
 * Embedding-based pattern matching for the Pattern Oracle.
 *
 * v1.4.0 used token-overlap matching (Jaccard-like ratio on a stopword-stripped
 * set of lowercased tokens). It works, but it misses paraphrases: "lue NIM-docs
 * ensin" and "check the Nvidia documentation first" share zero tokens and so
 * score 0, even though they describe the same lesson.
 *
 * This module is the proof-of-concept for embedding-based matching using a
 * small local ONNX model (all-MiniLM-L6-v2, ~25MB) via @xenova/transformers.
 * It runs offline, no API calls, no telemetry.
 *
 * ⚠️ PROTOTYPE STATUS:
 *   - @xenova/transformers is in devDependencies, NOT installed by default.
 *     Run `pnpm install @xenova/transformers` manually to enable.
 *   - First run downloads ~100MB of ONNX models to ~/.cache/transformers/.
 *   - Feature-flagged via AMPLIFIER_USE_SEMANTIC. Default off.
 *   - No batching, no quantization tuning, no eviction. Just enough to test
 *     "does semantic actually beat token-overlap for our lesson corpus?".
 *
 * Design notes (for Ville's morning review):
 *   - Singleton model loader. First call eats the ~2-5s cold start; subsequent
 *     calls are ~10-50ms per embed.
 *   - Vectors are 384-dim Float32. ~1.5KB per lesson stored as BLOB.
 *   - cosine similarity is the standard choice for sentence embeddings (MiniLM
 *     vectors are NOT pre-normalized, so we normalize ourselves).
 *   - semanticSearch is O(n) over candidates. Fine for <10k lessons. If we
 *     ever cross 100k, swap in HNSW (hnswlib-node) or sqlite-vec.
 */

// ---------------------------------------------------------------------------
// Embedder singleton
// ---------------------------------------------------------------------------

/**
 * Lazy embedder. The pipeline is a feature-extraction pipeline that maps a
 * string to a 384-dim sentence embedding.
 *
 * We use `any` here because @xenova/transformers is an optional/dev dependency
 * and we don't want TS to choke when it's not installed. The runtime check in
 * `loadEmbedder` handles the missing-module case gracefully.
 */
type Embedder = (text: string, options?: any) => Promise<any>;

let embedderPromise: Promise<Embedder> | null = null;

/**
 * Load the all-MiniLM-L6-v2 sentence-transformer pipeline. Cached after first
 * successful call. Throws a helpful error if the optional dep is missing so
 * the CLI can fall back to token-overlap matching.
 */
export async function loadEmbedder(): Promise<Embedder> {
  if (embedderPromise) return embedderPromise;

  embedderPromise = (async () => {
    let transformers: any;
    try {
      // Dynamic import so the package can be absent at install time.
      transformers = await import("@xenova/transformers" as any);
    } catch (err: any) {
      throw new Error(
        "@xenova/transformers is not installed. Run `pnpm install @xenova/transformers` " +
          "to enable semantic search, or unset AMPLIFIER_USE_SEMANTIC to use token-overlap. " +
          `Original error: ${err?.message ?? err}`
      );
    }

    // Quantized model is ~25MB vs ~90MB full-precision. Quality difference is
    // negligible for sentence similarity in our use case.
    const pipeline = await transformers.pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
      { quantized: true }
    );
    return pipeline as Embedder;
  })();

  return embedderPromise;
}

/** Reset the cached embedder. Used in tests to inject a mock. */
export function _resetEmbedderForTesting(): void {
  embedderPromise = null;
}

/** Inject a mock embedder. Tests only. */
export function _setEmbedderForTesting(mock: Embedder): void {
  embedderPromise = Promise.resolve(mock);
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

/**
 * Embed a single text into a 384-dim Float32Array.
 * Uses mean-pooling + normalization (the standard sentence-embedding setup).
 */
export async function embed(text: string): Promise<Float32Array> {
  if (!text || text.trim().length === 0) {
    // Return a zero vector for empty input. Callers should filter, but better
    // safe than NaN.
    return new Float32Array(384);
  }

  const embedder = await loadEmbedder();
  const output = await embedder(text, { pooling: "mean", normalize: true });

  // The xenova pipeline returns a Tensor with .data being a Float32Array.
  // We copy it because the underlying buffer can be reused.
  const data: Float32Array = output?.data ?? output;
  return new Float32Array(data);
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two equal-length Float32Arrays.
 *
 * Returns a value in [-1, 1]. For sentence embeddings from MiniLM, values
 * are typically in [0, 1] because all vectors live in the positive cone-ish
 * region. ≥0.6 is a strong match, ≥0.4 is a soft match, <0.3 is noise.
 *
 * Note: if the vectors are already L2-normalized (as our `embed` returns),
 * this simplifies to a dot product. We do the full formula anyway to be safe
 * against callers that hand us unnormalized vectors.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: vector length mismatch (${a.length} vs ${b.length})`
    );
  }
  if (a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// Semantic search
// ---------------------------------------------------------------------------

export interface SemanticCandidate {
  id: number;
  text: string;
  /**
   * Optional pre-computed vector. If supplied, the search skips re-embedding
   * this candidate (the common case when we keep an embeddings table).
   */
  vector?: Float32Array;
}

export interface SemanticHit {
  id: number;
  score: number;
}

/**
 * Rank candidates by cosine similarity to the query. Returns top-K hits in
 * descending score order.
 *
 * @param query     User prompt / lesson title to match against.
 * @param candidates Lessons / decisions to rank. Pre-computed vectors are
 *                   strongly preferred — embedding 1000 candidates on each
 *                   preflight call would be unusably slow (~30s).
 * @param topK      Maximum number of results to return.
 * @param threshold Minimum cosine score. Hits below this are dropped, even
 *                   if topK isn't full. Defaults to 0.3.
 */
export async function semanticSearch(
  query: string,
  candidates: SemanticCandidate[],
  topK: number,
  threshold = 0.3
): Promise<SemanticHit[]> {
  if (candidates.length === 0 || topK <= 0) return [];

  const queryVec = await embed(query);

  const scored: SemanticHit[] = [];
  for (const c of candidates) {
    const candVec = c.vector ?? (await embed(c.text));
    const score = cosineSimilarity(queryVec, candVec);
    if (score >= threshold) {
      scored.push({ id: c.id, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
