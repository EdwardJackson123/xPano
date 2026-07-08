import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Axis3d, CheckCircle2, ChevronDown, Layers, RefreshCw, RotateCcw, ScanSearch, Terminal, WandSparkles, Wrench, X, XCircle } from 'lucide-react'
import * as THREE from 'three'
import gsap from 'gsap'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { CameraPose, PointCloudData, ResolvedTheme } from '../../lib/types'

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
type PoseDisplayMode = 'frustum' | 'hidden'
type AxisName = 'x' | 'y' | 'z'
type UpAxisName = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z'
type AxisNotice = { text: string; tone: 'pending' | 'success' | 'error' }
type DensifyMode = 'turbo' | 'fast' | 'base' | 'high' | 'precise'
type DensifyPhase = 'idle' | 'checking' | 'installing' | 'running' | 'refreshing'
type DensifyImageFilter = 'front_plus_hd' | 'front' | 'hd' | 'cube_all' | 'all'
type DensifyLogEntry = { text: string; kind: DensifyTaskEvent['kind'] }

interface DensifyEnvStatus {
  pluginOk: boolean
  pythonOk: boolean
  depsOk: boolean
  runnerOk: boolean
  message: string
}

interface DensifyRunResult {
  originalPoints: number
  densePoints: number
  mergedPoints: number
  outputPointsPath: string
}

interface DensifyPersistedState {
  status: 'running' | 'completed_unconfirmed' | 'applied' | 'discarded' | 'failed' | 'stopped' | string
  message: string
  result?: DensifyRunResult | null
  logPath?: string
  updatedAt?: number
}

interface DensifyTaskEvent {
  task: 'install' | 'run'
  kind: 'start' | 'stdout' | 'stderr' | 'progress' | 'done' | 'error' | 'stopped'
  message: string
  progress?: number | null
}

const densifyModes: Array<{ value: DensifyMode; label: string; hint: string }> = [
  { value: 'turbo', label: 'Turbo', hint: '最快，适合快速试跑' },
  { value: 'fast', label: 'Fast', hint: '推荐，速度和质量均衡' },
  { value: 'base', label: 'Base', hint: '更稳，耗时略长' },
  { value: 'high', label: 'High', hint: '更高质量，耗时更长' },
  { value: 'precise', label: 'Precise', hint: '最高精度，适合最终输出' },
]

const densifyImageFilters: Array<{ value: DensifyImageFilter; label: string; hint: string }> = [
  { value: 'front_plus_hd', label: 'Front+补拍', hint: '全景只用 front 切图，同时加入高清补拍' },
  { value: 'front', label: '仅 Front', hint: '只使用全景相机 front 切图' },
  { value: 'hd', label: '仅补拍', hint: '只使用高清补拍图片' },
  { value: 'cube_all', label: '全景全部', hint: '使用全景相机所有 cube 切图' },
  { value: 'all', label: '全部', hint: '使用所有可用图片' },
]

const DENSIFY_LOG_LIMIT = 5000
const DENSIFY_LOG_TRIM_TO = 4500
const POINT_CLOUD_CACHE_LIMIT = 3
const EMPTY_CAMERAS: CameraPose[] = []
const upAxisOptions: UpAxisName[] = ['+Y', '+Z', '+X', '-Y', '-Z', '-X']

const formatPointCount = (value: number) => value.toLocaleString()

const trimDensifyLogs = (logs: DensifyLogEntry[]) => (
  logs.length > DENSIFY_LOG_LIMIT ? logs.slice(-DENSIFY_LOG_TRIM_TO) : logs
)

const compactErrorText = (error: unknown) => String(error).replace(/\r/g, '').trim().split('\n')[0]?.trim() || String(error)

const densifyLogTone = (entry: DensifyLogEntry) => {
  const text = entry.text.toLowerCase()
  if (entry.kind === 'error' || entry.kind === 'stderr' || text.includes('error') || text.includes('failed')) return 'is-danger'
  if (entry.kind === 'done' || text.includes('done') || text.includes('finished')) return 'is-success'
  return ''
}

const restoredDensifyMessage = (state: DensifyPersistedState) => {
  if (state.status === 'failed') return `上次致密化失败：${compactErrorText(state.message)}`
  if (state.status === 'stopped') return '上次致密化任务已停止'
  if (state.status === 'completed_unconfirmed') return '发现未确认的致密化结果，可继续查看、应用或丢弃'
  return state.message
}

const viewerThemes: Record<ResolvedTheme, {
  sceneBackground: string
  fog: string
  gridMain: string
  gridSecondary: string
  gridOpacity: number
  exposure: number
  contextOpacity: number
  primaryOpacity: number
  pointSizeBoost: number
  alphaTest: number
  overlayBackground: string
  mountBackground: string
}> = {
  dark: {
    sceneBackground: '#0f1316',
    fog: '#0f1316',
    gridMain: '#536772',
    gridSecondary: '#222a30',
    gridOpacity: 0.34,
    exposure: 1.16,
    contextOpacity: 0.18,
    primaryOpacity: 0.84,
    pointSizeBoost: 0,
    alphaTest: 0.05,
    overlayBackground:
      'linear-gradient(180deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0) 24%), radial-gradient(ellipse at center, rgba(255,255,255,0) 46%, rgba(0,0,0,0.28) 100%)',
    mountBackground: '#0f1316',
  },
  light: {
    sceneBackground: '#dfeaf2',
    fog: '#dfeaf2',
    gridMain: '#7f98aa',
    gridSecondary: '#c4d3de',
    gridOpacity: 0.36,
    exposure: 0.94,
    contextOpacity: 0.42,
    primaryOpacity: 1,
    pointSizeBoost: 0.34,
    alphaTest: 0.025,
    overlayBackground:
      'linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 24%), radial-gradient(ellipse at center, rgba(255,255,255,0) 54%, rgba(12,56,104,0.075) 100%)',
    mountBackground: '#dfeaf2',
  },
}

function makePointTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 48
  canvas.height = 48

  const ctx = canvas.getContext('2d')!
  const glow = ctx.createRadialGradient(24, 24, 0, 24, 24, 24)
  glow.addColorStop(0, 'rgba(255,255,255,0.98)')
  glow.addColorStop(0.46, 'rgba(255,255,255,0.9)')
  glow.addColorStop(0.72, 'rgba(255,255,255,0.28)')
  glow.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, 48, 48)

  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function makeAxisLabelSprite(label: string, color: string, resolvedTheme: ResolvedTheme) {
  const canvas = document.createElement('canvas')
  canvas.width = 160
  canvas.height = 160

  const ctx = canvas.getContext('2d')!
  const isDark = resolvedTheme === 'dark'
  ctx.clearRect(0, 0, 160, 160)
  ctx.fillStyle = isDark ? 'rgba(8, 12, 15, 0.82)' : 'rgba(255, 255, 255, 0.72)'
  ctx.beginPath()
  ctx.roundRect(38, 38, 84, 84, 24)
  ctx.fill()
  ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(12, 56, 104, 0.16)'
  ctx.lineWidth = 4
  ctx.stroke()
  ctx.shadowColor = isDark ? 'rgba(0, 0, 0, 0.22)' : 'rgba(12, 56, 104, 0.12)'
  ctx.shadowBlur = isDark ? 8 : 10
  ctx.shadowOffsetY = 2
  ctx.fillStyle = color
  ctx.font = '800 64px Inter, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, 80, 83)

  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.SRGBColorSpace

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(0.56, 0.56, 0.56)
  return sprite
}

function makeAxis(direction: THREE.Vector3, color: string, label: string, resolvedTheme: ResolvedTheme) {
  const group = new THREE.Group()
  const axisMaterial = new THREE.MeshBasicMaterial({ color })
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.72, 16), axisMaterial)
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.062, 0.16, 24), axisMaterial)
  const up = new THREE.Vector3(0, 1, 0)
  const q = new THREE.Quaternion().setFromUnitVectors(up, direction.clone().normalize())

  shaft.quaternion.copy(q)
  shaft.position.copy(direction).multiplyScalar(0.36)
  arrow.quaternion.copy(q)
  arrow.position.copy(direction).multiplyScalar(0.8)

  const labelSprite = makeAxisLabelSprite(label, color, resolvedTheme)
  labelSprite.position.copy(direction).multiplyScalar(1.12)

  group.add(shaft, arrow, labelSprite)
  return group
}

function makeAxisWidget(resolvedTheme: ResolvedTheme) {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 20)
  const group = new THREE.Group()

  group.add(makeAxis(new THREE.Vector3(1, 0, 0), '#ff8a6a', 'X', resolvedTheme))
  group.add(makeAxis(new THREE.Vector3(0, 1, 0), '#79d6a3', 'Y', resolvedTheme))
  group.add(makeAxis(new THREE.Vector3(0, 0, 1), '#7fb5ff', 'Z', resolvedTheme))

  const origin = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 24, 16),
    new THREE.MeshBasicMaterial({ color: '#dbe7ef' }),
  )
  group.add(origin)
  scene.add(group)

  return { scene, camera, group }
}

function enhanceColors(source: Float32Array, count: number) {
  const display = new Float32Array(count * 3)

  for (let i = 0; i < count * 3; i += 3) {
    const r = source[i] ?? 0.78
    const g = source[i + 1] ?? 0.78
    const b = source[i + 2] ?? 0.78
    const average = (r + g + b) / 3

    const saturatedR = average + (r - average) * 1.28
    const saturatedG = average + (g - average) * 1.24
    const saturatedB = average + (b - average) * 1.3

    display[i] = clamp01((saturatedR - 0.5) * 1.04 + 0.515)
    display[i + 1] = clamp01((saturatedG - 0.5) * 1.04 + 0.515)
    display[i + 2] = clamp01((saturatedB - 0.5) * 1.04 + 0.515)
  }

  return display
}

function adaptColorsForTheme(source: Float32Array, resolvedTheme: ResolvedTheme) {
  if (resolvedTheme === 'dark') return source

  const display = new Float32Array(source.length)
  for (let i = 0; i < source.length; i += 3) {
    const r = source[i] ?? 0
    const g = source[i + 1] ?? 0
    const b = source[i + 2] ?? 0
    const average = (r + g + b) / 3

    const contrastR = average + (r - average) * 1.22
    const contrastG = average + (g - average) * 1.2
    const contrastB = average + (b - average) * 1.28

    display[i] = clamp01(Math.pow(clamp01(contrastR), 1.22) * 0.58 + 0.018)
    display[i + 1] = clamp01(Math.pow(clamp01(contrastG), 1.22) * 0.6 + 0.02)
    display[i + 2] = clamp01(Math.pow(clamp01(contrastB), 1.12) * 0.72 + 0.026)
  }

  return display
}

function makeFocusBox(fullBox: THREE.Box3, xs: Float32Array, ys: Float32Array, zs: Float32Array, count: number) {
  xs.sort()
  ys.sort()
  zs.sort()

  const lower = Math.max(0, Math.floor(count * 0.015))
  const upper = Math.min(count - 1, Math.ceil(count * 0.985))
  const focusBox = new THREE.Box3(
    new THREE.Vector3(xs[lower], ys[lower], zs[lower]),
    new THREE.Vector3(xs[upper], ys[upper], zs[upper]),
  )
  const focusSize = focusBox.getSize(new THREE.Vector3())
  const fullSize = fullBox.getSize(new THREE.Vector3())
  const focusMax = Math.max(focusSize.x, focusSize.y, focusSize.z)
  const fullMax = Math.max(fullSize.x, fullSize.y, fullSize.z, 1)

  if (!Number.isFinite(focusMax) || focusMax < fullMax * 0.02) {
    return fullBox.clone()
  }

  focusBox.expandByScalar(Math.max(focusMax * 0.08, fullMax * 0.004))
  return focusBox
}

function getAxisIndex(value: number, min: number, size: number, bins: number) {
  if (size <= 1e-9) return 0
  return THREE.MathUtils.clamp(Math.floor(((value - min) / size) * bins), 0, bins - 1)
}

function makeDenseFocusBox(positions: Float32Array, baseBox: THREE.Box3, count: number) {
  const baseSize = baseBox.getSize(new THREE.Vector3())
  const baseMax = Math.max(baseSize.x, baseSize.y, baseSize.z, 1)
  if (!Number.isFinite(baseMax) || baseMax <= 0) return baseBox.clone()

  const bins = 24
  const binCounts = new Uint32Array(bins * bins * bins)
  let bestIndex = 0
  let bestCount = 0
  let validCount = 0
  const point = new THREE.Vector3()

  for (let i = 0; i < count; i++) {
    const source = i * 3
    point.set(positions[source], positions[source + 1], positions[source + 2])
    if (!baseBox.containsPoint(point)) continue

    const ix = getAxisIndex(point.x, baseBox.min.x, baseSize.x, bins)
    const iy = getAxisIndex(point.y, baseBox.min.y, baseSize.y, bins)
    const iz = getAxisIndex(point.z, baseBox.min.z, baseSize.z, bins)
    const index = ix + iy * bins + iz * bins * bins
    const nextCount = ++binCounts[index]
    validCount++

    if (nextCount > bestCount) {
      bestCount = nextCount
      bestIndex = index
    }
  }

  if (validCount < 32 || bestCount < 4) return baseBox.clone()

  const bestIz = Math.floor(bestIndex / (bins * bins))
  const bestIy = Math.floor((bestIndex - bestIz * bins * bins) / bins)
  const bestIx = bestIndex % bins
  const denseCenter = new THREE.Vector3(
    baseBox.min.x + ((bestIx + 0.5) / bins) * baseSize.x,
    baseBox.min.y + ((bestIy + 0.5) / bins) * baseSize.y,
    baseBox.min.z + ((bestIz + 0.5) / bins) * baseSize.z,
  )
  const safeSize = new THREE.Vector3(
    Math.max(baseSize.x, baseMax * 0.02),
    Math.max(baseSize.y, baseMax * 0.02),
    Math.max(baseSize.z, baseMax * 0.02),
  )
  const distances = new Float32Array(validCount)
  let distanceCount = 0

  for (let i = 0; i < count; i++) {
    const source = i * 3
    point.set(positions[source], positions[source + 1], positions[source + 2])
    if (!baseBox.containsPoint(point)) continue

    const dx = (point.x - denseCenter.x) / safeSize.x
    const dy = (point.y - denseCenter.y) / safeSize.y
    const dz = (point.z - denseCenter.z) / safeSize.z
    distances[distanceCount++] = dx * dx + dy * dy + dz * dz
  }

  const sortedDistances = distances.slice(0, distanceCount)
  sortedDistances.sort()
  const thresholdIndex = THREE.MathUtils.clamp(Math.floor(distanceCount * 0.28), 16, distanceCount - 1)
  const distanceThreshold = sortedDistances[thresholdIndex]
  const denseBox = new THREE.Box3()
  let denseCount = 0

  for (let i = 0; i < count; i++) {
    const source = i * 3
    point.set(positions[source], positions[source + 1], positions[source + 2])
    if (!baseBox.containsPoint(point)) continue

    const dx = (point.x - denseCenter.x) / safeSize.x
    const dy = (point.y - denseCenter.y) / safeSize.y
    const dz = (point.z - denseCenter.z) / safeSize.z
    if (dx * dx + dy * dy + dz * dz > distanceThreshold) continue

    denseBox.expandByPoint(point)
    denseCount++
  }

  const denseSize = denseBox.getSize(new THREE.Vector3())
  const denseMax = Math.max(denseSize.x, denseSize.y, denseSize.z)
  if (denseCount < Math.max(64, validCount * 0.04) || !Number.isFinite(denseMax) || denseMax < baseMax * 0.01) {
    return baseBox.clone()
  }

  denseBox.expandByScalar(Math.max(denseMax * 0.18, baseMax * 0.015))
  return denseBox
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((node) => {
    const item = node as THREE.Mesh | THREE.Points | THREE.LineSegments | THREE.Sprite
    item.geometry?.dispose()

    const materials = Array.isArray(item.material) ? item.material : item.material ? [item.material] : []
    for (const material of materials) {
      const withMap = material as THREE.Material & { map?: THREE.Texture }
      withMap.map?.dispose()
      material.dispose()
    }
  })
}

// COLMAP convention (+X=right, +Y=down, +Z=forward) → Three.js (+X=right, +Y=up, +Z=backward)
function seededRandom() {
  let seed = 23
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0xffffffff
  }
}

function createDemoPointCloud(): PointCloudData {
  const count = 7400
  const points = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const rand = seededRandom()

  for (let i = 0; i < count; i++) {
    const angle = rand() * Math.PI * 2
    const radius = Math.pow(rand(), 0.56) * 4.8
    const ridge = Math.sin(angle * 3.2 + radius * 1.65) * 0.42
    const x = Math.cos(angle) * radius + (rand() - 0.5) * 0.18
    const z = Math.sin(angle) * radius * 0.72 + (rand() - 0.5) * 0.18
    const y = ridge + Math.sin(radius * 2.45) * 0.2 + (rand() - 0.5) * 0.24
    points[i * 3] = x
    points[i * 3 + 1] = y
    points[i * 3 + 2] = z

    const warm = Math.max(0, Math.sin(angle + 1.1))
    const cyan = Math.max(0, Math.cos(angle - 0.5))
    colors[i * 3] = 0.2 + warm * 0.75
    colors[i * 3 + 1] = 0.32 + cyan * 0.62 + warm * 0.12
    colors[i * 3 + 2] = 0.7 + cyan * 0.25
  }

  const cameras: CameraPose[] = Array.from({ length: 18 }, (_, index) => {
    const angle = (index / 18) * Math.PI * 2
    const pos = new THREE.Vector3(Math.cos(angle) * 5.2, 1.1 + Math.sin(index * 0.8) * 0.24, Math.sin(angle) * 3.9)
    // Compute rotation so camera +Z (COLMAP forward) points toward origin
    const forward = new THREE.Vector3().sub(pos).normalize()
    const qCamToWorld = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), forward)
    const qColmap = qCamToWorld.clone().invert() // world→camera
    return {
      id: index,
      position: [pos.x, pos.y, pos.z],
      rotation: [qColmap.w, qColmap.x, qColmap.y, qColmap.z],
      frustum: { fov: Math.PI / 3, aspect: 1.55, near: 0.25, far: 10 },
    }
  })

  return { points, colors, numPoints: count, cameras }
}

function addCameraFrustums(
  container: THREE.Object3D,
  cameras: CameraPose[],
  _center: THREE.Vector3,
  radius: number,
  _floorY: number,
  resolvedTheme: ResolvedTheme,
) {
  if (!cameras.length) return

  const isLight = resolvedTheme === 'light'
  const planeColor = isLight ? '#2c8a43' : '#3fe765'
  const rayColor = isLight ? '#a45a34' : '#ff8758'
  const directionColor = isLight ? '#b3482f' : '#ff7048'
  const edgeColor = isLight ? '#167a3b' : '#63f47f'

  const overlay = new THREE.Group()
  overlay.renderOrder = 4
  const planeVertices: number[] = []
  const edgeVertices: number[] = []
  const rayVertices: number[] = []
  const directionVertices: number[] = []

  const cameraPathBox = new THREE.Box3()
  const cameraPositions = cameras.map((camera) => new THREE.Vector3(camera.position[0], -camera.position[1], -camera.position[2]))
  for (const cameraPosition of cameraPositions) {
    cameraPathBox.expandByPoint(cameraPosition)
  }
  const cameraPathSize = cameraPathBox.getSize(new THREE.Vector3())
  const cameraPathMaxDim = Math.max(cameraPathSize.x, cameraPathSize.y, cameraPathSize.z)
  const stableSceneScale = Number.isFinite(cameraPathMaxDim) && cameraPathMaxDim > 1e-6
    ? cameraPathMaxDim
    : radius
  const neighborDistances: number[] = []
  for (let i = 1; i < cameraPositions.length; i++) {
    const distance = cameraPositions[i].distanceTo(cameraPositions[i - 1])
    if (Number.isFinite(distance) && distance > 1e-6) neighborDistances.push(distance)
  }
  neighborDistances.sort((a, b) => a - b)
  const medianNeighborDistance = neighborDistances.length
    ? neighborDistances[Math.floor(neighborDistances.length * 0.5)]
    : 0
  const densityScale = stableSceneScale / Math.sqrt(Math.max(cameras.length, 1))
  // Keep camera glyphs stable and compact when densification changes the cloud bounds.
  const frustumReference = medianNeighborDistance > 1e-6
    ? Math.max(medianNeighborDistance * 1.8, densityScale * 0.35)
    : densityScale
  const frustumSize = THREE.MathUtils.clamp(frustumReference * 0.16, stableSceneScale * 0.0008, stableSceneScale * 0.0045)

  const pushVertex = (arr: number[], v: THREE.Vector3) => arr.push(v.x, v.y, v.z)
  const pushSegment = (arr: number[], a: THREE.Vector3, b: THREE.Vector3) => { pushVertex(arr, a); pushVertex(arr, b) }

  for (const camera of cameras) {
    const frustum = camera.frustum || { fov: Math.PI / 3, aspect: 1.55, near: 0.25, far: 10 }
    const d = frustumSize

    // COLMAP camera space: +X right, +Y down, +Z forward
    // Image top = -Y, image bottom = +Y
    const ch = d * Math.tan(frustum.fov / 2)
    const cw = ch * frustum.aspect
    // Corners in image order: top-left, top-right, bottom-right, bottom-left
    const localCorners = [
      new THREE.Vector3(-cw, -ch, d),  // top-left     (-X, -Y)
      new THREE.Vector3( cw, -ch, d),  // top-right    (+X, -Y)
      new THREE.Vector3( cw,  ch, d),  // bottom-right (+X, +Y)
      new THREE.Vector3(-cw,  ch, d),  // bottom-left  (-X, +Y)
    ]

    // COLMAP camera position in world
    const posW = new THREE.Vector3(camera.position[0], camera.position[1], camera.position[2])

    // COLMAP quaternion (qw,qx,qy,qz) = world→camera.
    // Invert to get camera→world for transforming local corners to world space.
    const qColmap = new THREE.Quaternion(camera.rotation[1], camera.rotation[2], camera.rotation[3], camera.rotation[0])
    const qCamToWorld = qColmap.clone().invert()

    const toWorld = (v: THREE.Vector3) => v.clone().applyQuaternion(qCamToWorld).add(posW)
    // COLMAP world → Three.js viewer: flip Y and Z
    const toViewer = (v: THREE.Vector3) => new THREE.Vector3(v.x, -v.y, -v.z)

    const cornersV = localCorners.map(toWorld).map(toViewer)
    const originV = toViewer(posW)
    const imageCenter = new THREE.Vector3(0, 0, d)
    const imgCenterV = toViewer(toWorld(imageCenter))

    // Semi-transparent frustum plane (two triangles)
    pushVertex(planeVertices, cornersV[0]); pushVertex(planeVertices, cornersV[1]); pushVertex(planeVertices, cornersV[2])
    pushVertex(planeVertices, cornersV[0]); pushVertex(planeVertices, cornersV[2]); pushVertex(planeVertices, cornersV[3])

    // Edge frame
    for (let i = 0; i < 4; i++) {
      pushSegment(edgeVertices, cornersV[i], cornersV[(i + 1) % 4])
    }

    // Rays from camera origin to each corner
    for (const c of cornersV) {
      pushSegment(rayVertices, originV, c)
    }

    // Direction indicator (from origin through image center, slightly extended)
    const dirTip = originV.clone().lerp(imgCenterV, 1.18)
    pushSegment(directionVertices, originV, dirTip)
  }

  // Semi-transparent planes
  if (planeVertices.length > 0) {
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(planeVertices, 3))
    const mat = new THREE.MeshBasicMaterial({ color: planeColor, transparent: true, opacity: isLight ? 0.14 : 0.07, side: THREE.DoubleSide, depthTest: true, depthWrite: false })
    const mesh = new THREE.Mesh(geom, mat)
    mesh.renderOrder = 2
    overlay.add(mesh)
  }

  const addLines = (vertices: number[], color: string, opacity: number, renderOrder: number, depthTest = true) => {
    if (!vertices.length) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest, depthWrite: false })
    const lines = new THREE.LineSegments(geometry, material)
    lines.renderOrder = renderOrder
    overlay.add(lines)
  }

  addLines(rayVertices, rayColor, isLight ? 0.36 : 0.24, 3, false)       // rays from origin to corners
  addLines(directionVertices, directionColor, isLight ? 0.58 : 0.44, 4, false)  // forward direction indicator
  addLines(edgeVertices, edgeColor, isLight ? 0.74 : 0.5, 5, false)        // frustum edge frame

  container.add(overlay)
}

interface ViewerProps {
  dataPath: string | null
  resolvedTheme: ResolvedTheme
}

export function PointCloudViewer({ dataPath, resolvedTheme }: ViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const initRef = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null)
  const resetAnimationRef = useRef<number>(0)
  const cloudTransitionTimerRef = useRef<number>(0)
  const cloudSwitchingRef = useRef(false)
  const pointCloudCacheRef = useRef<Map<string, PointCloudData>>(new Map())
  const densifyLogRef = useRef<HTMLDivElement>(null)
  const densifyUserScrolledUpRef = useRef(false)
  const densifyCancelRef = useRef(false)
  const viewSnapshotRef = useRef<{ sceneKey: string; position: THREE.Vector3; target: THREE.Vector3 } | null>(null)
  const poseOverlayRef = useRef<THREE.Group | null>(null)
  const frustumCtxRef = useRef<{ center: THREE.Vector3; radius: number; floorY: number }>({ center: new THREE.Vector3(), radius: 1, floorY: 0 })
  const [poseDisplayMode, setPoseDisplayMode] = useState<PoseDisplayMode>('frustum')
  const [loadedData, setLoadedData] = useState<PointCloudData | null>(null)
  const [cloudSwitching, setCloudSwitching] = useState(false)
  const [axisBusy, setAxisBusy] = useState<AxisName | null>(null)
  const [groundBusy, setGroundBusy] = useState(false)
  const [groundPanelOpen, setGroundPanelOpen] = useState(false)
  const [groundUpAxis, setGroundUpAxis] = useState<UpAxisName>('+Y')
  const [axisMessage, setAxisMessage] = useState<AxisNotice | null>(null)
  const [visibleMsg, setVisibleMsg] = useState<AxisNotice | null>(null)
  const [msgLeaving, setMsgLeaving] = useState(false)
  const [loadingOverlayVisible, setLoadingOverlayVisible] = useState(false)
  const [loadingOverlayLeaving, setLoadingOverlayLeaving] = useState(false)
  const [densifyOpen, setDensifyOpen] = useState(false)
  const [densifyAdvancedOpen, setDensifyAdvancedOpen] = useState(false)
  const [densifyEnv, setDensifyEnv] = useState<DensifyEnvStatus | null>(null)
  const [densifyChecking, setDensifyChecking] = useState(false)
  const [densifyInstalling, setDensifyInstalling] = useState(false)
  const [densifyRunning, setDensifyRunning] = useState(false)
  const [densifyApplying, setDensifyApplying] = useState(false)
  const [densifyStopping, setDensifyStopping] = useState(false)
  const [densifyUseCuda, setDensifyUseCuda] = useState(true)
  const [densifyMode, setDensifyMode] = useState<DensifyMode>('fast')
  const [densifyImageFilter, setDensifyImageFilter] = useState<DensifyImageFilter>('front_plus_hd')
  const [densifyMatchesPerRef, setDensifyMatchesPerRef] = useState(10000)
  const [densifyReferenceFraction, setDensifyReferenceFraction] = useState(0.8)
  const [densifyNeighborsPerRef, setDensifyNeighborsPerRef] = useState(1)
  const [densifyMinCertainty, setDensifyMinCertainty] = useState(0.2)
  const [densifyPhase, setDensifyPhase] = useState<DensifyPhase>('idle')
  const [densifyLastResult, setDensifyLastResult] = useState<DensifyRunResult | null>(null)
  const [densifyPreviewPointsPath, setDensifyPreviewPointsPath] = useState<string | null>(null)
  const [densifyPreviewActive, setDensifyPreviewActive] = useState(false)
  const [densifyLogs, setDensifyLogs] = useState<DensifyLogEntry[]>([])
  const [densifyProgress, setDensifyProgress] = useState<number | null>(null)
  const cloudPointsRef = useRef<THREE.Points[]>([])
  const sceneMaterialsRef = useRef<Array<THREE.Material & { opacity: number }>>([])
  const demoData = useMemo(() => createDemoPointCloud(), [])
  const viewerTheme = viewerThemes[resolvedTheme]
  const isDark = resolvedTheme === 'dark'
  const densifyReady = Boolean(densifyEnv?.pluginOk && densifyEnv?.pythonOk && densifyEnv?.depsOk && densifyEnv?.runnerOk)
  const densifyBusy = densifyChecking || densifyInstalling || densifyRunning
  const densifyTaskActive = densifyInstalling || densifyRunning
  const activeDensifyMode = densifyModes.find((mode) => mode.value === densifyMode) ?? densifyModes[1]
  const activeDensifyImageFilter = densifyImageFilters.find((filter) => filter.value === densifyImageFilter) ?? densifyImageFilters[0]
  const densifyPhaseText: Record<DensifyPhase, string> = {
    idle: densifyReady ? '环境就绪' : densifyEnv ? '需要配置' : '未检查',
    checking: '正在检查',
    installing: '正在配置',
    running: '正在致密化',
    refreshing: '正在刷新',
  }

  const fadeOutCloud = useCallback(() => {
    return new Promise<void>((resolve) => {
      const materials = sceneMaterialsRef.current.filter((m) => m.opacity > 0)
      if (!materials.length) { resolve(); return }
      let done = 0
      materials.forEach((m) => {
        gsap.to(m, { opacity: 0, duration: 0.72, ease: 'power2.inOut', onComplete: () => {
          done++
          if (done >= materials.length) resolve()
        }})
      })
    })
  }, [])

  const setCloudTransition = useCallback((value: boolean) => {
    cloudSwitchingRef.current = value
    setCloudSwitching(value)
  }, [])

  const finishCloudTransition = useCallback(() => {
    if (!cloudSwitchingRef.current) return
    if (cloudTransitionTimerRef.current) window.clearTimeout(cloudTransitionTimerRef.current)
    cloudTransitionTimerRef.current = window.setTimeout(() => {
      cloudTransitionTimerRef.current = 0
      setCloudTransition(false)
    }, 160)
  }, [setCloudTransition])

  const pointCloudCacheKey = useCallback((pointsPath?: string | null) => `${dataPath ?? 'demo'}::${pointsPath || 'base'}`, [dataPath])

  const cachePointCloudData = useCallback((key: string, data: PointCloudData) => {
    const cache = pointCloudCacheRef.current
    if (cache.has(key)) cache.delete(key)
    cache.set(key, data)
    while (cache.size > POINT_CLOUD_CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (!oldest) break
      cache.delete(oldest)
    }
  }, [])

  const loadPointCloudData = useCallback(async (pointsPath?: string | null, useCache = true) => {
    if (!dataPath) return null
    const cacheKey = pointCloudCacheKey(pointsPath)
    const cached = useCache ? pointCloudCacheRef.current.get(cacheKey) : null
    if (cached) return cached
    type ColmapResult = {
      points: number[]; colors: number[]; num_points: number
      cameras: { id: number; position: [number, number, number]; rotation: [number, number, number, number]; fov: number; aspect: number; near: number; far: number }[]
    }
    const result = await invoke<ColmapResult>('read_colmap_points', { dir: dataPath, pointsPath: pointsPath ?? null, maxPoints: 0 })
    if (!result?.num_points) return null
    const data: PointCloudData = {
      points: new Float32Array(result.points),
      colors: new Float32Array(result.colors),
      numPoints: result.num_points,
      cameras: (result.cameras || []).map((c) => ({
        id: c.id,
        position: c.position,
        rotation: c.rotation,
        frustum: { fov: c.fov, aspect: c.aspect, near: c.near, far: c.far },
      })),
    }
    if (useCache) cachePointCloudData(cacheKey, data)
    return data
  }, [dataPath, pointCloudCacheKey, cachePointCloudData])

  useEffect(() => {
    if (!dataPath) return
    let cancelled = false
    const pointsPath = densifyPreviewActive ? densifyPreviewPointsPath : null
    loadPointCloudData(pointsPath, true)
        .then((result) => {
          if (cancelled) return
          if (result?.numPoints) setLoadedData(result)
          finishCloudTransition()
        })
        .catch(() => {
          if (!cancelled) setCloudTransition(false)
        })
    return () => { cancelled = true }
  }, [dataPath, densifyPreviewActive, densifyPreviewPointsPath, loadPointCloudData, finishCloudTransition, setCloudTransition])

  useEffect(() => () => {
    if (cloudTransitionTimerRef.current) window.clearTimeout(cloudTransitionTimerRef.current)
  }, [])

  useEffect(() => {
    if (!dataPath) {
      setLoadingOverlayVisible(false)
      setLoadingOverlayLeaving(false)
      return
    }
    if (!loadedData) {
      setLoadingOverlayVisible(true)
      setLoadingOverlayLeaving(false)
      return
    }
    if (!loadingOverlayVisible) return
    setLoadingOverlayLeaving(true)
    const timer = window.setTimeout(() => {
      setLoadingOverlayVisible(false)
      setLoadingOverlayLeaving(false)
    }, 420)
    return () => window.clearTimeout(timer)
  }, [dataPath, loadedData, loadingOverlayVisible])

  useEffect(() => {
    pointCloudCacheRef.current.clear()
    setLoadedData(null)
    setDensifyLastResult(null)
    setDensifyPreviewPointsPath(null)
    setDensifyPreviewActive(false)
    setDensifyLogs([])
    setDensifyProgress(null)
    setDensifyOpen(false)
    if (!dataPath) return
    let cancelled = false
    ;(async () => {
      const state = await invoke<DensifyPersistedState | null>('get_lfs_densify_state', { outputDir: dataPath }).catch(() => null)
      if (cancelled) return
      if (state?.logPath) {
        const tail = await invoke<string[]>('read_lfs_densify_log_tail', { outputDir: dataPath, logPath: state.logPath, maxLines: 180 }).catch(() => [])
        if (!cancelled && tail.length) {
          setDensifyLogs(tail.map((text) => ({ text, kind: text.toLowerCase().includes('error') ? 'stderr' : 'stdout' })))
        }
      }
      if (!cancelled && state && ['failed', 'stopped', 'completed_unconfirmed'].includes(state.status)) {
        setAxisMessage({ text: restoredDensifyMessage(state), tone: state.status === 'failed' ? 'error' : 'success' })
      }
      const result = await invoke<DensifyRunResult | null>('get_lfs_densify_pending_result', { outputDir: dataPath }).catch(() => null)
      if (cancelled || !result?.outputPointsPath) return
      setDensifyLastResult(result)
      setDensifyPreviewPointsPath(result.outputPointsPath)
      setDensifyPreviewActive(false)
      setDensifyOpen(false)
      setAxisMessage({ text: `发现未确认的致密化结果：新增 ${formatPointCount(result.densePoints)} 点，可继续查看或丢弃`, tone: 'success' })
    })().catch(() => {})
    return () => { cancelled = true }
  }, [dataPath])

  useEffect(() => {
    let cleanup: (() => void) | undefined
    let cancelled = false
    listen<DensifyTaskEvent>('densify:task', (event) => {
      const payload = event.payload
      if (!payload) return
      if (payload.kind === 'start') {
        setDensifyProgress(0)
        densifyUserScrolledUpRef.current = false
        setDensifyLogs([{ text: payload.task === 'install' ? '开始配置致密化环境' : '开始运行 LichtFeld 致密化', kind: payload.kind }])
        return
      }
      if (payload.kind === 'progress') {
        const progress = Number(payload.progress)
        if (Number.isFinite(progress)) {
          const nextProgress = THREE.MathUtils.clamp(progress, 0, 100)
          setDensifyProgress((current) => Math.max(current ?? 0, nextProgress))
        }
        if (payload.message && payload.message !== String(payload.progress ?? '')) {
          setDensifyLogs((lines) => {
            if (lines[lines.length - 1]?.text === payload.message) return lines
            return trimDensifyLogs([...lines, { text: payload.message, kind: payload.kind }])
          })
        }
        return
      }
      if (payload.kind === 'done') setDensifyProgress(100)
      if (payload.kind === 'stopped') setDensifyProgress(null)
      if (payload.message) setDensifyLogs((lines) => trimDensifyLogs([...lines, { text: payload.message, kind: payload.kind }]))
    }).then((unlisten) => {
      if (cancelled) unlisten()
      else cleanup = unlisten
    })
    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [])

  const handleDensifyLogScroll = useCallback(() => {
    const el = densifyLogRef.current
    if (!el) return
    densifyUserScrolledUpRef.current = el.scrollHeight - el.scrollTop - el.clientHeight >= 8
  }, [])

  useLayoutEffect(() => {
    const el = densifyLogRef.current
    if (!el) return
    if (!densifyUserScrolledUpRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [densifyLogs])

  // Only show demo when no dataPath; show nothing until real data loads
  const visualData = loadedData ?? (dataPath ? null : demoData)
  const points = visualData?.points ?? null
  const colors = visualData?.colors ?? null
  const numPoints = visualData?.numPoints ?? 0
  const cameras = visualData?.cameras ?? EMPTY_CAMERAS
  const sceneKey = `${dataPath ?? 'demo'}:${numPoints}:${cameras.length}`
  const viewKey = `${dataPath ?? 'demo'}`

  const resetView = useCallback(() => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    const initial = initRef.current
    if (!camera || !controls || !initial) return

    if (resetAnimationRef.current) cancelAnimationFrame(resetAnimationRef.current)

    const startPosition = camera.position.clone()
    const startTarget = controls.target.clone()
    const startedAt = performance.now()

    const loop = (now: number) => {
      const progress = Math.min((now - startedAt) / 620, 1)
      const eased = 1 - Math.pow(1 - progress, 3)

      camera.position.lerpVectors(startPosition, initial.position, eased)
      controls.target.lerpVectors(startTarget, initial.target, eased)
      controls.update()

      if (progress < 1) resetAnimationRef.current = requestAnimationFrame(loop)
      else resetAnimationRef.current = 0
    }

    resetAnimationRef.current = requestAnimationFrame(loop)
  }, [])

  const applyAxisFlip = useCallback(async (axis: AxisName) => {
    if (!dataPath || axisBusy || groundBusy || cloudSwitchingRef.current) return
    setAxisBusy(axis)
    setAxisMessage({ text: `正在写入 ${axis.toUpperCase()} 方向校正...`, tone: 'pending' })
    try {
      await invoke('apply_colmap_axis_flip', {
        pythonExe: 'python',
        outputDir: dataPath,
        axis,
      })
      setAxisMessage({ text: `正在刷新 ${axis.toUpperCase()} 校正后的点云...`, tone: 'pending' })
      pointCloudCacheRef.current.delete(pointCloudCacheKey(null))
      const refreshedData = await loadPointCloudData(null, false)
      if (!refreshedData) throw new Error('校正后的点云读取失败')
      setCloudTransition(true)
      await fadeOutCloud()
      setLoadedData(refreshedData)
      setDensifyPreviewActive(false)
      finishCloudTransition()
      setAxisMessage({ text: `已应用 ${axis.toUpperCase()} 方向校正，COLMAP 数据已更新`, tone: 'success' })
    } catch (error) {
      setCloudTransition(false)
      setAxisMessage({ text: `校正失败：${String(error)}`, tone: 'error' })
    } finally {
      setAxisBusy(null)
    }
  }, [axisBusy, groundBusy, dataPath, fadeOutCloud, loadPointCloudData, pointCloudCacheKey, setCloudTransition, finishCloudTransition])

  const applyGroundAlignment = useCallback(async () => {
    if (!dataPath || axisBusy || groundBusy || cloudSwitchingRef.current) return
    setGroundBusy(true)
    setAxisMessage({ text: `正在估计地面并对齐到 ${groundUpAxis}...`, tone: 'pending' })
    try {
      await invoke('apply_colmap_ground_alignment', {
        pythonExe: 'python',
        outputDir: dataPath,
        upAxis: groundUpAxis,
      })
      setAxisMessage({ text: `正在刷新 ${groundUpAxis} 朝上的点云...`, tone: 'pending' })
      pointCloudCacheRef.current.delete(pointCloudCacheKey(null))
      const refreshedData = await loadPointCloudData(null, false)
      if (!refreshedData) throw new Error('对齐后的点云读取失败')
      setCloudTransition(true)
      await fadeOutCloud()
      setLoadedData(refreshedData)
      setDensifyPreviewActive(false)
      finishCloudTransition()
      setGroundPanelOpen(false)
      setAxisMessage({ text: `已将地面对齐到 ${groundUpAxis}，COLMAP 数据已更新`, tone: 'success' })
    } catch (error) {
      setCloudTransition(false)
      setAxisMessage({ text: `地面对齐失败：${compactErrorText(error)}`, tone: 'error' })
    } finally {
      setGroundBusy(false)
    }
  }, [axisBusy, groundBusy, groundUpAxis, dataPath, fadeOutCloud, loadPointCloudData, pointCloudCacheKey, setCloudTransition, finishCloudTransition])

  const checkDensifyEnv = useCallback(async (force = false) => {
    setDensifyChecking(true)
    setDensifyPhase('checking')
    try {
const status = await invoke<DensifyEnvStatus>('check_lfs_densify_env', { pythonExe: '', force })
      setDensifyEnv(status)
      setAxisMessage({ text: status.pluginOk && status.pythonOk && status.depsOk && status.runnerOk ? '致密化环境可用' : status.message, tone: status.pluginOk && status.pythonOk && status.depsOk && status.runnerOk ? 'success' : 'error' })
      return status
    } catch (error) {
      setAxisMessage({ text: `环境检查失败：${compactErrorText(error)}`, tone: 'error' })
      return null
    } finally {
      setDensifyChecking(false)
      setDensifyPhase('idle')
    }
  }, [])

  const installDensifyEnv = useCallback(async () => {
    setDensifyInstalling(true)
    setDensifyStopping(false)
    densifyCancelRef.current = false
    densifyUserScrolledUpRef.current = false
    setDensifyLogs([])
    setDensifyProgress(0)
    setDensifyPhase('installing')
    try {
await invoke<string>('install_lfs_densify_env', { useCuda: densifyUseCuda })
      const status = await invoke<DensifyEnvStatus>('check_lfs_densify_env', { pythonExe: '', force: true })
      setDensifyEnv(status)
      setAxisMessage({ text: status.pluginOk && status.pythonOk && status.depsOk && status.runnerOk ? '致密化环境配置完成' : status.message, tone: status.pluginOk && status.pythonOk && status.depsOk && status.runnerOk ? 'success' : 'error' })
    } catch (error) {
      setAxisMessage({ text: densifyCancelRef.current ? '已停止环境配置' : `环境配置失败：${compactErrorText(error)}`, tone: densifyCancelRef.current ? 'success' : 'error' })
    } finally {
      setDensifyInstalling(false)
      setDensifyStopping(false)
      densifyCancelRef.current = false
      setDensifyPhase('idle')
    }
  }, [densifyUseCuda])

  const runDensify = useCallback(async () => {
    if (!dataPath || densifyRunning || cloudSwitchingRef.current || densifyPreviewPointsPath) return
    setDensifyRunning(true)
    setDensifyStopping(false)
    densifyCancelRef.current = false
    densifyUserScrolledUpRef.current = false
    setDensifyLogs([])
    setDensifyProgress(0)
    setDensifyPhase('running')
    setDensifyLastResult(null)
    setAxisMessage({ text: '正在运行 LichtFeld 致密化...', tone: 'pending' })
    try {
const result = await invoke<DensifyRunResult>('run_lfs_densify', {
        outputDir: dataPath,
        roma: densifyMode,
        maxPoints: 0,
        numRefs: densifyReferenceFraction,
        nnsPerRef: densifyNeighborsPerRef,
        matchesPerRef: densifyMatchesPerRef,
        certaintyThresh: densifyMinCertainty,
        imageFilter: densifyImageFilter,
        roiStart: 0,
        roiEnd: 1,
      })
      setDensifyPhase('refreshing')
      setAxisMessage({ text: '正在后台加载致密化点云...', tone: 'pending' })
      pointCloudCacheRef.current.delete(pointCloudCacheKey(result.outputPointsPath))
      const denseData = await loadPointCloudData(result.outputPointsPath, false)
      if (!denseData) throw new Error('致密化点云读取失败')
      setCloudTransition(true)
      await fadeOutCloud()
      setLoadedData(denseData)
      setDensifyPreviewPointsPath(result.outputPointsPath)
      setDensifyPreviewActive(true)
      setDensifyLastResult(result)
      setAxisMessage({ text: `致密化预览已生成：新增 ${formatPointCount(result.densePoints)} 点，总计 ${formatPointCount(result.mergedPoints)} 点`, tone: 'success' })
    } catch (error) {
      setCloudTransition(false)
      setAxisMessage({ text: densifyCancelRef.current ? '已停止致密化任务' : `致密化失败：${compactErrorText(error)}`, tone: densifyCancelRef.current ? 'success' : 'error' })
    } finally {
      setDensifyRunning(false)
      setDensifyStopping(false)
      densifyCancelRef.current = false
      setDensifyPhase('idle')
    }
  }, [dataPath, densifyRunning, densifyPreviewPointsPath, densifyMode, densifyReferenceFraction, densifyNeighborsPerRef, densifyMatchesPerRef, densifyMinCertainty, densifyImageFilter, loadPointCloudData, pointCloudCacheKey, fadeOutCloud, setCloudTransition])

  const rollbackDensifyPreview = useCallback(async () => {
    if (!densifyPreviewActive || cloudSwitchingRef.current) return
    const baseData = await loadPointCloudData(null)
    if (!baseData) return
    setCloudTransition(true)
    await fadeOutCloud()
    setLoadedData(baseData)
    setDensifyPreviewActive(false)
    finishCloudTransition()
    setAxisMessage({ text: '已回退到原始点云预览', tone: 'success' })
  }, [densifyPreviewActive, loadPointCloudData, fadeOutCloud, setCloudTransition, finishCloudTransition])

  const showDensifyPreview = useCallback(async () => {
    if (!densifyPreviewPointsPath || densifyPreviewActive || cloudSwitchingRef.current) return
    pointCloudCacheRef.current.delete(pointCloudCacheKey(densifyPreviewPointsPath))
    const denseData = await loadPointCloudData(densifyPreviewPointsPath, false)
    if (!denseData) return
    setCloudTransition(true)
    await fadeOutCloud()
    setLoadedData(denseData)
    setDensifyPreviewActive(true)
    finishCloudTransition()
    setAxisMessage({ text: '已切换到致密化预览', tone: 'success' })
  }, [densifyPreviewPointsPath, densifyPreviewActive, loadPointCloudData, pointCloudCacheKey, fadeOutCloud, setCloudTransition, finishCloudTransition])

  const applyDensifyPreview = useCallback(async () => {
    if (!dataPath || !densifyPreviewPointsPath || densifyApplying || cloudSwitchingRef.current) return
    setDensifyApplying(true)
    try {
      const denseData = await loadPointCloudData(densifyPreviewPointsPath, false)
      if (!denseData) throw new Error('致密化点云读取失败')
await invoke('apply_lfs_densify_result', { outputDir: dataPath, densePointsPath: densifyPreviewPointsPath })
      cachePointCloudData(pointCloudCacheKey(null), denseData)
      setCloudTransition(true)
      await fadeOutCloud()
      setLoadedData(denseData)
      setDensifyPreviewActive(false)
      setDensifyPreviewPointsPath(null)
      setDensifyLastResult(null)
      finishCloudTransition()
      setAxisMessage({ text: '致密化结果已应用到点云文件', tone: 'success' })
    } catch (error) {
      setCloudTransition(false)
      setAxisMessage({ text: `应用致密化结果失败：${compactErrorText(error)}`, tone: 'error' })
    } finally {
      setDensifyApplying(false)
    }
  }, [dataPath, densifyPreviewPointsPath, densifyApplying, loadPointCloudData, pointCloudCacheKey, cachePointCloudData, fadeOutCloud, setCloudTransition, finishCloudTransition])

  const discardDensifyPreview = useCallback(async () => {
    if (!dataPath || !densifyPreviewPointsPath || densifyApplying || cloudSwitchingRef.current) return
    setDensifyApplying(true)
    try {
      const baseData = densifyPreviewActive ? await loadPointCloudData(null) : null
await invoke('discard_lfs_densify_result', { outputDir: dataPath, densePointsPath: densifyPreviewPointsPath })
      pointCloudCacheRef.current.delete(pointCloudCacheKey(densifyPreviewPointsPath))
      if (densifyPreviewActive && baseData) {
        setCloudTransition(true)
        await fadeOutCloud()
        setLoadedData(baseData)
        setDensifyPreviewActive(false)
      }
      setDensifyPreviewPointsPath(null)
      setDensifyLastResult(null)
      finishCloudTransition()
      setAxisMessage({ text: '已丢弃这次致密化结果', tone: 'success' })
    } catch (error) {
      setCloudTransition(false)
      setAxisMessage({ text: `丢弃致密化结果失败：${compactErrorText(error)}`, tone: 'error' })
    } finally {
      setDensifyApplying(false)
    }
  }, [dataPath, densifyPreviewPointsPath, densifyPreviewActive, densifyApplying, loadPointCloudData, pointCloudCacheKey, fadeOutCloud, setCloudTransition, finishCloudTransition])

  const stopDensifyTask = useCallback(async () => {
    if (!densifyBusy || densifyStopping) return
    densifyCancelRef.current = true
    setDensifyStopping(true)
    try {
const stopped = await invoke<boolean>('stop_lfs_densify_task')
      if (!stopped) setDensifyStopping(false)
    } catch (error) {
      setAxisMessage({ text: `停止失败：${compactErrorText(error)}`, tone: 'error' })
      setDensifyStopping(false)
    }
  }, [densifyBusy, densifyStopping])

  useEffect(() => {
    if (axisMessage) {
      setVisibleMsg(axisMessage)
      setMsgLeaving(false)
      if (axisMessage.tone !== 'pending') {
        const timer = window.setTimeout(() => setAxisMessage(null), 3600)
        return () => window.clearTimeout(timer)
      }
    } else if (visibleMsg) {
      setMsgLeaving(true)
      const timer = window.setTimeout(() => setVisibleMsg(null), 700)
      return () => window.clearTimeout(timer)
    }
  }, [axisMessage, visibleMsg])

  // Main Three.js scene setup
  useEffect(() => {
    const el = mountRef.current
    if (!el || !points || !colors || numPoints === 0) return
    el.innerHTML = ''
    const sceneTheme = viewerThemes[resolvedTheme]

    let viewWidth = el.clientWidth || 960
    let viewHeight = el.clientHeight || 640

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(sceneTheme.sceneBackground)

    const poseOverlay = new THREE.Group()
    poseOverlay.name = 'camera-pose-overlay'
    poseOverlay.visible = true
    scene.add(poseOverlay)
    poseOverlayRef.current = poseOverlay

    const camera = new THREE.PerspectiveCamera(50, viewWidth / viewHeight, 0.01, 5000)
    cameraRef.current = camera

    const largeCloud = numPoints > 450_000
    const hugeCloud = numPoints > 700_000
    const renderer = new THREE.WebGLRenderer({ antialias: !largeCloud, powerPreference: 'high-performance' })
    renderer.setSize(viewWidth, viewHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, hugeCloud ? 1.15 : largeCloud ? 1.35 : 1.75))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = sceneTheme.exposure
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    el.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    const viewScale = Math.min(viewWidth, viewHeight) / 720
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.rotateSpeed = 0.62 * viewScale
    controls.zoomSpeed = 0.72 * viewScale
    controls.panSpeed = 0.86 * viewScale
    controls.screenSpacePanning = true
    controlsRef.current = controls

    // Build point cloud geometry
    const positions = new Float32Array(numPoints * 3)
    const xs = new Float32Array(numPoints)
    const ys = new Float32Array(numPoints)
    const zs = new Float32Array(numPoints)
    const box = new THREE.Box3()
    const probe = new THREE.Vector3()

    for (let i = 0; i < numPoints; i++) {
      // COLMAP convention (+Y=down, +Z=forward) → Three.js (+Y=up, +Z=backward)
      const x = points[i * 3]
      const y = -points[i * 3 + 1]
      const z = -points[i * 3 + 2]

      positions[i * 3] = x
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = z
      xs[i] = x
      ys[i] = y
      zs[i] = z

      probe.set(x, y, z)
      box.expandByPoint(probe)
    }

    const robustBox = makeFocusBox(box, xs, ys, zs, numPoints)
    const focusBox = makeDenseFocusBox(positions, robustBox, numPoints)
    const center = focusBox.getCenter(new THREE.Vector3())
    const size = focusBox.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z, 1)
    const sphere = focusBox.getBoundingSphere(new THREE.Sphere())
    const radius = Math.max(sphere.radius, maxDim * 0.5, 1)
    const fullSphere = box.getBoundingSphere(new THREE.Sphere())
    const fullRadius = Math.max(fullSphere.radius, radius)
    const floorY = focusBox.min.y - radius * 0.045
    frustumCtxRef.current = { center: center.clone(), radius, floorY }

    scene.fog = new THREE.Fog(sceneTheme.fog, radius * 4.2, radius * 10.5)

    type FadeMaterial = THREE.Material & { opacity: number }
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const sceneEnteredAt = performance.now()
    const sceneFadeMs = reduceMotion ? 0 : 720
    const fadeMaterials: Array<{ material: FadeMaterial; targetOpacity: number }> = []
    cloudPointsRef.current = []
    sceneMaterialsRef.current = []
    const registerFadeMaterial = (material: THREE.Material | THREE.Material[]) => {
      if (sceneFadeMs === 0) return
      const materials = Array.isArray(material) ? material : [material]
      materials.forEach((mat) => {
        if (!('opacity' in mat) || typeof mat.opacity !== 'number') return
        const fadeMaterial = mat as FadeMaterial
        const targetOpacity = fadeMaterial.opacity
        fadeMaterial.transparent = true
        fadeMaterial.opacity = 0
        fadeMaterials.push({ material: fadeMaterial, targetOpacity })
        sceneMaterialsRef.current.push(fadeMaterial)
      })
    }

    // Grid
    const gridSize = Math.pow(2, Math.ceil(Math.log2(maxDim * 1.35)))
    const divisions = THREE.MathUtils.clamp(Math.round(gridSize / Math.max(maxDim / 36, 0.01)), 24, 96)
    const grid = new THREE.GridHelper(gridSize, divisions, sceneTheme.gridMain, sceneTheme.gridSecondary)
    grid.position.set(center.x, floorY, center.z)
    const gridMaterial = grid.material as THREE.LineBasicMaterial
    gridMaterial.transparent = true
    gridMaterial.opacity = sceneTheme.gridOpacity
    gridMaterial.depthWrite = false
    scene.add(grid)

    // Point cloud
    const displayColors = adaptColorsForTheme(enhanceColors(colors, numPoints), resolvedTheme)
    const pointTexture = makePointTexture()
    const pixelRatio = renderer.getPixelRatio()
    const pointSize = THREE.MathUtils.clamp(
      1.36 + Math.log10(Math.max(numPoints, 10)) * 0.045 + sceneTheme.pointSizeBoost - (largeCloud ? 0.16 : 0),
      1.34,
      largeCloud ? 1.72 : 2.08,
    ) * pixelRatio

    const cloudGeometry = new THREE.BufferGeometry()
    cloudGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    cloudGeometry.setAttribute('color', new THREE.BufferAttribute(displayColors, 3))
    cloudGeometry.computeBoundingSphere()

    const cloudMaterial = new THREE.PointsMaterial({
      size: pointSize,
      vertexColors: true,
      sizeAttenuation: false,
      map: pointTexture,
      transparent: true,
      toneMapped: false,
      opacity: sceneTheme.primaryOpacity,
      alphaTest: sceneTheme.alphaTest,
      depthWrite: true,
    })
    registerFadeMaterial(cloudMaterial)
    const cloudPoints = new THREE.Points(cloudGeometry, cloudMaterial)
    scene.add(cloudPoints)
    cloudPointsRef.current.push(cloudPoints)

    // Add camera frustums
    addCameraFrustums(poseOverlay, cameras, center, radius, floorY, resolvedTheme)
    poseOverlay.traverse((object) => {
      const material = (object as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }).material
      if (material) registerFadeMaterial(material)
    })

    // Axis widget
    const axisWidget = makeAxisWidget(resolvedTheme)
    const fov = THREE.MathUtils.degToRad(camera.fov)
    const distance = Math.max(radius / Math.sin(fov / 2), maxDim) * 1.12
    const viewDirection = new THREE.Vector3(0.72, 0.42, 0.88).normalize()
    const initialPosition = center.clone().addScaledVector(viewDirection, distance)
    const savedView = viewSnapshotRef.current?.sceneKey === viewKey ? viewSnapshotRef.current : null

    camera.near = Math.max(radius / 1200, 0.01)
    camera.far = Math.max(fullRadius * 8, radius * 80, 5000)
    camera.position.copy(savedView?.position ?? initialPosition)
    camera.updateProjectionMatrix()

    controls.target.copy(savedView?.target ?? center)
    controls.minDistance = Math.max(radius * 0.12, 0.05)
    controls.maxDistance = Math.max(fullRadius * 8, radius * 22, 100)
    controls.update()

    initRef.current = {
      position: initialPosition.clone(),
      target: center.clone(),
    }

    const pressedKeys = new Set<string>()
    const ignoreKeyboardMove = (target: EventTarget | null) => {
      const element = target as HTMLElement | null
      if (!element) return false
      return Boolean(element.closest('input, textarea, select, button, [contenteditable="true"]'))
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (!['w', 'a', 's', 'd', 'q', 'e'].includes(key) || ignoreKeyboardMove(event.target)) return
      pressedKeys.add(key)
      event.preventDefault()
    }

    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (!['w', 'a', 's', 'd', 'q', 'e'].includes(key)) return
      pressedKeys.delete(key)
      event.preventDefault()
    }

    const applyKeyboardMove = (deltaMs: number) => {
      if (pressedKeys.size === 0) return
      const forward = controls.target.clone().sub(camera.position)
      forward.y = 0
      if (forward.lengthSq() < 0.000001) return
      forward.normalize()
      const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize()
      const move = new THREE.Vector3()
      if (pressedKeys.has('w')) move.add(forward)
      if (pressedKeys.has('s')) move.sub(forward)
      if (pressedKeys.has('d')) move.add(right)
      if (pressedKeys.has('a')) move.sub(right)
      if (pressedKeys.has('e')) move.y += 1
      if (pressedKeys.has('q')) move.y -= 1
      if (move.lengthSq() < 0.000001) return
      move.normalize().multiplyScalar(radius * 0.58 * Math.min(deltaMs, 48) / 1000)
      camera.position.add(move)
      controls.target.add(move)
    }

    let animationFrame = 0
    let lastRenderAt = performance.now()
    const render = () => {
      animationFrame = requestAnimationFrame(render)
      const now = performance.now()
      const deltaMs = now - lastRenderAt
      lastRenderAt = now
      applyKeyboardMove(deltaMs)
      controls.update()
      if (fadeMaterials.length > 0) {
        const progress = Math.min((now - sceneEnteredAt) / sceneFadeMs, 1)
        const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2
        fadeMaterials.forEach(({ material, targetOpacity }) => {
          material.opacity = targetOpacity * eased
        })
        if (progress >= 1) fadeMaterials.length = 0
      }

      renderer.setScissorTest(false)
      renderer.setViewport(0, 0, viewWidth, viewHeight)
      renderer.render(scene, camera)

      const widgetSize = Math.min(186, Math.max(146, Math.round(Math.min(viewWidth, viewHeight) * 0.28)))
      const widgetX = viewWidth - widgetSize - 8
      const widgetY = 10
      const direction = camera.position.clone().sub(controls.target).normalize()

      axisWidget.camera.position.copy(direction.multiplyScalar(5.6))
      axisWidget.camera.up.copy(camera.up)
      axisWidget.camera.lookAt(0, 0, 0)

      renderer.autoClear = false
      renderer.clearDepth()
      renderer.setScissor(widgetX, widgetY, widgetSize, widgetSize)
      renderer.setViewport(widgetX, widgetY, widgetSize, widgetSize)
      renderer.setScissorTest(true)
      renderer.render(axisWidget.scene, axisWidget.camera)
      renderer.setScissorTest(false)
      renderer.autoClear = true
    }
    render()

    const onResize = () => {
      viewWidth = el.clientWidth || 960
      viewHeight = el.clientHeight || 640

      camera.aspect = viewWidth / viewHeight
      camera.updateProjectionMatrix()
      renderer.setSize(viewWidth, viewHeight)
    }

    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(el)
    window.addEventListener('resize', onResize)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    return () => {
      viewSnapshotRef.current = {
        sceneKey: viewKey,
        position: camera.position.clone(),
        target: controls.target.clone(),
      }
      if (resetAnimationRef.current) {
        cancelAnimationFrame(resetAnimationRef.current)
        resetAnimationRef.current = 0
      }
      cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)

      gsap.killTweensOf(sceneMaterialsRef.current)
      controls.dispose()
      disposeObject(scene)
      disposeObject(axisWidget.scene)
      renderer.dispose()
      el.innerHTML = ''
      cameraRef.current = null
      controlsRef.current = null
      initRef.current = null
      poseOverlayRef.current = null
      cloudPointsRef.current = []
      sceneMaterialsRef.current = []
    }
  }, [points, colors, numPoints, cameras, sceneKey, viewKey, resolvedTheme])

  // Toggle frustum overlay visibility without rebuilding the scene
  useEffect(() => {
    const overlay = poseOverlayRef.current
    if (!overlay) return
    overlay.visible = poseDisplayMode !== 'hidden'
  }, [poseDisplayMode])

  const pointCount = numPoints
  const cameraCount = cameras.length
  const axisNoticeTone = axisMessage?.tone ?? 'pending'
  const axisNoticeClass = axisNoticeTone === 'error'
    ? isDark
      ? 'border-danger/25 bg-danger/12 text-danger'
      : 'border-danger/22 bg-danger/10 text-danger'
    : axisNoticeTone === 'success'
      ? isDark
        ? 'border-brand/22 bg-brand/12 text-brand'
        : 'border-brand/18 bg-brand/10 text-brand'
      : isDark
        ? 'border-white/[0.08] bg-black/36 text-white/62'
        : 'border-ink/10 bg-white/72 text-ink/62 shadow-brand/5'
  const compactNotice = Boolean(visibleMsg && visibleMsg.text.length <= 42 && !visibleMsg.text.includes('\n'))

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div
        ref={mountRef}
        className="absolute inset-0"
        style={{
          background: viewerTheme.mountBackground,
        }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          zIndex: 4,
          background: viewerTheme.overlayBackground,
        }}
      />
      {loadingOverlayVisible && (
        <div className={`pointer-events-none absolute inset-0 z-10 grid place-items-center px-4 transition-all duration-[420ms] ease-out ${
          loadingOverlayLeaving ? 'opacity-0 scale-[0.985]' : 'opacity-100 scale-100'
        }`}>
          <div className={`flex min-h-[118px] w-[min(320px,calc(100%-2rem))] flex-col items-center justify-center gap-3 rounded-card px-5 py-5 text-center shadow-sm backdrop-blur-xl transition-all duration-[420ms] ease-out ${
          isDark
            ? 'border border-white/[0.08] bg-black/42 text-white/72'
            : 'border border-ink/10 bg-white/78 text-ink/70 shadow-brand/5'
        }`}>
            <span className={`grid h-11 w-11 place-items-center rounded-comfortable ${
              isDark ? 'bg-white/[0.06]' : 'bg-ink/[0.05]'
            }`}>
              <RefreshCw className="h-5 w-5 animate-spin text-brand" />
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-ink">正在加载点云预览</p>
              <p className="mt-1 text-[11px] leading-4 text-muted">读取完整点云并准备 Three.js 场景</p>
            </div>
          </div>
        </div>
      )}
      {(loadedData || !dataPath) && (
      <div className="absolute bottom-4 left-4 z-10 flex max-w-[calc(100%-2rem)] flex-wrap items-center gap-2">
        <ViewerStat color="#ff8a6a" label="点数" value={pointCount.toLocaleString()} />
        {cameraCount > 0 && (
          <ViewerStat color={poseDisplayMode === 'hidden' ? '#7b8791' : '#35e05a'} label="相机" value={cameraCount.toLocaleString()} />
        )}
        {cameraCount > 0 && (
          <div className={`flex overflow-hidden rounded-comfortable p-0.5 text-[11px] font-mono backdrop-blur ${
            isDark
              ? 'border border-white/[0.08] bg-black/40 shadow-2xl'
              : 'border border-ink/10 bg-white/64 shadow-sm'
          }`}>
            {([
              ['frustum', '视锥'],
              ['hidden', '隐藏'],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => setPoseDisplayMode(mode)}
                className={`motion-press rounded-subtle px-2.5 py-1.5 transition-colors ${
                  poseDisplayMode === mode
                    ? isDark
                      ? 'bg-white/[0.12] text-white/80'
                      : 'bg-brand/12 text-brand'
                    : isDark
                      ? 'text-white/35 hover:bg-white/[0.06] hover:text-white/60'
                      : 'text-ink/38 hover:bg-ink/[0.06] hover:text-ink/64'
                }`}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <button onClick={resetView} className={`motion-press flex h-9 w-9 items-center justify-center rounded-comfortable backdrop-blur transition-colors ${
          isDark
            ? 'border border-white/[0.08] bg-black/40 text-white/45 shadow-2xl hover:border-white/[0.16] hover:text-white/75'
            : 'border border-ink/10 bg-white/64 text-ink/44 shadow-sm hover:border-brand/24 hover:text-ink/74'
        }`}>
          <RotateCcw className="h-4 w-4" />
        </button>
        {dataPath && loadedData && (
          <div
            className={`flex h-9 items-center gap-1 rounded-comfortable px-1.5 text-[11px] font-mono backdrop-blur ${
              isDark
                ? 'border border-white/[0.08] bg-black/40 text-white/48 shadow-2xl'
                : 'border border-ink/10 bg-white/64 text-ink/48 shadow-sm'
            }`}
            title="自动估计地面平面，并旋转 COLMAP sparse 模型到选中的查看器上轴"
          >
            <Axis3d className="h-4 w-4 text-brand" />
            <span className="pl-1 pr-1 text-ink/45">地面对齐</span>
            <div className="relative">
              <button
                type="button"
                aria-expanded={groundPanelOpen}
                aria-label="选择地面对齐上轴"
                disabled={groundBusy || Boolean(axisBusy) || cloudSwitching}
                onClick={() => setGroundPanelOpen((open) => !open)}
                className={`motion-press flex h-7 min-w-[4.25rem] items-center justify-center gap-1 rounded-subtle px-2 font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                  groundPanelOpen
                    ? 'bg-brand text-white shadow-[0_0_14px_rgba(var(--xp-brand-rgb),0.22)]'
                    : isDark
                      ? 'bg-white/[0.04] text-white/62 hover:bg-white/[0.08] hover:text-white/78'
                      : 'bg-ink/[0.04] text-ink/62 hover:bg-brand/[0.08] hover:text-ink/78'
                }`}
              >
                <span>{groundUpAxis}</span>
                <ChevronDown className={`h-3 w-3 transition-transform ${groundPanelOpen ? 'rotate-180' : ''}`} />
              </button>
              {groundPanelOpen && (
                <div
                  role="radiogroup"
                  aria-label="选择地面对齐上轴"
                  className={`absolute bottom-[calc(100%+0.5rem)] left-1/2 z-20 grid w-[9.5rem] -translate-x-1/2 grid-cols-3 gap-1 rounded-comfortable p-1.5 shadow-2xl backdrop-blur-xl animate-in fade-in slide-in-from-bottom-1 duration-150 ${
                    isDark
                      ? 'border border-white/[0.08] bg-black/72'
                      : 'border border-ink/10 bg-white/86 shadow-brand/10'
                  }`}
                >
                  {upAxisOptions.map((axis) => {
                    const selected = groundUpAxis === axis
                    return (
                      <button
                        key={axis}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={groundBusy || Boolean(axisBusy) || cloudSwitching}
                        onClick={() => {
                          setGroundUpAxis(axis)
                          setGroundPanelOpen(false)
                        }}
                        className={`motion-press grid h-7 place-items-center rounded-subtle text-[10px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                          selected
                            ? 'bg-brand text-white shadow-[0_0_14px_rgba(var(--xp-brand-rgb),0.22)]'
                            : isDark
                              ? 'text-white/52 hover:bg-white/[0.08] hover:text-white/78'
                              : 'text-ink/52 hover:bg-brand/[0.08] hover:text-ink/78'
                        }`}
                      >
                        {axis}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
            <button
              type="button"
              disabled={groundBusy || Boolean(axisBusy) || cloudSwitching}
              onClick={applyGroundAlignment}
              className={`motion-press inline-flex h-7 items-center gap-1.5 rounded-subtle px-2 font-semibold transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-50 ${
                isDark
                  ? 'text-white/62 hover:-translate-y-0.5 hover:bg-white/[0.06]'
                  : 'text-ink/58 hover:-translate-y-0.5 hover:bg-brand/[0.06]'
              } ${groundBusy ? 'bg-brand/12 text-brand' : ''}`}
            >
              {groundBusy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}
              <span>应用</span>
            </button>
          </div>
        )}
        {dataPath && loadedData && (
          <div
            className={`flex h-9 items-center gap-1 rounded-comfortable px-1.5 text-[11px] font-mono backdrop-blur ${
              isDark
                ? 'border border-white/[0.08] bg-black/40 text-white/48 shadow-2xl'
                : 'border border-ink/10 bg-white/64 text-ink/48 shadow-sm'
            }`}
            title="后处理轴向校正：不重新抽帧/对齐，会备份并更新 sparse/0 的 COLMAP 数据"
          >
            <Axis3d className="h-4 w-4 text-brand" />
            <span className="pl-1 pr-1.5 text-ink/45">轴向校正</span>
            {(['x', 'y', 'z'] as const).map((axis) => {
              const colors: Record<string, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' }
              const isActive = axisBusy === axis
              return (
                <button
                  key={axis}
                  type="button"
                  disabled={Boolean(axisBusy) || groundBusy || cloudSwitching}
                  onClick={() => applyAxisFlip(axis)}
                  title={`翻转${axis.toUpperCase()}轴`}
                  className={`motion-press grid h-7 min-w-7 place-items-center gap-1 rounded-subtle px-2 font-semibold transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-50 ${
                    isDark
                      ? 'text-white/62 hover:-translate-y-0.5 hover:bg-white/[0.06]'
                      : 'text-ink/58 hover:-translate-y-0.5 hover:bg-brand/[0.06]'
                  } ${isActive ? 'scale-110' : ''}`}
                  style={isActive ? { background: `${colors[axis]}18`, color: colors[axis], boxShadow: `0 0 14px ${colors[axis]}26` } : undefined}
                >
                  {isActive ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : axis.toUpperCase()}
                </button>
              )
            })}
          </div>
        )}
        {dataPath && loadedData && (
          <button
            type="button"
            onClick={() => {
              setDensifyOpen((value) => !value)
              if (!densifyEnv && !densifyChecking) void checkDensifyEnv(false)
            }}
            className={`motion-press flex h-9 items-center gap-2 rounded-comfortable px-3 text-[11px] font-semibold backdrop-blur transition-all ${
              densifyOpen
                ? isDark ? 'border border-brand/30 bg-brand/16 text-brand shadow-2xl' : 'border border-brand/24 bg-brand/12 text-brand shadow-sm'
                : isDark ? 'border border-white/[0.08] bg-black/40 text-white/54 shadow-2xl hover:text-white/78' : 'border border-ink/10 bg-white/64 text-ink/54 shadow-sm hover:text-ink/78'
            }`}
          >
            {densifyBusy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4" />}
            <span>致密化</span>
          </button>
        )}
      </div>
      )}
      {dataPath && loadedData && densifyOpen && (
        <div className="liquid-card-clear absolute bottom-[4.25rem] left-4 z-10 max-h-[calc(100%-5.5rem)] w-[min(390px,calc(100%-2rem))] overflow-y-auto overscroll-contain rounded-card p-3 text-[12px] animate-in fade-in slide-in-from-bottom-2 duration-200">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-subtle ${isDark ? 'bg-white/[0.06]' : 'bg-ink/[0.05]'}`}>
                <WandSparkles className="h-4 w-4 text-brand" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-ink">LichtFeld 致密化</p>
                <p className="truncate text-[10px] text-muted">当前点云补密并刷新预览</p>
              </div>
            </div>
            <button type="button" onClick={() => setDensifyOpen(false)} className={`motion-press grid h-7 w-7 shrink-0 place-items-center rounded-subtle transition-colors ${isDark ? 'text-white/45 hover:bg-white/[0.06] hover:text-white/72' : 'text-ink/45 hover:bg-ink/[0.06] hover:text-ink/72'}`}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="glass-inset mt-2 flex min-h-10 shrink-0 items-center justify-between gap-3 rounded-comfortable px-2.5 py-2">
            <div className="flex min-w-0 items-center gap-2">
              {densifyBusy ? <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-brand" /> : densifyReady ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-brand" /> : <Wrench className="h-3.5 w-3.5 shrink-0 text-muted" />}
              <span className={`truncate text-[11px] font-semibold ${densifyReady ? 'text-brand' : 'text-ink/62'}`}>{densifyPhaseText[densifyPhase]}</span>
            </div>
            <button type="button" disabled={densifyBusy} onClick={() => void checkDensifyEnv(true)} className={`motion-press shrink-0 rounded-subtle px-2 py-1 text-[10px] font-semibold transition-colors disabled:opacity-45 ${isDark ? 'text-white/42 hover:bg-white/[0.06] hover:text-white/68' : 'text-ink/42 hover:bg-ink/[0.06] hover:text-ink/68'}`}>检查</button>
          </div>

          <div className="mt-2">
            <span className="ui-label mb-1 block text-[10px]">RoMa</span>
            <div className="theme-segment grid grid-cols-5 overflow-hidden rounded-comfortable p-0.5">
              {densifyModes.map((mode) => {
                const selected = densifyMode === mode.value
                return (
                  <button key={mode.value} type="button" disabled={densifyBusy} onClick={() => setDensifyMode(mode.value)} title={mode.hint} className={`motion-press h-7 min-w-0 rounded-subtle border px-1 text-[10px] font-semibold transition-colors disabled:opacity-45 ${selected ? 'border border-brand/40 bg-brand text-white shadow-[0_0_14px_rgba(var(--xp-brand-rgb),0.22)]' : 'border-transparent text-ink/42 hover:bg-ink/[0.04] hover:text-ink/72'}`}>
                    <span className="block truncate">{mode.label}</span>
                  </button>
                )
              })}
            </div>
            <span className="mt-1 block truncate text-[10px] text-muted">{activeDensifyMode.hint}</span>
          </div>

          <div className="mt-3">
            <span className="ui-label mb-1 block text-[10px]">图片范围</span>
            <div className="theme-segment grid grid-cols-5 overflow-hidden rounded-comfortable p-0.5">
              {densifyImageFilters.map((filter) => {
                const selected = densifyImageFilter === filter.value
                return (
                  <button key={filter.value} type="button" disabled={densifyBusy} onClick={() => setDensifyImageFilter(filter.value)} title={filter.hint} className={`motion-press h-7 min-w-0 rounded-subtle border px-1 text-[10px] font-semibold transition-colors disabled:opacity-45 ${selected ? 'border border-brand/40 bg-brand text-white shadow-[0_0_14px_rgba(var(--xp-brand-rgb),0.22)]' : 'border-transparent text-ink/42 hover:bg-ink/[0.04] hover:text-ink/72'}`}>
                    <span className="block truncate">{filter.label}</span>
                  </button>
                )
              })}
            </div>
            <span className="mt-1 block truncate text-[10px] text-muted">{activeDensifyImageFilter.hint}</span>
          </div>

          <div className="mt-3">
            <button type="button" onClick={() => setDensifyAdvancedOpen((value) => !value)} className="motion-press flex w-full items-center justify-between gap-3 rounded-subtle border border-[var(--xp-line)] px-3 py-2 text-[12px] text-ink/65 transition-colors hover:bg-[var(--xp-surface-soft)]">
              <span className="ui-label text-[10px]">高级参数</span>
              <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-muted">{densifyMatchesPerRef.toLocaleString()} / {densifyNeighborsPerRef} / {densifyReferenceFraction.toFixed(2)} / {densifyMinCertainty.toFixed(2)} / {densifyUseCuda ? 'CUDA' : 'CPU'}</span>
              <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${densifyAdvancedOpen ? 'rotate-180' : ''}`} />
            </button>
            <div className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${densifyAdvancedOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div className="min-h-0 overflow-hidden">
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="block"><span className="ui-label mb-1 block text-[10px]">匹配点 / Ref</span><input className="theme-input h-9 w-full rounded-comfortable border px-3 py-2 font-mono text-[12px]" disabled={densifyBusy} value={densifyMatchesPerRef} onChange={(event) => setDensifyMatchesPerRef(Math.max(100, Number(event.target.value.replace(/[^\d]/g, '')) || 100))} /></label>
                  <label className="block"><span className="ui-label mb-1 block text-[10px]">邻居 / Ref</span><input className="theme-input h-9 w-full rounded-comfortable border px-3 py-2 font-mono text-[12px]" disabled={densifyBusy} value={densifyNeighborsPerRef} onChange={(event) => setDensifyNeighborsPerRef(Math.max(1, Number(event.target.value.replace(/[^\d]/g, '')) || 1))} /></label>
                  <label className="block"><span className="ui-label mb-1 block text-[10px]">参考比例</span><input type="range" min={0.1} max={1} step={0.05} value={densifyReferenceFraction} disabled={densifyBusy} onChange={(event) => setDensifyReferenceFraction(Number(event.target.value))} className="h-9 w-full accent-[var(--xp-brand)]" /><span className="block text-center font-mono text-[10px] text-muted">{densifyReferenceFraction.toFixed(2)}</span></label>
                  <label className="block"><span className="ui-label mb-1 block text-[10px]">最小置信度</span><input type="range" min={0} max={1} step={0.05} value={densifyMinCertainty} disabled={densifyBusy} onChange={(event) => setDensifyMinCertainty(Number(event.target.value))} className="h-9 w-full accent-[var(--xp-brand)]" /><span className="block text-center font-mono text-[10px] text-muted">{densifyMinCertainty.toFixed(2)}</span></label>
                </div>
                <button type="button" role="switch" aria-checked={densifyUseCuda} disabled={densifyBusy} onClick={() => setDensifyUseCuda((value) => !value)} className="motion-press mt-2 flex w-full items-center justify-between gap-3 rounded-subtle border border-[var(--xp-line)] px-3 py-2 text-[12px] text-ink/65 transition-colors hover:bg-[var(--xp-surface-soft)] disabled:opacity-45">
                  <span className="text-[11px] text-muted">一键配置使用 CUDA</span>
                  <span className="relative h-4 w-8 rounded-full transition-colors" style={{ background: densifyUseCuda ? 'var(--xp-brand)' : 'var(--xp-line-strong)' }}><span className="absolute top-0.5 h-3 w-3 rounded-full bg-[var(--xp-surface)] shadow-sm transition-all" style={{ left: densifyUseCuda ? 18 : 2 }} /></span>
                </button>
              </div>
            </div>
          </div>

          {densifyLastResult && (
            <div className="glass-inset mt-3 grid grid-cols-3 gap-1.5 rounded-comfortable p-1.5">
              {[["原始", densifyLastResult.originalPoints], ["新增", densifyLastResult.densePoints], ["总计", densifyLastResult.mergedPoints]].map(([label, value]) => (
                <div key={String(label)} className="min-w-0 px-1 py-1 text-center"><p className="truncate text-[10px] text-muted">{label}</p><p className="truncate font-mono text-[11px] font-semibold">{formatPointCount(Number(value))}</p></div>
              ))}
            </div>
          )}

          {densifyPreviewPointsPath && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" disabled={densifyBusy || densifyApplying || cloudSwitching} onClick={densifyPreviewActive ? rollbackDensifyPreview : showDensifyPreview} className="glass-control motion-press inline-flex h-8 items-center justify-center gap-1.5 rounded-subtle px-2 text-[11px] font-semibold disabled:opacity-45">{densifyPreviewActive ? <RotateCcw className="h-3.5 w-3.5" /> : <Layers className="h-3.5 w-3.5" />}{densifyPreviewActive ? '回退预览' : '查看致密化'}</button>
              <button type="button" disabled={densifyBusy || densifyApplying || cloudSwitching} onClick={applyDensifyPreview} className="theme-action-shadow motion-press inline-flex h-8 items-center justify-center gap-1.5 rounded-subtle bg-brand px-2 text-[11px] font-semibold text-white disabled:opacity-45">{densifyApplying ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}应用结果</button>
              <button type="button" disabled={densifyBusy || densifyApplying || cloudSwitching} onClick={discardDensifyPreview} className="glass-control motion-press col-span-2 inline-flex h-8 items-center justify-center gap-1.5 rounded-subtle px-2 text-[11px] font-semibold text-danger disabled:opacity-45">{densifyApplying ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}丢弃这次结果</button>
            </div>
          )}

          {densifyEnv?.message && !densifyReady && <p className="mt-2 max-h-16 overflow-y-auto break-words rounded-subtle bg-danger/8 px-2 py-1.5 text-[10px] leading-4 text-danger">{densifyEnv.message}</p>}

          {(densifyTaskActive || densifyLogs.length > 0) && (
            <div className="mt-3 shrink-0">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="ui-label flex items-center gap-1.5 text-[10px]"><Terminal className="h-3.5 w-3.5" />任务日志</span>
                <span className="font-mono text-[10px] text-muted">{densifyProgress === null ? (densifyTaskActive ? '运行中' : '待命') : `${Math.round(densifyProgress)}%`}</span>
                {densifyTaskActive && <button type="button" disabled={densifyStopping} onClick={stopDensifyTask} className="motion-press rounded-subtle border border-danger/30 bg-danger/10 px-2 py-1 text-[10px] font-semibold text-danger disabled:opacity-45">{densifyStopping ? '停止中' : '停止'}</button>}
              </div>
              <div className="mb-1.5 h-1.5 overflow-hidden rounded-full bg-ink/10"><div className="h-full rounded-full bg-brand transition-all duration-300" style={{ width: `${THREE.MathUtils.clamp(densifyProgress ?? 0, 0, 100)}%` }} /></div>
              <div ref={densifyLogRef} onScroll={handleDensifyLogScroll} className="terminal h-28 max-h-28 overflow-y-auto overflow-x-hidden select-text px-1 py-1">
                {densifyLogs.length > 0 ? densifyLogs.map((line, index) => <p key={`${index}-${line.text.slice(0, 12)}`} className={`log-line min-w-0 max-w-full ${densifyLogTone(line)}`}><span className="log-index">{String(index + 1).padStart(2, '0')}</span><span className="log-text">{line.text}</span></p>) : <p className="px-1 py-1 text-[11px] leading-5 text-muted">等待任务输出<span className="terminal-cursor" /></p>}
              </div>
            </div>
          )}

          <div className="mt-3 grid shrink-0 grid-cols-[1fr_1.35fr] gap-2">
            <button type="button" disabled={densifyBusy} onClick={installDensifyEnv} className="glass-control motion-press inline-flex h-8 items-center justify-center gap-1.5 rounded-subtle px-2 text-[11px] font-semibold disabled:opacity-45">{densifyInstalling ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}一键配置</button>
            <button type="button" disabled={densifyBusy || !densifyReady || cloudSwitching || Boolean(densifyPreviewPointsPath)} onClick={runDensify} className="theme-action-shadow motion-press inline-flex h-8 items-center justify-center gap-1.5 rounded-subtle bg-brand px-2 text-[11px] font-semibold text-white disabled:opacity-45">{densifyRunning ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}运行致密化</button>
          </div>
        </div>
      )}
      {visibleMsg && (
        <div
          className={`pointer-events-none absolute left-1/2 top-[68px] z-20 flex max-h-[30svh] w-[min(560px,calc(100%-2rem))] -translate-x-1/2 gap-2 overflow-y-auto rounded-comfortable px-3 py-2 text-[12px] shadow-sm backdrop-blur-xl transition-all duration-700 ease-out ${
            msgLeaving ? '-translate-y-2 opacity-0' : 'translate-y-0 opacity-100'
          } ${compactNotice ? 'items-center justify-center' : 'items-start justify-start'} ${axisNoticeClass}`}
        >
          {visibleMsg.tone === 'pending' && <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin opacity-80" />}
          {visibleMsg.tone === 'success' && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />}
          {visibleMsg.tone === 'error' && <XCircle className="h-3.5 w-3.5 shrink-0 text-danger" />}
          <span className={`min-w-0 break-words ${compactNotice ? 'text-center' : 'text-left'}`}>{visibleMsg.text}</span>
        </div>
      )}
    </div>
  )
}

function ViewerStat({ color, label, value, title }: { color: string; label: string; value: string; title?: string }) {
  return (
    <div title={title} className="glass-control flex items-center gap-2 rounded-comfortable px-3 py-2 text-[11px] font-mono text-ink/45">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 14px ${color}` }} />
      <span className="text-ink/32">{label}</span>
      <span className="text-ink/72">{value}</span>
    </div>
  )
}


