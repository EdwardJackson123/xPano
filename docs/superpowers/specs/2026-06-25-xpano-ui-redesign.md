# xPano UI Redesign Spec

**Date**: 2026-06-25  
**Status**: Draft

## Goal

Replace the existing Python Tkinter GUI with a modern desktop UI built on Tauri + React + TypeScript + Vite + Tailwind CSS, while preserving all existing Python pipeline scripts.

## Design References

- **Engineering methodology** ← PanoFusion: Tailwind design tokens, React component structure, animation system, particle background
- **Visual language** ← 知天下AI (3d.explorerglobal.cn): Blue accent, clean/professional, TDesign-inspired restraint
- **Product identity** ← xPano: Desktop workspace tool, multi-track management, progress monitoring, 3D viewer

## Architecture (Option B: Event-Driven)

```
Tauri (Rust) ──subprocess──→ Python pipeline scripts
     │                        │
  IPC events            stdout JSON lines
     │                        │
React frontend ←── event bridge ──┘
```

- Rust layer: window management, file dialogs, subprocess lifecycle, stdout→event forwarding
- Frontend←→Rust via `invoke()` for commands, `listen()` for events
- Python pipeline scripts unchanged, output progress as stdout JSON lines
- No HTTP/FastAPI layer

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri 2 |
| Frontend framework | React 18 + TypeScript |
| Build tool | Vite |
| Styling | Tailwind CSS 3.4 + `clsx` + `tailwind-merge` |
| Icons | Lucide React |
| 3D rendering | Three.js (point cloud viewer) |
| Particle background | tsparticles |
| Animation | GSAP |
| Fonts | DM Sans, JetBrains Mono |
| Package manager | pnpm |

## Project Structure

```
xPano/
├── src-tauri/              # Tauri Rust backend
│   ├── src/main.rs         # Window, commands, event setup
│   ├── src/pipeline.rs     # Subprocess manager + stdout event forwarding
│   └── Cargo.toml
├── src/                    # React frontend
│   ├── main.tsx
│   ├── App.tsx             # Routes: / and /viewer/:projectName
│   ├── index.css           # Tailwind + globals + keyframes
│   ├── components/
│   │   ├── layout/         # Sidebar, TitleBar, WindowControls
│   │   ├── pipeline/       # TrackManager, ProgressRings, LogViewer, ParamPanel
│   │   ├── viewer/         # PointCloudViewer, ViewerHUD
│   │   └── shared/         # Button, Card, Toggle, Toast, Input, Select
│   ├── hooks/              # usePipeline, useTauriEvent, useToast
│   ├── lib/                # utils.ts, types.ts
│   └── assets/
├── scripts/                # Python pipeline (unchanged)
├── tailwind.config.ts
├── vite.config.ts
└── package.json
```

## IPC Communication

| Direction | Channel | Payload |
|-----------|---------|---------|
| Frontend → Rust | `invoke('start_pipeline', {tracks, config})` | Track list + pipeline config |
| Rust → Frontend | `event('pipeline:progress', ...)` | `{phase, percent, message}` |
| Rust → Frontend | `event('pipeline:complete', ...)` | `{outputPath}` |
| Rust → Frontend | `event('pipeline:error', ...)` | `{error}` |
| Frontend → Rust | `invoke('cancel_pipeline')` | — |
| Frontend → Rust | `invoke('open_output_folder', {path})` | — |

## Design Tokens

### Colors (Dark Theme, Blue Accent)

| Token | Value | Usage |
|-------|-------|-------|
| `bg-near-black` | `#0a0e14` | Page background |
| `bg-deep` | `#0f1419` | Card/panel |
| `bg-surface` | `#161b22` | Dropdown/overlay |
| `bg-raised` | `#1c2128` | Input/selected |
| `primary-400` | `#5b9cf5` | Hover |
| `primary-500` | `#3b82f6` | Primary action |
| `primary-600` | `#2563eb` | Pressed |
| `primary-700` | `#1d4ed8` | Gradient |
| `text-primary` | `rgba(255,255,255,0.92)` | Primary text |
| `text-secondary` | `rgba(255,255,255,0.55)` | Secondary text |
| `text-tertiary` | `rgba(255,255,255,0.30)` | Muted text |
| `border-default` | `rgba(255,255,255,0.06)` | Default border |
| `border-strong` | `rgba(255,255,255,0.10)` | Emphasis border |
| `success` | `#22c55e` | Success |
| `warning` | `#f59e0b` | Warning |
| `error` | `#ef4444` | Error |

### Typography

| Token | Size | Weight | Use |
|-------|------|--------|-----|
| `text-display` | 2.5rem | 600 | Page title |
| `text-section` | 1.5rem | 600 | Section header |
| `text-subhead` | 1.125rem | 500 | Subheading |
| `text-body` | 0.938rem | 400 | Body |
| `text-body-sm` | 0.813rem | 400 | Small body |
| `text-caption` | 0.75rem | 400 | Caption |
| `text-label` | 0.688rem | 500 | Label/overline |
| `text-code` | 0.813rem | 400 | Monospace |

### Border Radius

| Token | Value | Use |
|-------|-------|-----|
| `rounded-sharp` | 4px | Compact elements |
| `rounded-subtle` | 6px | Inputs/buttons |
| `rounded-card` | 10px | Cards/panels |
| `rounded-modal` | 14px | Modals |

### Animation

| Token | Value | Use |
|-------|-------|-----|
| `duration-fast` | 150ms | Hover transitions |
| `duration-normal` | 250ms | Toggle/expand |
| `duration-slow` | 400ms | Page transitions |

## Pages

### 1. Pipeline Page (`/`)

Split layout: 280px fixed sidebar + scrollable content area.

**Sidebar**: Logo, nav links, app version, bottom utility links

**Content Area** (stacked vertically):
- Track management panel: card-list of tracks with type icon, label, path; add/remove buttons
- Preview panel: left/right fisheye thumbnail preview
- Output & params panel: output directory, Metashape path, fps/frame limit
- Progress panel: 3 phase rings (extract/align/export), main progress bar, elapsed timer, phase status
- Action bar: Start Reconstruction + Open Output Folder buttons
- Log viewer: scrollable monospace text area, auto-scroll to bottom

**Primary CTA button**: Blue gradient (`primary-500` → `primary-700`), hover lift (GSAP `translateY(-2px)`), glow shadow

### 2. Viewer Page (`/viewer/:projectName`)

Full-height Three.js canvas with HUD overlay:
- Top-left: back button + project name
- Bottom-left: point cloud stats badges (point count, camera count)
- Top-right: axis orientation widget
- Bottom-center: camera frustum toggle

Three.js features: ACESFilmicToneMapping, soft point sprites, primary/context split rendering, fog, ground grid, animated camera reset, vignette overlay

## Visual Effects

- **Particle background** (tsparticles): 80-120 particles in blue/cyan range, mouse interaction, click ripple
- **GSAP transitions**: sidebar entry, card hover lift, progress ring animation, page transitions
- **CSS keyframes**: fade-in, slide-in-from-right (toasts), slide-in-from-bottom (cards)

## Scope

### In scope
- Tauri + React + Vite + Tailwind project scaffold
- Pipeline page with all panels
- 3D viewer page with point cloud rendering  
- Particle background
- Basic GSAP transitions
- Tauri Rust backend with subprocess management
- Custom window controls (frameless window)

### Out of scope (for now)
- Python backend changes (scripts remain identical)
- CI/CD pipeline
- macOS/Linux cross-platform testing
- Auto-updater
- Internationalization
