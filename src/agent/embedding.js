import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let embedderPromise = null;
let rerankerPromise = null;

/**
 * Check if the host system has enough available memory to safely allocate
 * the 280MB ONNX Cross-Encoder model without triggering kernel OOM SIGKILL.
 */
function hasAvailableMemory(minMb = 650) {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
    const m = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (m) {
      const availMb = parseInt(m[1], 10) / 1024;
      return availMb >= minMb;
    }
  } catch {}
  return os.freemem() >= minMb * 1024 * 1024;
}

/**
 * Configure environment and lazily initialize Xenova/bge-small-en-v1.5 embedding pipeline.
 */
async function getEmbedder() {
  if (embedderPromise) return embedderPromise;

  embedderPromise = (async () => {
    try {
      const { pipeline, env } = await import('@xenova/transformers');
      if (env?.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }
      const pipe = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', {
        quantized: true
      });
      return pipe;
    } catch (err) {
      embedderPromise = null;
      return null;
    }
  })();

  return embedderPromise;
}

/**
 * Lazily initialize Xenova/bge-reranker-base cross-encoder model and tokenizer.
 */
async function getReranker() {
  if (rerankerPromise) return rerankerPromise;

  // On memory-constrained mobile environments, skip 280MB cross-encoder allocation
  // to prevent kernel Low Memory Killer (LMK) from terminating the process.
  if (!hasAvailableMemory(650)) {
    return null;
  }

  rerankerPromise = (async () => {
    try {
      const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@xenova/transformers');
      if (env?.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }
      const tokenizer = await AutoTokenizer.from_pretrained('Xenova/bge-reranker-base');
      const model = await AutoModelForSequenceClassification.from_pretrained('Xenova/bge-reranker-base', {
        quantized: true
      });
      return { tokenizer, model };
    } catch (err) {
      rerankerPromise = null;
      return null;
    }
  })();

  return rerankerPromise;
}

/**
 * Compute a 384-dimensional normalized embedding vector using Xenova/bge-small-en-v1.5.
 * Returns Float32Array or null on failure.
 */
export async function getEmbedding(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim().slice(0, 512);
  if (!clean) return null;

  try {
    const pipe = await getEmbedder();
    if (!pipe) return null;
    const output = await pipe(clean, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
  } catch {
    return null;
  }
}

/**
 * Cross-Encoder Reranking using Xenova/bge-reranker-base.
 * Evaluates raw query and candidate document text together in a single attention matrix.
 * Outputs an affinity score between 0.0 and 1.0 (via sigmoid of logit) for each candidate.
 * Returns candidate list sorted by affinity score descending.
 */
export async function rerankCandidates(query, candidates) {
  if (!query || !Array.isArray(candidates) || candidates.length === 0) {
    return candidates || [];
  }

  const reranker = await getReranker();
  if (!reranker) {
    return candidates;
  }

  const { tokenizer, model } = reranker;
  try {
    const validCandidates = candidates.map((cand) => ({
      ...cand,
      cleanText: String(cand.text || cand.title || '').trim().slice(0, 512)
    }));

    const queries = validCandidates.map(() => query);
    const docs = validCandidates.map((c) => c.cleanText);

    const inputs = tokenizer(queries, { text_pair: docs, padding: true, truncation: true });
    const outputs = await model(inputs);
    const logits = outputs?.logits?.data;

    return validCandidates.map((cand, idx) => {
      const logit = logits ? logits[idx] : 0;
      const affinityScore = 1.0 / (1.0 + Math.exp(-logit));
      return { ...cand, affinityScore, score: affinityScore };
    }).sort((a, b) => b.affinityScore - a.affinityScore);
  } catch {
    return candidates;
  }
}

/**
 * Convert Float32Array to Buffer for SQLite storage / native vec0 format.
 */
export function vectorToBuffer(vec) {
  if (!vec) return null;
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Convert vector buffer to Float32Array.
 */
export function bufferToVector(buf) {
  if (!buf) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT);
}
