/**
 * Vector constellation builder for the knowledge graph.
 *
 * The memory host owns the facts (SQLite), while this module turns one or more
 * workspaces into a star map:
 *
 *   1. every indexed document (note / evidence / wiki) becomes a star;
 *   2. semantic vectors (bge-base-zh) or, when the index is cold, deterministic
 *      hashed vectors define the star's position via a whitened PCA projection;
 *   3. k-nearest-neighbour cosine similarity draws the "gravity" lines;
 *   4. note→evidence, evidence→source and wiki→source relations draw the hard
 *      structural lines;
 *   5. documents without a vector (every source, plus documents the embedding
 *      model has not reached yet) are anchored at the centroid of their
 *      neighbours, so a source sits in the middle of its evidence cluster;
 *   6. k-means over the projected sky names the constellations.
 *
 * Everything here is deterministic: the same corpus always yields the same
 * map, which matters because the renderer keeps a client-side viewport and the
 * agent can cite stable coordinates.
 */
import type {
  KnowledgeGraph,
  KnowledgeGraphCluster,
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeGraphNodeKind,
  KnowledgeGraphScope,
  KnowledgeGraphSpace,
  KnowledgeGraphStats,
  MemoryNoteType
} from '../shared/protocol'

export interface GraphDoc {
  /** Globally unique `${workspaceId}:${kind}:${id}` key used by edges. */
  key: string
  id: string
  kind: KnowledgeGraphNodeKind
  title: string
  body: string
  workspaceId: string
  workspaceName: string
  noteType?: MemoryNoteType
  createdAt: number
  /** Null means "no vector": anchored to the neighbours instead of projected. */
  vector: Float32Array | null
}

export interface GraphStructuralEdge {
  source: string
  target: string
  kind: 'evidence' | 'cites' | 'source'
}

export interface BuildOptions {
  scope: KnowledgeGraphScope
  maxNodes: number
  /** Absolute cosine floor; omitted means "use the default for this space". */
  minSimilarity?: number
  space: KnowledgeGraphSpace
  dim: number
  model: string
  totalDocs: number
  truncated: boolean
  notes?: string[]
}

const DEFAULT_SIMILARITY: Record<KnowledgeGraphSpace, number> = {
  semantic: 0.6,
  hashed: 0.22
}

/** Pooling target for the kNN + PCA pass keeps the O(n²) scan cheap. */
const POOL_TARGET = 48

const CJK_RUN = /[\u3400-\u9fff]{2,}/g
const ASCII_WORD = /[A-Za-z][A-Za-z0-9_+#.-]{2,}/g

const STOP_CHARS = new Set('的是了在和与或及把被对从到而也都就这那你我他她它之其或于很更最不没'.split(''))

const STOP_TOKENS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'not',
  'you',
  'are',
  'was',
  'has',
  'have',
  'but',
  'can',
  'will',
  'use',
  'one',
  'our',
  '的',
  '了',
  '和',
  '与',
  '或',
  '及',
  '是',
  '在',
  '有',
  '中',
  '上',
  '下',
  '为',
  '对',
  '从',
  '到',
  '一个',
  '我们',
  '可以',
  '没有',
  '这个',
  '那个',
  '因为',
  '所以',
  '如果',
  '就是',
  '不是',
  '还是',
  '需要',
  '使用',
  '通过',
  '基于',
  '进行',
  '以及',
  '并且',
  '可能',
  '应该',
  '已经',
  '目前',
  '现在'
])

function fnv1a(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

function normalizeInPlace(vector: Float32Array): number {
  let norm = 0
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] ?? 0
    norm += value * value
  }
  norm = Math.sqrt(norm)
  if (norm < 1e-9) return 0
  const scale = 1 / norm
  for (let index = 0; index < vector.length; index += 1) vector[index] = (vector[index] ?? 0) * scale
  return norm
}

/**
 * Mean-pool embeddings into a lower-dimensional proxy. Embedding dimensions
 * are semantically redundant (768 dims from a 12-layer encoder), so block
 * means preserve the cosine ordering closely enough for kNN, while making the
 * all-pairs scan and the power iteration an order of magnitude cheaper.
 */
function poolVectors(vectors: Float32Array[], target = POOL_TARGET): Float32Array[] {
  const sourceDim = vectors[0]?.length ?? 0
  if (sourceDim === 0) return vectors.map(() => new Float32Array(0))
  const blocks = Math.max(1, Math.min(target, sourceDim))
  const pooled: Float32Array[] = []
  for (const vector of vectors) {
    const result = new Float32Array(blocks)
    for (let block = 0; block < blocks; block += 1) {
      const start = Math.floor((block * sourceDim) / blocks)
      const end = Math.max(start + 1, Math.floor(((block + 1) * sourceDim) / blocks))
      let sum = 0
      for (let index = start; index < end; index += 1) sum += vector[index] ?? 0
      result[block] = sum / (end - start)
    }
    normalizeInPlace(result)
    pooled.push(result)
  }
  return pooled
}

interface Projection {
  xs: Float32Array
  ys: Float32Array
  zs: Float32Array
  coverage: number
}

/** Power iteration on the covariance of the (pooled) vectors. */
function dominantAxis(
  matrix: Float32Array,
  count: number,
  dim: number,
  salt: number
): { axis: Float32Array; variance: number } {
  const axis = new Float32Array(dim)
  for (let index = 0; index < dim; index += 1) {
    axis[index] = Math.sin((index + 1) * (12.9898 + salt)) + Math.cos((index + 1) * (4.1414 + salt * 0.5))
  }
  if (normalizeInPlace(axis) === 0) axis[0] = 1

  const scratch = new Float32Array(count)
  const next = new Float32Array(dim)
  for (let iteration = 0; iteration < 26; iteration += 1) {
    for (let index = 0; index < count; index += 1) {
      const base = index * dim
      let sum = 0
      for (let d = 0; d < dim; d += 1) sum += (matrix[base + d] ?? 0) * (axis[d] ?? 0)
      scratch[index] = sum
    }
    next.fill(0)
    for (let index = 0; index < count; index += 1) {
      const weight = scratch[index] ?? 0
      if (weight === 0) continue
      const base = index * dim
      for (let d = 0; d < dim; d += 1) next[d] = (next[d] ?? 0) + weight * (matrix[base + d] ?? 0)
    }
    if (normalizeInPlace(next) < 1e-9) break
    axis.set(next)
  }

  let variance = 0
  for (let index = 0; index < count; index += 1) {
    const base = index * dim
    let sum = 0
    for (let d = 0; d < dim; d += 1) sum += (matrix[base + d] ?? 0) * (axis[d] ?? 0)
    variance += sum * sum
  }
  return { axis, variance: variance / Math.max(1, count) }
}

function projectVectors(vectors: Float32Array[], dim: number): Projection {
  const count = vectors.length
  const xs = new Float32Array(count)
  const ys = new Float32Array(count)
  const zs = new Float32Array(count)
  if (count < 2 || dim === 0) return { xs, ys, zs, coverage: 0 }

  const mean = new Float32Array(dim)
  for (const vector of vectors) {
    for (let d = 0; d < dim; d += 1) mean[d] = (mean[d] ?? 0) + (vector[d] ?? 0) / count
  }

  const centered = new Float32Array(count * dim)
  let total = 0
  for (let index = 0; index < count; index += 1) {
    const vector = vectors[index]
    const base = index * dim
    let norm = 0
    for (let d = 0; d < dim; d += 1) {
      const value = (vector?.[d] ?? 0) - (mean[d] ?? 0)
      centered[base + d] = value
      norm += value * value
    }
    total += norm
  }
  total /= count
  if (total < 1e-9) return { xs, ys, zs, coverage: 0 }

  const first = dominantAxis(centered, count, dim, 0)
  const firstScale = Math.sqrt(Math.max(first.variance, 1e-9))

  // Deflate along the first axis before searching for the second one.
  let secondVariance = 0
  const deflated = new Float32Array(count * dim)
  for (let index = 0; index < count; index += 1) {
    const base = index * dim
    let dot = 0
    for (let d = 0; d < dim; d += 1) dot += (centered[base + d] ?? 0) * (first.axis[d] ?? 0)
    for (let d = 0; d < dim; d += 1) {
      const value = (centered[base + d] ?? 0) - dot * (first.axis[d] ?? 0)
      deflated[base + d] = value
      secondVariance += value * value
    }
  }
  secondVariance /= count

  let secondScale = Math.max(firstScale, 1e-9)
  let secondAxis: Float32Array | null = null
  if (secondVariance > total * 1e-6) {
    const second = dominantAxis(deflated, count, dim, 1.618)
    secondAxis = second.axis
    secondScale = Math.sqrt(Math.max(second.variance, 1e-9))
  }

  // Third axis: deflate the second direction away, then look for depth. A flat
  // corpus keeps a gentle deterministic wobble so the 3D view still reads.
  let thirdAxis: Float32Array | null = null
  let thirdScale = secondScale
  if (secondAxis) {
    const deflatedAgain = new Float32Array(count * dim)
    let thirdVariance = 0
    for (let index = 0; index < count; index += 1) {
      const base = index * dim
      let dot = 0
      for (let d = 0; d < dim; d += 1) dot += (deflated[base + d] ?? 0) * (secondAxis[d] ?? 0)
      for (let d = 0; d < dim; d += 1) {
        const value = (deflated[base + d] ?? 0) - dot * (secondAxis[d] ?? 0)
        deflatedAgain[base + d] = value
        thirdVariance += value * value
      }
    }
    thirdVariance /= count
    if (thirdVariance > total * 1e-6) {
      const third = dominantAxis(deflatedAgain, count, dim, 2.718)
      thirdAxis = third.axis
      thirdScale = Math.sqrt(Math.max(third.variance, 1e-9))
    }
  }

  // Whitening: divide by the axis standard deviation so a single dominant
  // direction cannot squash the whole map into a thin band.
  for (let index = 0; index < count; index += 1) {
    const base = index * dim
    let x = 0
    for (let d = 0; d < dim; d += 1) x += (centered[base + d] ?? 0) * (first.axis[d] ?? 0)
    xs[index] = clamp((x / firstScale) * 0.5, -1.15, 1.15)
    if (secondAxis) {
      let y = 0
      for (let d = 0; d < dim; d += 1) y += (centered[base + d] ?? 0) * (secondAxis[d] ?? 0)
      ys[index] = clamp((y / secondScale) * 0.5, -1.15, 1.15)
    } else {
      // Degenerate (rank-one) sky: spread the stars on a gentle sine instead
      // of stacking them on a single line.
      ys[index] = clamp(Math.sin(index * 2.3999) * 0.14 * (0.5 + (index % 7) / 7), -1.15, 1.15)
    }
    if (thirdAxis) {
      let z = 0
      for (let d = 0; d < dim; d += 1) z += (centered[base + d] ?? 0) * (thirdAxis[d] ?? 0)
      zs[index] = clamp((z / thirdScale) * 0.5, -1.15, 1.15)
    } else {
      zs[index] = clamp(Math.sin(index * 1.618) * 0.18, -1.15, 1.15)
    }
  }

  const coverage = clamp((first.variance + Math.max(secondVariance, 0)) / total, 0, 1)
  return { xs, ys, zs, coverage }
}

interface SimilarPair {
  i: number
  j: number
  similarity: number
}

interface NearestPairs {
  same: SimilarPair[]
  cross: SimilarPair[]
}

/**
 * Mutual kNN over pooled vectors. Same-workspace pairs use the similarity
 * floor, which produces the sparse, slightly organic web a constellation needs.
 * Cross-workspace pairs use a lower floor and their own small budget so every
 * knowledge base keeps a visible bridge to its nearest neighbour elsewhere.
 */
function nearestPairs(
  vectors: Float32Array[],
  threshold: number,
  maxPerNode: number,
  workspaces: string[],
  crossFloor: number
): NearestPairs {
  const count = vectors.length
  const empty: NearestPairs = { same: [], cross: [] }
  if (count < 2) return empty
  const k = Math.max(2, Math.min(maxPerNode, count - 1))
  const crossK = 2
  type Offer = { index: number; similarity: number }
  const sameTop: Offer[][] = Array.from({ length: count }, () => [])
  const crossTop: Offer[][] = Array.from({ length: count }, () => [])

  const offer = (slot: Offer[], index: number, similarity: number, limit: number): void => {
    if (slot.length === limit && similarity <= (slot[slot.length - 1]?.similarity ?? -1)) return
    let position = slot.length
    while (position > 0 && (slot[position - 1]?.similarity ?? -1) < similarity) position -= 1
    slot.splice(position, 0, { index, similarity })
    if (slot.length > limit) slot.pop()
  }

  for (let i = 0; i < count; i += 1) {
    const a = vectors[i]
    if (!a) continue
    for (let j = i + 1; j < count; j += 1) {
      const b = vectors[j]
      if (!b) continue
      const similarity = cosineSimilarity(a, b)
      if ((workspaces[i] ?? '') !== (workspaces[j] ?? '')) {
        if (similarity < crossFloor) continue
        offer(crossTop[i]!, j, similarity, crossK)
        offer(crossTop[j]!, i, similarity, crossK)
        continue
      }
      if (similarity < threshold) continue
      offer(sameTop[i]!, j, similarity, k)
      offer(sameTop[j]!, i, similarity, k)
    }
  }

  const collect = (tops: Offer[][]): SimilarPair[] => {
    const best = new Map<string, SimilarPair>()
    for (let i = 0; i < count; i += 1) {
      for (const entry of tops[i] ?? []) {
        const low = Math.min(i, entry.index)
        const high = Math.max(i, entry.index)
        const key = `${low}:${high}`
        const current = best.get(key)
        if (!current || current.similarity < entry.similarity) {
          best.set(key, { i: low, j: high, similarity: entry.similarity })
        }
      }
    }
    return [...best.values()]
  }

  return { same: collect(sameTop), cross: collect(crossTop) }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const size = Math.min(a.length, b.length)
  let dot = 0
  for (let index = 0; index < size; index += 1) dot += (a[index] ?? 0) * (b[index] ?? 0)
  return dot
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0
  const index = clamp(Math.floor(fraction * (values.length - 1)), 0, values.length - 1)
  return values[index] ?? 0
}

interface Point {
  x: number
  y: number
  z: number
}

/** Deterministic k-means over the projected sky. */
function clusterPoints(points: Point[], targetClusters: number): number[] {
  const count = points.length
  const assignments = new Array<number>(count).fill(0)
  if (count < 2) return assignments
  const k = clamp(targetClusters, 1, count)
  if (k < 2) return assignments

  const centers: Point[] = []
  let firstIndex = 0
  let farthest = -1
  points.forEach((point, index) => {
    const distance = point.x * point.x + point.y * point.y + point.z * point.z
    if (distance > farthest) {
      farthest = distance
      firstIndex = index
    }
  })
  centers.push(points[firstIndex] ?? { x: 0, y: 0, z: 0 })

  while (centers.length < k) {
    let candidate = -1
    let bestDistance = -1
    for (let index = 0; index < count; index += 1) {
      const point = points[index]
      if (!point) continue
      let nearest = Number.POSITIVE_INFINITY
      for (const center of centers) {
        const dx = point.x - center.x
        const dy = point.y - center.y
        const dz = point.z - center.z
        nearest = Math.min(nearest, dx * dx + dy * dy + dz * dz)
      }
      if (nearest > bestDistance) {
        bestDistance = nearest
        candidate = index
      }
    }
    if (candidate < 0) break
    centers.push(points[candidate] ?? { x: 0, y: 0, z: 0 })
  }

  for (let iteration = 0; iteration < 14; iteration += 1) {
    let moved = false
    for (let index = 0; index < count; index += 1) {
      const point = points[index]
      if (!point) continue
      let nearest = 0
      let bestDistance = Number.POSITIVE_INFINITY
      centers.forEach((center, centerIndex) => {
        const dx = point.x - center.x
        const dy = point.y - center.y
        const dz = point.z - center.z
        const distance = dx * dx + dy * dy + dz * dz
        if (distance < bestDistance) {
          bestDistance = distance
          nearest = centerIndex
        }
      })
      if (assignments[index] !== nearest) {
        assignments[index] = nearest
        moved = true
      }
    }
    const sums = centers.map(() => ({ x: 0, y: 0, z: 0, weight: 0 }))
    for (let index = 0; index < count; index += 1) {
      const sum = sums[assignments[index] ?? 0]
      const point = points[index]
      if (!sum || !point) continue
      sum.x += point.x
      sum.y += point.y
      sum.z += point.z
      sum.weight += 1
    }
    sums.forEach((sum, centerIndex) => {
      if (sum.weight > 0) {
        centers[centerIndex] = { x: sum.x / sum.weight, y: sum.y / sum.weight, z: sum.z / sum.weight }
      }
    })
    if (!moved) break
  }

  // Relabel by cluster size so colour 0 is always the largest constellation.
  const sizes = new Map<number, number>()
  for (const assignment of assignments) sizes.set(assignment, (sizes.get(assignment) ?? 0) + 1)
  const order = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id)
  const remap = new Map(order.map((id, index) => [id, index]))
  return assignments.map((assignment) => remap.get(assignment) ?? 0)
}

/** Frequent tokens across the constellation's titles, used as cluster tags. */
function keywordsFor(texts: string[], limit: number): string[] {
  const scores = new Map<string, number>()
  const bump = (token: string, weight: number): void => {
    if (token.length < 2 || STOP_TOKENS.has(token)) return
    scores.set(token, (scores.get(token) ?? 0) + weight)
  }

  for (const text of texts) {
    const sample = text.slice(0, 180)
    for (const word of sample.match(ASCII_WORD) ?? []) bump(word.toLowerCase(), 2)
    for (const run of sample.match(CJK_RUN) ?? []) {
      for (let index = 0; index + 1 < run.length; index += 1) {
        const first = run[index] ?? ''
        const second = run[index + 1] ?? ''
        if (STOP_CHARS.has(first) || STOP_CHARS.has(second)) continue
        bump(`${first}${second}`, 2)
      }
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token)
}

function shortTitle(title: string, max = 14): string {
  const compact = title.replace(/\s+/g, ' ').trim()
  return compact.length > max ? `${compact.slice(0, max)}…` : compact
}

function anchorJitter(key: string): Point {
  const hash = fnv1a(key)
  const angle = ((hash % 3600) / 3600) * Math.PI * 2
  const tilt = (((hash >>> 12) % 1000) / 1000) * 0.7 - 0.35
  const radius = 0.04 + (((hash >>> 9) % 1000) / 1000) * 0.055
  return { x: Math.cos(angle) * radius, y: tilt * radius, z: Math.sin(angle) * radius }
}

/**
 * Documents without vectors are drawn to the barycentre of their neighbours.
 * A few relaxation passes let sources settle after their evidence has moved.
 */
function placeAnchors(
  keys: string[],
  positions: Map<string, Point>,
  adjacency: Map<string, Set<string>>
): void {
  const pending = new Set(keys)
  for (let pass = 0; pass < 6 && pending.size > 0; pass += 1) {
    let placedAny = false
    for (const key of [...pending]) {
      const neighbours = adjacency.get(key)
      if (!neighbours) continue
      let x = 0
      let y = 0
      let z = 0
      let count = 0
      for (const neighbour of neighbours) {
        const point = positions.get(neighbour)
        if (!point) continue
        x += point.x
        y += point.y
        z += point.z
        count += 1
      }
      if (count === 0) continue
      const jitter = anchorJitter(key)
      positions.set(key, { x: x / count + jitter.x, y: y / count + jitter.y, z: z / count + jitter.z })
      pending.delete(key)
      placedAny = true
    }
    if (!placedAny) break
  }

  for (const key of pending) {
    const hash = fnv1a(key)
    const angle = ((hash % 3600) / 3600) * Math.PI * 2
    const radius = 0.6 + (((hash >>> 9) % 1000) / 1000) * 0.3
    const tilt = (hash % 200) / 200 - 0.5
    positions.set(key, { x: Math.cos(angle) * radius, y: tilt * radius, z: Math.sin(angle) * radius })
  }
}

function normalizeSky(positions: Map<string, Point>): void {
  let extent = 0
  for (const point of positions.values()) {
    extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y), Math.abs(point.z))
  }
  if (extent < 1e-6) {
    for (const [key, point] of positions) {
      const jitter = anchorJitter(key)
      positions.set(key, { x: point.x + jitter.x, y: point.y + jitter.y, z: point.z + jitter.z })
    }
    return
  }
  // Shrink oversized skies; never inflate beyond a comfortable star radius.
  const scale = extent > 1.02 ? 1 / extent : extent < 0.34 ? 0.34 / extent : 1
  for (const point of positions.values()) {
    point.x = clamp(point.x * scale, -1, 1)
    point.y = clamp(point.y * scale, -1, 1)
    point.z = clamp(point.z * scale, -1, 1)
  }
}

/**
 * PCA squeezes every document into a narrow band, so a dense corpus collapses
 * into one bright blob. Give each k-means constellation its own sphere in a 3D
 * shell and lay its members out with a Fibonacci sphere: clusters stay legible
 * from any orbit angle and no two stars land on top of each other.
 */
function packConstellations(
  positions: Map<string, Point>,
  members: string[],
  clusterOf: Map<string, number>,
  clusterCount: number
): void {
  if (members.length === 0) return
  const ids: number[] = []
  for (let id = 0; id < clusterCount; id += 1) {
    if (members.some((key) => (clusterOf.get(key) ?? 0) === id)) ids.push(id)
  }
  if (ids.length === 0) return

  const sphereRadius = clamp(0.36 - 0.016 * ids.length, 0.19, 0.36)
  const golden = Math.PI * (3 - Math.sqrt(5))
  ids.forEach((id, order) => {
    const group = members.filter((key) => (clusterOf.get(key) ?? 0) === id)
    if (group.length === 0) return
    // Spread cluster centres over a sphere (Fibonacci directions) so the map
    // reads as a volume from any orbit angle instead of a flat ring.
    const centreY = ids.length === 1 ? 0 : 1 - (2 * (order + 0.5)) / ids.length
    const centreRing = Math.sqrt(Math.max(0, 1 - centreY * centreY))
    const angle = ids.length === 1 ? 0 : order * 2.399963229728653 + 0.35
    const ring = ids.length === 1 ? 0 : 0.62
    const center = {
      x: Math.cos(angle) * centreRing * ring,
      y: centreY * 0.46,
      z: Math.sin(angle) * centreRing * ring
    }
    const phase = order * 0.9
    group.forEach((key, index) => {
      // Fibonacci sphere: even spacing in a ball, so no star lands on another.
      const cosPhi = 1 - (2 * (index + 0.5)) / (group.length + 0.6)
      const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi))
      const theta = index * golden + phase
      const radius = sphereRadius * Math.cbrt((index + 0.7) / (group.length + 0.3))
      positions.set(key, {
        x: clamp(center.x + Math.cos(theta) * sinPhi * radius, -1, 1),
        y: clamp(center.y + cosPhi * radius, -1, 1),
        z: clamp(center.z + Math.sin(theta) * sinPhi * radius, -1, 1)
      })
    })
  })
}

export function buildConstellation(
  docs: GraphDoc[],
  structural: GraphStructuralEdge[],
  options: BuildOptions
): KnowledgeGraph {
  const byKey = new Map(docs.map((doc) => [doc.key, doc]))
  const suggestedThreshold = DEFAULT_SIMILARITY[options.space]
  const threshold = clamp(options.minSimilarity ?? suggestedThreshold, 0, 1)

  const edges = new Map<string, KnowledgeGraphEdge>()

  for (const link of structural) {
    if (link.source === link.target) continue
    if (!byKey.has(link.source) || !byKey.has(link.target)) continue
    const key = pairKey(link.source, link.target)
    if (edges.has(key)) continue
    edges.set(key, {
      source: link.source,
      target: link.target,
      kind: link.kind,
      weight: 0.85,
      similarity: 1,
      crossWorkspace: false
    })
  }

  const withVectors: GraphDoc[] = []
  const anchored: GraphDoc[] = []
  for (const doc of docs) {
    if (doc.kind === 'source' || !doc.vector || doc.vector.length === 0) anchored.push(doc)
    else withVectors.push(doc)
  }

  const positions = new Map<string, Point>()
  let clusterCount = 1
  let coverage = 0

  if (withVectors.length > 0) {
    const pooled = poolVectors(withVectors.map((doc) => doc.vector as Float32Array))
    const projection = projectVectors(pooled, pooled[0]?.length ?? 0)
    coverage = projection.coverage
    withVectors.forEach((doc, index) => {
      positions.set(doc.key, {
        x: clamp(projection.xs[index] ?? 0, -1.15, 1.15),
        y: clamp(projection.ys[index] ?? 0, -1.15, 1.15),
        z: clamp(projection.zs[index] ?? 0, -1.15, 1.15)
      })
    })

    const workspaces = withVectors.map((doc) => doc.workspaceId)
    const crossFloor = Math.min(threshold, Math.max(0.1, threshold * 0.55))
    const pairs = nearestPairs(pooled, threshold, 6, workspaces, crossFloor)
    const cap = Math.max(160, withVectors.length * 4)
    const retained = pairs.same.sort((a, b) => b.similarity - a.similarity).slice(0, cap)
    const similarities = retained.map((pair) => pair.similarity).sort((a, b) => a - b)
    const low = percentile(similarities, 0.05)
    const high = percentile(similarities, 0.95)
    const spread = Math.max(1e-6, high - low)

    for (const pair of retained) {
      const left = withVectors[pair.i]
      const right = withVectors[pair.j]
      if (!left || !right) continue
      const key = pairKey(left.key, right.key)
      if (edges.has(key)) continue
      edges.set(key, {
        source: left.key,
        target: right.key,
        kind: 'similar',
        weight: clamp((pair.similarity - low) / spread, 0.16, 1),
        similarity: pair.similarity,
        crossWorkspace: false
      })
    }

    // Cross-knowledge-base bridges: the nearest few pairs in the other
    // workspace, kept even below the intra-base threshold so the star map can
    // show which bases orbit the same region.
    const bridges = pairs.cross.sort((a, b) => b.similarity - a.similarity).slice(0, 36)
    if (bridges.length > 0) {
      const values = bridges.map((pair) => pair.similarity).sort((a, b) => a - b)
      const bridgeLow = percentile(values, 0.05)
      const bridgeHigh = percentile(values, 0.95)
      const bridgeSpread = Math.max(1e-6, bridgeHigh - bridgeLow)
      for (const pair of bridges) {
        const left = withVectors[pair.i]
        const right = withVectors[pair.j]
        if (!left || !right) continue
        const key = pairKey(left.key, right.key)
        if (edges.has(key)) continue
        edges.set(key, {
          source: left.key,
          target: right.key,
          kind: 'bridge',
          weight: clamp(0.3 + ((pair.similarity - bridgeLow) / bridgeSpread) * 0.7, 0.28, 1),
          similarity: pair.similarity,
          crossWorkspace: true
        })
      }
    }

    clusterCount = withVectors.length < 4 ? 1 : clamp(Math.round(Math.sqrt(withVectors.length / 8)), 2, 9)
    const assignments = clusterPoints(
      withVectors.map((doc) => positions.get(doc.key) ?? { x: 0, y: 0, z: 0 }),
      clusterCount
    )
    const clusterOf = new Map<string, number>()
    withVectors.forEach((doc, index) => clusterOf.set(doc.key, assignments[index] ?? 0))
    clusterCount = Math.max(1, new Set(assignments).size)

    const adjacency = new Map<string, Set<string>>()
    for (const key of byKey.keys()) adjacency.set(key, new Set())
    for (const edge of edges.values()) {
      adjacency.get(edge.source)?.add(edge.target)
      adjacency.get(edge.target)?.add(edge.source)
    }

    const unresolved: string[] = []
    for (const doc of anchored) {
      const tally = new Map<number, number>()
      for (const neighbour of adjacency.get(doc.key) ?? []) {
        const cluster = clusterOf.get(neighbour)
        if (cluster === undefined) continue
        tally.set(cluster, (tally.get(cluster) ?? 0) + 1)
      }
      if (tally.size === 0) {
        unresolved.push(doc.key)
        continue
      }
      let winner = 0
      let votes = -1
      for (const [cluster, count] of tally) {
        if (count > votes) {
          votes = count
          winner = cluster
        }
      }
      clusterOf.set(doc.key, winner)
    }

    for (const key of unresolved) {
      const point = positions.get(key)
      const doc = byKey.get(key)
      let nearest: string | null = null
      let best = Number.POSITIVE_INFINITY
      for (const candidate of withVectors) {
        const position = positions.get(candidate.key)
        if (!position || !point) continue
        const dx = position.x - point.x
        const dy = position.y - point.y
        const dz = position.z - point.z
        const distance = dx * dx + dy * dy + dz * dz
        if (distance < best) {
          best = distance
          nearest = candidate.key
        }
      }
      clusterOf.set(key, (nearest ? clusterOf.get(nearest) : undefined) ?? (doc ? Math.abs(fnv1a(doc.key)) % clusterCount : 0))
    }

    packConstellations(
      positions,
      withVectors.map((doc) => doc.key),
      clusterOf,
      clusterCount
    )
    placeAnchors(anchored.map((doc) => doc.key), positions, adjacency)
    normalizeSky(positions)

    const degree = new Map<string, number>()
    for (const edge of edges.values()) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
    }
    const maxDegree = Math.max(1, ...degree.values())
    const similaritySum = new Map<string, { total: number; count: number }>()
    for (const edge of edges.values()) {
      if (edge.kind === 'similar' || edge.kind === 'bridge') {
        for (const key of [edge.source, edge.target]) {
          const entry = similaritySum.get(key) ?? { total: 0, count: 0 }
          entry.total += edge.similarity
          entry.count += 1
          similaritySum.set(key, entry)
        }
      }
    }

    const nodes: KnowledgeGraphNode[] = docs.map((doc) => {
      const point = positions.get(doc.key) ?? { x: 0, y: 0, z: 0 }
      const similarity = similaritySum.get(doc.key)
      return {
        key: doc.key,
        id: doc.id,
        kind: doc.kind,
        title: doc.title,
        excerpt: doc.body.replace(/\s+/g, ' ').trim().slice(0, 240),
        workspaceId: doc.workspaceId,
        workspaceName: doc.workspaceName,
        ...(doc.noteType ? { noteType: doc.noteType } : {}),
        x: Math.round(point.x * 10000) / 10000,
        y: Math.round(point.y * 10000) / 10000,
        z: Math.round(point.z * 10000) / 10000,
        cluster: clusterOf.get(doc.key) ?? 0,
        degree: degree.get(doc.key) ?? 0,
        weight: Math.round(Math.sqrt((degree.get(doc.key) ?? 0) / maxDegree) * 1000) / 1000,
        similarity: similarity && similarity.count > 0 ? Math.round((similarity.total / similarity.count) * 1000) / 1000 : 0,
        semantic: doc.vector !== null && doc.kind !== 'source',
        createdAt: doc.createdAt
      }
    })

    const clusters: KnowledgeGraphCluster[] = []
    for (let id = 0; id < clusterCount; id += 1) {
      const members = nodes.filter((node) => node.cluster === id)
      if (members.length === 0) continue
      const rankedMembers = [...members].sort((a, b) => b.weight - a.weight || b.degree - a.degree)
      const names: string[] = []
      for (const member of rankedMembers) {
        const name = shortTitle(member.title)
        if (!name || names.includes(name)) continue
        names.push(name)
        if (names.length >= 2) break
      }
      const label = names.length > 0 ? names.join(' · ') : `星群 ${id + 1}`
      const sumX = members.reduce((total, node) => total + node.x, 0) / members.length
      const sumY = members.reduce((total, node) => total + node.y, 0) / members.length
      const sumZ = members.reduce((total, node) => total + node.z, 0) / members.length
      const workspaceIds = [...new Set(members.map((node) => node.workspaceId))]
      clusters.push({
        id,
        label: label.length > 26 ? `${label.slice(0, 26)}…` : label,
        keywords: keywordsFor(
          rankedMembers.slice(0, 14).map((node) => `${node.title} ${node.excerpt}`),
          5
        ),
        size: members.length,
        x: Math.round(sumX * 10000) / 10000,
        y: Math.round(sumY * 10000) / 10000,
        z: Math.round(sumZ * 10000) / 10000,
        workspaceIds
      })
    }

    const edgeList = [...edges.values()]
    const stats: KnowledgeGraphStats = {
      nodeCount: nodes.length,
      edgeCount: edgeList.length,
      bridgeCount: edgeList.filter((edge) => edge.crossWorkspace).length,
      clusterCount: clusters.length,
      semanticCount: options.space === 'semantic' ? withVectors.length : 0,
      anchoredCount: anchored.length,
      workspaceCount: new Set(nodes.map((node) => node.workspaceId)).size,
      isolated: nodes.filter((node) => node.degree === 0).length,
      space: options.space,
      dim: options.dim,
      model: options.model,
      threshold: Math.round(threshold * 1000) / 1000,
      suggestedThreshold,
      totalDocs: options.totalDocs,
      truncated: options.truncated,
      generatedAt: Date.now()
    }

    return {
      scope: options.scope,
      nodes,
      edges: edgeList,
      clusters,
      stats,
      ...(options.notes && options.notes.length > 0 ? { notes: options.notes } : {}),
      ...(coverage > 0 ? { coverage: Math.round(coverage * 1000) / 1000 } : {})
    }
  }

  // No vectors at all: render the structural graph as a single wide constellation.
  const adjacency = new Map<string, Set<string>>()
  for (const edge of edges.values()) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set())
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set())
    adjacency.get(edge.source)?.add(edge.target)
    adjacency.get(edge.target)?.add(edge.source)
  }
  // Fibonacci sphere: a vector-less corpus still reads as a solid sky instead
  // of a pile of overlapping points.
  docs.forEach((doc, index) => {
    const cosPhi = docs.length <= 1 ? 1 : 1 - (2 * (index + 0.5)) / docs.length
    const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi))
    const theta = index * 2.399963229728653
    const radius = docs.length <= 1 ? 0.12 : 0.34 + Math.sqrt((index + 0.5) / docs.length) * 0.5
    positions.set(doc.key, {
      x: Math.cos(theta) * sinPhi * radius,
      y: cosPhi * radius,
      z: Math.sin(theta) * sinPhi * radius
    })
  })

  const nodes: KnowledgeGraphNode[] = docs.map((doc) => {
    const point = positions.get(doc.key) ?? { x: 0, y: 0, z: 0 }
    return {
      key: doc.key,
      id: doc.id,
      kind: doc.kind,
      title: doc.title,
      excerpt: doc.body.replace(/\s+/g, ' ').trim().slice(0, 240),
      workspaceId: doc.workspaceId,
      workspaceName: doc.workspaceName,
      ...(doc.noteType ? { noteType: doc.noteType } : {}),
      x: Math.round(point.x * 10000) / 10000,
      y: Math.round(point.y * 10000) / 10000,
      z: Math.round(point.z * 10000) / 10000,
      cluster: 0,
      degree: adjacency.get(doc.key)?.size ?? 0,
      weight: Math.sqrt(Math.min(1, (adjacency.get(doc.key)?.size ?? 0) / 6)),
      similarity: 0,
      semantic: false,
      createdAt: doc.createdAt
    }
  })

  const clusters: KnowledgeGraphCluster[] =
    nodes.length === 0
      ? []
      : [
          {
            id: 0,
            label: nodes.length > 0 ? shortTitle(nodes[0]?.title ?? '') : '星群 1',
            keywords: keywordsFor(nodes.slice(0, 14).map((node) => `${node.title} ${node.excerpt}`), 5),
            size: nodes.length,
            x: Math.round((nodes.reduce((sum, node) => sum + node.x, 0) / nodes.length) * 10000) / 10000,
            y: Math.round((nodes.reduce((sum, node) => sum + node.y, 0) / nodes.length) * 10000) / 10000,
            z: Math.round((nodes.reduce((sum, node) => sum + node.z, 0) / nodes.length) * 10000) / 10000,
            workspaceIds: [...new Set(nodes.map((node) => node.workspaceId))]
          }
        ]

  const edgeList = [...edges.values()]
  return {
    scope: options.scope,
    nodes,
    edges: edgeList,
    clusters,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edgeList.length,
      bridgeCount: edgeList.filter((edge) => edge.crossWorkspace).length,
      clusterCount: clusters.length,
      semanticCount: 0,
      anchoredCount: docs.length,
      workspaceCount: new Set(nodes.map((node) => node.workspaceId)).size,
      isolated: nodes.filter((node) => node.degree === 0).length,
      space: options.space,
      dim: options.dim,
      model: options.model,
      threshold: Math.round(threshold * 1000) / 1000,
      suggestedThreshold,
      totalDocs: options.totalDocs,
      truncated: options.truncated,
      generatedAt: Date.now()
    },
    ...(options.notes && options.notes.length > 0 ? { notes: options.notes } : {})
  }
}
