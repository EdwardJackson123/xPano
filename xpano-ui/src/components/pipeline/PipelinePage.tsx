import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  Camera,
  ChevronDown,
  Crosshair,
  ChevronUp,
  CheckCircle2,
  Cpu,
  Eye,
  FolderOpen,
  Gauge,
  Image,
  PanelRight,
  Plane,
  Play,
  Plus,
  Scissors,
  Search,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Video,
} from 'lucide-react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import gsap from 'gsap'
import { ThemeControls } from '../layout/ThemeControls'
import { WindowControls } from '../layout/WindowControls'
import { ToastContainer } from '../shared/Toast'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { VideoTrimmer } from './VideoTrimmer'
import { useToast } from '../../hooks/useToast'
import { usePipeline } from '../../hooks/usePipeline'
import { useMaskProcess } from '../../hooks/useMaskProcess'
import { useMorphSwap } from '../../hooks/useGsap'
import type {
  AlignmentEngine,
  ColmapDensityPreset,
  ColmapMatcher,
  MaterialTrack,
  PipelineConfig,
  PipelinePhase,
  MaskConfig,
  MaskDevice,
  MaskExpandMode,
  ThemeMode,
  TrackType,
} from '../../lib/types'

interface PipelinePageProps {
  themeMode: ThemeMode
  onThemeModeChange: (mode: ThemeMode) => void
  /** Notifies the host that a pipeline is running so ambient effects can react. */
  onPipelineStateChange?: (state: { running: boolean; phase: PipelinePhase }) => void
}

const trackMeta: Record<TrackType, { icon: ReactNode; label: string; hint: string }> = {
  panoramic_video: { icon: <Video size={18} strokeWidth={1.8} />, label: '全景视频', hint: '.osv / .insv' },
  standard_photos: { icon: <Image size={18} strokeWidth={1.8} />, label: '标准照片', hint: '照片文件夹' },
  aerial_photos: { icon: <Plane size={18} strokeWidth={1.8} />, label: '航拍照片', hint: '无人机航线' },
}

const stageLabels: Record<'extract' | 'align' | 'export', string> = {
  extract: '抽帧',
  align: '对齐',
  export: '导出',
}

const phaseLabels: Record<PipelinePhase, string> = {
  idle: '等待开始',
  extract: '抽帧中',
  align: '对齐中',
  export: '导出中',
  complete: '处理完成',
  error: '处理出错',
}

const defaultConfig: PipelineConfig = {
  outputDir: '',
  metashapePath: '',
  colmapPath: '',
  secondsPerFrame: 1.0,
  frameLimit: 0,
  alignmentEngine: 'metashape',
  metaKeypointLimit: 40000,
  metaTiepointLimit: 0,
  upAxis: '+Y',
  colmapDensityPreset: 'stable',
  colmapUseGpu: false,
  colmapMatcher: 'sequential',
  colmapMaxImageSize: 1600,
  colmapMaxNumFeatures: 4096,
}

const defaultExtractConfig = { secondsPerFrame: 1.0, frameLimit: 0 }

const defaultMaskConfig: MaskConfig = {
  targets: ['person'],
  includeShadow: false,
  expandMode: 'pixels',
  expandPixels: 15,
  expandPercent: 1.0,
  edgeFusePixels: 25,
  device: 'auto',
  workers: Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4)),
}

const maskTargetOptions = [
  { value: 'person', label: '人物', group: '常用目标' },
  { value: 'car', label: '汽车', group: '常用目标' },
  { value: 'bicycle', label: '自行车', group: '常用目标' },
  { value: 'motorcycle', label: '摩托车', group: '常用目标' },
  { value: 'bus', label: '公交车', group: '常用目标' },
  { value: 'truck', label: '卡车', group: '常用目标' },
  { value: 'animal', label: '动物（鸟/猫/狗）', group: '常用目标' },
  { value: 'airplane', label: '飞机', group: '更多 COCO 类别' },
  { value: 'train', label: '火车', group: '更多 COCO 类别' },
  { value: 'boat', label: '船', group: '更多 COCO 类别' },
  { value: 'bird', label: '鸟', group: '更多 COCO 类别' },
  { value: 'cat', label: '猫', group: '更多 COCO 类别' },
  { value: 'dog', label: '狗', group: '更多 COCO 类别' },
  { value: 'horse', label: '马', group: '更多 COCO 类别' },
  { value: 'sheep', label: '羊', group: '更多 COCO 类别' },
  { value: 'cow', label: '牛', group: '更多 COCO 类别' },
  { value: 'backpack', label: '背包', group: '更多 COCO 类别' },
  { value: 'umbrella', label: '雨伞', group: '更多 COCO 类别' },
  { value: 'handbag', label: '手提包', group: '更多 COCO 类别' },
  { value: 'suitcase', label: '行李箱', group: '更多 COCO 类别' },
  { value: 'bench', label: '长椅', group: '更多 COCO 类别' },
  { value: 'chair', label: '椅子', group: '更多 COCO 类别' },
  { value: 'couch', label: '沙发', group: '更多 COCO 类别' },
] as const

export function PipelinePage({
  themeMode,
  onThemeModeChange,
  onPipelineStateChange,
}: PipelinePageProps) {
  const navigate = useNavigate()
  const [tracks, setTracks] = useState<MaterialTrack[]>([])
  const [config, setConfig] = useState(defaultConfig)
  const [maskConfig, setMaskConfig] = useState(defaultMaskConfig)
  const [showRightPanel, setShowRightPanel] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<MaterialTrack | null>(null)
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null)
  const { progress, running, logs, start: startPipeline, cancel, reset } = usePipeline()
  const maskTask = useMaskProcess()
  const { toasts, removeToast, toast } = useToast()
  const shellRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const lastOutcomeToastRef = useRef<PipelinePhase | null>(null)

  // Lift running state to the host so the particle field can tune its motion budget.
  useEffect(() => {
    onPipelineStateChange?.({ running: running || maskTask.running, phase: progress.phase })
  }, [running, maskTask.running, progress.phase, onPipelineStateChange])

  useEffect(() => () => {
    onPipelineStateChange?.({ running: false, phase: 'idle' })
  }, [onPipelineStateChange])

  // Surface pipeline completion / failure as a toast so the outcome is never silent.
  useEffect(() => {
    if (progress.phase !== 'complete' && progress.phase !== 'error') {
      lastOutcomeToastRef.current = null
      return
    }
    if (lastOutcomeToastRef.current === progress.phase) return
    lastOutcomeToastRef.current = progress.phase

    if (progress.phase === 'complete') toast.success('高斯对齐完成，已导出 Colmap 数据')
    else if (progress.message.includes('取消')) toast.warning('任务已取消，可重新开始')
    else toast.error(progress.message || '高斯对齐过程中出错')
  }, [progress.phase, progress.message, toast])

  const lastMaskOutcomeToastRef = useRef<string | null>(null)
  useEffect(() => {
    const status = maskTask.progress.status
    if (status !== 'complete' && status !== 'error') {
      lastMaskOutcomeToastRef.current = null
      return
    }
    if (lastMaskOutcomeToastRef.current === status) return
    lastMaskOutcomeToastRef.current = status
    if (status === 'complete') toast.success('遮罩处理完成，已生成与 images 对应的 masks')
    else if (maskTask.progress.message.includes('取消')) toast.warning('遮罩任务已取消，原有输出未受影响')
    else toast.error(maskTask.progress.message || '遮罩处理过程中出错')
  }, [maskTask.progress.status, maskTask.progress.message, toast])

  // Keep the terminal pinned to the latest line while logs stream in,
  // but only when the user hasn't scrolled up to read past entries.
  const userScrolledUp = useRef(false)
  useEffect(() => {
    const el = logRef.current
    if (!el) return
    const onScroll = () => {
      userScrolledUp.current = el.scrollHeight - el.scrollTop - el.clientHeight >= 40
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useLayoutEffect(() => {
    const el = logRef.current
    if (!el) return
    if (!userScrolledUp.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [logs])

  useEffect(() => {
    try {
      const saved = localStorage.getItem('xpano-config')
      if (saved) setConfig((prev) => ({ ...prev, ...JSON.parse(saved) }))
    } catch {
      // Defaults keep the app usable when local state is malformed.
    }
  }, [])

  useEffect(() => {
    const nodes = shellRef.current?.querySelectorAll('[data-enter]')
    if (!nodes?.length) return
    gsap.fromTo(
      nodes,
      { autoAlpha: 0, y: 14 },
      { autoAlpha: 1, y: 0, duration: 0.56, ease: 'power3.out', stagger: 0.035 }
    )
  }, [])

  useEffect(() => {
    const root = shellRef.current
    if (!root) return

    let frame = 0
    let mouseX = -9999
    let mouseY = -9999
    const radius = 118

    const update = () => {
      frame = 0
      const icons = root.querySelectorAll<HTMLElement>('.icon-tile, .icon-tile-lg')
      icons.forEach((icon) => {
        const rect = icon.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        const dx = mouseX - cx
        const dy = mouseY - cy
        const distance = Math.sqrt(dx * dx + dy * dy)
        const proximity = Math.max(0, 1 - distance / radius)
        // Only brightness/saturation lift — no translate, so click targets stay put.
        icon.style.setProperty('--icon-proximity', proximity.toFixed(3))
      })
    }

    const requestUpdate = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }

    const onMove = (event: MouseEvent) => {
      mouseX = event.clientX
      mouseY = event.clientY
      requestUpdate()
    }

    const onLeave = () => {
      mouseX = -9999
      mouseY = -9999
      requestUpdate()
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseout', onLeave)
    requestUpdate()

    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseout', onLeave)
    }
  }, [])

  useEffect(() => {
    if (!config.outputDir && !config.metashapePath && !config.colmapPath) return
    try {
      localStorage.setItem('xpano-config', JSON.stringify(config))
    } catch {
      // Local persistence is a convenience only.
    }
  }, [config])

  const addTrack = async (type: TrackType) => {
    if (type === 'panoramic_video') {
      const selected = await openDialog({ multiple: true, filters: [{ name: '全景视频', extensions: ['osv', 'insv'] }] })
      if (!selected) return
      const files = Array.isArray(selected) ? selected : [selected]
      for (const path of files) {
        setTracks((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            type,
            label: path.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') || '全景视频',
            path,
            extract: defaultExtractConfig,
          },
        ])
      }
      toast.success(`已添加 ${files.length} 个全景视频`)
      return
    }

    const selected = await openDialog({ directory: true })
    if (!selected) return
    setTracks((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        type,
        label: selected.split(/[/\\]/).pop() || trackMeta[type].label,
        path: selected,
      },
    ])
    toast.success(`已添加：${selected.split(/[/\\]/).pop() || trackMeta[type].label}`)
  }

  const removeTrack = (id: string) => {
    const target = tracks.find((track) => track.id === id)
    if (!target) return
    // Gate single-track removal behind a confirm dialog so a stray click can't drop a configured track.
    setConfirmRemove(target)
  }

  const executeRemove = () => {
    const target = confirmRemove
    setConfirmRemove(null)
    if (!target) return
    setTracks((prev) => prev.filter((track) => track.id !== target.id))
    toast.info(`已移除：${target.label}`)
  }

  const handleStart = async () => {
    startPipeline(tracks, config)
    toast.info(`启动高斯对齐（${tracks.length} 组素材），将自动检查可复用抽帧`)
  }

  const handleMaskStart = async () => {
    if (!config.outputDir) {
      toast.warning('请先选择包含最终 images 目录的输出目录')
      return
    }
    if (running) {
      toast.warning('请等待高斯对齐任务结束后再处理遮罩')
      return
    }
    maskTask.start(config.outputDir, maskConfig)
    toast.info('启动独立遮罩处理，将读取最终 images 并输出同级 masks')
  }

  const handleCancel = () => {
    cancel()
  }

  const selectedTrack = tracks.find((track) => track.id === selectedTrackId) ?? null
  const selectedExtract = {
    secondsPerFrame: selectedTrack?.extract?.secondsPerFrame ?? defaultExtractConfig.secondsPerFrame,
    frameLimit: selectedTrack?.extract?.frameLimit ?? defaultExtractConfig.frameLimit,
  }

  const updateTrim = (id: string, trim: { start: number; end: number }) => {
    setTracks((prev) => prev.map((track) => (track.id === id ? { ...track, trim } : track)))
  }

  const updateExtract = (id: string, extract: { secondsPerFrame: number; frameLimit: number }) => {
    setTracks((prev) => prev.map((track) => (track.id === id ? { ...track, extract } : track)))
  }

  const browseOutput = async () => {
    const selected = await openDialog({ directory: true })
    if (selected) setConfig((prev) => ({ ...prev, outputDir: selected }))
  }

  const openOutput = async () => {
    if (config.outputDir) await invoke('open_output_folder', { path: config.outputDir })
  }

  const browseEngine = async () => {
    const name = config.alignmentEngine === 'metashape' ? 'Metashape' : 'Colmap'
    const selected = await openDialog({ filters: [{ name, extensions: ['exe'] }] })
    if (!selected) return
    setConfig((prev) => (
      prev.alignmentEngine === 'metashape'
        ? { ...prev, metashapePath: selected }
        : { ...prev, colmapPath: selected }
    ))
  }

  const noEngine = config.alignmentEngine === 'metashape' ? !config.metashapePath : !config.colmapPath
  const canStart = tracks.length > 0 && Boolean(config.outputDir) && !noEngine && !maskTask.running
  const canStartMask = Boolean(config.outputDir) && !running && !maskTask.running
  const maskVisible = maskTask.running || maskTask.progress.status === 'complete' || maskTask.progress.status === 'error'
  const visibleProgress = maskVisible ? {
    phase: maskTask.progress.status === 'complete' ? 'complete' as const : maskTask.progress.status === 'error' ? 'error' as const : 'export' as const,
    stage: 'mask',
    percent: maskTask.progress.percent,
    message: maskTask.progress.message,
    elapsed: maskTask.progress.elapsed,
    phasePercents: { extract: 0, align: 0, export: maskTask.progress.percent },
  } : progress
  const visibleRunning = maskVisible ? maskTask.running : running
  const visibleLogs = maskVisible ? maskTask.logs : logs
  const idle = !visibleRunning && visibleProgress.phase !== 'complete' && visibleProgress.phase !== 'error'
  const blockReason = !config.outputDir
    ? '请选择输出目录'
    : !tracks.length
      ? '请先添加至少一组素材'
      : noEngine
        ? `请选择 ${config.alignmentEngine === 'metashape' ? 'Metashape.exe' : 'Colmap.exe'}`
        : '准备就绪'

  const trackCounts = {
    panoramic_video: tracks.filter((track) => track.type === 'panoramic_video').length,
    standard_photos: tracks.filter((track) => track.type === 'standard_photos').length,
    aerial_photos: tracks.filter((track) => track.type === 'aerial_photos').length,
  }

  const inputClass = 'theme-input w-full rounded-comfortable border px-3 py-2 text-[13px] outline-none transition-all'

  const engineReady = !noEngine
  const activeEngineName = config.alignmentEngine === 'metashape' ? 'Metashape' : 'Colmap'
  const activeEnginePath = config.alignmentEngine === 'metashape' ? config.metashapePath : config.colmapPath
  const activeEngineFile = activeEnginePath?.split(/[/\\]/).pop()

  return (
    <div className="liquid-shell relative z-10 h-screen overflow-hidden bg-transparent text-ink">
      <ConfirmDialog
        open={confirmRemove !== null}
        danger
        title="移除素材轨道？"
        message={`将从列表移除「${confirmRemove?.label ?? ''}」，不影响磁盘文件。`}
        confirmText="移除"
        onConfirm={executeRemove}
        onCancel={() => setConfirmRemove(null)}
      />

      {/* Top bar */}
      <div className="liquid-topbar fixed left-2 right-2 top-2 z-50 flex h-10 items-center justify-between rounded-[14px] border-0 py-0 pl-3.5 pr-0 drag-region">
        <div className="flex items-center gap-2.5">
          <img src="/icon.png" alt="xPano" className="h-6 w-6 rounded-subtle" />
          <div className="leading-none">
            <span className="text-[13px] font-medium text-ink">xPano</span>
            <span className="ml-2 text-[11px] font-medium text-muted">EXPLORER AI</span>
          </div>
        </div>
        <div className="topbar-control-group no-drag flex items-center gap-1">
          <ThemeControls
            themeMode={themeMode}
            onThemeModeChange={onThemeModeChange}
          />
          <button
            onClick={() => setShowRightPanel((v) => !v)}
            className="motion-press grid h-7 w-7 place-items-center rounded-subtle text-ink/45 hover:bg-white/[0.08] hover:text-ink/72 transition-colors xl:hidden"
            title={showRightPanel ? '隐藏状态面板' : '显示状态面板'}
          >
            <PanelRight className="h-4 w-4" />
          </button>
          <span className="topbar-control-divider" />
          <WindowControls />
        </div>
      </div>

      <div ref={shellRef} className="grid h-screen box-border grid-cols-[220px_minmax(0,1fr)] gap-2 px-2 pb-2 pt-14 xl:grid-cols-[252px_minmax(0,1fr)_320px]">
        {/* Left — material library (知天下导航风格) */}
        <aside className="liquid-panel flex min-h-0 flex-col overflow-x-hidden p-4">
          <div data-enter className="theme-segment relative flex p-1 overflow-hidden" style={{ boxShadow: 'inset 0 2px 4px var(--xp-segment-inset), inset 0 1px 2px var(--xp-segment-inset-soft)' }}>
            <span
              className="absolute top-0.5 bottom-0.5 w-[calc(50%-6px)] rounded-subtle"
              style={{
                left: config.alignmentEngine === 'colmap' ? 'calc(50% + 3px)' : '3px',
                background: 'linear-gradient(180deg, var(--xp-brand-soft), var(--xp-brand))',
                border: '1px solid rgba(255,255,255,0.25)',
                boxShadow: `
                  0 8px 20px var(--xp-segment-glow),
                  0 2px 6px var(--xp-segment-glow-soft),
                  inset 0 1px 0 rgba(255,255,255,0.25)
                `,
                transition: 'left 320ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            />
            {(['metashape', 'colmap'] as const).map((engine) => (
              <button key={engine} onClick={() => setConfig((prev) => ({ ...prev, alignmentEngine: engine as AlignmentEngine }))}
                className={`motion-press relative z-10 flex-1 rounded-subtle px-3 py-1.5 text-[12px] font-medium transition-colors duration-200 ${
                  config.alignmentEngine === engine ? 'text-white' : 'text-muted hover:text-ink'
                }`}>{engine === 'metashape' ? 'Metashape' : 'Colmap'}</button>
            ))}
          </div>

          <button onClick={browseEngine} data-enter
            className="glass-control mt-2.5 flex w-full items-center gap-2.5 rounded-card px-3 py-2.5 text-left transition-all hover:-translate-y-0.5 hover:text-brand">
            <span className="icon-tile grid h-8 w-8 shrink-0 place-items-center rounded-comfortable">
              <Cpu className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium text-ink">{activeEngineName} 路径</span>
                <span className={`h-1.5 w-1.5 rounded-full ${activeEnginePath ? 'bg-brand' : 'bg-ink/20'}`} />
              </span>
              <span className="mt-1 block truncate text-[11px] text-muted">
                {activeEngineFile || '选择对齐引擎可执行文件'}
              </span>
            </span>
          </button>

          {/* Add-track shortcuts — empty state surfaces bigger cards in the track list below. */}
          {tracks.length > 0 && (
            <nav className="mt-4 flex flex-col gap-0.5">
              {(Object.keys(trackMeta) as TrackType[]).map((type) => (
                <button key={type} data-enter onClick={() => addTrack(type)}
                  className="group flex w-full items-center gap-2.5 rounded-card px-3 py-2 text-left text-[12px] text-ink/80 transition-all hover:bg-[var(--xp-control-hover)] hover:text-ink">
                  <span className="icon-tile grid h-7 w-7 place-items-center rounded-comfortable transition-transform group-hover:scale-105">{trackMeta[type].icon}</span>
                  <span className="flex-1">{trackMeta[type].label}</span>
                  <Plus className="h-3 w-3 opacity-0 group-hover:opacity-40 transition-opacity" />
                </button>
              ))}
            </nav>
          )}

          {/* Tracks list */}
          <section className="relative mt-4 flex min-h-0 flex-1 flex-col">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="ui-label text-[11px]">素材轨道</h3>
              {tracks.length > 0 && (
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted">
                  <span className={`beacon h-1.5 w-1.5 ${idle ? 'beacon-idle' : ''}`} />
                  {tracks.length}
                </span>
              )}
            </div>

            {!tracks.length ? (
              <div className="flex flex-1 flex-col gap-2">
                {(Object.keys(trackMeta) as TrackType[]).map((type) => (
                  <button key={type} data-enter onClick={() => addTrack(type)}
                    className="liquid-card liquid-card-clear group flex items-center gap-3 p-3 text-left transition-all hover:-translate-y-0.5 hover:border-brand/30">
                    <span className="icon-tile grid h-9 w-9 shrink-0 place-items-center rounded-card transition-transform group-hover:scale-105">{trackMeta[type].icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-ink">{trackMeta[type].label}</span>
                      <span className="block truncate font-mono text-[11px] text-muted">{trackMeta[type].hint}</span>
                    </span>
                    <Plus className="h-3.5 w-3.5 shrink-0 text-muted transition-colors group-hover:text-brand" />
                  </button>
                ))}
              </div>
            ) : (
              <div className="glass-inset flex-1 overflow-y-auto overflow-x-hidden rounded-card">
                {tracks.map((track) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    selected={track.id === selectedTrackId}
                    onSelect={(id) => setSelectedTrackId(prev => prev === id ? null : id)}
                    onRemove={removeTrack}
                  />
                ))}
              </div>
            )}
          </section>

          <div className="mt-3 grid grid-cols-3 gap-1.5 border-t border-[var(--xp-line)] pt-3">
            <MiniCount label="视频" value={trackCounts.panoramic_video} />
            <MiniCount label="照片" value={trackCounts.standard_photos} />
            <MiniCount label="航拍" value={trackCounts.aerial_photos} />
          </div>
          <button
            onClick={() => {
              if (running) return
              navigate(config.outputDir ? `/viewer/${encodeURIComponent(config.outputDir)}` : '/viewer/demo')
            }}
            disabled={running}
            title={running ? '任务运行中暂不可查看点云' : undefined}
            data-enter
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-card py-2 text-[12px] text-muted transition-colors hover:bg-[var(--xp-control-hover)] hover:text-brand disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted">
            <Eye className="h-3.5 w-3.5" /> 查看点云
          </button>
        </aside>

        {/* Center — main stage */}
        <main className="liquid-panel stage-grid flex min-h-0 flex-col overflow-y-auto overflow-x-hidden p-4">
          <div data-enter className="mb-3 flex shrink-0 items-start justify-between gap-4">
            <div>
              <h1 className="text-[16px] font-medium text-ink">三维高斯对齐工作台</h1>
            </div>
            <div className="hidden items-center gap-2 lg:flex">
              <span className="rounded-full border border-[var(--xp-line)] bg-brand/8 px-2.5 py-1 text-[11px] font-medium text-brand">{activeEngineName}</span>
              <span className="rounded-full border border-[var(--xp-line)] bg-data/8 px-2.5 py-1 text-[11px] font-medium text-data">COLMAP 输出</span>
            </div>
          </div>

          {/* Output & params toolbar */}
          <div data-enter className="glass-inset mb-3 flex shrink-0 flex-wrap items-end gap-3 rounded-card p-2.5">
            <div className="min-w-0 flex-1">
              <label className="ui-label mb-1.5 block whitespace-nowrap text-[11px]">输出目录</label>
              <div className="flex gap-2">
                <input className={`${inputClass} flex-1 font-mono`} value={config.outputDir} onChange={(event) => setConfig({ ...config, outputDir: event.target.value })} placeholder="选择或粘贴输出目录..." spellCheck={false} />
                <IconButton label="选择" onClick={browseOutput}><FolderOpen className="h-4 w-4" /></IconButton>
              </div>
            </div>
          </div>

          {/* Advanced parameters — grouped with the output/extract settings above */}
          <section data-enter className="glass-inset relative z-30 mb-3 shrink-0 overflow-visible rounded-card p-3">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="ui-label text-[11px]">高级参数</h3>
              <span className="rounded-full border border-[var(--xp-line)] bg-[var(--xp-control)] px-2 py-0.5 font-mono text-[11px] text-muted">{activeEngineName}</span>
            </div>
            <div className="flex flex-wrap items-start gap-3">
                <Field label="向上轴">
                  <ThemeSelect className="w-20" value={config.upAxis} onChange={(v) => setConfig({ ...config, upAxis: v })} options={[
                    { value: '+Y', label: '+Y' }, { value: '-Y', label: '-Y' }, { value: '+Z', label: '+Z' }, { value: '-Z', label: '-Z' }, { value: '+X', label: '+X' }, { value: '-X', label: '-X' },
                  ]} />
                </Field>
              {config.alignmentEngine === 'metashape' ? (<>
                <Field label="关键点"><NumberInput value={config.metaKeypointLimit} onChange={(value) => setConfig({ ...config, metaKeypointLimit: value })} /></Field>
                <Field label="连接点"><NumberInput value={config.metaTiepointLimit} onChange={(value) => setConfig({ ...config, metaTiepointLimit: value })} /></Field>
              </>) : (<>
                  <Field label="密度">
                    <ThemeSelect className="w-24" value={config.colmapDensityPreset} onChange={(v) => setConfig({ ...config, colmapDensityPreset: v as ColmapDensityPreset })} options={[
                      { value: 'stable', label: '稳定' }, { value: 'high-density', label: '高密度' }, { value: 'experimental-high-density', label: '实验' },
                    ]} />
                  </Field>
                  <Field label="匹配">
                    <ThemeSelect className="w-20" value={config.colmapMatcher} onChange={(v) => setConfig({ ...config, colmapMatcher: v as ColmapMatcher })} options={[
                      { value: 'sequential', label: '顺序' }, { value: 'exhaustive', label: '穷举' },
                    ]} />
                  </Field>
                  <Field label="图像尺寸"><NumberInput value={config.colmapMaxImageSize} onChange={(value) => setConfig({ ...config, colmapMaxImageSize: value })} /></Field>
                  <Field label="特征点数"><NumberInput value={config.colmapMaxNumFeatures} onChange={(value) => setConfig({ ...config, colmapMaxNumFeatures: value })} /></Field>
                  <div className="ml-auto self-end"><SwitchRow label="GPU 加速" checked={config.colmapUseGpu} onClick={() => setConfig({ ...config, colmapUseGpu: !config.colmapUseGpu })} /></div>
              </>)}
            </div>
            <div className="mt-3 border-t border-[var(--xp-line)] pt-3">
              <div className="mb-2.5 flex items-center justify-between gap-3">
                <h4 className="ui-label flex items-center gap-1.5 text-[11px]"><ShieldCheck className="h-3.5 w-3.5 text-brand" /> 遮罩参数</h4>
                <span className="text-[10px] text-muted">最终 images → masks · 白色参与训练</span>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="遮罩目标">
                  <ThemeMultiSelect
                    className="w-52"
                    value={maskConfig.targets}
                    onChange={(targets) => setMaskConfig({ ...maskConfig, targets })}
                    options={maskTargetOptions}
                  />
                </Field>
                <Field label="扩张方式">
                  <ThemeSelect className="w-24" value={maskConfig.expandMode} onChange={(value) => setMaskConfig({ ...maskConfig, expandMode: value as MaskExpandMode })} options={[
                    { value: 'pixels', label: '像素' }, { value: 'percent', label: '百分比' },
                  ]} />
                </Field>
                {maskConfig.expandMode === 'pixels' ? (
                  <Field label="扩张像素"><NumberInput value={maskConfig.expandPixels} onChange={(value) => setMaskConfig({ ...maskConfig, expandPixels: value })} /></Field>
                ) : (
                  <Field label="扩张百分比"><NumberInput value={maskConfig.expandPercent} step={0.1} onChange={(value) => setMaskConfig({ ...maskConfig, expandPercent: value })} /></Field>
                )}
                <Field label="边缘融合"><NumberInput value={maskConfig.edgeFusePixels} onChange={(value) => setMaskConfig({ ...maskConfig, edgeFusePixels: value })} /></Field>
                <Field label="计算设备">
                  <ThemeSelect className="w-24" value={maskConfig.device} onChange={(value) => setMaskConfig({ ...maskConfig, device: value as MaskDevice })} options={[
                    { value: 'auto', label: '自动' }, { value: 'cuda', label: 'CUDA' }, { value: 'cpu', label: 'CPU' },
                  ]} />
                </Field>
                <Field label="预读取线程"><NumberInput value={maskConfig.workers} min={1} onChange={(value) => setMaskConfig({ ...maskConfig, workers: value })} /></Field>
                <SwitchRow label="包含邻近阴影" checked={maskConfig.includeShadow} onClick={() => setMaskConfig({ ...maskConfig, includeShadow: !maskConfig.includeShadow })} />
              </div>
            </div>
          </section>

          {/* Video clip trimmer — shows when a panoramic video track is selected */}
          <section data-enter className="glass-inset mb-3 shrink-0 rounded-card p-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="ui-label flex min-w-0 items-center gap-1.5 text-[11px]">
                <Scissors className="h-3.5 w-3.5 shrink-0" />
                <span className="shrink-0">视频截取</span>
                {selectedTrack && (
                  <span className="truncate font-mono text-[11px] font-normal text-muted">{selectedTrack.label}</span>
                )}
              </h3>
              {selectedTrack?.trim && (
                <button
                  onClick={() => setTracks((prev) => prev.map((t) => (t.id === selectedTrack.id ? { ...t, trim: undefined } : t)))}
                  className="shrink-0 text-[11px] text-muted transition-colors hover:text-danger"
                >
                  清除截取
                </button>
              )}
            </div>
            <div key={selectedTrackId ?? 'empty'} className="motion-fade-up">
            {selectedTrack?.type === 'panoramic_video' ? (
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-end gap-2.5 border-b border-[var(--xp-line)] pb-2.5">
                  <Field label="帧/秒">
                    <NumberInput
                      value={selectedExtract.secondsPerFrame > 0 ? Math.round(1 / selectedExtract.secondsPerFrame) : 1}
                      step={1}
                      min={1}
                      onChange={(value) => updateExtract(selectedTrack.id, {
                        ...selectedExtract,
                        secondsPerFrame: value > 0 ? +(1 / value).toFixed(3) : 1,
                      })}
                    />
                  </Field>
                  <Field label="帧数上限">
                    <NumberInput
                      value={selectedExtract.frameLimit}
                      onChange={(value) => updateExtract(selectedTrack.id, { ...selectedExtract, frameLimit: value })}
                    />
                  </Field>
                </div>
                <VideoTrimmer
                  key={selectedTrack.id}
                  path={selectedTrack.path}
                  trim={selectedTrack.trim}
                  onChange={(trim) => updateTrim(selectedTrack.id, trim)}
                />
              </div>
            ) : (
              <div className="grid place-items-center py-8 text-center text-muted">
                <div>
                  <Scissors className="mx-auto mb-2 h-5 w-5 opacity-50" />
                  <p className="text-[12px]">在左侧选择一个全景视频轨道</p>
                  <p className="mt-0.5 text-[11px] opacity-70">可截取视频片段用于高斯对齐</p>
                </div>
              </div>
            )}
            </div>
          </section>

          {/* Bottom terminal — moved to the right status cell */}

          <div className="mt-auto pt-3">
            <ToastContainer toasts={toasts} onRemove={removeToast} />
          </div>
        </main>

        {/* Right — status cell (3rd column on xl, overlay on smaller) */}
        <div className="hidden xl:contents">
          <StatusCell
            idle={idle}
            canStart={canStart}
            blockReason={blockReason}
            progress={visibleProgress}
            running={visibleRunning}
            outputReady={Boolean(config.outputDir)}
            materialCount={tracks.length}
            engineReady={engineReady}
            logs={visibleLogs}
            logRef={logRef}
            onStart={handleStart}
            onCancel={maskTask.running ? maskTask.cancel : handleCancel}
            onReset={maskVisible ? maskTask.reset : reset}
            onOpenOutput={openOutput}
            canStartMask={canStartMask}
            onStartMask={handleMaskStart}
            maskMode={maskVisible}
          />
        </div>
        {/* Right panel overlay for non-xl screens */}
        {showRightPanel && (
          <div className="liquid-panel fixed right-2 top-14 bottom-2 z-40 w-[320px] max-w-[calc(100vw-1rem)] overflow-y-auto xl:hidden animate-in slide-in-from-right-2 duration-200">
            <div className="flex items-center justify-between p-3 pb-0">
              <span className="text-[12px] font-semibold text-ink/60">状态面板</span>
              <button onClick={() => setShowRightPanel(false)} className="motion-press grid h-6 w-6 place-items-center rounded-subtle text-ink/40 hover:text-ink/70">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <StatusCell
              idle={idle}
              canStart={canStart}
              blockReason={blockReason}
              progress={visibleProgress}
              running={visibleRunning}
              outputReady={Boolean(config.outputDir)}
              materialCount={tracks.length}
              engineReady={engineReady}
              logs={visibleLogs}
              logRef={logRef}
              onStart={handleStart}
              onCancel={maskTask.running ? maskTask.cancel : handleCancel}
              onReset={maskVisible ? maskTask.reset : reset}
              onOpenOutput={openOutput}
              canStartMask={canStartMask}
              onStartMask={handleMaskStart}
              maskMode={maskVisible}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function MiniCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="glass-inset rounded-card px-2 py-2 text-center">
      <p className="font-mono text-[15px] font-medium text-ink">{value}</p>
      <p className="text-[11px] text-muted">{label}</p>
    </div>
  )
}

function IconButton({ children, label, onClick }: { children: ReactNode; label: string; onClick: () => void }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className="glass-control motion-press grid h-10 w-11 place-items-center rounded-card text-ink/72 transition-all hover:-translate-y-0.5 hover:text-brand">
      {children}
    </button>
  )
}

function TrackRow({
  track,
  selected,
  onSelect,
  onRemove,
}: {
  track: MaterialTrack
  selected: boolean
  onSelect: (id: string) => void
  onRemove: (id: string) => void
}) {
  const editable = track.type === 'panoramic_video'
  return (
    <div
      className={`group flex flex-col border-b border-ink/[0.075] px-2.5 py-2 last:border-b-0 transition-colors animate-in fade-in slide-in-from-bottom-4 duration-300 ${
        selected ? 'bg-brand/[0.06]' : 'hover:bg-ink/[0.04]'
      } ${editable ? 'cursor-pointer' : ''}`}
      onClick={editable ? () => onSelect(track.id) : undefined}
    >
      <span className="flex items-center gap-2">
        <span className={`icon-tile grid h-7 w-7 shrink-0 place-items-center rounded-comfortable ${selected ? 'ring-1 ring-brand/40' : ''}`}>{trackMeta[track.type].icon}</span>
        <span className="shrink-0 rounded border border-ink/10 px-1.5 py-px text-[11px] text-muted">{trackMeta[track.type].label}</span>
        {track.trim && <Scissors className="h-3 w-3 shrink-0 text-brand" />}
        <span className="flex-1" />
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(track.id) }}
          className="motion-press grid h-6 w-6 shrink-0 place-items-center rounded-comfortable text-ink/25 transition-all hover:bg-danger/10 hover:text-danger"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </span>
      <span className="mt-1 ml-9 break-all text-[11px] font-medium leading-snug text-ink">{track.label}{track.type === 'panoramic_video' && <span className="text-muted">{track.path.match(/\.([^.]+)$/)?.[0]}</span>}</span>
    </div>
  )
}

function ThemeSelect({ value, onChange, options, className }: { value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; className?: string }) {
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) return

    const updateMenuPosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return

      const padding = 8
      const gap = 6
      const desiredHeight = options.length * 34 + 8
      const spaceBelow = window.innerHeight - rect.bottom - gap - padding
      const spaceAbove = rect.top - gap - padding
      const opensUp = spaceBelow < Math.min(desiredHeight, 220) && spaceAbove > spaceBelow
      const availableSpace = Math.max(48, opensUp ? spaceAbove : spaceBelow)
      const maxHeight = Math.min(260, availableSpace)
      const visibleHeight = Math.min(desiredHeight, maxHeight)
      const width = Math.min(rect.width, window.innerWidth - padding * 2)
      const left = Math.min(Math.max(padding, rect.left), window.innerWidth - width - padding)
      const rawTop = opensUp ? rect.top - gap - visibleHeight : rect.bottom + gap
      const top = Math.min(Math.max(padding, rawTop), window.innerHeight - visibleHeight - padding)

      setMenuPosition({ left, top, width, maxHeight })
    }

    updateMenuPosition()
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)
    return () => {
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, true)
    }
  }, [open, options.length])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])
  const selected = options.find((o) => o.value === value)
  return (
    <div ref={ref} className={className || ''}>
      <button ref={triggerRef} type="button" onClick={() => setOpen(!open)}
        className={`theme-select-trigger motion-press flex w-full items-center gap-1.5 rounded-comfortable px-2.5 py-2 text-[13px] ${open ? 'is-open' : ''}`}>
        <span className="flex-1 text-left">{selected?.label ?? value}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && menuPosition && createPortal(
        <div
          ref={menuRef}
          className="theme-select-menu fixed animate-in fade-in zoom-in-95 slide-in-from-top-1 duration-150"
          style={{
            left: menuPosition.left,
            top: menuPosition.top,
            width: menuPosition.width,
            maxHeight: menuPosition.maxHeight,
          }}
        >
          {options.map((opt) => (
            <button key={opt.value} type="button" onClick={() => { onChange(opt.value); setOpen(false) }}
              className={`theme-select-option ${opt.value === value ? 'is-selected' : ''}`}>
              {opt.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

function ThemeMultiSelect({
  value,
  onChange,
  options,
  className,
}: {
  value: string[]
  onChange: (value: string[]) => void
  options: ReadonlyArray<{ value: string; label: string; group: string }>
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const padding = 8
      const gap = 6
      const desiredHeight = 430
      const spaceBelow = window.innerHeight - rect.bottom - gap - padding
      const spaceAbove = rect.top - gap - padding
      const opensUp = spaceBelow < 300 && spaceAbove > spaceBelow
      const maxHeight = Math.min(desiredHeight, Math.max(240, opensUp ? spaceAbove : spaceBelow))
      const width = Math.min(360, Math.max(300, rect.width))
      const left = Math.min(Math.max(padding, rect.left), window.innerWidth - width - padding)
      const rawTop = opensUp ? rect.top - gap - maxHeight : rect.bottom + gap
      const top = Math.min(Math.max(padding, rawTop), window.innerHeight - maxHeight - padding)
      setMenuPosition({ left, top, width, maxHeight })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [open])

  const selectedLabels = value.map((selectedValue) => options.find((option) => option.value === selectedValue)?.label ?? selectedValue)
  const summary = selectedLabels.length <= 2 ? selectedLabels.join(' · ') : `${selectedLabels.slice(0, 2).join(' · ')} +${selectedLabels.length - 2}`
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = options.filter((option) => !normalizedQuery || option.label.includes(query.trim()) || option.value.includes(normalizedQuery))
  const groups = [...new Set(filtered.map((option) => option.group))]
  const toggle = (target: string) => {
    if (value.includes(target)) {
      if (value.length === 1) return
      onChange(value.filter((item) => item !== target))
    } else {
      onChange([...value, target])
    }
  }
  const presets = [
    { label: '仅人物', values: ['person'] },
    { label: '人物与车辆', values: ['person', 'car', 'bicycle', 'motorcycle', 'bus', 'truck'] },
    { label: '常见动态目标', values: ['person', 'car', 'bicycle', 'motorcycle', 'bus', 'truck', 'animal'] },
  ]

  return (
    <div ref={rootRef} className={className || ''}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={`theme-select-trigger motion-press flex w-full items-center gap-1.5 rounded-comfortable px-2.5 py-2 text-[13px] ${open ? 'is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
        <span className="rounded-full bg-brand/12 px-1.5 py-0.5 font-mono text-[10px] text-brand">{value.length}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && menuPosition && createPortal(
        <div
          ref={menuRef}
          className="theme-select-menu fixed flex animate-in flex-col overflow-hidden fade-in zoom-in-95 slide-in-from-top-1 duration-150"
          style={{ left: menuPosition.left, top: menuPosition.top, width: menuPosition.width, maxHeight: menuPosition.maxHeight }}
          role="listbox"
          aria-multiselectable="true"
        >
          <div className="border-b border-[var(--xp-line)] p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索中文或 COCO 类别…"
                className="theme-input w-full rounded-comfortable border py-2 pl-8 pr-2 text-[12px] outline-none"
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {presets.map((preset) => (
                <button key={preset.label} type="button" onClick={() => onChange(preset.values)} className="rounded-full border border-[var(--xp-line)] bg-[var(--xp-control)] px-2 py-1 text-[10px] text-muted transition-colors hover:border-brand/35 hover:text-brand">
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 overflow-y-auto p-1.5">
            {groups.map((group) => (
              <div key={group} className="mb-1.5 last:mb-0">
                <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{group}</p>
                {filtered.filter((option) => option.group === group).map((option) => {
                  const selected = value.includes(option.value)
                  const locked = selected && value.length === 1
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      title={locked ? '至少保留一个遮罩目标' : undefined}
                      onClick={() => toggle(option.value)}
                      className={`theme-select-option flex items-center gap-2 ${selected ? 'is-selected' : ''}`}
                    >
                      <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${selected ? 'border-brand bg-brand text-white' : 'border-[var(--xp-line-strong)]'}`}>
                        {selected && <CheckCircle2 className="h-3 w-3" />}
                      </span>
                      <span className="flex-1 text-left">{option.label}</span>
                      <span className="font-mono text-[10px] text-muted">{option.value}</span>
                    </button>
                  )
                })}
              </div>
            ))}
            {!filtered.length && <p className="px-3 py-6 text-center text-[12px] text-muted">没有匹配的类别</p>}
          </div>
          <div className="flex items-center justify-between border-t border-[var(--xp-line)] px-3 py-2 text-[10px] text-muted">
            <span>已选择 {value.length} 项</span>
            <span>至少保留一项</span>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="block">
      <span className="ui-label mb-1.5 block whitespace-nowrap text-[11px]">{label}</span>
      {children}
    </div>
  )
}

function NumberInput({ value, onChange, step, min = 0, placeholder }: { value: number; onChange: (value: number) => void; step?: number; min?: number; placeholder?: string }) {
  const [edit, setEdit] = useState(String(value))
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { setEdit(String(value)) }, [value])
  const stepSize = step ?? 1
  const decimals = Math.max(0, `${stepSize}`.split('.')[1]?.length ?? 0)
  const format = (next: number) => String(Number(next.toFixed(decimals)))
  const commit = (raw: string) => {
    const n = Number(raw)
    if (!Number.isNaN(n) && n >= min) onChange(n)
    else setEdit(String(value))
  }
  const stepValue = (direction: 1 | -1) => {
    const current = Number(edit)
    const base = Number.isNaN(current) ? value : current
    const next = Math.max(min, Number((base + direction * stepSize).toFixed(decimals)))
    const formatted = format(next)
    setEdit(formatted)
    onChange(next)
    inputRef.current?.focus()
  }
  return (
    <div className="number-input-shell relative w-20">
      <input ref={inputRef} className="theme-input number-input-field w-full rounded-comfortable border px-3 py-2 font-mono text-[13px] outline-none transition-all"
        type="text" inputMode="decimal" value={edit} placeholder={placeholder}
        onChange={(e) => { setEdit(e.target.value); const n = Number(e.target.value); if (!Number.isNaN(n) && n >= min) onChange(n) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { inputRef.current?.blur(); commit(edit) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); stepValue(1) }
          else if (e.key === 'ArrowDown') { e.preventDefault(); stepValue(-1) }
        }}
        onBlur={() => commit(edit)}
      />
      <div className="number-stepper">
        <button type="button" className="number-stepper-button" aria-label="增加数值" onMouseDown={(event) => event.preventDefault()} onClick={() => stepValue(1)}>
          <ChevronUp className="h-3 w-3" />
        </button>
        <button type="button" className="number-stepper-button" aria-label="减少数值" onMouseDown={(event) => event.preventDefault()} onClick={() => stepValue(-1)}>
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}

function SwitchRow({ label, checked, onClick }: { label: string; checked: boolean; onClick: () => void }) {
  return (
    <button role="switch" aria-checked={checked} onClick={onClick} className="motion-press flex items-center justify-between gap-3 whitespace-nowrap rounded-subtle border border-[var(--xp-line)] px-3 py-2 text-[13px] text-ink/65 transition-colors hover:bg-[var(--xp-surface-soft)]">
      <span>{label}</span>
      <span className="relative h-4 w-8 rounded-full transition-colors" style={{ background: checked ? 'var(--xp-brand)' : 'var(--xp-line-strong)' }}>
        <span className="absolute top-0.5 h-3 w-3 rounded-full bg-[var(--xp-surface)] shadow-sm transition-all" style={{ left: checked ? 18 : 2 }} />
      </span>
    </button>
  )
}

interface StatusCellProps {
  idle: boolean
  canStart: boolean
  blockReason: string
  progress: ReturnType<typeof usePipeline>['progress']
  running: boolean
  outputReady: boolean
  materialCount: number
  engineReady: boolean
  logs: string[]
  logRef: React.RefObject<HTMLDivElement | null>
  onStart: () => void
  onCancel: () => void
  onReset: () => void
  onOpenOutput: () => void
  canStartMask: boolean
  onStartMask: () => void
  maskMode: boolean
}

function logTone(line: string) {
  if (line.includes('错误') || line.includes('失败') || line.includes('中断')) return 'is-danger'
  if (line.includes('完成') || line.includes('已导出')) return 'is-success'
  return ''
}

function formatStatusPercent(value: number, maskMode: boolean) {
  return maskMode && value > 0 && value < 10 ? value.toFixed(1) : String(Math.round(value))
}

function StatusCell(props: StatusCellProps) {
  const { idle } = props
  // Smooth the displayed percentage with GSAP so it never snaps.
  const percentRef = useRef<HTMLSpanElement>(null)
  const displayPct = useRef(props.progress.percent)
  useEffect(() => {
    let raf = 0
    const target = Math.min(100, Math.max(0, props.progress.percent))
    if (props.progress.phase === 'idle' && target < displayPct.current) {
      displayPct.current = target
      if (percentRef.current) percentRef.current.textContent = formatStatusPercent(target, props.maskMode)
      return () => cancelAnimationFrame(raf)
    }
    const start = displayPct.current
    const startedAt = performance.now()
    const dur = Math.min(1200, 420 + Math.abs(target - start) * 14)
    const tick = (now: number) => {
      const t = Math.min((now - startedAt) / dur, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      displayPct.current = start + (target - start) * eased
      if (percentRef.current) percentRef.current.textContent = formatStatusPercent(displayPct.current, props.maskMode)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [props.progress.percent, props.progress.phase, props.maskMode])

  // Morph between ready / progress content when the idle flag flips.
  const stageRef = useMorphSwap<HTMLDivElement>({ trigger: idle })

  const isError = props.progress.phase === 'error'
  const isDone = props.progress.phase === 'complete'
  const isCanceled = isError && props.progress.message.includes('取消')
  const isRunningView = props.running && !idle
  const bloomClass = isDone ? 'success-bloom' : ''
  const stagePanelSizing = idle ? 'flex-1' : 'flex-none'
  const logPanelSpacing = idle ? 'mt-4 mb-3 shrink-0' : isRunningView ? 'mt-3 mb-3 min-h-44 flex-1' : isDone ? 'mt-4 mb-3 min-h-0 flex-1' : 'mt-4 mb-3 min-h-0 flex-1'
  const logBoxSize = idle ? 'h-28 p-3' : isRunningView ? 'min-h-0 flex-1 p-3' : isDone ? 'min-h-0 flex-1 p-3' : 'min-h-0 flex-1 p-3'
  const readiness = [
    { label: '输出目录', ready: props.outputReady },
    { label: '素材轨道', ready: props.materialCount > 0 },
    { label: '引擎路径', ready: props.engineReady },
  ]

  return (
    <aside className={`liquid-panel stage-grid flex min-h-0 min-w-0 flex-col overflow-x-hidden p-4 ${bloomClass}`}>
      <div className="mb-3 flex items-center justify-between" data-enter>
        <div>
          <h2 className="text-[12px] font-medium text-ink">状态仪表</h2>
        </div>
        <span className="rounded-full border border-[var(--xp-line)] bg-[var(--xp-control)] px-2 py-1 font-mono text-[11px] text-muted">{props.maskMode ? '遮罩' : idle ? '待命' : props.running ? '运行中' : isDone ? '完成' : isCanceled ? '已取消' : '错误'}</span>
      </div>

      {idle && (
        <div className="glass-inset mb-3 rounded-card p-3" data-enter>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium text-ink/80">配置完整度</span>
            <span className="font-mono text-[11px] text-muted">{readiness.filter((item) => item.ready).length}/3</span>
          </div>
          <div className="space-y-1.5">
            {readiness.map((item) => (
              <div key={item.label} className="flex items-center justify-between text-[12px]">
                <span className="text-muted">{item.label}</span>
                <span className={`inline-flex items-center gap-1.5 font-mono text-[11px] ${item.ready ? 'text-brand' : 'text-muted'}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${item.ready ? 'bg-brand' : 'bg-ink/18'}`} />
                  {item.ready ? 'OK' : 'WAIT'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div ref={stageRef} className={`relative flex min-h-0 flex-col transition-[flex-basis,height] duration-300 ${stagePanelSizing}`}>
        {idle ? (
          <ReadyContent canStart={props.canStart} blockReason={props.blockReason} readiness={readiness} />
        ) : (
          <ProgressContent
            progress={props.progress}
            running={props.running}
            percentRef={percentRef}
            isError={isError}
            isCanceled={isCanceled}
            maskMode={props.maskMode}
          />
        )}
      </div>

      {/* Log panel — always visible so the right column is never empty. */}
      <div className={`status-log-panel flex min-h-0 flex-col transition-[flex,margin,height] duration-300 ${logPanelSpacing}`}>
        <div className="mb-1.5 flex shrink-0 items-center justify-between">
          <span className="ui-label flex items-center gap-1.5 text-[11px]">
            <Terminal className="h-3.5 w-3.5" /> 运行日志
          </span>
        </div>
        <div ref={props.logRef} className={`terminal status-log-box min-w-0 max-w-full overflow-y-auto overflow-x-hidden select-text ${logBoxSize}`}>
          {!props.logs.length ? (
            <p className="px-1 py-1 text-[12px] leading-5 text-muted">
              等待任务启动…<span className="terminal-cursor" />
            </p>
          ) : (
            props.logs.map((lineText, index) => (
              <p key={`${lineText}-${index}`} className={`log-line min-w-0 max-w-full ${logTone(lineText)}`}>
                <span className="log-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="log-text">{lineText}</span>
              </p>
            ))
          )}
        </div>
      </div>

      {/* Action buttons — always pinned to the bottom of the cell */}
      <div className="mt-4 space-y-2 shrink-0">
        {idle ? (
          <>
            <button onClick={props.onStart} disabled={!props.canStart} title={!props.canStart ? props.blockReason : undefined} className="theme-action-shadow motion-press inline-flex w-full items-center justify-center gap-2 rounded-card bg-brand px-4 py-3 text-[13px] font-semibold text-white transition-all hover:-translate-y-0.5 hover:bg-brand-hover disabled:cursor-not-allowed disabled:translate-y-0 disabled:bg-[var(--xp-line)] disabled:text-muted disabled:shadow-none">
              <Play className="h-4 w-4" fill="currentColor" /> 开始高斯对齐
            </button>
            <button onClick={props.onStartMask} disabled={!props.canStartMask} title={!props.outputReady ? '请先选择包含最终 images 的输出目录' : undefined} className="glass-control motion-press inline-flex w-full items-center justify-center gap-2 rounded-card border border-brand/20 px-4 py-2.5 text-[13px] font-semibold text-ink/72 transition-all hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-45">
              <ShieldCheck className="h-4 w-4" /> 开始遮罩处理
            </button>
            <button onClick={props.onOpenOutput} disabled={!props.outputReady} title={!props.outputReady ? '请先选择输出目录' : undefined} className="glass-control motion-press inline-flex w-full items-center justify-center gap-2 rounded-card px-4 py-2.5 text-[13px] font-semibold text-ink/72 transition-all hover:text-brand disabled:cursor-not-allowed disabled:opacity-45">
              <FolderOpen className="h-4 w-4" /> 打开输出目录
            </button>
          </>
        ) : props.running ? (
          <button onClick={props.onCancel} className="motion-press inline-flex w-full items-center justify-center gap-2 rounded-card border border-danger/30 bg-danger/10 px-4 py-2.5 text-[13px] font-medium text-danger transition-colors hover:bg-danger/15">
            <Square className="h-4 w-4" /> 停止任务
          </button>
        ) : isDone ? (
          <>
            <button onClick={props.onOpenOutput} className="theme-action-shadow motion-press inline-flex w-full items-center justify-center gap-2 rounded-card bg-brand px-4 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-brand-hover">
              <FolderOpen className="h-4 w-4" /> 打开输出目录
            </button>
            {!props.maskMode && (
              <button onClick={props.onStartMask} disabled={!props.canStartMask} className="glass-control motion-press inline-flex w-full items-center justify-center gap-2 rounded-card border border-brand/20 px-4 py-2.5 text-[13px] font-semibold text-ink/72 transition-all hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-45">
                <ShieldCheck className="h-4 w-4" /> 开始遮罩处理
              </button>
            )}
            <button onClick={props.onReset} className="glass-control motion-press inline-flex w-full items-center justify-center gap-2 rounded-card px-4 py-2.5 text-[13px] font-semibold text-ink/72 transition-all hover:text-brand">返回界面</button>
          </>
        ) : isCanceled ? (
          <>
            <button onClick={props.onStart} disabled={!props.canStart} className="theme-action-shadow motion-press inline-flex w-full items-center justify-center gap-2 rounded-card bg-brand px-4 py-2.5 text-[13px] font-semibold text-white transition-all hover:-translate-y-0.5 hover:bg-brand-hover disabled:cursor-not-allowed disabled:translate-y-0 disabled:bg-[var(--xp-line)] disabled:text-muted disabled:shadow-none">
              <Play className="h-4 w-4" fill="currentColor" /> 重新开始
            </button>
            <button onClick={props.onReset} className="glass-control motion-press inline-flex w-full items-center justify-center gap-2 rounded-card px-4 py-2.5 text-[13px] font-semibold text-ink/72 transition-all hover:text-brand">返回界面</button>
          </>
        ) : (
          <>
            <div className="max-w-full overflow-hidden break-all rounded-card border border-danger/20 bg-danger/10 p-3 text-[13px] text-danger">
              {props.progress.message}
            </div>
            <button onClick={props.onStart} disabled={!props.canStart} className="theme-action-shadow motion-press inline-flex w-full items-center justify-center gap-2 rounded-card bg-brand px-4 py-2.5 text-[13px] font-semibold text-white transition-all hover:-translate-y-0.5 hover:bg-brand-hover disabled:cursor-not-allowed disabled:translate-y-0 disabled:bg-[var(--xp-line)] disabled:text-muted disabled:shadow-none">
              <Play className="h-4 w-4" fill="currentColor" /> 重新开始
            </button>
            <button onClick={props.onReset} className="glass-control motion-press inline-flex w-full items-center justify-center gap-2 rounded-card px-4 py-2.5 text-[13px] font-semibold text-ink/72 transition-all hover:text-brand">返回界面</button>
          </>
        )}
      </div>
    </aside>
  )
}

function ReadyContent({
  canStart,
  blockReason,
  readiness,
}: {
  canStart: boolean
  blockReason: string
  readiness: Array<{ label: string; ready: boolean }>
}) {
  const readyCount = readiness.filter((item) => item.ready).length
  const readyPct = Math.round((readyCount / Math.max(readiness.length, 1)) * 100)
  return (
    <div className="glass-inset relative flex flex-1 flex-col justify-between overflow-hidden rounded-card px-4 py-4">
      <div className="pointer-events-none absolute inset-x-8 top-5 h-px bg-gradient-to-r from-transparent via-brand/35 to-transparent" />
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <div className="relative mb-3 grid h-20 w-20 place-items-center">
          <div className={`absolute inset-0 rounded-full border ${canStart ? 'border-brand/35 bg-brand/8' : 'border-[var(--xp-line)] bg-[var(--xp-control)]'}`} />
          <div className={`absolute h-12 w-12 rounded-full ${canStart ? 'bg-brand/15 shadow-[0_0_28px_rgba(var(--xp-brand-rgb),0.22)]' : 'bg-ink/8'}`} />
          {canStart ? <CheckCircle2 className="relative h-7 w-7 text-brand" /> : <Gauge className="relative h-7 w-7 text-muted" />}
        </div>
        <p className="text-[13px] font-semibold text-ink">{canStart ? '准备就绪' : '等待配置'}</p>
        <p className="mt-1 max-w-[210px] text-[11px] leading-5 text-muted">
          {canStart ? '配置已满足，可以开始对齐。' : blockReason}
        </p>
        <div className="mt-3 h-1.5 w-full max-w-[190px] overflow-hidden rounded-full bg-ink/10">
          <span className="block h-full rounded-full bg-gradient-to-r from-brand to-data transition-all duration-500" style={{ width: `${readyPct}%` }} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {readiness.map((item) => (
          <div key={item.label} className="rounded-subtle border border-[var(--xp-line)] bg-[var(--xp-control)] px-2 py-2 text-center">
            <span className={`mx-auto mb-1 block h-1.5 w-1.5 rounded-full ${item.ready ? 'bg-brand shadow-[0_0_10px_rgba(var(--xp-brand-rgb),0.45)]' : 'bg-ink/18'}`} />
            <p className="truncate text-[10px] font-medium text-ink/65">{item.label}</p>
            <p className={`mt-0.5 font-mono text-[10px] ${item.ready ? 'text-brand' : 'text-muted'}`}>{item.ready ? 'OK' : 'WAIT'}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function ProgressContent({
  progress,
  running,
  percentRef,
  isError,
  isCanceled,
  maskMode,
}: {
  progress: StatusCellProps['progress']
  running: boolean
  percentRef: React.RefObject<HTMLSpanElement | null>
  isError: boolean
  isCanceled: boolean
  maskMode: boolean
}) {
  const elapsed = progress.elapsed
  const time = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`
  const percent = Math.min(100, Math.max(0, progress.percent))
  const circumference = 2 * Math.PI * 44
  const dashOffset = circumference * (1 - percent / 100)
  // Orbit dot position on the ring (starts at 12 o'clock, goes clockwise)
  const orbitAngle = -Math.PI / 2 + (percent / 100) * 2 * Math.PI
  const orbitX = 60 + 44 * Math.cos(orbitAngle)
  const orbitY = 60 + 44 * Math.sin(orbitAngle)
  const phaseText = maskMode ? progress.message : progress.phase === 'idle' && running ? '启动中' : (phaseLabels[progress.phase] || progress.message)

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="liquid-card progress-art relative overflow-hidden p-4">
        {running && <div className="scan-line" />}
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-2 text-[12px] font-semibold text-ink/78">
            <Gauge className="h-3.5 w-3.5 text-brand" /> 总进度
          </span>
          <span className="rounded-full border border-[var(--xp-line)] bg-[var(--xp-control)] px-2 py-1 font-mono text-[11px] text-muted">{time}</span>
        </div>

        <div className="relative mx-auto mt-3 grid h-40 w-40 place-items-center">
          <svg viewBox="0 0 120 120" className="absolute inset-0 h-full w-full overflow-visible">
            <defs>
              <linearGradient id="progress-ring-gradient" x1="16" y1="18" x2="104" y2="104" gradientUnits="userSpaceOnUse">
                <stop stopColor="var(--xp-brand)" />
                <stop offset="0.55" stopColor="var(--xp-data)" />
                <stop offset="1" stopColor="var(--xp-brand-hover)" />
              </linearGradient>
              <filter id="progress-ring-glow" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="3.4" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <circle cx="60" cy="60" r="48" fill="none" stroke="color-mix(in srgb, var(--xp-ink) 9%, transparent)" strokeWidth="1" />
            <circle cx="60" cy="60" r="39" fill="none" stroke="color-mix(in srgb, var(--xp-data) 32%, transparent)" strokeDasharray="5 10" strokeWidth="1.5" />
            <circle cx="60" cy="60" r="44" fill="none" stroke="color-mix(in srgb, var(--xp-ink) 11%, transparent)" strokeWidth="8" />
            <circle
              cx="60"
              cy="60"
              r="44"
              fill="none"
              stroke="url(#progress-ring-gradient)"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              strokeWidth="7"
              filter="url(#progress-ring-glow)"
              style={{ transform: 'rotate(-90deg)', transformOrigin: '60px 60px', transition: 'stroke-dashoffset 1000ms cubic-bezier(0.22, 1, 0.36, 1)' }}
            />
            {/* Progress dot tracks completion; orbit marker shows that the task is actively running. */}
            <circle cx={orbitX} cy={orbitY} r="3" fill="var(--xp-data)" filter="url(#progress-ring-glow)" className="transition-all duration-1000 ease-out" />
            <g className={`progress-orbit ${running ? 'is-running' : ''}`}>
              <circle cx="60" cy="16" r="5.5" fill="color-mix(in srgb, var(--xp-surface) 78%, transparent)" stroke="var(--xp-brand)" strokeWidth="1.4" />
              <circle cx="60" cy="16" r="3" fill="url(#progress-ring-gradient)" />
            </g>
          </svg>

          <div className="relative z-10 text-center">
            <p className="font-mono text-[32px] font-semibold leading-none text-ink">
              <span ref={percentRef} className="digit-glow">{maskMode && percent > 0 && percent < 10 ? percent.toFixed(1) : Math.round(percent)}</span>
              <span className="ml-0.5 text-[16px] text-muted">%</span>
            </p>
            <p className="mt-1.5 font-mono text-[11px] text-muted">
              {running ? phaseText : isCanceled ? '已取消' : isError ? '已中断' : '处理完成'}
            </p>
          </div>
        </div>

        <div className={`progress-bar-shimmer mt-3 h-1.5 overflow-hidden rounded-full bg-ink/10 ${running ? '' : 'opacity-60'}`}>
          <span className="block h-full rounded-full bg-gradient-to-r from-brand via-data to-brand-hover transition-all duration-1000 ease-out" style={{ width: `${percent}%` }} />
        </div>
        <p className="mt-3 text-center text-[13px] font-medium" style={{ color: isError ? 'rgb(var(--xp-danger-rgb))' : 'var(--xp-muted)' }}>
          {phaseText}
        </p>
      </div>

      {maskMode ? (
        <div className="glass-inset flex items-center justify-between rounded-card px-3 py-2.5 text-[12px]">
          <span className="inline-flex items-center gap-2 font-medium text-ink/75"><ShieldCheck className="h-4 w-4 text-brand" /> 独立训练遮罩</span>
          <span className="font-mono text-[11px] text-muted">images → masks</span>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {(['extract', 'align', 'export'] as const).map((phase) => (
            <PhasePill key={phase} phaseKey={phase} label={stageLabels[phase]} percent={progress.phasePercents[phase]} active={progress.phase === phase} />
          ))}
        </div>
      )}
    </div>
  )
}

const phaseIcons: Record<string, ReactNode> = {
  extract: <Camera className="h-4 w-4" />,
  align: <Crosshair className="h-4 w-4" />,
  export: <FolderOpen className="h-4 w-4" />,
}

function PhasePill({ phaseKey, label, percent, active }: { phaseKey: string; label: string; percent: number; active: boolean }) {
  const [displayPercent, setDisplayPercent] = useState(percent)
  const displayPercentRef = useRef(displayPercent)
  useEffect(() => {
    displayPercentRef.current = displayPercent
  }, [displayPercent])
  useEffect(() => {
    let raf = 0
    const start = displayPercentRef.current
    const rawTarget = Math.min(100, Math.max(0, percent))
    if (rawTarget <= 0 && !active) {
      setDisplayPercent(0)
      return () => {}
    }
    const target = Math.max(start, rawTarget)
    const startedAt = performance.now()
    const dur = Math.min(1000, 360 + Math.abs(target - start) * 12)
    const tick = (now: number) => {
      const t = Math.min((now - startedAt) / dur, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplayPercent(Math.min(100, Math.max(0, start + (target - start) * eased)))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, percent])

  const done = displayPercent >= 99.5
  return (
    <div className={`glass-inset relative overflow-hidden rounded-card px-2 py-2.5 text-center transition-colors ${active ? 'ring-1 ring-brand/25' : ''}`}>
      {done ? <CheckCircle2 className="mx-auto h-4 w-4 text-brand" /> : <div className={`flex justify-center ${active ? 'text-brand' : 'text-muted/50'}`}>{phaseIcons[phaseKey]}</div>}
      <p className="mt-1.5 text-[11px] font-medium text-ink/65">{label}</p>
      <p className="mt-0.5 font-mono text-[11px] text-muted">{Math.round(displayPercent)}%</p>
    </div>
  )
}
