export type TrackType = 'panoramic_video' | 'standard_photos' | 'aerial_photos'
export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export interface MaterialTrack {
  id: string
  type: TrackType
  label: string
  path: string
  /** Optional time window (seconds) for panoramic video trimming. */
  trim?: { start: number; end: number }
  /** Per-panorama extraction settings. */
  extract?: { secondsPerFrame: number; frameLimit: number }
}

export type AlignmentEngine = 'metashape' | 'colmap'
export type ColmapDensityPreset = 'stable' | 'high-density' | 'experimental-high-density'
export type ColmapMatcher = 'sequential' | 'exhaustive'

export interface PipelineConfig {
  outputDir: string
  metashapePath: string
  colmapPath: string
  secondsPerFrame: number
  frameLimit: number
  alignmentEngine: AlignmentEngine
  // Metashape
  metaKeypointLimit: number
  metaTiepointLimit: number
  upAxis: string
  // COLMAP
  colmapDensityPreset: ColmapDensityPreset
  colmapUseGpu: boolean
  colmapMatcher: ColmapMatcher
  colmapMaxImageSize: number
  colmapMaxNumFeatures: number
}

export type PipelinePhase = 'idle' | 'extract' | 'align' | 'export' | 'complete' | 'error'

export interface PipelineProgress {
  phase: PipelinePhase; stage?: string
  percent: number; message: string; elapsed: number
  phasePercents: { extract: number; align: number; export: number }
}

export interface PipelineComplete { outputPath: string }
export interface PipelineError { error: string }

export interface PointCloudData {
  points: Float32Array; colors: Float32Array; numPoints: number; cameras: CameraPose[]
}

export interface CameraPose {
  id: number
  position: [number, number, number]; rotation: [number, number, number, number]
  frustum?: { fov: number; aspect: number; near: number; far: number }
}
