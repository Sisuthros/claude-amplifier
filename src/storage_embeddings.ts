/**
 * Embedding storage — Amplifier 1.5 prototype
 * ============================================
 *
 * Additive storage layer for sentence-embedding vectors. Lives in its own file
 * (separate from src/storage.ts) so the v1.4.0 storage layer stays untouched
 * and we can rip the prototype out cleanly if the strategy doesn't pan out.
 *
 * The `embeddings` table stores one row per (ref_kind, ref_id) pair:
 *
 *   ref_kind: 'lesson' | 'decision'  — what the vector represents
 *   ref_id:   FK into lessons.id or decisions.id (no actual FK constraint
 *             because we want delete-cascade behavior to be opt-in)
 *   vector:   BLOB of the raw Float32Array bytes (384 dims × 4 bytes = 1536B)
 *   model:    Model fingerprint so we can detect & rebuild stale vectors when
 *             we swap the embedder in a later release
 *   updated_at: ISO timestamp
 *
 * ⚠️ PROTOTYPE NOTES:
 *   - No automatic invalidation when the source lesson/decision text changes.
 *     A real v1.5 needs a content-hash column or a trigger; this scaffold
 *     leaves that for the next iteration.
 *   - No indexes on ref_kind alone — get-all-for-kind is a full table scan.
 *     Fine for <10k rows.
 */

import Database from "better-sqlite3";

export type EmbeddingRefKind = "lesson" | "decision";

export interface EmbeddingRow {
  id: number;
  ref_kind: EmbeddingRefKind;
  ref_id: number;
  vector: Float32Array;
  model: string;
  updated_at: string;
}

/**
 * Default model fingerprint. Bump this whenever we change the embedding model
 * — old rows with a different fingerprint will be ignored / lazily rebuilt.
 */
export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2@quantized";

/**
 * Idempotent schema bootstrap. Safe to call multiple times. Intended to be
 * invoked from SQLiteStore.migrate() (additive, no changes to existing tables).
 */
export function ensureEmbeddingsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ref_kind   TEXT    NOT NULL,
      ref_id     INTEGER NOT NULL,
      vector     BLOB    NOT NULL,
      model      TEXT    NOT NULL,
      updated_at TEXT    NOT NULL,
      UNIQUE(ref_kind, ref_id, model)
    );
    CREATE INDEX IF NOT EXISTS idx_embeddings_kind_ref
      ON embeddings(ref_kind, ref_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_model
      ON embeddings(model);
  `);
}

/**
 * Convert a Float32Array to a Buffer for SQLite BLOB storage.
 * Shares the underlying ArrayBuffer — no copy.
 */
function vectorToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Convert a SQLite BLOB back to a Float32Array.
 * Copies into a new ArrayBuffer because the better-sqlite3 buffer is a view
 * over memory that may be reused.
 */
function bufferToVector(buf: Buffer): Float32Array {
  // Copy the bytes so the resulting Float32Array owns its memory.
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return new Float32Array(copy);
}

/**
 * Insert or replace an embedding row. UPSERT on (ref_kind, ref_id, model).
 */
export function storeEmbedding(
  db: Database.Database,
  refKind: EmbeddingRefKind,
  refId: number,
  vector: Float32Array,
  model: string = DEFAULT_EMBEDDING_MODEL
): void {
  const now = new Date().toISOString();
  const buf = vectorToBuffer(vector);
  db.prepare(
    `
    INSERT INTO embeddings (ref_kind, ref_id, vector, model, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(ref_kind, ref_id, model) DO UPDATE SET
      vector     = excluded.vector,
      updated_at = excluded.updated_at
    `
  ).run(refKind, refId, buf, model, now);
}

/**
 * Fetch one embedding for a given reference. Returns undefined if not found.
 */
export function getEmbedding(
  db: Database.Database,
  refKind: EmbeddingRefKind,
  refId: number,
  model: string = DEFAULT_EMBEDDING_MODEL
): Float32Array | undefined {
  const row = db
    .prepare(
      `SELECT vector FROM embeddings WHERE ref_kind = ? AND ref_id = ? AND model = ?`
    )
    .get(refKind, refId, model) as { vector: Buffer } | undefined;
  if (!row) return undefined;
  return bufferToVector(row.vector);
}

/**
 * Fetch every embedding of a given ref_kind for the active model. Returns rows
 * as a Map<refId, vector> for cheap O(1) lookup at search time.
 */
export function getAllEmbeddings(
  db: Database.Database,
  refKind: EmbeddingRefKind,
  model: string = DEFAULT_EMBEDDING_MODEL
): Map<number, Float32Array> {
  const rows = db
    .prepare(
      `SELECT ref_id, vector FROM embeddings WHERE ref_kind = ? AND model = ?`
    )
    .all(refKind, model) as Array<{ ref_id: number; vector: Buffer }>;

  const out = new Map<number, Float32Array>();
  for (const row of rows) {
    out.set(row.ref_id, bufferToVector(row.vector));
  }
  return out;
}

/** Delete an embedding. Used when the underlying lesson/decision is removed. */
export function deleteEmbedding(
  db: Database.Database,
  refKind: EmbeddingRefKind,
  refId: number
): void {
  db.prepare(`DELETE FROM embeddings WHERE ref_kind = ? AND ref_id = ?`).run(
    refKind,
    refId
  );
}

/** Count embeddings (for stats / doctor commands). */
export function countEmbeddings(
  db: Database.Database,
  refKind?: EmbeddingRefKind
): number {
  if (refKind) {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM embeddings WHERE ref_kind = ?`)
      .get(refKind) as { n: number };
    return row.n;
  }
  const row = db.prepare(`SELECT COUNT(*) AS n FROM embeddings`).get() as {
    n: number;
  };
  return row.n;
}
