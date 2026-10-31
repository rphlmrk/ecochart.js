# AI Training Data Exporter (CSV Dataset with Signal Outcomes & Range Detection)

A specialized training data export engine that packages historical candle data, EMA 10 / SMA 30, Market Structure Pullback Zones, and Strict CBC Pullback Zones into standardized CSV datasets. It tags all historical signals with forward trade outcomes (positive target hits vs. negative stop-outs) and signal density metrics, empowering an external AI or machine learning model to learn when to buy, sell, and stay out during choppy ranges.

---

### User Review & Critical Decisions

> [!IMPORTANT]
> The exporter produces objective, un-opinionated ground truth datasets. Instead of making hardcoded trade decisions in JavaScript, it provides the AI with full structural context, indicator metrics, forward outcomes (positive/negative based on fixed R:R and swing boundaries), and signal clustering counts so the AI can discern genuine expansions from sideways chop.

- **Confirmed Decision 1 (Signal Outcomes)**: Every signal row includes forward outcome tracking based on fixed Risk:Reward (1.5R and 2.0R) versus swing high/low breaks, plus bars-to-resolution and max drawdown (MAE).
- **Confirmed Decision 2 (Range & Chop Recognition)**: A `signal_density_cluster` feature tracks the number of repeated or conflicting signals occurring within the same price band across a rolling window, allowing the AI to learn range-bound conditions and output "Stay Out".
- **Confirmed Decision 3 (Packaging Options)**: Both single consolidated CSV and daily partitioned CSV files inside a `.zip` archive are supported and toggleable in the export dialog.
- **Confirmed Decision 4 (Placement)**: Integrated into the top toolbar as a dedicated "AI Training Export" icon button (`Brain` / `Database` icon with tooltip) matching the platform's professional dark theme.

---

## 1. Overview & Core Concept

### What It Does
Traders and quants need high-fidelity historical data to train machine learning models (XGBoost, Random Forest, LSTMs, or Gemini LLM evaluators) to find genuine trade edges. This tool extracts cached historical candlestick data from Binance and IndexedDB, calculates all three core indicators bar-by-bar, tracks the subsequent forward price path for every generated signal, and exports a clean `.csv` dataset covering 1 week to 3 months.

### Target Audience / Persona
Quantitative traders, machine learning practitioners, and technical analysts developing algorithmic trading strategies or training AI agents to trade cryptocurrency markets.

### Key Value
- **Zero Look-Ahead Bias**: Clean historical indicator snapshots computed strictly up to each bar's close.
- **Supervised Learning Ready**: Pre-labeled with forward outcomes (positive vs. negative R:R outcomes) without requiring users to write separate Python labeling scripts.
- **Chop / Range Awareness**: Exposes spatial clustering and rapid indicator whipsaws so the AI can learn when the market is erratic and predict "CASH / STAY OUT".

---

## 2. User Experience & Visual Design

### Top Bar Integration
A new high-density tool button is added to the top navigation bar alongside the existing timeframe and indicator toggles:
- **Visual**: Monochromatic SVG icon (neural/data grid motif) with subtle hover highlight (`bg-neutral-800 text-neutral-200`).
- **Tooltip**: *"Export AI Training Data (.csv)"*.
- **Touch / Click Target**: Compliant $\ge 40\text{px}$ touch target with active state ring.

### The Export Modal Dialog
Clicking the button opens a clean, focused dark-mode modal (following the SaaS dashboard design guidelines with hairline borders and tabular typography):

1. **Range Selection**:
   - Quick Preset Buttons: `1 Week`, `2 Weeks`, `1 Month`, `3 Months`.
   - Custom Date Pickers: Start date and End date inputs with automatic validation.
2. **Timeframe & Pair Context**:
   - Displays current active symbol (e.g. `BTCUSDT`) and selected resolution (e.g. `5m`, `15m`).
3. **Packaging Format Toggle (Segmented Button)**:
   - `Single CSV`: One consolidated chronological file (`BTCUSDT_5m_3M_training_data.csv`).
   - `Daily ZIP (.zip)`: Individual daily CSV files (`BTCUSDT_5m_2024-09-01.csv`, etc.) bundled into a single ZIP archive.
4. **Signal Outcome Configuration**:
   - Risk:Reward Ratio Target: `1.5R` or `2.0R` (default `2.0R`).
   - Stop Loss Reference: `Strict CBC Anchor` or `Macro Pullback Zone Edge`.
   - Max Forward Horizon: Number of bars to evaluate forward outcome (e.g. `30 bars`).
5. **Progress & Status Bar**:
   - Live progress indicator during chunk hydration from IndexedDB and calculation:
     `Fetching history... [18,420 / 25,920 bars] -> Calculating Indicators -> Evaluating Outcomes -> Generating CSV`.
6. **Download Action**:
   - Primary download button (`Export CSV Dataset`) with estimated file size and row count preview.

---

## 3. Key Product Decisions & Trade-Offs

### Decision 1: Client-Side Web Worker Generation vs. Server Export
- **Chosen Approach**: Process and generate the CSV entirely client-side using Web Workers (`DataWorkerClient` / `MathWorkerClient`).
- **Why**: Zero server latency, no server bandwidth costs, works offline with locally cached IndexedDB candle data, and handles tens of thousands of rows in milliseconds using browser streaming.
- **Alternatives Considered**: Server-side proxy generation was rejected because it introduces rate-limiting bottlenecks and unnecessary cloud egress costs.

### Decision 2: Objective Raw Signals vs. Subjective Pre-Filtering
- **Chosen Approach**: Export *all* signals (both winning and losing) with raw descriptive features and quantitative forward metrics.
- **Why**: Machine learning models need negative examples (false breakouts, fake crosses in chop) just as much as positive ones to learn true discriminative boundaries and predict when to stay out.
- **Alternatives Considered**: Filtering out bad trades before export was rejected because it would create survivorship bias in the training set.

### Decision 3: Range Detection Feature Engineering (`signal_density_cluster`)
- **Chosen Approach**: Compute rolling metrics:
  - `signals_last_10_bars`: Number of opposing or repetitive crosses in the last 10 candles.
  - `ema_sma_spread_pct`: How tightly compressed the moving averages are relative to ATR.
  - `in_macro_pullback_zone` & `in_strict_cbc_zone`: Boolean states indicating whether price is bouncing inside boundaries.
- **Why**: Enables the AI to detect sideways consolidation directly from tabular numeric inputs.

---

## 4. Technical Architecture & Data Strategy

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                       Top Toolbar                           │
│  [Timeframe] [Indicators] [Symbol] ... [AI Export Icon]     │
└─────────────────────────────────────┬───────────────────────┘
                                      │ opens
                                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    Export Modal Dialog                      │
│  - Range: 1W / 1M / 3M / Custom                             │
│  - Packaging: Single CSV vs. Daily ZIP (.zip)               │
│  - Target R:R: 1.5R / 2.0R & Stop Anchor Selection          │
└─────────────────────────────────────┬───────────────────────┘
                                      │ starts export
                                      ▼
┌─────────────────────────────────────────────────────────────┐
│                Export Coordinator & Worker                  │
│                                                             │
│  1. BinanceClient / DataWorkerClient                        │
│     └── Hydrates full historical window from IndexedDB      │
│                                                             │
│  2. Indicator Engine Calculations                           │
│     ├── EmaSmaCrossIndicator (EMA 10, SMA 30, Crosses)      │
│     ├── MarketStructurePullbackZones (Macro Zones)          │
│     └── StrictCBCPullbackZones (Flips, Trends, Anchors)     │
│                                                             │
│  3. Forward Outcome & Range Evaluator                       │
│     ├── Evaluates Stop Loss hit vs. Target hit (2.0R)       │
│     ├── Measures Max Favorable & Adverse Excursions         │
│     └── Computes Signal Density & Range Clustering          │
│                                                             │
│  4. CSV Serializer & ZIP Packager                           │
│     └── Streams formatted CSV rows / triggers download      │
└─────────────────────────────────────────────────────────────┘
```

### CSV Schema Specification

Every row in the generated `.csv` represents one candle with full context and signal metrics:

| Column Header | Data Type | Description |
| :--- | :--- | :--- |
| `timestamp` | Integer | Epoch millisecond timestamp of the candle |
| `datetime_utc` | String | ISO formatted human-readable UTC date/time |
| `open`, `high`, `low`, `close` | Float | Standard candlestick price levels |
| `volume` | Float | Candle trading volume |
| `ema_10` | Float | Fast 10-period Exponential Moving Average |
| `sma_30` | Float | Slow 30-period Simple Moving Average |
| `ema_sma_spread` | Float | `ema_10 - sma_30` (Positive = Bullish, Negative = Bearish) |
| `ema_sma_cross` | Integer | `+1` (Golden Cross), `-1` (Death Cross), `0` (None) |
| `macro_zone_active` | Boolean | Whether price is inside a Macro Pullback Zone |
| `macro_zone_top` | Float | Upper boundary of the active Macro Zone |
| `macro_zone_bottom` | Float | Lower boundary of the active Macro Zone |
| `cbc_trend` | Integer | `+1` (Bullish trend push), `-1` (Bearish pullback) |
| `cbc_flip` | Integer | `+1` (Bullish structure flip), `-1` (Bearish structure flip), `0` |
| `cbc_anchor_high` | Float | Recent swing high anchor price |
| `cbc_anchor_low` | Float | Recent swing low anchor price |
| `signal_cluster_count_10` | Integer | Number of signal flips within the last 10 candles (Range / Chop proxy) |
| `signal_type` | String | `BULL_ENTRY`, `BEAR_ENTRY`, or `NONE` |
| `outcome_target_2R_hit` | Integer | `1` (Target hit first), `0` (Stop hit first), `-1` (Unresolved / End of data) |
| `bars_to_resolution` | Integer | Number of candles elapsed until Stop Loss or 2R Target was reached |
| `max_adverse_excursion_pct` | Float | Maximum % drawdown during the active trade window |
| `max_favorable_excursion_pct`| Float | Maximum % profit achieved during the active trade window |

---

## 5. Implementation Steps (Planned Execution)

1. **CSV Export & Labeling Service (`src/data/AiExportService.ts`)**:
   - Implement date-range filtering and historical data extraction from `DataStore` and IndexedDB.
   - Run the indicator calculation loops (`EMA 10`, `SMA 30`, `MarketStructurePullbackZones`, `StrictCBCPullbackZones`).
   - Implement forward outcome walk-forward evaluator (evaluating 1.5R/2.0R target hits and stop-loss breaks).
   - Compute range clustering metrics (`signal_cluster_count`).
   - Implement CSV generation and multi-day ZIP packaging (using lightweight browser JSZip/fflate).

2. **AI Export Dialog UI (`src/ui/AiExportModal.ts`)**:
   - Build accessible modal dialog following the dark-mode aesthetic.
   - Presets for `1 Week`, `2 Weeks`, `1 Month`, and `3 Months` + custom date inputs.
   - Output format selection: Single CSV vs. Daily ZIP.
   - Real-time progress bar and status feedback during historical data sync.

3. **Top Bar Icon Integration (`src/main.ts` / toolbar template)**:
   - Mount new `AI Export` icon button with tooltip in the top navigation bar.
   - Connect click handler to launch the Export modal.

4. **Verification & Testing**:
   - Verify 1-week, 1-month, and 3-month exports across multiple intervals (1m, 5m, 15m, 1h).
   - Validate CSV structure in Python/Pandas and verify that both winning and losing signals are accurately labeled without look-ahead bias.
