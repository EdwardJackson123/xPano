import { useEffect, useRef, useState } from 'react'
import { HashRouter, Routes, Route, useLocation } from 'react-router-dom'
import gsap from 'gsap'
import { PipelinePage } from './components/pipeline/PipelinePage'
import { ViewerPage } from './components/viewer/ViewerPage'
import { ParticleBackground } from './components/effects/ParticleBackground'
import { DragTrail } from './components/effects/DragTrail'
import type { PipelinePhase, ResolvedTheme, ThemeMode } from './lib/types'

interface ChromeSettings {
  themeMode: ThemeMode
  resolvedTheme: ResolvedTheme
  onThemeModeChange: (mode: ThemeMode) => void
  onPipelineStateChange?: (state: { running: boolean; phase: PipelinePhase }) => void
}

const themeModes: ThemeMode[] = ['system', 'light', 'dark']

function readThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system'
  const saved = window.localStorage.getItem('xpano-theme-mode') as ThemeMode | null
  return saved && themeModes.includes(saved) ? saved : 'system'
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function AnimatedRoutes(props: ChromeSettings) {
  const location = useLocation()
  const mainRef = useRef<HTMLDivElement>(null)
  const transitionKey = `${location.pathname}${location.search}`

  useEffect(() => {
    const node = mainRef.current
    if (!node) return

    const ctx = gsap.context(() => {
      gsap.fromTo(
        node,
        { autoAlpha: 0, y: 12, scale: 0.992, filter: 'blur(8px)' },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          filter: 'blur(0px)',
          duration: 0.48,
          ease: 'power3.out',
          clearProps: 'opacity,visibility,transform,filter',
        },
      )
    }, node)

    return () => ctx.revert()
  }, [transitionKey])

  return (
    <div ref={mainRef} className="page-transition">
      <Routes location={location} key={transitionKey}>
        <Route path="/" element={<PipelinePage {...props} />} />
        <Route path="/viewer/:projectName" element={<ViewerPage {...props} />} />
      </Routes>
    </div>
  )
}

function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode)
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme)
  const [pipelineRunning, setPipelineRunning] = useState(false)
  const [pipelinePhase, setPipelinePhase] = useState<PipelinePhase>('idle')
  const firstThemeApply = useRef(true)
  const resolvedTheme = themeMode === 'system' ? systemTheme : themeMode

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemTheme(media.matches ? 'dark' : 'light')
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = resolvedTheme
    root.dataset.themeMode = themeMode
    root.style.colorScheme = resolvedTheme
    window.localStorage.setItem('xpano-theme-mode', themeMode)

    if (firstThemeApply.current) {
      firstThemeApply.current = false
      return
    }

    root.classList.add('theme-is-switching')
    const timeout = window.setTimeout(() => {
      root.classList.remove('theme-is-switching')
    }, 460)

    return () => {
      window.clearTimeout(timeout)
      root.classList.remove('theme-is-switching')
    }
  }, [resolvedTheme, themeMode])

  // Disable the browser context menu for a native desktop-app feel.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => e.preventDefault()
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [])

  useEffect(() => {
    const timers = new WeakMap<HTMLElement, number>()
    const activeTimers = new Set<number>()

    const onPointerDown = (event: PointerEvent) => {
      const rawTarget = event.target
      if (!(rawTarget instanceof Element)) return

      const target = rawTarget.closest('button:not(:disabled), [role="button"]') as HTMLElement | null
      if (!target) return

      const existing = timers.get(target)
      if (existing) {
        window.clearTimeout(existing)
        activeTimers.delete(existing)
      }

      target.classList.remove('is-pressing')
      void target.offsetWidth
      target.classList.add('is-pressing')

      const timeout = window.setTimeout(() => {
        target.classList.remove('is-pressing')
        timers.delete(target)
        activeTimers.delete(timeout)
      }, 320)
      timers.set(target, timeout)
      activeTimers.add(timeout)
    }

    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      activeTimers.forEach((timer) => window.clearTimeout(timer))
      activeTimers.clear()
    }
  }, [])

  return (
    <HashRouter>
      <ParticleBackground active={pipelineRunning} phase={pipelinePhase} />
      <DragTrail />
      <div className="min-h-screen overflow-hidden text-ink" style={{ background: 'transparent' }}>
        <AnimatedRoutes
          themeMode={themeMode}
          resolvedTheme={resolvedTheme}
          onThemeModeChange={setThemeMode}
          onPipelineStateChange={(state) => {
            setPipelineRunning(state.running)
            setPipelinePhase(state.phase)
          }}
        />
      </div>
    </HashRouter>
  )
}

export default App
