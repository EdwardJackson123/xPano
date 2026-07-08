import { ArrowLeft } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { PointCloudViewer } from './PointCloudViewer'
import { ThemeControls } from '../layout/ThemeControls'
import { WindowControls } from '../layout/WindowControls'
import type { ResolvedTheme, ThemeMode } from '../../lib/types'

interface ViewerPageProps {
  themeMode: ThemeMode
  resolvedTheme: ResolvedTheme
  onThemeModeChange: (mode: ThemeMode) => void
}

export function ViewerPage({
  themeMode,
  resolvedTheme,
  onThemeModeChange,
}: ViewerPageProps) {
  const navigate = useNavigate()
  const { projectName } = useParams<{ projectName: string }>()
  const dataPath = projectName && projectName !== 'demo' ? decodeURIComponent(projectName) : null
  const projectLabel = dataPath ?? projectName ?? '未命名项目'
  const isDark = resolvedTheme === 'dark'

  return (
    <div className={`fixed inset-0 overflow-hidden ${isDark ? 'bg-[#06101C] text-milk' : 'bg-[#eaf2f8] text-ink'}`}>
      <PointCloudViewer dataPath={dataPath} resolvedTheme={resolvedTheme} />

      <div className="drag-region fixed left-0 right-0 top-0 z-20 flex h-14 items-start justify-between px-4 pt-3 animate-in fade-in slide-in-from-top-2 duration-300">
        <div className={`no-drag flex h-8 min-w-0 items-center overflow-hidden rounded-subtle backdrop-blur-xl ${
          isDark
            ? 'border border-white/[0.08] bg-black/42 shadow-2xl shadow-black/20'
            : 'border border-ink/10 bg-white/72 shadow-sm shadow-brand/5'
        }`}>
          <button
            aria-label="返回"
            onClick={() => navigate('/')}
            className={`motion-press grid h-8 w-8 shrink-0 place-items-center border-r transition-colors ${
              isDark
                ? 'border-white/[0.08] text-white/62 hover:bg-white/[0.08] hover:text-white'
                : 'border-ink/10 text-ink/58 hover:bg-brand/[0.08] hover:text-ink'
            }`}
          >
            <ArrowLeft size={16} />
          </button>
          <div className="flex min-w-0 items-center gap-2 px-3">
            <span className={`text-[11px] font-medium ${isDark ? 'text-aurora/72' : 'text-brand/72'}`}>点云预览</span>
            <span className={`max-w-[320px] truncate text-[12px] font-medium ${isDark ? 'text-white/78' : 'text-ink/78'}`}>
              {projectLabel}
            </span>
            {!dataPath && (
              <span className={`shrink-0 rounded-subtle border px-2 py-0.5 text-[10px] ${
                isDark ? 'border-white/10 text-white/36 bg-white/[0.04]' : 'border-ink/10 text-ink/40 bg-ink/[0.04]'
              }`}>
                选择输出目录并具有 COLMAP 数据即可查看目标点云
              </span>
            )}
          </div>
        </div>

        <div className={`no-drag flex h-8 items-center gap-2 rounded-subtle px-1.5 backdrop-blur-xl ${
          isDark
            ? 'border border-white/[0.06] bg-black/24'
            : 'border border-ink/[0.08] bg-white/54 shadow-sm'
        }`}>
          <ThemeControls
            themeMode={themeMode}
            onThemeModeChange={onThemeModeChange}
          />
          <span className={`h-4 w-px ${isDark ? 'bg-white/10' : 'bg-ink/10'}`} />
          <WindowControls />
        </div>
      </div>
    </div>
  )
}
