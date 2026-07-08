# xPano UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python Tkinter GUI with a Tauri + React + TypeScript desktop app with dark-blue professional theme, preserving all existing Python pipeline scripts.

**Architecture:** Tauri 2 shell with thin Rust backend managing subprocess calls to Python pipeline scripts. Rust forwards stdout JSON progress events to the React frontend via Tauri events. React frontend uses Vite + Tailwind CSS + Three.js + tsparticles + GSAP.

**Tech Stack:** Tauri 2, React 18, TypeScript, Vite, Tailwind CSS 3.4, Three.js, tsparticles, GSAP, Lucide React, clsx, tailwind-merge

---

### Task 1: Scaffold Tauri + React + Vite project

**Files:**
- Create: entire project scaffold via CLI

- [ ] **Step 1: Create Tauri project with React template**

```bash
cd D:/xPano
pnpm create tauri-app xpano-ui --template react-ts
```

When prompted, select:
- Project name: `xpano-ui`
- UI template: React with TypeScript
- Package manager: pnpm

- [ ] **Step 2: Navigate into project and verify structure**

```bash
cd D:/xPano/xpano-ui
ls src/
ls src-tauri/
```

Expected: `src/` contains `main.tsx`, `App.tsx`, `App.css`. `src-tauri/` contains `src/main.rs`, `Cargo.toml`, `tauri.conf.json`.

- [ ] **Step 3: Install core dependencies**

```bash
cd D:/xPano/xpano-ui
pnpm add react-router-dom three @react-three/fiber @react-three/drei gsap @tsparticles/react @tsparticles/slim lucide-react clsx tailwind-merge
pnpm add -D @types/three
```

- [ ] **Step 4: Verify dev server starts**

```bash
cd D:/xPano/xpano-ui
pnpm tauri dev
```

Expected: Tauri window opens with default React template content. Kill after verifying.

- [ ] **Step 5: Commit**

```bash
cd D:/xPano
git add xpano-ui/
git commit -m "feat: scaffold Tauri + React + Vite project"
```

---

### Task 2: Configure Tailwind CSS with design tokens

**Files:**
- Create: `xpano-ui/tailwind.config.ts`
- Create: `xpano-ui/postcss.config.js`
- Modify: `xpano-ui/src/index.css`

- [ ] **Step 1: Install Tailwind CSS**

```bash
cd D:/xPano/xpano-ui
pnpm add -D tailwindcss @tailwindcss/vite
```

- [ ] **Step 2: Create postcss.config.js**

```js
// D:/xPano/xpano-ui/postcss.config.js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

- [ ] **Step 3: Create tailwind.config.ts with all design tokens**

```ts
// D:/xPano/xpano-ui/tailwind.config.ts
import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'bg-near-black': '#0a0e14',
        'bg-deep': '#0f1419',
        'bg-surface': '#161b22',
        'bg-raised': '#1c2128',
        primary: {
          400: '#5b9cf5',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
        },
        'text-primary': 'rgba(255, 255, 255, 0.92)',
        'text-secondary': 'rgba(255, 255, 255, 0.55)',
        'text-tertiary': 'rgba(255, 255, 255, 0.30)',
        'border-default': 'rgba(255, 255, 255, 0.06)',
        'border-strong': 'rgba(255, 255, 255, 0.10)',
        success: '#22c55e',
        warning: '#f59e0b',
        error: '#ef4444',
      },
      fontSize: {
        display: ['2.5rem', { lineHeight: '1.2', fontWeight: '600' }],
        section: ['1.5rem', { lineHeight: '1.3', fontWeight: '600' }],
        subhead: ['1.125rem', { lineHeight: '1.4', fontWeight: '500' }],
        body: ['0.938rem', { lineHeight: '1.5', fontWeight: '400' }],
        'body-sm': ['0.813rem', { lineHeight: '1.5', fontWeight: '400' }],
        caption: ['0.75rem', { lineHeight: '1.4', fontWeight: '400' }],
        label: ['0.688rem', { lineHeight: '1.3', fontWeight: '500', letterSpacing: '0.05em' }],
        code: ['0.813rem', { lineHeight: '1.5', fontWeight: '400' }],
      },
      borderRadius: {
        sharp: '4px',
        subtle: '6px',
        card: '10px',
        modal: '14px',
      },
      boxShadow: {
        'card': '0 1px 3px rgba(0, 0, 0, 0.4)',
        'modal': '0 8px 32px rgba(0, 0, 0, 0.6)',
        'glow': '0 0 20px rgba(59, 130, 246, 0.15)',
      },
      transitionDuration: {
        fast: '150ms',
        normal: '250ms',
        slow: '400ms',
      },
      fontFamily: {
        sans: ['"DM Sans"', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config
```

- [ ] **Step 4: Update index.css with Tailwind directives and base styles**

```css
/* D:/xPano/xpano-ui/src/index.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

@layer base {
  * {
    border-color: rgba(255, 255, 255, 0.06);
  }

  body {
    @apply bg-bg-near-black text-text-primary font-sans antialiased;
    user-select: none;
    overflow: hidden;
  }

  ::-webkit-scrollbar {
    width: 4px;
  }
  ::-webkit-scrollbar-track {
    background: transparent;
  }
  ::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.08);
    border-radius: 2px;
  }

  ::selection {
    background: rgba(59, 130, 246, 0.3);
  }
}

@layer components {
  .animate-in {
    animation-duration: 0.5s;
    animation-fill-mode: both;
  }
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slide-in-from-right-4 {
  from { transform: translateX(1rem); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

@keyframes slide-in-from-bottom-4 {
  from { transform: translateY(1rem); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

@keyframes slide-in-from-top-2 {
  from { transform: translateY(-0.5rem); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

@keyframes pulse-glow {
  0%, 100% { box-shadow: 0 0 8px rgba(59, 130, 246, 0.1); }
  50% { box-shadow: 0 0 20px rgba(59, 130, 246, 0.25); }
}

.fade-in { animation-name: fade-in; }
.slide-in-from-right-4 { animation-name: slide-in-from-right-4; }
.slide-in-from-bottom-4 { animation-name: slide-in-from-bottom-4; }
.slide-in-from-top-2 { animation-name: slide-in-from-top-2; }
```

- [ ] **Step 5: Verify Tailwind compiles**

```bash
cd D:/xPano/xpano-ui
pnpm tauri dev
```

Expected: No build errors. Kill after verifying.

- [ ] **Step 6: Commit**

```bash
cd D:/xPano
git add xpano-ui/tailwind.config.ts xpano-ui/postcss.config.js xpano-ui/src/index.css
git commit -m "feat: add Tailwind CSS config with design tokens"
```

---

### Task 3: Create shared TypeScript types

**Files:**
- Create: `xpano-ui/src/lib/types.ts`
- Create: `xpano-ui/src/lib/utils.ts`

- [ ] **Step 1: Write types.ts**

```ts
// D:/xPano/xpano-ui/src/lib/types.ts

export type TrackType = 'panoramic_video' | 'standard_photos' | 'aerial_photos'

export interface MaterialTrack {
  id: string
  type: TrackType
  label: string
  path: string
}

export interface PipelineConfig {
  outputDir: string
  metashapePath: string
  fps: number
  frameLimit: number
}

export type PipelinePhase = 'idle' | 'extract' | 'align' | 'export' | 'complete' | 'error'

export interface PipelineProgress {
  phase: PipelinePhase
  percent: number
  message: string
  elapsed: number
  phasePercents: {
    extract: number
    align: number
    export: number
  }
}

export interface PipelineComplete {
  outputPath: string
}

export interface PipelineError {
  error: string
}

export interface PointCloudData {
  points: Float32Array
  colors: Float32Array
  numPoints: number
  cameras: CameraPose[]
}

export interface CameraPose {
  id: number
  position: [number, number, number]
  rotation: [number, number, number, number]
  frustum?: {
    fov: number
    aspect: number
    near: number
    far: number
  }
}
```

- [ ] **Step 2: Write utils.ts**

```ts
// D:/xPano/xpano-ui/src/lib/utils.ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 3: Commit**

```bash
cd D:/xPano
git add xpano-ui/src/lib/
git commit -m "feat: add shared types and utility functions"
```

---

### Task 4: Build shared UI components

**Files:**
- Create: `xpano-ui/src/components/shared/Button.tsx`
- Create: `xpano-ui/src/components/shared/Card.tsx`
- Create: `xpano-ui/src/components/shared/Input.tsx`
- Create: `xpano-ui/src/components/shared/Select.tsx`
- Create: `xpano-ui/src/components/shared/Toggle.tsx`
- Create: `xpano-ui/src/components/shared/Toast.tsx`
- Create: `xpano-ui/src/hooks/useToast.ts`

- [ ] **Step 1: Write Button component**

```tsx
// D:/xPano/xpano-ui/src/components/shared/Button.tsx
import { cn } from '../../lib/utils'
import { ButtonHTMLAttributes, forwardRef } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', children, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center font-medium transition-all duration-fast',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
          'disabled:opacity-30 disabled:pointer-events-none',
          {
            primary:
              'bg-gradient-to-b from-primary-500 to-primary-700 text-white rounded-subtle ' +
              'shadow-glow hover:-translate-y-0.5 hover:shadow-[0_0_28px_rgba(59,130,246,0.25)] ' +
              'active:translate-y-0',
            secondary:
              'bg-white/[0.04] text-text-secondary border border-border-strong rounded-subtle ' +
              'hover:bg-white/[0.08] hover:text-text-primary',
            ghost:
              'text-text-tertiary hover:text-text-primary hover:bg-white/[0.04] rounded-sharp',
          }[variant],
          {
            sm: 'h-7 px-3 text-label',
            md: 'h-9 px-4 text-body-sm',
            lg: 'h-12 px-8 text-body',
          }[size],
          className
        )}
        disabled={disabled}
        {...props}
      >
        {children}
      </button>
    )
  }
)

Button.displayName = 'Button'
export { Button }
export type { ButtonProps }
```

- [ ] **Step 2: Write Card component**

```tsx
// D:/xPano/xpano-ui/src/components/shared/Card.tsx
import { cn } from '../../lib/utils'
import { HTMLAttributes, forwardRef } from 'react'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padded?: boolean
}

const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className, padded = true, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'bg-bg-deep border border-border-default rounded-card shadow-card',
          padded && 'p-5',
          className
        )}
        {...props}
      >
        {children}
      </div>
    )
  }
)

Card.displayName = 'Card'
export { Card }
export type { CardProps }
```

- [ ] **Step 3: Write Input component**

```tsx
// D:/xPano/xpano-ui/src/components/shared/Input.tsx
import { cn } from '../../lib/utils'
import { InputHTMLAttributes, forwardRef } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, id, ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={id} className="text-label text-text-tertiary uppercase tracking-wider">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={id}
          className={cn(
            'h-9 px-3 bg-bg-raised border-0 border-b border-border-default rounded-subtle',
            'text-body-sm text-text-primary font-mono',
            'placeholder:text-text-tertiary',
            'focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/20',
            'transition-colors duration-fast',
            className
          )}
          {...props}
        />
      </div>
    )
  }
)

Input.displayName = 'Input'
export { Input }
export type { InputProps }
```

- [ ] **Step 4: Write Select component**

```tsx
// D:/xPano/xpano-ui/src/components/shared/Select.tsx
import { cn } from '../../lib/utils'
import { SelectHTMLAttributes, forwardRef } from 'react'

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  options: { value: string; label: string }[]
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, options, id, ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={id} className="text-label text-text-tertiary uppercase tracking-wider">
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={id}
          className={cn(
            'h-9 px-3 bg-bg-raised border-0 border-b border-border-default rounded-subtle',
            'text-body-sm text-text-primary',
            'focus:outline-none focus:border-primary-500',
            'transition-colors duration-fast appearance-none',
            className
          )}
          {...props}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    )
  }
)

Select.displayName = 'Select'
export { Select }
export type { SelectProps }
```

- [ ] **Step 5: Write Toggle component**

```tsx
// D:/xPano/xpano-ui/src/components/shared/Toggle.tsx
import { cn } from '../../lib/utils'

interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
}

function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-4 w-8 rounded-full transition-colors duration-normal',
          checked ? 'bg-primary-500' : 'bg-white/[0.12]'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all duration-normal',
            checked ? 'left-[18px]' : 'left-0.5'
          )}
        />
      </button>
      {label && <span className="text-body-sm text-text-secondary">{label}</span>}
    </label>
  )
}

export { Toggle }
export type { ToggleProps }
```

- [ ] **Step 6: Write useToast hook**

```tsx
// D:/xPano/xpano-ui/src/hooks/useToast.ts
import { useState, useCallback } from 'react'

export interface Toast {
  id: string
  type: 'info' | 'success' | 'error' | 'warning'
  message: string
}

let toastId = 0

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([])

  const addToast = useCallback((type: Toast['type'], message: string) => {
    const id = String(++toastId)
    setToasts((prev) => [...prev, { id, type, message }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 4000)
  }, [])

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = {
    info: (msg: string) => addToast('info', msg),
    success: (msg: string) => addToast('success', msg),
    error: (msg: string) => addToast('error', msg),
    warning: (msg: string) => addToast('warning', msg),
  }

  return { toasts, removeToast, toast }
}
```

- [ ] **Step 7: Write Toast component**

```tsx
// D:/xPano/xpano-ui/src/components/shared/Toast.tsx
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { Toast as ToastType } from '../../hooks/useToast'

const borderMap = {
  info: 'border-l-primary-500',
  success: 'border-l-success',
  error: 'border-l-error',
  warning: 'border-l-warning',
}

const iconMap = {
  info: 'text-primary-500',
  success: 'text-success',
  error: 'text-error',
  warning: 'text-warning',
}

function ToastItem({ toast, onRemove }: { toast: ToastType; onRemove: (id: string) => void }) {
  return (
    <div
      className={cn(
        'animate-in slide-in-from-right-4',
        'flex items-center gap-3 px-4 py-3 bg-bg-near-black/90 backdrop-blur-xl',
        'border border-border-strong border-l-2 rounded-subtle shadow-card',
        'max-w-md',
        borderMap[toast.type]
      )}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', iconMap[toast.type])} />
      <p className="text-body-sm text-text-secondary flex-1">{toast.message}</p>
      <button
        onClick={() => onRemove(toast.id)}
        className="text-text-tertiary hover:text-text-primary transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  )
}

function ToastContainer({
  toasts,
  onRemove,
}: {
  toasts: ToastType[]
  onRemove: (id: string) => void
}) {
  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onRemove={onRemove} />
      ))}
    </div>
  )
}

export { ToastContainer }
```

- [ ] **Step 8: Commit**

```bash
cd D:/xPano
git add xpano-ui/src/components/shared/ xpano-ui/src/hooks/useToast.ts
git commit -m "feat: add shared UI components and toast system"
```

---

### Task 5: Build layout components (Sidebar + WindowControls)

**Files:**
- Create: `xpano-ui/src/components/layout/WindowControls.tsx`
- Create: `xpano-ui/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Write WindowControls component**

```tsx
// D:/xPano/xpano-ui/src/components/layout/WindowControls.tsx
import { Minus, Square, X } from 'lucide-react'

function WindowControls() {
  return (
    <div className="fixed top-0 right-0 z-50 flex items-center h-8">
      <button
        onClick={() => {/* Tauri minimize */ }}
        className="h-8 w-10 flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] transition-colors"
      >
        <Minus size={14} />
      </button>
      <button
        onClick={() => {/* Tauri maximize */ }}
        className="h-8 w-10 flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] transition-colors"
      >
        <Square size={12} />
      </button>
      <button
        onClick={() => {/* Tauri close */ }}
        className="h-8 w-10 flex items-center justify-center text-text-tertiary hover:text-white hover:bg-error transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  )
}

export { WindowControls }
```

- [ ] **Step 2: Write Sidebar component**

```tsx
// D:/xPano/xpano-ui/src/components/layout/Sidebar.tsx
import { cn } from '../../lib/utils'

interface NavItem {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick?: () => void
}

function Sidebar({
  logo,
  navItems,
  bottomContent,
}: {
  logo: React.ReactNode
  navItems: NavItem[]
  bottomContent?: React.ReactNode
}) {
  return (
    <aside className="fixed left-0 top-0 bottom-0 w-72 bg-bg-deep border-r border-border-default flex flex-col">
      {/* Drag region for frameless window */}
      <div data-tauri-drag-region className="h-8 flex-shrink-0" />

      {/* Logo */}
      <div className="px-6 py-4">
        {logo}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-2 space-y-0.5">
        {navItems.map((item, i) => (
          <button
            key={i}
            onClick={item.onClick}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2 rounded-subtle text-body-sm transition-colors duration-fast',
              item.active
                ? 'bg-white/[0.06] text-text-primary'
                : 'text-text-secondary hover:text-text-primary hover:bg-white/[0.03]'
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>

      {/* Bottom */}
      {bottomContent && (
        <div className="px-6 py-4 border-t border-border-default">
          {bottomContent}
        </div>
      )}
    </aside>
  )
}

export { Sidebar }
export type { NavItem }
```

- [ ] **Step 3: Commit**

```bash
cd D:/xPano
git add xpano-ui/src/components/layout/
git commit -m "feat: add WindowControls and Sidebar layout components"
```

---

### Task 6: Build Pipeline page - TrackManager

**Files:**
- Create: `xpano-ui/src/components/pipeline/TrackManager.tsx`

- [ ] **Step 1: Write TrackManager component**

```tsx
// D:/xPano/xpano-ui/src/components/pipeline/TrackManager.tsx
import { Plus, Trash2, Video, Image, Plane } from 'lucide-react'
import { Card } from '../shared/Card'
import { Button } from '../shared/Button'
import type { MaterialTrack, TrackType } from '../../lib/types'

const trackTypeMeta: Record<TrackType, { icon: React.ReactNode; label: string }> = {
  panoramic_video: { icon: <Video size={16} />, label: '全景视频' },
  standard_photos: { icon: <Image size={16} />, label: '标准照片' },
  aerial_photos: { icon: <Plane size={16} />, label: '航拍照片' },
}

function TrackManager({
  tracks,
  onAdd,
  onRemove,
}: {
  tracks: MaterialTrack[]
  onAdd: () => void
  onRemove: (id: string) => void
}) {
  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-section text-text-primary">素材轨道</h2>
        <Button variant="ghost" size="sm" onClick={onAdd}>
          <Plus size={16} className="mr-1" />
          添加轨道
        </Button>
      </div>

      {tracks.length === 0 ? (
        <div className="py-8 text-center text-text-tertiary text-body-sm">
          暂无轨道，点击"添加轨道"开始
        </div>
      ) : (
        <div className="space-y-2">
          {tracks.map((track) => (
            <div
              key={track.id}
              className="flex items-center gap-3 px-3 py-2.5 bg-bg-raised rounded-subtle border border-border-default group"
            >
              <span className="text-text-tertiary">
                {trackTypeMeta[track.type].icon}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-body-sm text-text-primary truncate">{track.label}</p>
                <p className="text-caption text-text-tertiary truncate">{track.path}</p>
              </div>
              <span className="text-label text-text-tertiary">
                {trackTypeMeta[track.type].label}
              </span>
              <button
                onClick={() => onRemove(track.id)}
                className="text-text-tertiary hover:text-error transition-colors opacity-0 group-hover:opacity-100"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

export { TrackManager }
```

- [ ] **Step 2: Commit**

```bash
cd D:/xPano
git add xpano-ui/src/components/pipeline/TrackManager.tsx
git commit -m "feat: add TrackManager component"
```

---

### Task 7: Build Pipeline page - ParamPanel + ProgressPanel + LogViewer

**Files:**
- Create: `xpano-ui/src/components/pipeline/ParamPanel.tsx`
- Create: `xpano-ui/src/components/pipeline/ProgressPanel.tsx`
- Create: `xpano-ui/src/components/pipeline/LogViewer.tsx`

- [ ] **Step 1: Write ParamPanel component**

```tsx
// D:/xPano/xpano-ui/src/components/pipeline/ParamPanel.tsx
import { useState } from 'react'
import { ChevronDown, ChevronRight, FolderOpen } from 'lucide-react'
import { Card } from '../shared/Card'
import { Input } from '../shared/Input'
import { Button } from '../shared/Button'
import type { PipelineConfig } from '../../lib/types'

function ParamPanel({
  config,
  onChange,
  onBrowseOutput,
  onBrowseMetashape,
}: {
  config: PipelineConfig
  onChange: (config: PipelineConfig) => void
  onBrowseOutput: () => void
  onBrowseMetashape: () => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <Card>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full mb-4"
      >
        <h2 className="text-section text-text-primary">输出 & 参数</h2>
        {expanded ? <ChevronDown size={18} className="text-text-tertiary" /> : <ChevronRight size={18} className="text-text-tertiary" />}
      </button>

      <div className="space-y-4">
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <Input
              label="输出目录"
              value={config.outputDir}
              onChange={(e) => onChange({ ...config, outputDir: e.target.value })}
              placeholder="选择输出目录..."
              readOnly
            />
          </div>
          <Button variant="secondary" size="md" onClick={onBrowseOutput}>
            <FolderOpen size={16} className="mr-1" />
            浏览
          </Button>
        </div>

        {expanded && (
          <div className="space-y-4 pt-2 border-t border-border-default">
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Input
                  label="Metashape 路径"
                  value={config.metashapePath}
                  onChange={(e) => onChange({ ...config, metashapePath: e.target.value })}
                  placeholder="Metashape.exe 路径..."
                  readOnly
                />
              </div>
              <Button variant="secondary" size="md" onClick={onBrowseMetashape}>
                <FolderOpen size={16} className="mr-1" />
                浏览
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="帧率 (fps)"
                type="number"
                value={config.fps}
                onChange={(e) => onChange({ ...config, fps: Number(e.target.value) })}
              />
              <Input
                label="帧数限制"
                type="number"
                value={config.frameLimit}
                onChange={(e) => onChange({ ...config, frameLimit: Number(e.target.value) })}
              />
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

export { ParamPanel }
```

- [ ] **Step 2: Write ProgressPanel with SVG ring indicators**

```tsx
// D:/xPano/xpano-ui/src/components/pipeline/ProgressPanel.tsx
import { Card } from '../shared/Card'
import type { PipelineProgress } from '../../lib/types'

const phaseLabels = { extract: '抽取', align: '对齐', export: '导出' }
const radius = 36
const circumference = 2 * Math.PI * radius

function PhaseRing({ label, percent }: { label: string; percent: number }) {
  const offset = circumference - (percent / 100) * circumference
  const isActive = percent > 0 && percent < 100
  const isDone = percent >= 100

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width={88} height={88} className="transform -rotate-90">
        <circle
          cx={44}
          cy={44}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={3}
        />
        <circle
          cx={44}
          cy={44}
          r={radius}
          fill="none"
          stroke={isDone ? '#22c55e' : '#3b82f6'}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-500 ease-out"
        />
      </svg>
      {isActive && (
        <div className="w-2 h-2 rounded-full bg-primary-500 animate-pulse" />
      )}
      <span className="text-label text-text-tertiary">{label}</span>
      <span className="text-code text-text-secondary tabular-nums">
        {Math.round(percent)}%
      </span>
    </div>
  )
}

function ProgressPanel({ progress }: { progress: PipelineProgress }) {
  const elapsed = progress.elapsed
  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60

  return (
    <Card>
      <h2 className="text-section text-text-primary mb-5">处理进度</h2>

      <div className="flex justify-around mb-6">
        <PhaseRing label="抽取" percent={progress.phasePercents.extract} />
        <PhaseRing label="对齐" percent={progress.phasePercents.align} />
        <PhaseRing label="导出" percent={progress.phasePercents.export} />
      </div>

      {/* Overall progress bar */}
      <div className="mb-3">
        <div className="h-px bg-border-default rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-primary-400 via-primary-500 to-primary-700 rounded-full transition-all duration-500 ease-out"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      </div>

      <div className="flex justify-between items-center">
        <span className="text-label text-text-tertiary uppercase">
          {progress.phase === 'idle' ? '等待开始' : progress.message}
        </span>
        <span className="text-code text-text-tertiary tabular-nums">
          {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
        </span>
      </div>
    </Card>
  )
}

export { ProgressPanel }
```

- [ ] **Step 3: Write LogViewer component**

```tsx
// D:/xPano/xpano-ui/src/components/pipeline/LogViewer.tsx
import { useEffect, useRef } from 'react'
import { Card } from '../shared/Card'

function LogViewer({ lines }: { lines: string[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lines])

  return (
    <Card>
      <h2 className="text-section text-text-primary mb-3">运行日志</h2>
      <div
        ref={scrollRef}
        className="h-40 overflow-y-auto bg-bg-near-black rounded-subtle border border-border-default p-3"
      >
        {lines.length === 0 ? (
          <p className="text-caption text-text-tertiary font-mono">等待任务开始...</p>
        ) : (
          lines.map((line, i) => (
            <p key={i} className="text-code text-text-secondary font-mono leading-relaxed whitespace-pre-wrap">
              {line}
            </p>
          ))
        )}
      </div>
    </Card>
  )
}

export { LogViewer }
```

- [ ] **Step 4: Commit**

```bash
cd D:/xPano
git add xpano-ui/src/components/pipeline/
git commit -m "feat: add ParamPanel, ProgressPanel, and LogViewer components"
```

---

### Task 8: Build PipelinePage assembly

**Files:**
- Create: `xpano-ui/src/components/pipeline/PipelinePage.tsx`

- [ ] **Step 1: Write PipelinePage**

```tsx
// D:/xPano/xpano-ui/src/components/pipeline/PipelinePage.tsx
import { useState } from 'react'
import { Play, FolderOpen, Layers, Box, Sliders } from 'lucide-react'
import { Sidebar } from '../layout/Sidebar'
import { WindowControls } from '../layout/WindowControls'
import { TrackManager } from './TrackManager'
import { ParamPanel } from './ParamPanel'
import { ProgressPanel } from './ProgressPanel'
import { LogViewer } from './LogViewer'
import { Button } from '../shared/Button'
import { ToastContainer } from '../shared/Toast'
import { useToast } from '../../hooks/useToast'
import type { MaterialTrack, PipelineConfig, PipelineProgress } from '../../lib/types'

const defaultConfig: PipelineConfig = {
  outputDir: '',
  metashapePath: '',
  fps: 2,
  frameLimit: 0,
}

const defaultProgress: PipelineProgress = {
  phase: 'idle',
  percent: 0,
  message: '等待开始',
  elapsed: 0,
  phasePercents: { extract: 0, align: 0, export: 0 },
}

function PipelinePage() {
  const [tracks, setTracks] = useState<MaterialTrack[]>([])
  const [config, setConfig] = useState<PipelineConfig>(defaultConfig)
  const [progress, setProgress] = useState<PipelineProgress>(defaultProgress)
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const { toasts, removeToast, toast } = useToast()

  const handleAddTrack = () => {
    // TODO: open file dialog via Tauri, then add track
    toast.info('文件选择功能将在 Tauri 集成后可用')
  }

  const handleRemoveTrack = (id: string) => {
    setTracks((prev) => prev.filter((t) => t.id !== id))
  }

  const handleStart = () => {
    if (tracks.length === 0) {
      toast.warning('请先添加至少一个素材轨道')
      return
    }
    if (!config.outputDir) {
      toast.warning('请选择输出目录')
      return
    }
    // TODO: invoke Tauri pipeline start
    setRunning(true)
    toast.info('管线启动中...')
  }

  const handleOpenOutput = () => {
    if (config.outputDir) {
      // TODO: invoke Tauri open folder
    }
  }

  const sidebarNav = [
    { icon: <Layers size={18} />, label: '管线', active: true },
    { icon: <Box size={18} />, label: '3D 查看器' },
    { icon: <Sliders size={18} />, label: '设置' },
  ]

  return (
    <div className="h-screen flex bg-bg-near-black">
      <WindowControls />
      <Sidebar
        logo={
          <div>
            <h1 className="text-subhead text-text-primary font-semibold tracking-tight">xPano</h1>
            <p className="text-caption text-text-tertiary mt-0.5">全景三维重建工具</p>
          </div>
        }
        navItems={sidebarNav}
        bottomContent={
          <p className="text-caption text-text-tertiary">v0.1.0</p>
        }
      />

      {/* Main content */}
      <main className="ml-72 flex-1 overflow-y-auto p-8 space-y-5">
        <div className="mb-2">
          <h1 className="text-display text-text-primary">新建项目</h1>
          <p className="text-body text-text-tertiary mt-1">
            添加素材轨道，配置参数，开始三维重建
          </p>
        </div>

        <TrackManager
          tracks={tracks}
          onAdd={handleAddTrack}
          onRemove={handleRemoveTrack}
        />

        <ParamPanel
          config={config}
          onChange={setConfig}
          onBrowseOutput={() => toast.info('文件浏览将在 Tauri 集成后可用')}
          onBrowseMetashape={() => toast.info('文件浏览将在 Tauri 集成后可用')}
        />

        <ProgressPanel progress={progress} />

        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            size="lg"
            onClick={handleStart}
            disabled={running}
          >
            <Play size={18} className="mr-2" />
            开始重建
          </Button>
          <Button variant="secondary" size="lg" onClick={handleOpenOutput}>
            <FolderOpen size={18} className="mr-2" />
            打开输出
          </Button>
        </div>

        <LogViewer lines={logs} />
      </main>

      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </div>
  )
}

export { PipelinePage }
```

- [ ] **Step 2: Commit**

```bash
cd D:/xPano
git add xpano-ui/src/components/pipeline/PipelinePage.tsx
git commit -m "feat: add PipelinePage assembly"
```

---

### Task 9: Build particle background

**Files:**
- Create: `xpano-ui/src/components/effects/ParticleBackground.tsx`

- [ ] **Step 1: Write ParticleBackground component**

```tsx
// D:/xPano/xpano-ui/src/components/effects/ParticleBackground.tsx
import { useCallback } from 'react'
import Particles from '@tsparticles/react'
import { loadSlim } from '@tsparticles/slim'
import type { Engine } from '@tsparticles/engine'

function ParticleBackground() {
  const particlesInit = useCallback(async (engine: Engine) => {
    await loadSlim(engine)
  }, [])

  return (
    <Particles
      id="tsparticles"
      init={partarticlesInit}
      className="fixed inset-0 -z-10"
      options={{
        fpsLimit: 60,
        particles: {
          number: { value: 80, density: { enable: true } },
          color: { value: ['#3b82f6', '#5b9cf5', '#1d4ed8', '#60a5fa'] },
          opacity: { value: { min: 0.1, max: 0.4 } },
          size: { value: { min: 1, max: 3 } },
          move: {
            enable: true,
            speed: 0.3,
            direction: 'none' as const,
            random: true,
            straight: false,
            outModes: { default: 'bounce' as const },
          },
          links: {
            enable: true,
            distance: 150,
            color: 'rgba(59, 130, 246, 0.1)',
            opacity: 0.3,
            width: 0.5,
          },
        },
        interactivity: {
          events: {
            onHover: { enable: true, mode: 'grab' },
            onClick: { enable: true, mode: 'push' },
          },
          modes: {
            grab: { distance: 180, links: { opacity: 0.5, color: '#3b82f6' } },
            push: { quantity: 3 },
          },
        },
        detectRetina: true,
      }}
    />
  )
}

export { ParticleBackground }
```

- [ ] **Step 2: Commit**

```bash
cd D:/xPano
git add xpano-ui/src/components/effects/
git commit -m "feat: add tsparticles particle background"
```

---

### Task 10: Build 3D Viewer page

**Files:**
- Create: `xpano-ui/src/components/viewer/PointCloudViewer.tsx`
- Create: `xpano-ui/src/components/viewer/ViewerPage.tsx`

- [ ] **Step 1: Write PointCloudViewer component**

```tsx
// D:/xPano/xpano-ui/src/components/viewer/PointCloudViewer.tsx
import { useRef, useMemo, useEffect } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'

function PointCloud({ data }: { data?: { points: Float32Array; colors: Float32Array } }) {
  const meshRef = useRef<THREE.Points>(null)

  const geometry = useMemo(() => {
    if (!data) return null
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(data.points, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3))
    return geo
  }, [data])

  const sprite = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 32
    const ctx = canvas.getContext('2d')!
    const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
    gradient.addColorStop(0, 'rgba(255,255,255,0.9)')
    gradient.addColorStop(0.4, 'rgba(255,255,255,0.4)')
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 32, 32)
    const tex = new THREE.CanvasTexture(canvas)
    tex.needsUpdate = true
    return tex
  }, [])

  if (!geometry) {
    return (
      <mesh>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#3b82f6" wireframe />
      </mesh>
    )
  }

  return (
    <points ref={meshRef} geometry={geometry}>
      <pointsMaterial
        map={sprite}
        size={0.03}
        vertexColors
        blending={THREE.NormalBlending}
        depthWrite={false}
        transparent
        opacity={0.85}
        sizeAttenuation
      />
    </points>
  )
}

function SceneSetup() {
  const { scene, gl } = useThree()

  useEffect(() => {
    scene.fog = new THREE.Fog('#0a0e14', 1, 30)
    gl.toneMapping = THREE.ACESFilmicToneMapping
    gl.toneMappingExposure = 1.2
  }, [scene, gl])

  return null
}

function GroundGrid() {
  return (
    <gridHelper
      args={[20, 20, 'rgba(255,255,255,0.04)', 'rgba(255,255,255,0.02)']}
      position={[0, -2, 0]}
    />
  )
}

function PointCloudViewer({
  pointCloudData,
}: {
  pointCloudData?: { points: Float32Array; colors: Float32Array }
}) {
  return (
    <div className="fixed inset-0">
      <Canvas
        camera={{ position: [3, 2, 5], fov: 55, near: 0.01, far: 50 }}
        gl={{ antialias: true, alpha: false }}
        style={{ background: '#0a0e14' }}
      >
        <SceneSetup />
        <ambientLight intensity={0.4} />
        <PointCloud data={pointCloudData} />
        <GroundGrid />
        <OrbitControls
          enableDamping
          dampingFactor={0.08}
          minDistance={0.5}
          maxDistance={20}
        />
        <axesHelper args={[2]} />
      </Canvas>
    </div>
  )
}

export { PointCloudViewer }
```

- [ ] **Step 2: Write ViewerPage**

```tsx
// D:/xPano/xpano-ui/src/components/viewer/ViewerPage.tsx
import { ArrowLeft } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { PointCloudViewer } from './PointCloudViewer'
import { WindowControls } from '../layout/WindowControls'

function ViewerPage() {
  const navigate = useNavigate()
  const { projectName } = useParams<{ projectName: string }>()

  return (
    <div className="h-screen bg-bg-near-black">
      <WindowControls />

      {/* HUD overlay */}
      <div className="fixed top-0 left-0 right-0 z-10 pointer-events-none">
        <div className="flex items-center gap-3 p-4">
          <button
            onClick={() => navigate('/')}
            className="pointer-events-auto flex items-center gap-2 px-3 py-1.5 text-body-sm text-text-secondary
                       bg-bg-deep/80 backdrop-blur rounded-subtle border border-border-default
                       hover:text-text-primary hover:bg-bg-surface/80 transition-colors"
          >
            <ArrowLeft size={16} />
            返回
          </button>
          <span className="text-body text-text-primary">{projectName || '未命名项目'}</span>
        </div>
      </div>

      {/* Stats badge */}
      <div className="fixed bottom-4 left-4 z-10">
        <div className="flex gap-3">
          <div className="px-3 py-1.5 bg-bg-deep/80 backdrop-blur rounded-subtle border border-border-default">
            <span className="text-label text-text-tertiary">点数 </span>
            <span className="text-code text-text-primary">--</span>
          </div>
          <div className="px-3 py-1.5 bg-bg-deep/80 backdrop-blur rounded-subtle border border-border-default">
            <span className="text-label text-text-tertiary">相机 </span>
            <span className="text-code text-text-primary">--</span>
          </div>
        </div>
      </div>

      {/* Vignette overlay */}
      <div
        className="fixed inset-0 z-10 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 60%, rgba(10,14,20,0.5) 100%)',
        }}
      />

      <PointCloudViewer />
    </div>
  )
}

export { ViewerPage }
```

- [ ] **Step 3: Commit**

```bash
cd D:/xPano
git add xpano-ui/src/components/viewer/
git commit -m "feat: add 3D viewer page with point cloud rendering"
```

---

### Task 11: Set up App routing and entry point

**Files:**
- Create: `xpano-ui/src/App.tsx`
- Modify: `xpano-ui/src/main.tsx`

- [ ] **Step 1: Write App.tsx with routing**

```tsx
// D:/xPano/xpano-ui/src/App.tsx
import { HashRouter, Routes, Route } from 'react-router-dom'
import { PipelinePage } from './components/pipeline/PipelinePage'
import { ViewerPage } from './components/viewer/ViewerPage'
import { ParticleBackground } from './components/effects/ParticleBackground'

function App() {
  return (
    <HashRouter>
      <ParticleBackground />
      <Routes>
        <Route path="/" element={<PipelinePage />} />
        <Route path="/viewer/:projectName" element={<ViewerPage />} />
      </Routes>
    </HashRouter>
  )
}

export default App
```

- [ ] **Step 2: Update main.tsx**

```tsx
// D:/xPano/xpano-ui/src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

- [ ] **Step 3: Verify build compiles**

```bash
cd D:/xPano/xpano-ui
pnpm build
```

Expected: No TypeScript errors or build failures. Fix any import issues.

- [ ] **Step 4: Commit**

```bash
cd D:/xPano
git add xpano-ui/src/App.tsx xpano-ui/src/main.tsx
git commit -m "feat: add App routing and entry point"
```

---

### Task 12: Set up Tauri Rust backend

**Files:**
- Modify: `xpano-ui/src-tauri/src/main.rs`
- Create: `xpano-ui/src-tauri/src/pipeline.rs`
- Modify: `xpano-ui/src-tauri/Cargo.toml`
- Modify: `xpano-ui/src-tauri/tauri.conf.json`

- [ ] **Step 1: Update Cargo.toml with dependencies**

```toml
# D:/xPano/xpano-ui/src-tauri/Cargo.toml
# Add under [dependencies]:
# serde = { version = "1", features = ["derive"] }
# serde_json = "1"
```

Run:
```bash
cd D:/xPano/xpano-ui/src-tauri
cargo add serde --features derive
cargo add serde_json
```

- [ ] **Step 2: Write pipeline.rs for subprocess management**

```rust
// D:/xPano/xpano-ui/src-tauri/src/pipeline.rs
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineProgressEvent {
    pub phase: String,
    pub percent: f64,
    pub message: String,
    pub elapsed: u64,
    pub phase_percents: PhasePercents,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhasePercents {
    pub extract: f64,
    pub align: f64,
    pub export: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineCompleteEvent {
    pub output_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineErrorEvent {
    pub error: String,
}

pub struct PipelineState {
    child: Option<Child>,
}

impl PipelineState {
    pub fn new() -> Self {
        Self { child: None }
    }

    pub fn start(
        &mut self,
        app: AppHandle,
        python_exe: &str,
        script: &str,
        args: &[String],
    ) -> Result<(), String> {
        if self.child.is_some() {
            return Err("Pipeline already running".into());
        }

        let mut cmd = Command::new(python_exe);
        cmd.arg(script);
        for arg in args {
            cmd.arg(arg);
        }
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("Failed to start pipeline: {}", e))?;
        let stdout = child.stdout.take().ok_or("No stdout")?;

        self.child = Some(child);

        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        if let Ok(event) = serde_json::from_str::<PipelineProgressEvent>(&text) {
                            let _ = app.emit("pipeline:progress", event);
                        } else if text.contains("COMPLETE:") {
                            let output_path = text.trim_start_matches("COMPLETE:").trim().to_string();
                            let _ = app.emit("pipeline:complete", PipelineCompleteEvent { output_path });
                        } else if text.contains("ERROR:") {
                            let error = text.trim_start_matches("ERROR:").trim().to_string();
                            let _ = app.emit("pipeline:error", PipelineErrorEvent { error });
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(())
    }

    pub fn cancel(&mut self) -> Result<(), String> {
        if let Some(ref mut child) = self.child {
            child.kill().map_err(|e| format!("Failed to kill pipeline: {}", e))?;
            self.child = None;
        }
        Ok(())
    }
}
```

- [ ] **Step 3: Write main.rs with Tauri commands**

```rust
// D:/xPano/xpano-ui/src-tauri/src/main.rs
// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pipeline;

use pipeline::PipelineState;
use std::sync::Mutex;
use tauri::State;

struct AppState {
    pipeline: Mutex<PipelineState>,
}

#[tauri::command]
fn start_pipeline(
    state: State<AppState>,
    app: tauri::AppHandle,
    python_exe: String,
    script: String,
    args: Vec<String>,
) -> Result<String, String> {
    let mut pipeline = state.pipeline.lock().map_err(|e| e.to_string())?;
    pipeline.start(app, &python_exe, &script, &args)?;
    Ok("Pipeline started".into())
}

#[tauri::command]
fn cancel_pipeline(state: State<AppState>) -> Result<String, String> {
    let mut pipeline = state.pipeline.lock().map_err(|e| e.to_string())?;
    pipeline.cancel()?;
    Ok("Pipeline cancelled".into())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            pipeline: Mutex::new(PipelineState::new()),
        })
        .invoke_handler(tauri::generate_handler![start_pipeline, cancel_pipeline])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: Update tauri.conf.json for frameless window**

```json
// D:/xPano/xpano-ui/src-tauri/tauri.conf.json
// Update these sections:
{
  "app": {
    "windows": [
      {
        "title": "xPano",
        "width": 1280,
        "height": 800,
        "minWidth": 960,
        "minHeight": 600,
        "decorations": false,
        "center": true
      }
    ]
  }
}
```

- [ ] **Step 5: Commit**

```bash
cd D:/xPano
git add xpano-ui/src-tauri/
git commit -m "feat: add Tauri Rust backend with pipeline subprocess management"
```

---

### Task 13: Create usePipeline hook and wire up Tauri IPC

**Files:**
- Create: `xpano-ui/src/hooks/usePipeline.ts`

- [ ] **Step 1: Write usePipeline hook**

```ts
// D:/xPano/xpano-ui/src/hooks/usePipeline.ts
import { useState, useEffect, useCallback, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import type { PipelineProgress, PipelineComplete, PipelineError, PipelineConfig, MaterialTrack } from '../lib/types'

export function usePipeline() {
  const [progress, setProgress] = useState<PipelineProgress>({
    phase: 'idle',
    percent: 0,
    message: '等待开始',
    elapsed: 0,
    phasePercents: { extract: 0, align: 0, export: 0 },
  })
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const unlisteners = useRef<Array<() => void>>([])

  useEffect(() => {
    const setup = async () => {
      const unlisten1 = await listen<PipelineProgress>('pipeline:progress', (event) => {
        setProgress(event.payload)
        setLogs((prev) => [...prev, `[${event.payload.phase}] ${event.payload.message} (${Math.round(event.payload.percent)}%)`])
      })

      const unlisten2 = await listen<PipelineComplete>('pipeline:complete', (event) => {
        setRunning(false)
        setLogs((prev) => [...prev, `完成: ${event.payload.outputPath}`])
      })

      const unlisten3 = await listen<PipelineError>('pipeline:error', (event) => {
        setRunning(false)
        setLogs((prev) => [...prev, `错误: ${event.payload.error}`])
      })

      unlisteners.current = [unlisten1, unlisten2, unlisten3]
    }

    setup()

    return () => {
      unlisteners.current.forEach((fn) => fn())
    }
  }, [])

  const start = useCallback(async (tracks: MaterialTrack[], config: PipelineConfig) => {
    setRunning(true)
    setLogs([])
    setProgress({
      phase: 'idle',
      percent: 0,
      message: '启动中...',
      elapsed: 0,
      phasePercents: { extract: 0, align: 0, export: 0 },
    })

    try {
      await invoke('start_pipeline', {
        pythonExe: 'python',
        script: 'scripts/run_xpano_tracks_job.py',
        args: [
          '--output', config.outputDir,
          '--metashape', config.metashapePath,
        ],
      })
    } catch (e) {
      setRunning(false)
      setLogs((prev) => [...prev, `启动失败: ${e}`])
    }
  }, [])

  const cancel = useCallback(async () => {
    try {
      await invoke('cancel_pipeline')
      setRunning(false)
    } catch (e) {
      console.error('Failed to cancel:', e)
    }
  }, [])

  return { progress, running, logs, start, cancel }
}
```

- [ ] **Step 2: Commit**

```bash
cd D:/xPano
git add xpano-ui/src/hooks/usePipeline.ts
git commit -m "feat: add usePipeline hook with Tauri IPC integration"
```

---

### Task 14: Final integration and GSAP polish

**Files:**
- Modify: `xpano-ui/src/components/pipeline/PipelinePage.tsx` — integrate usePipeline
- Modify: `xpano-ui/src/App.tsx` — add page transition animations

- [ ] **Step 1: Update PipelinePage to use usePipeline hook**

In `PipelinePage.tsx`, replace the local state handlers:

```tsx
// Add import:
import { usePipeline } from '../../hooks/usePipeline'

// Replace progress/running/logs state with:
const { progress, running, logs, start: startPipeline, cancel } = usePipeline()

// Update handleStart:
const handleStart = () => {
  if (tracks.length === 0) {
    toast.warning('请先添加至少一个素材轨道')
    return
  }
  if (!config.outputDir) {
    toast.warning('请选择输出目录')
    return
  }
  startPipeline(tracks, config)
  toast.info('管线启动中...')
}
```

- [ ] **Step 2: Add GSAP page transition to App.tsx**

```tsx
// D:/xPano/xpano-ui/src/App.tsx
// Add after imports:
import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { useLocation } from 'react-router-dom'

// Inside App component, add:
const location = useLocation()
const mainRef = useRef<HTMLDivElement>(null)

useEffect(() => {
  if (mainRef.current) {
    gsap.fromTo(mainRef.current, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' })
  }
}, [location.pathname])

// Wrap Routes in div with ref:
<div ref={mainRef}>
  <Routes>...</Routes>
</div>
```

- [ ] **Step 3: Add Button hover animation with GSAP**

In Button.tsx, add hover effect via inline event handlers or a wrapper. The gradient/shadow CSS handles basic hover; GSAP can enhance the primary button on the PipelinePage:

```tsx
// In PipelinePage.tsx, on the CTA button, add:
import { useRef, useEffect } from 'react'
import gsap from 'gsap'

const ctaRef = useRef<HTMLButtonElement>(null)

useEffect(() => {
  if (ctaRef.current) {
    const ctx = gsap.context(() => {
      gsap.set(ctaRef.current, { transformOrigin: 'center center' })
    })
    return () => ctx.revert()
  }
}, [])

// On button:
<Button ref={ctaRef} variant="primary" size="lg" ...>
```

- [ ] **Step 4: Full build verification**

```bash
cd D:/xPano/xpano-ui
pnpm build
```

Expected: Clean build with no errors.

- [ ] **Step 5: Commit**

```bash
cd D:/xPano
git add xpano-ui/src/
git commit -m "feat: integrate usePipeline, add GSAP transitions"
```

---

### Task 15: Verification and smoke test

- [ ] **Step 1: Run Tauri dev mode**

```bash
cd D:/xPano/xpano-ui
pnpm tauri dev
```

- [ ] **Step 2: Verify the following work correctly:**
  - Window appears with frameless design and custom WindowControls
  - Sidebar renders with logo, nav items, and version
  - Pipeline page shows all sections: TrackManager, ParamPanel, ProgressPanel, LogViewer
  - Particle background animates in the background
  - "开始重建" button disabled state shows correctly
  - "打开输出" button renders as secondary
  - Toast notifications appear and auto-dismiss
  - Navigate to `/viewer/test` shows the 3D viewer with grid and orbit controls
  - Back button on viewer returns to pipeline page
  - GSAP page transition animates on navigation
  - Window controls (minimize/maximize/close) work

- [ ] **Step 3: Commit any fixes**

```bash
cd D:/xPano
git add -A
git commit -m "fix: smoke test fixes and polish"
```
