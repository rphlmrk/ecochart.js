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

<img width="1920" height="914" alt="ecoochart 2" src="https://github.com/user-attachments/assets/b41b08aa-b481-4a53-9072-c6239adf71ad" />
<img width="1920" height="917" alt="ecoochart 1" src="https://github.com/user-attachments/assets/392b49f1-fe46-4a98-9ca0-7fa0255c61c5" />

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

---

## 🧠 Streaming State Machine: How to Write Custom Indicators

To guarantee stable 60–120 FPS performance on live market feeds—even on low-power mobile devices—EcoChart does **not** recalculate indicators using full-history loops on every live tick.

Instead, `BaseIndicator` operates as an **Event-Driven Streaming State Machine**:
- **History Load:** Runs sequentially through all historical bars once ($i = 0 \dots N-1$) with `isClosed = true`.
- **Live Ticks:** Executes in **$O(1)$ time complexity** only on the forming bar (`index = ds.length - 1`), evaluating single-candle changes without touching past candles.
- **Automated Tick Rollback:** Before processing an unclosed live tick (`isClosed = false`), the engine automatically restores `this.state` from `this.confirmedState`. This prevents temporary wicks and false intraday breakouts from corrupting permanent indicator memory.

---

### The Two Lifecycle Methods

When creating a new indicator, you only implement two methods:

```typescript
export class MyIndicator extends BaseIndicator {
    // 1. Called on initial load, symbol change, or parameter update
    protected setup(): void {
        this.state = {
            // Put persistent running values here (e.g., running sum, trend state)
            trend: 0,
            lastSwingPrice: 0
        };
    }

    // 2. Called per candle (once per bar in history, and once per tick on live edge)
    protected next(index: number, isClosed: boolean, ds: DataStore): void {
        // Read candle data
        const close = ds.data[index * 6 + 4];

        // Perform calculation for THIS index only
        this.values[index] = close;

        // Mutate state freely — BaseIndicator handles rolling it back on live ticks!
        if (close > this.state.lastSwingPrice) {
            this.state.trend = 1;
            this.state.lastSwingPrice = close;
        }
    }
}
```

### Rulebook for Custom Indicators

| Rule | Description |
| :--- | :--- |
| ❌ **No Full-History Loops** | Never write `for (let i = 0; i < ds.length; i++)` inside `next()`. The engine manages the loop. |
| 🔄 **State Isolation** | Store running states (such as pivot counts or session boundaries) inside `this.state`. Do not use detached global variables. |
| ⚡ **Sparse Output Arrays** | If your indicator produces visual boxes or lines (like HTF boxes or ZigZag segments), cap historical cache arrays inside `this.state` to avoid memory bloat (e.g., `if (this.state.blocks.length > 500) this.state.blocks.shift()`). |
| 🎯 **Direct Data Access** | Candlesticks in `DataStore` use a flat `Float64Array` with 6 fields per bar: `base = index * 6`. Offsets: `+0 Time`, `+1 Open`, `+2 High`, `+3 Low`, `+4 Close`, `+5 Volume`. |

### Example: Writing a Simple Moving Average (SMA)

```typescript
import { BaseIndicator, parseColor, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import { Graphics } from 'pixi.js';

export class SimpleSMA extends BaseIndicator {
    constructor(period = 20) {
        super(`SMA_${period}`, `SMA (${period})`);
        this.params = [{ id: 'length', name: 'Length', type: 'number', value: period, min: 1, max: 200 }];
    }

    protected setup(): void {}

    protected next(index: number, _isClosed: boolean, ds: DataStore): void {
        const len = Math.max(1, this.getParam<number>('length', 20));
        if (index < len - 1) return;

        let sum = 0;
        for (let j = 0; j < len; j++) {
            sum += ds.data[(index - j) * 6 + 4]; // Close price
        }
        this.values[index] = sum / len;
    }

    public render(r: any, layout: IndicatorLayout, g: Graphics): void {
        // Standard WebGL stroke rendering...
    }
}
```

