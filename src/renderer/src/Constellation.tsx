import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  KnowledgeGraph,
  KnowledgeGraphCluster,
  KnowledgeGraphNode,
  KnowledgeGraphNodeKind
} from '../../shared/protocol'

const PALETTE = [
  '#7dd3fc',
  '#c4b5fd',
  '#6ee7b7',
  '#fcd34d',
  '#f9a8d4',
  '#93c5fd',
  '#f0abfc',
  '#86efac',
  '#fdba74'
]

const KIND_LABELS: Record<KnowledgeGraphNodeKind, string> = {
  note: '笔记',
  evidence: '证据',
  wiki: 'Wiki',
  source: '资料'
}

const KIND_GLYPHS: Record<KnowledgeGraphNodeKind, string> = {
  note: '●',
  evidence: '◆',
  wiki: '◎',
  source: '✦'
}

const KIND_ORDER: KnowledgeGraphNodeKind[] = ['note', 'evidence', 'wiki', 'source']

const DEFAULT_CAMERA = { yaw: -0.55, pitch: 0.34, distance: 2.5, panX: 0, panY: 0 }

interface Camera {
  /** Rotation around the vertical axis. */
  yaw: number
  /** Tilt above the ecliptic; clamped so the pole never turns ambiguous. */
  pitch: number
  /** Camera distance from the centre of the sky. */
  distance: number
  panX: number
  panY: number
}

interface Projected {
  x: number
  y: number
  /** Depth toward the viewer: +1 is nearest, -1 farthest. */
  depth: number
  /** Pixels per world unit at this depth. */
  scale: number
}

interface HoverState {
  node: KnowledgeGraphNode
  x: number
  y: number
  width: number
  height: number
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  originYaw: number
  originPitch: number
  originPanX: number
  originPanY: number
  mode: 'orbit' | 'pan'
  moved: boolean
}

interface BackdropStar {
  x: number
  y: number
  radius: number
  phase: number
  alpha: number
}

interface ConstellationProps {
  graph: KnowledgeGraph
  threshold: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function colorFor(cluster: number): string {
  const index = ((cluster % PALETTE.length) + PALETTE.length) % PALETTE.length
  return PALETTE[index] ?? '#7dd3fc'
}

function withAlpha(hex: string, alpha: number): string {
  const raw = hex.replace('#', '')
  const red = Number.parseInt(raw.slice(0, 2), 16)
  const green = Number.parseInt(raw.slice(2, 4), 16)
  const blue = Number.parseInt(raw.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${clamp(alpha, 0, 1)})`
}

function makeBackdrop(seed: number): BackdropStar[] {
  let state = Math.imul(seed ^ 0x9e3779b9, 2654435761) >>> 0
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
  const stars: BackdropStar[] = []
  for (let index = 0; index < 160; index += 1) {
    stars.push({
      x: next(),
      y: next(),
      radius: 0.35 + next() * 1.05,
      phase: next() * Math.PI * 2,
      alpha: 0.1 + next() * 0.42
    })
  }
  return stars
}

/**
 * Rotate the sky (yaw around Y, then pitch around X), then apply a perspective
 * divide so nearer stars grow and drift away from the centre. Everything the
 * canvas renders goes through this single projection.
 */
function projectPoint(
  x: number,
  y: number,
  z: number,
  camera: Camera,
  width: number,
  height: number
): Projected {
  const cosYaw = Math.cos(camera.yaw)
  const sinYaw = Math.sin(camera.yaw)
  const x1 = x * cosYaw + z * sinYaw
  const z1 = -x * sinYaw + z * cosYaw
  const cosPitch = Math.cos(camera.pitch)
  const sinPitch = Math.sin(camera.pitch)
  const y2 = y * cosPitch - z1 * sinPitch
  const z2 = y * sinPitch + z1 * cosPitch
  const depth = camera.distance - z2
  const focal = 2.35
  const scale = Math.min(width, height) * 0.52 * (focal / Math.max(0.5, depth))
  return {
    x: width / 2 + camera.panX + x1 * scale,
    y: height / 2 + camera.panY + y2 * scale,
    depth: z2,
    scale
  }
}

function nodeRadius(node: KnowledgeGraphNode, density = 1): number {
  const base = 2 + clamp(node.weight, 0, 1) * 4.1 + (node.kind === 'source' ? 0.4 : 0)
  return base * density
}

interface Rect {
  x1: number
  y1: number
  x2: number
  y2: number
}

function overlaps(left: Rect, right: Rect, padding = 2): boolean {
  return !(
    left.x2 + padding < right.x1 ||
    right.x2 + padding < left.x1 ||
    left.y2 + padding < right.y1 ||
    right.y2 + padding < left.y1
  )
}

/**
 * Evidence nodes inherit their source's title, so a quote fragment reads much
 * better on the sky than the same filename repeated eight times.
 */
function cleanExcerpt(node: KnowledgeGraphNode): string {
  const clean = node.excerpt
    .replace(/\\\\[nrt]/g, ' ')
    .replace(/^#+\\s*/gm, '')
    .replace(/\\s+/g, ' ')
    .trim()
  return clean.startsWith(node.title) ? clean.slice(node.title.length).trim() : clean
}

function labelText(node: KnowledgeGraphNode): string {
  if (node.kind !== 'evidence') return node.title.slice(0, 16)
  const first = cleanExcerpt(node).split(/[。；;！？!?\\n]/)[0]?.trim() ?? ''
  return (first.length >= 4 ? first : node.title).slice(0, 14)
}

function edgeColor(
  kind: KnowledgeGraph['edges'][number]['kind'],
  sourceCluster: number,
  weight: number
): string {
  if (kind === 'bridge') return 'rgba(251, 191, 36, 0.4)'
  if (kind === 'similar') return withAlpha(colorFor(sourceCluster), 0.16 + clamp(weight, 0, 1) * 0.22)
  if (kind === 'cites') return 'rgba(125, 211, 252, 0.3)'
  if (kind === 'source') return 'rgba(94, 234, 212, 0.3)'
  return 'rgba(148, 163, 184, 0.34)'
}

export default function Constellation({ graph, threshold }: ConstellationProps): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cameraRef = useRef<Camera>({ ...DEFAULT_CAMERA })
  const dragRef = useRef<DragState | null>(null)
  const hoverRef = useRef<string | null>(null)
  const selectedRef = useRef<string | null>(null)
  const thresholdRef = useRef(threshold)
  const autoRef = useRef(true)
  const interactionRef = useRef(0)
  const [hover, setHover] = useState<HoverState | null>(null)
  const [selected, setSelected] = useState<KnowledgeGraphNode | null>(null)
  const [spinning, setSpinning] = useState(true)

  useEffect(() => {
    thresholdRef.current = threshold
  }, [threshold])

  useEffect(() => {
    autoRef.current = spinning
  }, [spinning])

  useEffect(() => {
    if (!selected) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setSelected(null)
        selectedRef.current = null
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selected])

  const nodeMap = useMemo(() => {
    const map = new Map<string, KnowledgeGraphNode>()
    for (const node of graph.nodes) map.set(node.key, node)
    return map
  }, [graph.nodes])

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const edge of graph.edges) {
      let source = map.get(edge.source)
      if (!source) {
        source = new Set()
        map.set(edge.source, source)
      }
      source.add(edge.target)
      let target = map.get(edge.target)
      if (!target) {
        target = new Set()
        map.set(edge.target, target)
      }
      target.add(edge.source)
    }
    return map
  }, [graph.edges])

  const labeled = useMemo(() => {
    // Big corpora turn into a wall of overlapping text, so keep the sky quiet
    // and let hover/selection reveal the rest.
    const limit = graph.nodes.length > 140 ? 8 : graph.nodes.length > 80 ? 10 : 12
    return [...graph.nodes]
      .filter((node) => node.degree > 0 && node.kind !== 'source')
      .sort((left, right) => right.weight - left.weight || left.key.localeCompare(right.key))
      .slice(0, limit)
  }, [graph.nodes])

  const density = graph.nodes.length > 240 ? 0.7 : graph.nodes.length > 120 ? 0.8 : 1

  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const backdrop = makeBackdrop(graph.nodes.length * 7919 + graph.edges.length * 131)
    let frame = 0
    let lastDrawn = 0
    let lastTime = 0

    const drawFrame = (time: number): void => {
      const width = stage.clientWidth
      const height = stage.clientHeight
      if (width <= 0 || height <= 0) return
      lastDrawn = time
      const delta = lastTime === 0 ? 0 : Math.min(64, time - lastTime)
      lastTime = time
      const camera = cameraRef.current
      if (autoRef.current && dragRef.current === null && time - interactionRef.current > 2400) {
        // A slow drift gives the sky parallax, which is what makes depth read
        // even on a still frame.
        camera.yaw += delta * 0.00007
      }
      const ratio = Math.min(2, window.devicePixelRatio || 1)
      const pixelWidth = Math.round(width * ratio)
      const pixelHeight = Math.round(height * ratio)
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth
        canvas.height = pixelHeight
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0)

      context.clearRect(0, 0, width, height)
      const sky = context.createRadialGradient(
        width * 0.5,
        height * 0.4,
        0,
        width * 0.5,
        height * 0.5,
        Math.max(width, height) * 0.8
      )
      sky.addColorStop(0, 'rgba(15, 31, 47, 0.97)')
      sky.addColorStop(0.5, 'rgba(8, 15, 24, 0.98)')
      sky.addColorStop(1, '#04070c')
      context.fillStyle = sky
      context.fillRect(0, 0, width, height)

      for (const star of backdrop) {
        const twinkle = 0.62 + 0.38 * Math.sin(time / 1100 + star.phase)
        context.globalAlpha = star.alpha * twinkle
        context.fillStyle = '#9fb8cf'
        context.beginPath()
        context.arc(star.x * width, star.y * height, star.radius, 0, Math.PI * 2)
        context.fill()
      }
      context.globalAlpha = 1

      // Faint orbital rings anchor the volume; they are drawn from real 3D
      // circles so they rotate with the camera like everything else.
      context.lineWidth = 1
      for (const ring of [
        { radius: 0.92, tilt: 0 },
        { radius: 0.62, tilt: 1.1 },
        { radius: 0.4, tilt: -0.9 }
      ]) {
        context.strokeStyle = 'rgba(125, 211, 252, 0.055)'
        context.beginPath()
        for (let step = 0; step <= 72; step += 1) {
          const angle = (step / 72) * Math.PI * 2
          const x = Math.cos(angle) * ring.radius
          const y = 0
          const z = Math.sin(angle) * ring.radius
          const tiltCos = Math.cos(ring.tilt)
          const tiltSin = Math.sin(ring.tilt)
          const point = projectPoint(x, y * tiltCos - z * tiltSin, z * tiltCos + y * tiltSin, camera, width, height)
          if (step === 0) context.moveTo(point.x, point.y)
          else context.lineTo(point.x, point.y)
        }
        context.stroke()
      }

      const projected = new Map<string, Projected>()
      for (const node of graph.nodes) {
        projected.set(node.key, projectPoint(node.x, node.y ?? 0, node.z ?? 0, camera, width, height))
      }

      const clusterCenters: Array<{ cluster: KnowledgeGraphCluster; x: number; y: number; radius: number }> = []
      for (const cluster of graph.clusters) {
        const center = projectPoint(cluster.x, cluster.y, cluster.z ?? 0, camera, width, height)
        let spread = 0
        for (const node of graph.nodes) {
          if (node.cluster !== cluster.id) continue
          const point = projected.get(node.key)
          if (!point) continue
          spread = Math.max(spread, Math.hypot(point.x - center.x, point.y - center.y))
        }
        const radius = clamp(Math.max(spread * 1.25, Math.sqrt(cluster.size) * 7), 24, 280)
        clusterCenters.push({ cluster, x: center.x, y: center.y, radius })
      }

      for (const entry of clusterCenters) {
        const { cluster } = entry
        const x = entry.x
        const y = entry.y
        const radius = entry.radius
        if (x + radius < 0 || x - radius > width || y + radius < 0 || y - radius > height) continue
        const halo = context.createRadialGradient(x, y, 2, x, y, radius)
        halo.addColorStop(0, withAlpha(colorFor(cluster.id), 0.13))
        halo.addColorStop(0.55, withAlpha(colorFor(cluster.id), 0.045))
        halo.addColorStop(1, withAlpha(colorFor(cluster.id), 0))
        context.fillStyle = halo
        context.beginPath()
        context.arc(x, y, radius, 0, Math.PI * 2)
        context.fill()
      }

      const focusKey = hoverRef.current ?? selectedRef.current
      const neighbours = focusKey ? adjacency.get(focusKey) : undefined
      const activeThreshold = thresholdRef.current
      context.lineCap = 'round'
      const edges = graph.edges
        .filter((edge) => (edge.kind === 'similar' ? edge.similarity >= activeThreshold : true))
        .map((edge) => {
          const source = projected.get(edge.source)
          const target = projected.get(edge.target)
          return { edge, source, target, depth: ((source?.depth ?? 0) + (target?.depth ?? 0)) / 2 }
        })
        .filter((item) => item.source && item.target)
        .sort((left, right) => left.depth - right.depth)
      for (const { edge, source, target } of edges) {
        if (!source || !target) continue
        const active =
          focusKey !== null && focusKey !== undefined && (edge.source === focusKey || edge.target === focusKey)
        const depthAlpha = clamp(0.55 + ((source.depth + target.depth) / 2) * 0.22, 0.34, 0.95)
        context.globalAlpha = (active ? 0.95 : focusKey ? 0.2 : 0.72) * depthAlpha
        context.strokeStyle = edgeColor(edge.kind, nodeMap.get(edge.source)?.cluster ?? 0, edge.weight)
        context.lineWidth = active
          ? 1.7
          : (edge.kind === 'bridge' ? 1.05 : 0.55 + clamp(edge.weight, 0, 1) * 0.85) *
            clamp(source.scale / (Math.min(width, height) * 0.24), 0.55, 1.5)
        context.setLineDash(edge.kind === 'bridge' ? [5, 4] : [])
        context.beginPath()
        context.moveTo(source.x, source.y)
        context.lineTo(target.x, target.y)
        context.stroke()
      }
      context.setLineDash([])
      context.globalAlpha = 1

      const ordered = [...graph.nodes]
        .map((node) => ({ node, point: projected.get(node.key) }))
        .filter((item): item is { node: KnowledgeGraphNode; point: Projected } => Boolean(item.point))
        .sort((left, right) => left.point.depth - right.point.depth)

      for (const { node, point } of ordered) {
        const depthFactor = clamp(0.55 + point.depth * 0.3, 0.34, 1)
        const radius = nodeRadius(node, density) * clamp(point.scale / (Math.min(width, height) * 0.24), 0.6, 1.9)
        const x = point.x
        const y = point.y
        if (x < -40 || x > width + 40 || y < -40 || y > height + 40) continue
        const color = node.kind === 'source' ? '#fcd34d' : colorFor(node.cluster)
        const dimmed =
          focusKey !== null && focusKey !== undefined && node.key !== focusKey && !neighbours?.has(node.key)
        context.globalAlpha = (dimmed ? 0.24 : 1) * depthFactor
        const glowScale = density < 1 ? 3.3 : 4.4
        const glow = context.createRadialGradient(x, y, 0, x, y, radius * glowScale)
        glow.addColorStop(0, withAlpha(color, 0.52))
        glow.addColorStop(1, withAlpha(color, 0))
        context.fillStyle = glow
        context.beginPath()
        context.arc(x, y, radius * glowScale, 0, Math.PI * 2)
        context.fill()

        if (node.kind === 'evidence') {
          context.beginPath()
          context.moveTo(x, y - radius)
          context.lineTo(x + radius, y)
          context.lineTo(x, y + radius)
          context.lineTo(x - radius, y)
          context.closePath()
          context.fillStyle = color
          context.fill()
        } else if (node.kind === 'wiki') {
          context.strokeStyle = color
          context.lineWidth = 1.5
          context.beginPath()
          context.arc(x, y, radius * 0.95, 0, Math.PI * 2)
          context.stroke()
          context.globalAlpha = (dimmed ? 0.18 : 0.55) * depthFactor
          context.fillStyle = color
          context.beginPath()
          context.arc(x, y, radius * 0.42, 0, Math.PI * 2)
          context.fill()
          context.globalAlpha = (dimmed ? 0.24 : 1) * depthFactor
        } else if (node.kind === 'source') {
          context.strokeStyle = color
          context.lineWidth = 1.1
          context.beginPath()
          context.moveTo(x - radius * 1.9, y)
          context.lineTo(x + radius * 1.9, y)
          context.moveTo(x, y - radius * 1.9)
          context.lineTo(x, y + radius * 1.9)
          context.stroke()
          context.fillStyle = color
          context.beginPath()
          context.arc(x, y, radius * 0.58, 0, Math.PI * 2)
          context.fill()
        } else {
          context.fillStyle = color
          context.beginPath()
          context.arc(x, y, radius, 0, Math.PI * 2)
          context.fill()
        }

        if (node.key === selectedRef.current) {
          const pulse = 1.6 + (Math.sin(time / 320) + 1) * 1.2
          context.globalAlpha = 0.8
          context.strokeStyle = '#f8fafc'
          context.lineWidth = 1.2
          context.beginPath()
          context.arc(x, y, radius + pulse, 0, Math.PI * 2)
          context.stroke()
        } else if (node.key === hoverRef.current) {
          context.globalAlpha = 0.75
          context.strokeStyle = '#e2e8f0'
          context.lineWidth = 1
          context.beginPath()
          context.arc(x, y, radius + 3.5, 0, Math.PI * 2)
          context.stroke()
        }
        context.globalAlpha = 1
      }

      context.textAlign = 'center'
      context.textBaseline = 'bottom'
      context.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'
      context.shadowColor = 'rgba(2, 5, 9, 0.85)'
      context.shadowBlur = 5
      const placedLabels: Rect[] = []
      for (const entry of clusterCenters) {
        const x = entry.x
        const y = clamp(entry.y - Math.min(entry.radius * 0.72, 110), 20, height - 16)
        if (x < -60 || x > width + 60) continue
        const text = entry.cluster.label.slice(0, 18)
        if (text === '') continue
        const metrics = context.measureText(text)
        const cx = clamp(x, metrics.width / 2 + 6, width - metrics.width / 2 - 6)
        const rect: Rect = {
          x1: cx - metrics.width / 2 - 3,
          y1: y - 25,
          x2: cx + metrics.width / 2 + 3,
          y2: y - 10
        }
        if (placedLabels.some((placed) => overlaps(rect, placed, 1))) continue
        placedLabels.push(rect)
        context.fillStyle = withAlpha(colorFor(entry.cluster.id), 0.5)
        context.fillText(text, cx, y - 14)
      }

      context.font = '10.5px ui-sans-serif, system-ui, "Segoe UI", sans-serif'
      context.textBaseline = 'middle'
      const seenLabels = new Set<string>()
      for (const node of labeled) {
        if (node.key === hoverRef.current || node.key === selectedRef.current) continue
        const point = projected.get(node.key)
        if (!point) continue
        const x = point.x
        const y = point.y
        if (x < -80 || x > width + 80 || y < -20 || y > height + 20) continue
        if (point.depth < -0.55) continue
        const text = labelText(node)
        if (text === '' || seenLabels.has(text)) continue
        const metrics = context.measureText(text)
        const baseline = clamp(y + nodeRadius(node, density) + 12, 12, height - 8)
        const cx = clamp(x, metrics.width / 2 + 6, width - metrics.width / 2 - 6)
        const rect: Rect = {
          x1: cx - metrics.width / 2 - 3,
          y1: baseline - 9,
          x2: cx + metrics.width / 2 + 3,
          y2: baseline + 9
        }
        if (placedLabels.some((placed) => overlaps(rect, placed))) continue
        placedLabels.push(rect)
        seenLabels.add(text)
        const dimmed =
          focusKey !== null && focusKey !== undefined && !neighbours?.has(node.key) && node.key !== focusKey
        context.fillStyle = `rgba(203, 213, 225, ${dimmed ? 0.16 : 0.68})`
        context.fillText(text, cx, baseline)
      }
      context.shadowBlur = 0
    }

    const tick = (time: number): void => {
      frame = window.requestAnimationFrame(tick)
      if (time - lastDrawn < 33) return
      drawFrame(time)
    }
    const redraw = (): void => drawFrame(performance.now())
    const observer = new ResizeObserver(redraw)
    observer.observe(stage)
    // Some environments throttle or never deliver requestAnimationFrame (hidden
    // windows, headless captures); a slow watchdog keeps the sky painted.
    const watchdog = window.setInterval(() => {
      if (performance.now() - lastDrawn > 600) redraw()
    }, 300)
    drawFrame(performance.now())
    frame = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearInterval(watchdog)
      observer.disconnect()
    }
  }, [adjacency, graph, labeled, nodeMap, density])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const camera = cameraRef.current
      interactionRef.current = performance.now()
      camera.distance = clamp(camera.distance * Math.exp(event.deltaY * 0.0011), 1.9, 8)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    const onContextMenu = (event: MouseEvent): void => event.preventDefault()
    stage.addEventListener('contextmenu', onContextMenu)
    return () => {
      stage.removeEventListener('wheel', onWheel)
      stage.removeEventListener('contextmenu', onContextMenu)
    }
  }, [])

  function screenRadius(node: KnowledgeGraphNode, point: Projected): number {
    const stage = stageRef.current
    const width = stage?.clientWidth ?? 0
    const height = stage?.clientHeight ?? 0
    const reference = (Math.min(width, height) || 1) * 0.24
    return nodeRadius(node, density) * clamp(point.scale / reference, 0.6, 1.9)
  }

  function pickNode(clientX: number, clientY: number): KnowledgeGraphNode | null {
    const stage = stageRef.current
    if (!stage) return null
    const rect = stage.getBoundingClientRect()
    const camera = cameraRef.current
    const pointerX = clientX - rect.left
    const pointerY = clientY - rect.top
    let best: KnowledgeGraphNode | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const node of graph.nodes) {
      const point = projectPoint(node.x, node.y ?? 0, node.z ?? 0, camera, rect.width, rect.height)
      const distance = Math.hypot(point.x - pointerX, point.y - pointerY)
      // Prefer near stars when two discs overlap.
      const score = distance - point.depth * 6
      const limit = Math.max(11, screenRadius(node, point) + 6)
      if (distance <= limit && score < bestScore) {
        bestScore = score
        best = node
      }
    }
    return best
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return
    const camera = cameraRef.current
    interactionRef.current = performance.now()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originYaw: camera.yaw,
      originPitch: camera.pitch,
      originPanX: camera.panX,
      originPanY: camera.panY,
      mode: event.button === 0 && !event.shiftKey ? 'orbit' : 'pan',
      moved: false
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setHover(null)
    hoverRef.current = null
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>): void {
    const drag = dragRef.current
    const camera = cameraRef.current
    if (drag && drag.pointerId === event.pointerId) {
      const deltaX = event.clientX - drag.startX
      const deltaY = event.clientY - drag.startY
      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) drag.moved = true
      interactionRef.current = performance.now()
      if (drag.mode === 'orbit') {
        camera.yaw = drag.originYaw + deltaX * 0.0065
        camera.pitch = clamp(drag.originPitch + deltaY * 0.005, -1.3, 1.3)
      } else {
        camera.panX = drag.originPanX + deltaX
        camera.panY = drag.originPanY + deltaY
      }
      return
    }
    const node = pickNode(event.clientX, event.clientY)
    const stage = stageRef.current
    if (!node || !stage) {
      if (hoverRef.current !== null) {
        hoverRef.current = null
        setHover(null)
      }
      return
    }
    const rect = stage.getBoundingClientRect()
    hoverRef.current = node.key
    interactionRef.current = performance.now()
    setHover({
      node,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      width: rect.width,
      height: rect.height
    })
  }

  function onPointerUp(event: React.PointerEvent<HTMLCanvasElement>): void {
    const drag = dragRef.current
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!drag || drag.moved) return
    const node = pickNode(event.clientX, event.clientY)
    selectedRef.current = node?.key ?? null
    setSelected(node)
    if (!node) {
      hoverRef.current = null
      setHover(null)
    }
  }

  function focusCluster(cluster: KnowledgeGraphCluster): void {
    const stage = stageRef.current
    if (!stage) return
    const members = graph.nodes.filter((node) => node.cluster === cluster.id)
    if (members.length === 0) return
    let cx = 0
    let cy = 0
    let cz = 0
    for (const node of members) {
      cx += node.x
      cy += node.y
      cz += node.z ?? 0
    }
    cx /= members.length
    cy /= members.length
    cz /= members.length
    let spread = 0
    for (const node of members) {
      spread = Math.max(spread, Math.hypot(node.x - cx, node.y - cy, (node.z ?? 0) - cz))
    }
    const width = stage.clientWidth
    const height = stage.clientHeight
    if (width <= 0 || height <= 0) return
    const camera = cameraRef.current
    camera.distance = clamp(1.5 + spread / 0.42, 2.1, 6.5)
    const point = projectPoint(cx, cy, cz, { ...camera, panX: 0, panY: 0 }, width, height)
    camera.panX = width / 2 - point.x
    camera.panY = height / 2 - point.y
    interactionRef.current = performance.now()
  }

  function resetView(): void {
    cameraRef.current = { ...DEFAULT_CAMERA }
    interactionRef.current = performance.now()
  }

  const selectedNeighbours = selected
    ? [...(adjacency.get(selected.key) ?? [])]
        .map((key) => nodeMap.get(key))
        .filter((node): node is KnowledgeGraphNode => Boolean(node))
        .sort((left, right) => right.weight - left.weight)
        .slice(0, 6)
    : []

  return (
    <div className="constellation">
      <div className="constellation-kinds">
        {KIND_ORDER.map((kind) => (
          <span key={kind}>
            <i>{KIND_GLYPHS[kind]}</i>
            {KIND_LABELS[kind]}
          </span>
        ))}
      </div>

      <div className="constellation-stage" ref={stageRef}>
        <canvas
          className="constellation-canvas"
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => {
            if (!dragRef.current) {
              hoverRef.current = null
              setHover(null)
            }
          }}
          onPointerCancel={() => {
            dragRef.current = null
          }}
          onDoubleClick={resetView}
        />
        {hover ? (
          <div
            className="constellation-tip"
            style={{
              left: Math.max(8, Math.min(hover.x + 14, hover.width - 236)),
              top: Math.max(8, Math.min(hover.y + 12, hover.height - 92))
            }}
          >
            <strong>{hover.node.title}</strong>
            <small>
              {KIND_LABELS[hover.node.kind]} · {hover.node.workspaceName || '当前知识库'} · 连接{' '}
              {hover.node.degree}
            </small>
            {hover.node.excerpt ? <small>{hover.node.excerpt.slice(0, 90)}</small> : null}
          </div>
        ) : null}
        <div className="constellation-hint">
          拖拽旋转 · Shift 拖拽平移 · 滚轮缩放 · 点击节点查看详情 · 双击复位
        </div>
      </div>

      <div className="constellation-legend">
        {graph.clusters.map((cluster) => (
          <button
            key={cluster.id}
            type="button"
            className="constellation-cluster"
            title={cluster.keywords.join(' · ') || cluster.label}
            onClick={() => focusCluster(cluster)}
          >
            <span className="constellation-swatch" style={{ background: colorFor(cluster.id) }} />
            <span className="constellation-cluster-label">{cluster.label || `星座簇 ${cluster.id + 1}`}</span>
            <span className="constellation-cluster-size">{cluster.size}</span>
          </button>
        ))}
        <button
          type="button"
          className={`ghost-button small${spinning ? ' active' : ''}`}
          onClick={() => setSpinning((value) => !value)}
        >
          {spinning ? '停止旋转' : '自动旋转'}
        </button>
        <button type="button" className="ghost-button small" onClick={resetView}>
          重置视角
        </button>
      </div>

      {selected ? (
        <div className="constellation-detail">
          <div className="constellation-detail-head">
            <span className="constellation-kind">{KIND_LABELS[selected.kind]}</span>
            <strong>{selected.title}</strong>
            <button
              type="button"
              className="ghost-button small"
              onClick={() => {
                setSelected(null)
                selectedRef.current = null
              }}
            >
              关闭
            </button>
          </div>
          <p>{selected.excerpt || '（暂无摘录）'}</p>
          <div className="constellation-detail-meta">
            <span>{selected.workspaceName || '当前知识库'}</span>
            <span>{selected.degree} 条连接</span>
            <span>平均相似度 {selected.similarity.toFixed(2)}</span>
            <span>{selected.semantic ? '语义向量' : '锚定位置'}</span>
            {selected.noteType ? <span>{selected.noteType}</span> : null}
          </div>
          {selectedNeighbours.length > 0 ? (
            <div className="constellation-detail-meta">
              <span>邻近：</span>
              {selectedNeighbours.map((node) => (
                <button
                  key={node.key}
                  type="button"
                  className="constellation-neighbour"
                  onClick={() => {
                    setSelected(node)
                    selectedRef.current = node.key
                  }}
                >
                  {node.title.slice(0, 18)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="memory-empty">点击星空中的节点查看它与哪些素材相连。</div>
      )}
    </div>
  )
}
