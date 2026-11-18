/**
 * Real semantic retrieval for the memory index.
 *
 * Two small ONNX models run in-process through transformers.js:
 * - `Xenova/multilingual-e5-small` (384-dim, 512 tokens) for chunk embeddings;
 *   multilingual, so a Chinese question can reach English documents.
 * - `Xenova/bge-reranker-base` (278M) for cross-encoder reranking of the
 *   shortlist produced by RRF fusion.
 *
 * Both are downloaded once into `<userData>/models` and are optional: if the
 * load or the download fails (offline install, blocked network), callers fall
 * back to the hashed vectors and the heuristic reranker.
 */

import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DEFAULT_EMBED_MODEL = 'Xenova/multilingual-e5-small'
const DEFAULT_RERANK_MODEL = 'Xenova/bge-reranker-base'
// English queries go through an MS MARCO cross-encoder: it is 23 MB, ~4x faster
// than bge-reranker-base on CPU and clearly better on English scientific text
// (TREC nDCG 0.7652 -> 0.7766 with a full candidate list). Chinese queries keep
// bge, which is the model actually trained on Chinese pairs.
const DEFAULT_EN_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2'
const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model_quantized.onnx']
const DOWNLOAD_ATTEMPTS = 8
const EMBED_BATCH = 8
const MAX_RERANK_DOCS = 20

/**
 * Model families differ in how they turn token states into one vector and in
 * the prefixes they were trained with. e5 expects mean pooling and the
 * `query: ` / `passage: ` prefixes; bge expects CLS pooling and, for Chinese
 * retrieval, a long instruction on the query side.
 */
const E5_STYLE = /multilingual-e5|(^|[/-])e5(-|$)/i.test(process.env.OPENFUTURE_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL)
const EMBED_POOL =
  (process.env.OPENFUTURE_EMBED_POOL ?? (E5_STYLE ? 'mean' : 'cls')).toLowerCase() === 'mean' ? 'mean' : 'cls'
const QUERY_PREFIX = process.env.OPENFUTURE_QUERY_PREFIX ?? (E5_STYLE ? 'query: ' : '')
const DOC_PREFIX = process.env.OPENFUTURE_DOC_PREFIX ?? (E5_STYLE ? 'passage: ' : '')
const INSTRUCTION_ENABLED = process.env.OPENFUTURE_EMBED_INSTRUCTION
  ? process.env.OPENFUTURE_EMBED_INSTRUCTION !== '0'
  : !E5_STYLE

export const EMBED_MODEL = process.env.OPENFUTURE_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL
export const RERANK_MODEL = process.env.OPENFUTURE_RERANK_MODEL?.trim() || DEFAULT_RERANK_MODEL
export const EN_RERANK_MODEL =
  process.env.OPENFUTURE_RERANK_MODEL?.trim() ||
  process.env.OPENFUTURE_RERANK_MODEL_EN?.trim() ||
  DEFAULT_EN_RERANK_MODEL

/** The cross-encoder is language-specialised: pick per query text. */
export function rerankModelFor(query: string): string {
  return /[\u4e00-\u9fff]/.test(query) ? RERANK_MODEL : EN_RERANK_MODEL
}

export function semanticEnabled(): boolean {
  return process.env.OPENFUTURE_SEMANTIC !== '0'
}

export function modelCacheDir(): string {
  const explicit = process.env.OPENFUTURE_MODEL_DIR?.trim()
  if (explicit) return explicit
  const memoryDir = process.env.OPENFUTURE_MEMORY_DIR?.trim()
  if (memoryDir) return `${memoryDir}/../models`
  return 'models'
}

interface Transformers {
  env: { cacheDir: string; allowRemoteModels: boolean; remoteHost?: string }
  AutoTokenizer: { from_pretrained(name: string, options?: Record<string, unknown>): Promise<Tokenizer> }
  AutoModel: { from_pretrained(name: string, options?: Record<string, unknown>): Promise<Model> }
  AutoModelForSequenceClassification: {
    from_pretrained(name: string, options?: Record<string, unknown>): Promise<Model>
  }
}

interface Tokenizer {
  (text: string | string[], options?: Record<string, unknown>): Promise<Record<string, unknown>>
}

interface Tensor {
  dims: number[]
  data: Float32Array
}

interface Model {
  (inputs: Record<string, unknown>): Promise<{ logits?: Tensor } | Tensor>
}


/**
 * HuggingFace's own downloader has no resume support; on a flaky link a 100 MB
 * ONNX file arrives truncated and onnxruntime reports "Protobuf parsing failed".
 * Fetch the files ourselves with Range resume before handing the cache to
 * transformers.js, which then only reads local bytes.
 */
async function headSize(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) })
    const length = Number(response.headers.get('content-length') ?? 0)
    return response.ok && length > 0 ? length : null
  } catch {
    return null
  }
}

async function fetchFile(url: string, target: string): Promise<void> {
  mkdirSync(dirname(target), { recursive: true })
  const expected = await headSize(url)
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
    let current = 0
    try {
      current = statSync(target).size
    } catch {
      current = 0
    }
    if (expected !== null && current >= expected) return
    const headers: Record<string, string> = {}
    if (current > 0) headers.Range = `bytes=${current}-`
    const controller = new AbortController()
    let idle = setTimeout(() => controller.abort(), 45_000)
    let handle: number | null = null
    try {
      const response = await fetch(url, { headers, signal: controller.signal })
      if (response.status === 416) return
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      // Append as bytes arrive so an aborted attempt keeps its progress; the
      // next attempt resumes from the current file size.
      handle = openSync(target, current > 0 && response.status === 206 ? 'a' : 'w')
      if (!response.body) {
        writeSync(handle, Buffer.from(await response.arrayBuffer()))
      } else {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) writeSync(handle, Buffer.from(value))
          clearTimeout(idle)
          idle = setTimeout(() => controller.abort(), 45_000)
        }
      }
      const size = statSync(target).size
      if (expected === null || size >= expected) {
        clearTimeout(idle)
        return
      }
      console.warn(`[semantic] ${target} truncated at ${size}/${expected}, resuming`)
    } catch (error) {
      console.warn(`[semantic] download attempt ${attempt + 1} failed for ${url}:`, error)
      await new Promise((resolve) => setTimeout(resolve, 1_500))
    } finally {
      clearTimeout(idle)
      if (handle !== null) {
        try {
          closeSync(handle)
        } catch {
          /* already closed */
        }
      }
    }
  }
  throw new Error(`无法下载模型文件 ${url}`)
}

async function ensureModelFiles(model: string): Promise<void> {
  const endpoint = process.env.OPENFUTURE_HF_ENDPOINT?.trim() || 'https://huggingface.co'
  const root = join(modelCacheDir(), model)
  for (const file of MODEL_FILES) {
    const target = join(root, file)
    const url = `${endpoint}/${model}/resolve/main/${file}`
    let size = 0
    try {
      size = statSync(target).size
    } catch {
      size = 0
    }
    if (size > 0) {
      const expected = await headSize(url)
      if (expected === null || size >= expected) continue
    }
    console.log(`[semantic] downloading ${model}/${file}`)
    await fetchFile(url, target)
  }
}

let libraryPromise: Promise<Transformers> | null = null
let embedderPromise: Promise<{ tokenizer: Tokenizer; model: Model }> | null = null
const rerankerPromises = new Map<string, Promise<{ tokenizer: Tokenizer; model: Model }>>()
const readyRerankers = new Set<string>()
let embedderReady = false

async function transformers(): Promise<Transformers> {
  if (!libraryPromise) {
    libraryPromise = import('@huggingface/transformers').then((module) => {
      const lib = module as unknown as Transformers
      lib.env.cacheDir = modelCacheDir()
      lib.env.allowRemoteModels = true
      const endpoint = process.env.OPENFUTURE_HF_ENDPOINT?.trim()
      if (endpoint) lib.env.remoteHost = endpoint
      return lib
    })
  }
  return libraryPromise
}

async function loadEmbedder(): Promise<{ tokenizer: Tokenizer; model: Model }> {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      await ensureModelFiles(EMBED_MODEL)
      const lib = await transformers()
      console.log(`[semantic] loading embedding model ${EMBED_MODEL} (cache ${modelCacheDir()})`)
      const tokenizer = await lib.AutoTokenizer.from_pretrained(EMBED_MODEL)
      const model = await lib.AutoModel.from_pretrained(EMBED_MODEL, { dtype: 'q8' })
      embedderReady = true
      console.log('[semantic] embedding model ready')
      return { tokenizer, model }
    })().catch((error) => {
      embedderPromise = null
      console.error('[semantic] embedding model failed:', error)
      throw error
    })
  }
  return embedderPromise
}

async function loadReranker(modelName: string): Promise<{ tokenizer: Tokenizer; model: Model }> {
  const existing = rerankerPromises.get(modelName)
  if (existing) return existing
  const promise = (async () => {
    await ensureModelFiles(modelName)
    const lib = await transformers()
    console.log(`[semantic] loading reranker ${modelName}`)
    const tokenizer = await lib.AutoTokenizer.from_pretrained(modelName)
    const model = await lib.AutoModelForSequenceClassification.from_pretrained(modelName, { dtype: 'q8' })
    readyRerankers.add(modelName)
    console.log(`[semantic] reranker ready (${modelName})`)
    return { tokenizer, model }
  })().catch((error) => {
    rerankerPromises.delete(modelName)
    console.error('[semantic] reranker failed:', error)
    throw error
  })
  rerankerPromises.set(modelName, promise)
  return promise
}

/** Download the embedding model; failures only disable semantic search. */
export async function warmEmbedder(): Promise<void> {
  if (!semanticEnabled()) return
  try {
    await loadEmbedder()
  } catch {
    // fall back to hashed vectors
  }
}

/** Download the rerankers; failures only disable the cross-encoder path. */
export async function warmReranker(): Promise<void> {
  if (!semanticEnabled()) return
  const models = [...new Set([RERANK_MODEL, EN_RERANK_MODEL])]
  await Promise.all(
    models.map((model) =>
      loadReranker(model).catch(() => {
        // fall back to the heuristic reranker for that language
      })
    )
  )
}

export async function warmModels(): Promise<void> {
  await warmEmbedder()
  await warmReranker()
}

export function modelsReady(): { embedder: boolean; reranker: boolean } {
  return { embedder: embedderReady, reranker: readyRerankers.size > 0 }
}

function poolCls(output: unknown, count: number): { vectors: Float32Array[]; dim: number } {
  // AutoModel returns { last_hidden_state: [batch, seq, dim] }; a bare tensor is
  // accepted too so a pipeline-style backend keeps working.
  const tensor = ((output as { last_hidden_state?: Tensor }).last_hidden_state ?? output) as Tensor
  const dims = tensor.dims
  const dim = dims[dims.length - 1] ?? 768
  const sequence = dims.length >= 3 ? dims[dims.length - 2] ?? 1 : 1
  const vectors: Float32Array[] = []
  for (let row = 0; row < count; row += 1) {
    const base = row * sequence * dim
    const vector = new Float32Array(dim)
    let norm = 0
    for (let index = 0; index < dim; index += 1) {
      const value = tensor.data[base + index] ?? 0
      vector[index] = value
      norm += value * value
    }
    const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0
    for (let index = 0; index < dim; index += 1) vector[index] = (vector[index] ?? 0) * scale
    vectors.push(vector)
  }
  return { vectors, dim }
}

/**
 * Mean pooling over the attention mask (e5 / sentence-transformers style).
 * `last_hidden_state` is [batch, seq, dim] and the mask is [batch, seq].
 */
function poolMean(output: unknown, inputs: Record<string, unknown>, count: number): { vectors: Float32Array[]; dim: number } {
  const tensor = ((output as { last_hidden_state?: Tensor }).last_hidden_state ?? output) as Tensor
  const dims = tensor.dims
  const dim = dims[dims.length - 1] ?? 768
  const sequence = dims.length >= 3 ? dims[dims.length - 2] ?? 1 : 1
  const mask = (inputs.attention_mask as Tensor | undefined)?.data
  const vectors: Float32Array[] = []
  for (let row = 0; row < count; row += 1) {
    const base = row * sequence * dim
    const vector = new Float32Array(dim)
    let tokens = 0
    for (let step = 0; step < sequence; step += 1) {
      if (mask && Number(mask[row * sequence + step] ?? 1) === 0) continue
      tokens += 1
      for (let index = 0; index < dim; index += 1) {
        vector[index] = (vector[index] ?? 0) + (tensor.data[base + step * dim + index] ?? 0)
      }
    }
    let norm = 0
    const scale = tokens > 0 ? 1 / tokens : 0
    for (let index = 0; index < dim; index += 1) {
      vector[index] = (vector[index] ?? 0) * scale
      norm += (vector[index] ?? 0) * (vector[index] ?? 0)
    }
    const inverse = norm > 0 ? 1 / Math.sqrt(norm) : 0
    for (let index = 0; index < dim; index += 1) vector[index] = (vector[index] ?? 0) * inverse
    vectors.push(vector)
  }
  return { vectors, dim }
}

/** Embed passages (optionally with a model prefix); returns one normalized vector per text. */
export async function embedTexts(texts: string[], kind: 'doc' | 'query' = 'doc'): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  const { tokenizer, model } = await loadEmbedder()
  const prefix = kind === 'doc' ? DOC_PREFIX : QUERY_PREFIX
  const payload = prefix ? texts.map((text) => prefix + text) : texts
  const vectors: Float32Array[] = []
  for (let offset = 0; offset < payload.length; offset += EMBED_BATCH) {
    const batch = payload.slice(offset, offset + EMBED_BATCH)
    const inputs = await tokenizer(batch, { padding: true, truncation: true, max_length: 512 })
    const output = await model(inputs)
    const { vectors: pooled } =
      EMBED_POOL === 'mean' ? poolMean(output, inputs as Record<string, unknown>, batch.length) : poolCls(output, batch.length)
    vectors.push(...pooled)
  }
  return vectors
}

export async function embedQuery(text: string, instruction = false): Promise<Float32Array | null> {
  try {
    // bge models are trained with an instruction prefix on Chinese queries for
    // retrieval. It helps same-language search but *hurts* cross-lingual search,
    // so `searchMemory` only enables it when no glossary translation fired.
    const instructionPrefix =
      instruction && INSTRUCTION_ENABLED && /[\u4e00-\u9fff]/.test(text)
        ? '为这个句子生成表示以用于检索相关文章：'
        : ''
    const [vector] = await embedTexts([instructionPrefix + text], 'query')
    return vector ?? null
  } catch {
    return null
  }
}

/** Cross-encoder scores in [0,1]; higher means the passage answers the query. */
export async function rerankScores(query: string, documents: string[]): Promise<number[] | null> {
  if (documents.length === 0) return []
  try {
    const { tokenizer, model } = await loadReranker(rerankModelFor(query))
    const scores: number[] = []
    for (let offset = 0; offset < documents.length; offset += 8) {
      const batch = documents.slice(offset, offset + 8)
      const inputs = await tokenizer(batch.map(() => query), {
        text_pair: batch,
        padding: true,
        truncation: true,
        max_length: 512
      })
      const output = await model(inputs)
      const tensor = (output as { logits?: Tensor }).logits as Tensor
      for (const logit of tensor.data) {
        scores.push(1 / (1 + Math.exp(-logit)))
      }
    }
    return scores
  } catch (error) {
    console.error('[semantic] rerank failed:', error)
    return null
  }
}

export function rerankSize(): number {
  return MAX_RERANK_DOCS
}
