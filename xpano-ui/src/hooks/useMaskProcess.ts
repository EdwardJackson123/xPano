import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { MaskComplete, MaskConfig, MaskError, MaskProgress } from '../lib/types'

const initialProgress: MaskProgress = {
  status: 'idle',
  percent: 0,
  message: '等待开始遮罩处理',
  elapsed: 0,
}

function isTauriRuntime() {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

function appendLog(lines: string[], message: string, elapsed = 0) {
  const text = message.trim()
  if (!text) return lines
  const line = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')} · 遮罩 · ${text}`
  if (lines[lines.length - 1] === line) return lines
  return [...lines, line]
}

export function useMaskProcess() {
  const [progress, setProgress] = useState<MaskProgress>(initialProgress)
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const runningRef = useRef(false)
  const startedAtRef = useRef(0)
  const polledEventRef = useRef('')

  const setMaskRunning = useCallback((value: boolean) => {
    runningRef.current = value
    setRunning(value)
  }, [])

  useEffect(() => {
    if (!isTauriRuntime()) return
    let disposed = false
    const unlisteners: Array<() => void> = []
    const setup = async () => {
      unlisteners.push(await listen<MaskProgress>('mask:progress', (event) => {
        if (!runningRef.current) return
        const payload = event.payload
        if (payload.status) {
          setProgress((previous) => ({
            ...previous,
            ...payload,
            percent: Math.max(previous.percent, Math.min(100, Math.max(0, payload.percent || 0))),
            elapsed: Math.max(previous.elapsed, payload.elapsed || 0),
          }))
          if (payload.status === 'error') setMaskRunning(false)
        }
        setLogs((previous) => appendLog(previous, payload.message, payload.elapsed))
      }))
      if (disposed) return
      unlisteners.push(await listen<MaskComplete>('mask:complete', (event) => {
        if (!runningRef.current) return
        const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000)
        setMaskRunning(false)
        setProgress((previous) => ({ ...previous, status: 'complete', percent: 100, elapsed, message: '遮罩处理完成', outputPath: event.payload.outputPath }))
        setLogs((previous) => appendLog(previous, `遮罩已输出到 ${event.payload.outputPath}`, elapsed))
      }))
      if (disposed) return
      unlisteners.push(await listen<MaskError>('mask:error', (event) => {
        if (!runningRef.current) return
        const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000)
        setMaskRunning(false)
        setProgress((previous) => ({ ...previous, status: 'error', elapsed, message: event.payload.error }))
        setLogs((previous) => appendLog(previous, `错误：${event.payload.error}`, elapsed))
      }))
    }
    setup().catch((error) => {
      setLogs((previous) => appendLog(previous, `事件监听初始化失败：${error}`))
    })
    return () => {
      disposed = true
      unlisteners.forEach((unlisten) => unlisten())
      if (runningRef.current) invoke('cancel_mask_process').catch(() => {})
      runningRef.current = false
    }
  }, [setMaskRunning])

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(async () => {
      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000)
      setProgress((previous) => previous.status === 'complete' || previous.status === 'error' ? previous : { ...previous, elapsed })
      try {
        const payload = await invoke<MaskProgress | null>('get_mask_process_progress')
        if (!payload || !runningRef.current) return
        setProgress((previous) => ({
          ...previous,
          ...payload,
          percent: Math.max(previous.percent, Math.min(100, Math.max(0, payload.percent || 0))),
          elapsed: Math.max(previous.elapsed, payload.elapsed || elapsed),
        }))
        const eventKey = `${payload.status}:${payload.current ?? ''}:${payload.percent}:${payload.message}`
        if (eventKey !== polledEventRef.current) {
          polledEventRef.current = eventKey
          setLogs((previous) => appendLog(previous, payload.message, payload.elapsed || elapsed))
        }
        if (payload.status === 'complete' || payload.status === 'error') setMaskRunning(false)
      } catch {
        // Live events remain primary; polling recovers any event missed by the webview.
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [running, setMaskRunning])

  const start = useCallback(async (outputDir: string, config: MaskConfig) => {
    if (!isTauriRuntime()) {
      setProgress({ ...initialProgress, status: 'error', message: '浏览器预览模式不能启动遮罩处理，请在 Tauri 桌面应用中运行。' })
      return
    }
    const args = [
      '--output', outputDir,
      '--targets', config.targets.join(','),
      '--expand-mode', config.expandMode,
      '--expand-pixels', String(config.expandPixels),
      '--expand-percent', String(config.expandPercent),
      '--edge-fuse-pixels', String(config.edgeFusePixels),
      '--device', config.device,
      '--workers', String(config.workers),
    ]
    if (config.includeShadow) args.push('--include-shadow')
    startedAtRef.current = Date.now()
    polledEventRef.current = ''
    setMaskRunning(true)
    setLogs([])
    setProgress({ status: 'loading', percent: 0, message: '正在检查最终 images 目录并加载模型', elapsed: 0 })
    setLogs((previous) => appendLog(previous, '正在创建独立遮罩任务', 0))
    try {
      await invoke('start_mask_process', { pythonExe: '', args })
    } catch (error) {
      setMaskRunning(false)
      setProgress({ status: 'error', percent: 0, message: String(error), elapsed: 0 })
      setLogs((previous) => appendLog(previous, `启动失败：${error}`, 0))
    }
  }, [setMaskRunning])

  const cancel = useCallback(async () => {
    if (!runningRef.current) return
    const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000)
    setMaskRunning(false)
    setProgress((previous) => ({ ...previous, status: 'error', message: '遮罩任务已取消', elapsed }))
    setLogs((previous) => appendLog(previous, '遮罩任务已取消', elapsed))
    try { await invoke('cancel_mask_process') } catch (error) {
      setProgress((previous) => ({ ...previous, message: `停止失败：${error}` }))
    }
  }, [setMaskRunning])

  const reset = useCallback(() => {
    setProgress(initialProgress)
    setLogs([])
  }, [])

  return { progress, running, logs, start, cancel, reset }
}
