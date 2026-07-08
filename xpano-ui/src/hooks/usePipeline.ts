import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { MaterialTrack, PipelineComplete, PipelineConfig, PipelineError, PipelineProgress } from '../lib/types'

function detectPython(): string {
  // Empty string lets the backend resolve bundled Python first
  return ''
}

function isTauriRuntime() {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

const defaultTrackExtract = { secondsPerFrame: 1.0, frameLimit: 0 }

const initialProgress: PipelineProgress = {
  phase: 'idle',
  percent: 0,
  message: '等待开始',
  elapsed: 0,
  phasePercents: { extract: 0, align: 0, export: 0 },
}

const phaseLabels: Record<PipelineProgress['phase'], string> = {
  idle: '准备',
  extract: '抽帧',
  align: '对齐',
  export: '导出',
  complete: '完成',
  error: '错误',
}

function clampPercent(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return Math.min(100, Math.max(0, value))
}

function roundPercent(value: number | undefined): number {
  return Math.round(clampPercent(value))
}

function formatElapsed(seconds: number | undefined): string {
  const safe = Math.max(0, Math.floor(seconds || 0))
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

function sanitizeProgress(next: PipelineProgress, prev: PipelineProgress): PipelineProgress {
  const rawPercent = roundPercent(next.percent)
  const allowReset = next.phase === 'idle' || prev.phase === 'complete' || prev.phase === 'error'
  const percent = allowReset ? rawPercent : Math.max(roundPercent(prev.percent), rawPercent)
  const phasePercents = next.phasePercents || initialProgress.phasePercents
  const nextElapsed = Math.max(0, Math.floor(next.elapsed || 0))
  const keepMonotonicPhasePercents = !allowReset && next.phase !== 'idle'

  return {
    ...next,
    percent,
    message: next.message || phaseLabels[next.phase] || '处理中',
    elapsed: allowReset ? nextElapsed : Math.max(prev.elapsed, nextElapsed),
    phasePercents: {
      extract: keepMonotonicPhasePercents
        ? Math.max(roundPercent(prev.phasePercents.extract), roundPercent(phasePercents.extract))
        : roundPercent(phasePercents.extract),
      align: keepMonotonicPhasePercents
        ? Math.max(roundPercent(prev.phasePercents.align), roundPercent(phasePercents.align))
        : roundPercent(phasePercents.align),
      export: keepMonotonicPhasePercents
        ? Math.max(roundPercent(prev.phasePercents.export), roundPercent(phasePercents.export))
        : roundPercent(phasePercents.export),
    },
  }
}

let lastExtractProgress = ''
let lastLoggedExtractBucket = -1

function friendlyProgressMessage(phase: PipelineProgress['phase'], percent: number): string {
  if (phase === 'extract') return lastExtractProgress || '正在抽取影像帧'
  if (phase === 'align') return percent < 36 ? '正在初始化对齐引擎' : '正在匹配特征并对齐相机'
  if (phase === 'export') return '正在导出 COLMAP 数据和点云索引'
  if (phase === 'complete') return '重建任务已完成'
  if (phase === 'error') return '任务已中断'
  return '任务正在启动'
}

function friendlyRawMessage(raw: string): string {
  const text = raw.trim()
  if (!text) return ''

  const extractMatch = text.match(/^extract progress\s+(\d+)\/(\d+)/i)
  if (extractMatch) return `已抽取 ${extractMatch[1]}/${extractMatch[2]} 帧`

  const colmapDone = text.match(/^COLMAP_STAGE_DONE:\s*(.+)$/i)
  if (colmapDone) return `COLMAP 阶段完成：${colmapDone[1]}`

  const colmapCommand = text.match(/^COLMAP\s+([^:]+):/i)
  if (colmapCommand) return `COLMAP 正在执行：${colmapCommand[1]}`

  if (text.includes('开始抽帧')) return '开始抽取视频帧'
  if (text.includes('开始 Metashape')) return '启动 Metashape 自动对齐'
  if (text.includes('开始 COLMAP')) return '启动 COLMAP 自动处理'
  if (text.includes('应用向上轴')) return '正在应用向上轴设置'
  if (text.includes('导出 COLMAP')) return '正在导出 COLMAP 文件'
  if (text === '完成' || text.includes('job complete')) return '任务已完成'
  if (text.startsWith('>>>')) return text.replace(/^>>>\s*/, '')
  if (text.startsWith('WARN:')) return `注意：${text.slice(5).trim()}`
  return text
}

function formatLogLine(message: string, phase?: PipelineProgress['phase'], elapsed = 0, percent?: number): string {
  const safeMessage = friendlyRawMessage(message)
  const pct = typeof percent === 'number' ? ` · ${Math.round(clampPercent(percent))}%` : ''
  if (phase) return `${formatElapsed(elapsed)} · ${phaseLabels[phase]}${pct} · ${safeMessage}`
  return `${formatElapsed(elapsed)}${pct} · ${safeMessage}`
}

function shouldLogProgressEvent(event: PipelineProgress): boolean {
  const stage = event.stage || event.phase
  if (event.phase === 'extract' && stage === 'extract.frames') {
    const bucket = Math.floor(clampPercent(event.phasePercents?.extract) / 10)
    if (bucket <= lastLoggedExtractBucket && bucket < 10) return false
    lastLoggedExtractBucket = bucket
    return true
  }
  if (event.phase === 'extract' && /^已抽取\s+\d+\/\d+\s+帧$/.test(event.message || '')) return false
  return true
}

function logPercentForEvent(event: PipelineProgress): number {
  if (event.phase === 'extract') return clampPercent(event.phasePercents?.extract)
  if (event.phase === 'align') return clampPercent(event.phasePercents?.align)
  if (event.phase === 'export') return clampPercent(event.phasePercents?.export)
  return clampPercent(event.percent)
}

function appendLog(prev: string[], line: string): string[] {
  if (!line.trim()) return prev
  // Compare message content ignoring the elapsed-time prefix to deduplicate
  // consecutive reports of the same progress at different timestamps.
  const body = line.replace(/^\d{2}:\d{2} · /, '')
  const prevBody = prev[prev.length - 1]?.replace(/^\d{2}:\d{2} · /, '') ?? ''
  if (body === prevBody) return prev
  return [...prev, line]
}

export function usePipeline() {
  const [progress, setProgress] = useState<PipelineProgress>(initialProgress)
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [preview, setPreview] = useState<{ left: string; right: string } | null>(null)
  const unlisteners = useRef<Array<() => void>>([])
  const runningRef = useRef(false)
  const startTimeRef = useRef(0)

  const syncElapsed = useCallback((elapsed: number) => {
    if (!runningRef.current) return
    const safeElapsed = Math.max(0, Math.floor(elapsed || 0))
    setProgress((prev) => {
      if (prev.phase === 'complete' || prev.phase === 'error') return prev
      if (safeElapsed <= prev.elapsed) return prev
      return { ...prev, elapsed: safeElapsed }
    })
  }, [])

  const setPipelineRunning = useCallback((value: boolean) => {
    runningRef.current = value
    setRunning(value)
  }, [])

  useEffect(() => {
    if (!isTauriRuntime()) return
    let disposed = false

    const setup = async () => {
      const listeners: Array<() => void> = []
      const track = (unlisten: () => void) => {
        if (disposed) {
          unlisten()
          return false
        }
        listeners.push(unlisten)
        unlisteners.current = listeners
        return true
      }

      const progressUnlisten = await listen<PipelineProgress>('pipeline:progress', (event) => {
        // Only update progress for genuine progress events (with phase); log lines have empty phase
        if (event.payload.phase) {
          if (!runningRef.current) return
          const eventMessage = event.payload.message?.trim()
          const displayMessage = eventMessage && !/^进度\s+\d+%$/.test(eventMessage)
            ? eventMessage
            : friendlyProgressMessage(event.payload.phase, event.payload.percent)
          let sanitizedEvent: PipelineProgress | null = null
          setProgress((prev) => {
            const next = sanitizeProgress({ ...event.payload, message: displayMessage }, prev)
            sanitizedEvent = next
            // Clear frame preview once extraction finishes
            if (next.phase !== 'extract' && prev.phase === 'extract') setPreview(null)
            return next
          })
          if (shouldLogProgressEvent({ ...event.payload, message: displayMessage })) {
            const logEvent = sanitizedEvent ?? { ...event.payload, message: displayMessage }
            setLogs((prev) => appendLog(prev, formatLogLine(
              displayMessage,
              event.payload.phase,
              event.payload.elapsed,
              logPercentForEvent(logEvent),
            )))
          }
        } else {
          const msg = event.payload.message
          syncElapsed(event.payload.elapsed)
          // Skip raw "extract progress" lines — the progress event already covers this
          if (!/^extract progress/i.test(msg)) {
            setLogs((prev) => appendLog(prev, formatLogLine(msg, undefined, event.payload.elapsed)))
          }
          const m = msg.match(/extract progress (\d+)\/(\d+)/i)
          if (m) lastExtractProgress = `已抽取 ${m[1]}/${m[2]} 帧`
        }
      })

      if (!track(progressUnlisten)) return

      const completeUnlisten = await listen<PipelineComplete>('pipeline:complete', (event) => {
        if (!runningRef.current) return
        const finalElapsed = startTimeRef.current ? Math.floor((Date.now() - startTimeRef.current) / 1000) : 0
        setPipelineRunning(false)
        setProgress((prev) => ({ ...prev, phase: 'complete', percent: 100, elapsed: Math.max(prev.elapsed, finalElapsed), message: '处理完成', phasePercents: { extract: 100, align: 100, export: 100 } }))
        setLogs((prev) => appendLog(prev, formatLogLine(event.payload.outputPath ? '任务已完成，输出目录已就绪' : '任务已完成', 'complete', finalElapsed, 100)))
        setPreview(null)
      })

      if (!track(completeUnlisten)) return

      const errorUnlisten = await listen<PipelineError>('pipeline:error', (event) => {
        if (!runningRef.current && event.payload.error !== '任务已取消') return
        const finalElapsed = startTimeRef.current ? Math.floor((Date.now() - startTimeRef.current) / 1000) : 0
        setPipelineRunning(false)
        setProgress((prev) => ({ ...prev, phase: 'error', elapsed: Math.max(prev.elapsed, finalElapsed), message: event.payload.error }))
        setLogs((prev) => appendLog(prev, formatLogLine(`错误：${event.payload.error}`, 'error', finalElapsed)))
        setPreview(null)
      })

      if (!track(errorUnlisten)) return

      const previewUnlisten = await listen<{ left: string; right: string }>('pipeline:preview', (event) => {
        setPreview(event.payload)
      })
      track(previewUnlisten)
    }

    setup().catch((error) => {
      setLogs((prev) => appendLog(prev, formatLogLine(`事件监听初始化失败：${error}`, 'error')))
    })
    return () => {
      disposed = true
      if (runningRef.current) {
        runningRef.current = false
        invoke('cancel_pipeline').catch(() => {})
      }
      unlisteners.current.forEach((unlisten) => unlisten())
      unlisteners.current = []
    }
  }, [setPipelineRunning, syncElapsed])

  useEffect(() => {
    if (!running) return
    const tick = () => {
      if (!startTimeRef.current) return
      syncElapsed((Date.now() - startTimeRef.current) / 1000)
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [running, syncElapsed])

  const buildArgs = useCallback((tracks: MaterialTrack[], config: PipelineConfig): string[] => {
    const args: string[] = []
    args.push('--output', config.outputDir)

    for (const track of tracks.filter((item) => item.type === 'panoramic_video')) {
      if (track.path) args.push('--pano', track.path)
      // Trim window pairs with --pano by position (see run_xpano_tracks_job.py).
      args.push('--pano-start', String(track.trim?.start ?? 0))
      args.push('--pano-end', String(track.trim?.end ?? 0))
      args.push('--pano-seconds-per-frame', String(track.extract?.secondsPerFrame ?? defaultTrackExtract.secondsPerFrame))
      args.push('--pano-max-frames', String(track.extract?.frameLimit ?? defaultTrackExtract.frameLimit))
    }
    for (const track of tracks.filter((item) => item.type === 'standard_photos')) {
      if (track.path) args.push('--standard-track', track.label, track.path)
    }
    for (const track of tracks.filter((item) => item.type === 'aerial_photos')) {
      if (track.path) args.push('--aerial-track', track.label, track.path)
    }

    args.push('--seconds-per-frame', String(config.secondsPerFrame))
    if (config.frameLimit > 0) args.push('--max-frames', String(config.frameLimit))

    if (config.alignmentEngine === 'metashape') {
      if (config.metashapePath && config.metashapePath !== 'metashape.exe') {
        args.push('--metashape', config.metashapePath)
      }
      args.push('--metashape-keypoint-limit', String(config.metaKeypointLimit))
      args.push('--metashape-tiepoint-limit', String(config.metaTiepointLimit))
    } else {
      args.push('--backend', 'colmap')
      if (config.colmapPath) args.push('--colmap', config.colmapPath)
      args.push('--colmap-density-preset', config.colmapDensityPreset)
      args.push('--colmap-matcher', config.colmapMatcher)
      if (config.colmapUseGpu) args.push('--colmap-use-gpu')
      args.push('--colmap-max-image-size', String(config.colmapMaxImageSize))
      args.push('--colmap-max-num-features', String(config.colmapMaxNumFeatures))
    }

    args.push('--up-axis', config.upAxis)

    return args
  }, [])

  const start = useCallback(async (tracks: MaterialTrack[], config: PipelineConfig, skipExtract = false) => {
    if (!isTauriRuntime()) {
      setLogs((prev) => appendLog(prev, formatLogLine('浏览器预览模式下不能启动高斯对齐，请在 Tauri 桌面应用中运行。', 'error')))
      return
    }

    setPipelineRunning(true)
    setLogs([])
    setPreview(null)
    lastExtractProgress = ''
    lastLoggedExtractBucket = -1
    startTimeRef.current = Date.now()
    setProgress({
      phase: 'idle',
      percent: 0,
      message: '启动中...',
      elapsed: 0,
      phasePercents: { extract: 0, align: 0, export: 0 },
    })
    setLogs((prev) => appendLog(prev, formatLogLine('正在创建任务并检查参数', 'idle', 0, 0)))

    try {
      const args = buildArgs(tracks, config)
      if (skipExtract) args.push('--skip-extract')
      await invoke('start_pipeline', {
        pythonExe: detectPython(),
        script: 'scripts/run_xpano_tracks_job.py',
        args,
      })
    } catch (error) {
      setPipelineRunning(false)
      setProgress((prev) => ({ ...prev, phase: 'error', message: String(error) }))
      setLogs((prev) => appendLog(prev, formatLogLine(`启动失败：${error}`, 'error')))
    }
  }, [buildArgs, setPipelineRunning])

  const cancel = useCallback(async () => {
    if (!isTauriRuntime() || !runningRef.current) return
    const realElapsed = Math.floor((Date.now() - startTimeRef.current) / 1000)
    setPipelineRunning(false)
    setProgress((prev) => ({ ...prev, phase: 'error', message: '任务已取消', elapsed: prev.elapsed || realElapsed }))
    setLogs((prev) => appendLog(prev, formatLogLine('任务已取消', 'error', realElapsed)))
    setPreview(null)
    try {
      await invoke('cancel_pipeline')
    } catch (error) {
      setProgress((prev) => ({ ...prev, phase: 'error', message: `停止失败：${error}` }))
      setLogs((prev) => appendLog(prev, formatLogLine(`停止失败：${error}`, 'error')))
    }
  }, [setPipelineRunning])

  const reset = useCallback(() => {
    setProgress(initialProgress)
    setLogs([])
    setPreview(null)
    lastExtractProgress = ''
    lastLoggedExtractBucket = -1
  }, [])

  return { progress, running, logs, preview, start, cancel, reset }
}
