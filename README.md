**EcoChart Engine** 📈🚀

**EcoChart Engine** is a high-performance, WebGL-powered financial charting library built for the modern web. Written in TypeScript and powered by PixiJS with an offline-first IndexedDB layer (via Dexie.js), it provides an extremely fast, mobile-friendly trading interface designed to outperform traditional canvas-based charting solutions.

It applies game-engine techniques such as **Sliding-Window Viewport Culling**, **Zero-GC Object Pooling**, and **Delta-Time Frame Throttling** to deliver smooth 60–120 FPS performance with low battery usage and no memory leaks.

---

## ✨ Key Features

### 🚀 Hardware-Accelerated Rendering (WebGL)
- **Sliding Window Viewport Culling:** Only candles inside the visible area (plus a 15-candle buffer) are processed and rendered. Scrolling through histories of 100,000+ candles adds no extra drawing cost.
- **Zero-Allocation Object Pools:** Axis labels, crosshairs, telemetry badges, and indicator labels live in VRAM pools, eliminating garbage-collection stutters while panning or zooming.
- **Delta-Time Throttling:** Dynamically switch frame rates from **15 FPS (Ultra Eco / battery saver)** up to **120 FPS (high-refresh displays)**.
- **Multi-Chart Modes:** Instantly switch between Candlesticks, OHLC Bars, Line, Area, and Heikin-Ashi.

### 💾 Offline-First Storage & Custom Timeframe Resampling
- **IndexedDB Local Storage (Dexie.js):** Historical data and user drawings are cached locally for near-instant startup and symbol changes.
- **Smart Timeframe Resampler:** Binance supplies only standard intervals. EcoChart fetches the nearest base interval and aggregates custom ones (e.g., 45m, 90m, 2h) in memory, avoiding extra network calls and database growth.
- **Storage Retention Caps:** Configurable limits per timeframe group (e.g., a few weeks for 1–3 m charts, 10+ years for daily/weekly).
- **Workspace Backup:** Complete workspace state (layouts, panes, indicators, preferences) can be exported to or imported from portable JSON files.

### ✏️ Interactive Vector Drawing Suite
- **Comprehensive Drawing Tools:** Trendlines, Horizontal Rays, Vertical Lines, Rectangles, Fibonacci Retracements, Price Range tools, and screen-anchored text boxes.
- **Persistence & DB Sync:** Drawings are automatically saved to IndexedDB on creation, style changes, text edits, or handle moves.
- **Interactive Transformation:** Click to select, drag the body, or move individual anchors (`handle_0`, `handle_1`) to resize.
- **Shift-to-Snap Straight Lines:** Hold `Shift` while drawing or dragging to lock angles to 0° (horizontal), 90° (vertical), or 45° diagonals.
- **Smart Magnet Snapping:** Cursor snaps to the nearest candle Open, High, Low, or Close within a configurable pixel distance.
- **Flexible Toolbar:** Free-floating draggable palette or docked to the top center of each pane.

### 📈 Modular Indicator & Math Plugin System
- **Plug-and-Play Indicators:**
  - **Moving Averages:** SMA and EMA.
  - **Volume:** Overlay with adjustable height and bullish/bearish colors.
  - **Exhaustion (CCI):** Separate oscillator pane with stacked scales and extreme-band shading.
  - **Higher Timeframe (HTF) Suite:** HTF Box overlays, HTF Bias (including inside-bar states and future session projections), and HTF Candle Projections.
  - **ZigZag 1-2-3 Breakout:** PineScript-accurate pivot detection with automatic 1-2-3 confirmation lines and non-allocating GPU text badges.
- **Interactive Legend:** Live values, one-click visibility toggle, parameter modals, and proper cleanup (`destroy()` / `clearAll()`).

### 🕒 Market Sessions & Dynamic Time Axis Clocks
- **Market Session Highlights:** Color-coded Tokyo/Asia, London, and New York sessions with independent axis and chart shading. Automatically hidden on timeframes ≥ 1 h.
- **Dynamic Time Axis World Clock:**
  - Live local times for major financial hubs (New York, London, Tokyo, Hong Kong, Frankfurt, UTC, or Local).
  - **Empty-Space Detection:** Clocks appear in the right margin of the time axis when viewing live data and hide when scrolling into history.
  - **Responsive Display:** Collapses to one clock on mobile/compact views; expands to dual clocks on desktop.
  - **Session Status Indicators:**
    - `🔔` **Morning Open / Bell** — golden highlight at the open.
    - `🟢` **Regular Session** — teal accent while the market is open.
    - `🌙` **Closed / After-Hours** — muted styling outside market hours.

### 🎨 4-Mode Dynamic Theme Engine
Includes 14+ designer presets (Midnight Abyss, Cyberpunk Neon, Solar Spark, Crimson Pulse, etc.) with automatic black/white drawing inversion for light/dark contrast.

- **Mode 1: Manual** — pick any static preset.
- **Mode 2: Option A (Scheduled Day & Night)** — switches between chosen light and dark presets by local time.
- **Mode 3: Option B (Market Session Reactive)** — changes themes with the active global session (Tokyo → Cyberpunk Dark, London → European Finance, NY → High-Energy Daylight).
- **Mode 4: Option C (Follow System OS)** — follows the OS light/dark preference via `prefers-color-scheme`.
- **Mode 5: Option D (Solar Session Flow)** — hybrid that blends local daylight/night curves with live session colors, tinting crosshairs, borders, and session glows accordingly.

### 📱 Mobile-First Touch Engine
- **Fluid Multi-Touch:** Smooth two-finger pinch-zoom, independent one-finger panning on price/time axes, and momentum scrolling.
- **Long-Press Crosshairs:** 400 ms long-press locks the crosshair under the finger without accidental panning (with haptic feedback).
- **Auto-Collapsing Navigation:** Floating nav pills fade in when the cursor or touch approaches and hide otherwise.

### 🗂 Multi-Pane Grid Workspaces
- **Flexible Layouts:** 1–4 charts in horizontal, vertical, or grid arrangements.
- **Synchronized Crosshairs:** Hover timestamps are shared across all panes in real time.

---

## 🛠️ Tech Stack

- **Language:** TypeScript  
- **Rendering Engine:** PixiJS (WebGL)  
- **Local Database:** Dexie.js (IndexedDB)  
- **Live Data:** Native WebSockets & Fetch API (Binance Spot)  
- **Build Tool:** Vite  

---

## 🗺️ Roadmap & Milestones

- [x] **Milestone 1:** Core WebGL renderer, DataStore TypedArrays & viewport math  
- [x] **Milestone 2:** Mobile multi-touch, pinch-to-zoom & long-press crosshairs  
- [x] **Milestone 3:** Math engine & indicator plugins (SMA, EMA, Exhaustion CCI, HTF Suite, ZigZag 1-2-3)  
- [x] **Milestone 4:** Vector drawing suite (trendlines, Fibs, rays, text) with magnet snapping, handle dragging & IndexedDB persistence  
- [x] **Milestone 5:** Market session highlights, time-axis clocks & dynamic day/night/session theming  
- [ ] **Milestone 6:** Drawing tools undo/redo history stack & clipboard copy/paste  
- [ ] **Milestone 7:** Order-flow footprint charts & volume-profile heatmaps  
- [ ] **Milestone 8:** Web Workers & background AI model integration (ONNX Runtime)  

---

## 📥 Getting Started

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/rphlmrk/ecochart.js.git
cd ecochart
npm install
```

### 2. Run the Development Server
```bash
npm run dev
```

### 3. Build for Production
```bash
npm run build
```

### 💻 Basic Usage Example
```html
<div id="chart-container" style="width: 100vw; height: 100vh;"></div>

<script type="module">
  import { EcoChart, WorkspaceManager } from './src/index.ts';

  // Initialize the workspace manager
  WorkspaceManager.init();

  // Create an individual chart pane
  const container = document.getElementById('chart-container');
  const chart = new EcoChart(container);

  // Connect live data stream (e.g. BTC/USDT on 1-minute interval)
  await chart.startLiveBinance('BTCUSDT', '1m');
</script>
```