# EcoChart Engine 📈🚀

**EcoChart Engine** is a high-performance, WebGL-accelerated financial charting library built for the modern web. Engineered with TypeScript and PixiJS, it is designed to be an ultra-fast, mobile-optimized alternative to traditional HTML5 Canvas charting libraries.

By utilizing AAA-game-engine techniques like **Object Pooling** and **Delta-Time Rendering**, EcoChart achieves a buttery-smooth 60 to 120 FPS on mobile devices with near-zero Garbage Collection (GC) thrashing and minimal battery drain.

![EcoChart Preview](./assets/preview.png)
![EcoChart Preview](./assets/preview-2.png)

## ✨ Key Features

* 🚀 **Hardware Accelerated (WebGL):** Renders thousands of candles, indicators, and footprint volume matrices natively on the GPU via PixiJS.
* 📱 **Mobile-First Touch Engine:** Native 2-finger pinch-to-zoom, 1-finger smooth panning, and long-press crosshair activation. Eliminates the "fat finger" problem.
* 🧠 **Zero VRAM Memory Leaks:** Uses advanced Object Pooling for axis labels and crosshair markers. Memory allocation drops to absolutely zero during intense swiping and zooming.
* 🗂 **Multi-Pane Workspaces:** Split the screen into 1x1, 2x2, or custom grids with perfectly synchronized crosshairs across all active panes.
* 🎨 **Deep Customization:** 14+ built-in themes (Midnight Abyss, Cyberpunk Neon, etc.) with real-time UI reacting to active bullish/bearish accent colors.
* ⚡ **Adjustable FPS Capping:** Built-in delta-time loops allow users to cap rendering at 15 FPS (Ultra Eco battery saver) up to 120 FPS (High Refresh Rate monitors).

## 🛠️ Tech Stack

* **Language:** TypeScript
* **Rendering Backend:** [PixiJS](https://pixijs.com/) (WebGL / WebGPU)
* **Data Ingestion:** Native WebSockets (Binance API ready)
* **UI/UX:** Native HTML5/CSS3 overlays mapped to screen coordinates

## 🗺️ Roadmap & Milestones

- [x] **Milestone 1:** Core WebGL Renderer & DataStore
- [x] **Milestone 2:** Mobile Multi-Touch & UI Responsiveness
- [ ] **Milestone 3:** Math Engine & Plugin Architecture (SMA, EMA, ZigZag)
- [ ] **Milestone 4:** Drawing Tools (Trendlines, Fibonacci) with Magnet Snapping
- [ ] **Milestone 5:** Web Workers & AI Evaluator (ONNX background processing)
- [ ] **Milestone 6:** Order Flow Footprint Charts & BitmapText optimization

## 📥 Installation & Usage

*(Coming soon: npm package initialization)*
Currently, EcoChart is designed to be embedded directly into your TypeScript project architecture.

```html
<!-- Example Initialization -->
<div id="chart-container"></div>
<script type="module">
  import { EcoChart } from './src/index.ts';
  const chart = new EcoChart(document.getElementById('chart-container'));
  chart.startLiveBinance('BTCUSDT', '1m');
</script>