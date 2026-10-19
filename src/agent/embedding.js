import path from 'node:path';
import os from 'node:os';

let pipelinePromise = null;

/**
 * Lazily initialize the local feature-extraction pipeline.
 * Runs in pure WebAssembly using single-threaded onnxruntime-web (100% compatible with Termux/Android/Linux/macOS/Windows).
 */
async function getPipeline() {
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    try {
      const { pipeline, env } = await import('@xenova/transformers');
      if (env?.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }
      env.cacheDir = path.join(os.homedir(), '.cache', 'huggingface');
      const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        quantized: true
      });
      return pipe;
    } catch (err) {
      pipelinePromise = null;
      return null;
    }
  })();

  return pipelinePromise;
}

/**
 * Compute a 384-dimensional normalized embedding vector for a string.
 * Returns Float32Array or null on failure.
 */
export async function getEmbedding(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim().slice(0, 512);
  if (!clean) return null;

  try {
    const pipe = await getPipeline();
    if (!pipe) return null;
    const output = await pipe(clean, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
  } catch {
    return null;
  }
}

/**
 * Calculate cosine similarity between two Float32Arrays of identical length.
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Convert Float32Array to Buffer for SQLite storage.
 */
export function vectorToBuffer(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Convert SQLite Buffer back to Float32Array.
 */
export function bufferToVector(buf) {
  if (!buf) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT);
}
