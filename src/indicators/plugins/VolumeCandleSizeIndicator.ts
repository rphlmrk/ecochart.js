import { Graphics } from 'pixi.js';
import { BaseIndicator, parseColor, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { updateVolumeCandleSize } from '../mlr1/volume/VolumeCandleSize';
import type { VolumeCandleSizeState } from '../mlr1/ML1FeatureTypes';

export class VolumeCandleSizeIndicator extends BaseIndicator {
    public ratios = new Float64Array(20000);
    public zScores = new Float64Array(20000);
    public regimes = new Int8Array(20000);
    public validMask = new Uint8Array(20000);
    public candleDirs = new Int8Array(20000); // 1 = close >= open, -1 = close < open
    public defaultVolRatios = new Float64Array(20000);
    public defaultVolMeans = new Float64Array(20000);
    public defaultVolValid = new Uint8Array(20000);

    private lastCalculatedLength = -1;
    private lastStateHash = '';

    constructor() {
        super('VCS_360', 'Volume Candle Size (360)');
        this.isOscillator = false;
        this.layerType = 'main';
        this.oscillatorScale = { min: 0, max: 4 };

        this.params = [
            { id: 'period', name: 'Baseline Period (1m)', type: 'number', value: 360, min: 2, max: 1440, step: 1 },
            { id: 'displayPlacement', name: 'Placement', type: 'select', value: 'Main Chart Bottom', options: ['Main Chart Bottom', 'Oscillator Pane'] },
            { id: 'heightPct', name: 'Main Chart Height %', type: 'number', value: 0.15, min: 0.05, max: 0.5, step: 0.05 },
            { id: 'opacity', name: 'Bar Opacity', type: 'number', value: 0.65, min: 0.1, max: 1.0, step: 0.05 },
            { id: 'compareDefaultVolume', name: 'Compare with Default Volume (Composite Bar)', type: 'boolean', value: true },
            { id: 'compTealColor', name: 'Composite Base (Teal)', type: 'color', value: '#26A69A' },
            { id: 'compAmberColor', name: 'Excess VCS Overflow (Amber)', type: 'color', value: '#FF9800' },
            { id: 'compGreyColor', name: 'Remaining Default Vol (Grey)', type: 'color', value: '#787B86' },
            { id: 'baselineColor', name: '1x / 2x MA Line Color', type: 'color', value: '#00E5FF' },
            { id: 'extremeColor', name: 'Extreme (> 2x) Color', type: 'color', value: '#EF5350' },
            { id: 'elevatedColor', name: 'Elevated (1x–2x) Color', type: 'color', value: '#FFEB3B' },
            { id: 'normalColor', name: 'Normal (<= 1x) Color', type: 'color', value: '#787B86' },
            { id: 'showBgColor', name: 'Show Candle Direction BG', type: 'boolean', value: false }
        ];
    }

    protected override onParamsUpdated(): void {
        const isOsc = this.getParam<string>('displayPlacement', 'Main Chart Bottom') === 'Oscillator Pane';
        this.isOscillator = isOsc;
        this.layerType = isOsc ? 'oscillator' : 'main';
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.name = `Volume Candle Size (${this.getParam<number>('period', 360)})`;
    }

    private ensureCapacity(len: number): void {
        if (len <= this.ratios.length) return;
        const cap = Math.max(len * 2, 20000);
        this.ratios = new Float64Array(cap);
        this.zScores = new Float64Array(cap);
        this.regimes = new Int8Array(cap);
        this.validMask = new Uint8Array(cap);
        this.candleDirs = new Int8Array(cap);
        this.defaultVolRatios = new Float64Array(cap);
        this.defaultVolMeans = new Float64Array(cap);
        this.defaultVolValid = new Uint8Array(cap);
    }

    public override reset(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.ratios.fill(0);
        this.zScores.fill(0);
        this.regimes.fill(0);
        this.validMask.fill(0);
        this.candleDirs.fill(0);
        this.defaultVolRatios.fill(0);
        this.defaultVolMeans.fill(0);
        this.defaultVolValid.fill(0);
        super.reset();
    }

    public calculate(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) return;
        this.ensureCapacity(len);

        const period = Math.max(2, Math.round(this.getParam<number>('period', 360)));
        const intervalMs = (len >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60_000;
        const lastBase = (len - 1) * 6;
        const rev = (ds as any).revision ?? 0;
        const hash = `${period}:${intervalMs}:${len}:${rev}:${ds.data[0]}:${ds.data[lastBase]}:${ds.data[lastBase + 4]}:${ds.data[lastBase + 5]}`;
        if (this.lastStateHash === hash && this.lastCalculatedLength === len) return;

        this.ratios.fill(0, 0, len);
        this.zScores.fill(0, 0, len);
        this.regimes.fill(0, 0, len);
        this.validMask.fill(0, 0, len);
        this.candleDirs.fill(0, 0, len);
        this.defaultVolRatios.fill(0, 0, len);
        this.defaultVolMeans.fill(0, 0, len);
        this.defaultVolValid.fill(0, 0, len);

        if (intervalMs !== 60_000) {
            this.lastCalculatedLength = len;
            this.lastStateHash = hash;
            return;
        }

        let state: VolumeCandleSizeState | undefined;
        let prevTime = -1;

        // Prior-window circular buffer for Default Volume comparison (same 360-bar baseline, zero ML-R1 alteration)
        const volRing = new Float64Array(period);
        let volCount = 0;
        let volHead = 0;
        let volSum = 0;

        for (let i = 0; i < len; i++) {
            const base = i * 6;
            const t = ds.data[base];
            const o = ds.data[base + 1];
            const h = ds.data[base + 2];
            const l = ds.data[base + 3];
            const c = ds.data[base + 4];
            const v = ds.data[base + 5];

            const validOhlcv =
                Number.isFinite(t) && t >= 0 &&
                Number.isFinite(o) && o > 0 &&
                Number.isFinite(h) && h > 0 &&
                Number.isFinite(l) && l > 0 &&
                Number.isFinite(c) && c > 0 &&
                Number.isFinite(v) && v >= 0 &&
                h >= l && h >= Math.max(o, c) && l <= Math.min(o, c);

            if (!validOhlcv || (prevTime !== -1 && t <= prevTime)) continue;

            const isDiscontinuity = prevTime !== -1 && (t - prevTime) >= 300_000;
            if (isDiscontinuity) {
                volCount = 0;
                volHead = 0;
                volSum = 0;
            }
            prevTime = t;
            this.candleDirs[i] = c < o ? -1 : 1;

            if (volCount >= period) {
                const priorMean = volSum / period;
                if (Number.isFinite(priorMean) && priorMean > 0) {
                    const ratio = v / priorMean;
                    if (Number.isFinite(ratio) && ratio >= 0) {
                        this.defaultVolMeans[i] = priorMean;
                        this.defaultVolRatios[i] = ratio;
                        this.defaultVolValid[i] = 1;
                    }
                }
            }

            if (volCount < period) {
                volRing[volHead] = v;
                volSum += v;
                volCount++;
                volHead = (volHead + 1) % period;
            } else {
                const oldValue = volRing[volHead];
                volRing[volHead] = v;
                volSum += v - oldValue;
                volHead = (volHead + 1) % period;
                // Periodic exact recomputation once every `period` bars to prevent floating-point drift
                if (volHead === 0) {
                    let exact = 0;
                    for (let k = 0; k < period; k++) exact += volRing[k];
                    volSum = exact;
                }
            }

            const res = updateVolumeCandleSize(h, l, v, period, state, isDiscontinuity);
            state = res.nextState;

            if (res.isRatioValid) {
                this.ratios[i] = res.ratio;
                this.zScores[i] = res.isZScoreValid ? res.zScore : 0;
                this.regimes[i] = res.regime;
                this.validMask[i] = 1;
            }
        }

        this.lastCalculatedLength = len;
        this.lastStateHash = hash;
    }

    public override update(ds: DataStore, isClosedTick: boolean): void {
        if (this.lastCalculatedLength !== -1 && (ds.length > this.lastCalculatedLength + 2 || ds.length <= this.lastCalculatedLength)) {
            this.lastCalculatedLength = -1;
        }
        this.calculate(ds);
        super.update(ds, isClosedTick);
    }

    public getCompositeBarGeometry(idx: number): {
        mode: 'hidden' | 'classic' | 'composite';
        tealHeight: number;
        amberBottom: number;
        amberTop: number;
        greyBottom: number;
        greyTop: number;
        isOverflow: boolean;
        overflowSide: 'none' | 'teal' | 'amber' | 'grey';
    } {
        if (this.validMask[idx] !== 1) {
            return { mode: 'hidden', tealHeight: 0, amberBottom: 0, amberTop: 0, greyBottom: 0, greyTop: 0, isOverflow: false, overflowSide: 'none' };
        }
        const compareDefault = this.getParam<boolean>('compareDefaultVolume', true);
        if (!compareDefault || this.defaultVolValid[idx] !== 1) {
            return { mode: 'classic', tealHeight: 0, amberBottom: 0, amberTop: 0, greyBottom: 0, greyTop: 0, isOverflow: false, overflowSide: 'none' };
        }

        const maxCap = 4.0;
        const vcsVal = this.ratios[idx];
        const defVal = this.defaultVolRatios[idx];
        const cappedVcs = Math.min(vcsVal, maxCap);
        const cappedDef = Math.min(defVal, maxCap);
        const tealHeight = Math.min(cappedDef, cappedVcs);

        const isOverflow = vcsVal > maxCap || defVal > maxCap;
        const overflowSide: 'none' | 'teal' | 'amber' | 'grey' = !isOverflow
            ? 'none'
            : vcsVal > defVal + 1e-9
                ? 'amber'
                : defVal > vcsVal + 1e-9
                    ? 'grey'
                    : 'teal';

        if (vcsVal > defVal + 1e-9) {
            return {
                mode: 'composite',
                tealHeight,
                amberBottom: cappedDef,
                amberTop: cappedVcs,
                greyBottom: 0,
                greyTop: 0,
                isOverflow,
                overflowSide
            };
        }
        if (defVal > vcsVal + 1e-9) {
            return {
                mode: 'composite',
                tealHeight,
                amberBottom: 0,
                amberTop: 0,
                greyBottom: cappedVcs,
                greyTop: cappedDef,
                isOverflow,
                overflowSide
            };
        }
        return { mode: 'composite', tealHeight, amberBottom: 0, amberTop: 0, greyBottom: 0, greyTop: 0, isOverflow, overflowSide };
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) return;
        if (this.lastCalculatedLength !== r.dataStore.length) this.calculate(r.dataStore);

        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp));
        const visEnd = Math.min(r.dataStore.length, Math.floor((r.cameraX + layout.chartWidth) / sp) + 1);

        // Render on main chart bottom (like VolumeIndicator) or optional oscillator pane
        const isOsc = this.isOscillator && layout.oscHeight > 0;
        const heightPct = Math.max(0.05, Math.min(0.5, this.getParam<number>('heightPct', 0.15)));
        const regionHeight = isOsc ? layout.oscHeight : (layout.mainChartHeight * heightPct);
        const regionTop = isOsc ? layout.oscY : (layout.mainChartHeight - regionHeight);

        const customOpacity = this.getParam<number>('opacity', 0.65);
        const barOpacity = isOsc
            ? 1.0
            : (r.isDarkTheme ? customOpacity : Math.min(0.95, customOpacity * 1.3));

        // Fixed 0–4x scale with 6px top headroom for overflow carets
        const maxScale = 4;
        this.oscillatorScale = { min: 0, max: maxScale };
        const yCap = regionTop + 6;
        const usableH = Math.max(1, regionHeight - (isOsc ? 8 : 6));
        const yBottom = yCap + usableH;
        const toY = (val: number) => yBottom - Math.max(0, Math.min(1, val / maxScale)) * usableH;

        // Exact Volume.ts candle-aligned bar X & width
        const barW = Math.max(1, sp * 0.8);

        // 1. Optional candle-direction background strip restricted to regionTop..yBottom
        if (this.getParam<boolean>('showBgColor', false)) {
            for (const [dir, clr] of [[1, 0x26A69A], [-1, 0xEF5350]] as const) {
                g.beginPath();
                let hasBg = false;
                for (let i = visStart; i < visEnd; i++) {
                    if (this.validMask[i] !== 1 || this.candleDirs[i] !== dir) continue;
                    const xLeft = (i * sp) - r.cameraX;
                    g.rect(xLeft, regionTop, Math.max(1, sp), regionHeight);
                    hasBg = true;
                }
                if (hasBg) g.fill({ color: clr, alpha: 0.10 });
            }
        }

        // 2. Pine ma1 (2x) and ma2 (1x) in Aqua (light-mode adapted)
        const rawBase = String(this.getParam('baselineColor', '#00E5FF')).toUpperCase();
        const baseParsed = parseColorAndAlpha(rawBase, 0.75);
        const baseColor = (!r.isDarkTheme && rawBase.startsWith('#00E5FF')) ? 0x00838F : baseParsed.color;
        g.beginPath();
        g.moveTo(0, toY(1)).lineTo(layout.chartWidth, toY(1));
        g.moveTo(0, toY(2)).lineTo(layout.chartWidth, toY(2));
        g.stroke({ color: baseColor, width: 1, alpha: baseParsed.alpha * (isOsc ? 1.0 : 0.7) });

        const compareDefault = this.getParam<boolean>('compareDefaultVolume', true);

        // 3. Single-Bar Composite Mode (fixed 0–4x scale + overflow marker above 4x)
        if (compareDefault) {
            const tealStyle = parseColorAndAlpha(this.getParam<string>('compTealColor', '#26A69A'), 0.95);
            const amberStyle = parseColorAndAlpha(this.getParam<string>('compAmberColor', '#FF9800'), 0.95);
            const greyStyle = parseColorAndAlpha(this.getParam<string>('compGreyColor', '#787B86'), 0.75);

            // Batch A: Teal Base (0 -> min(def, vcs), capped at 4x)
            g.beginPath();
            let hasTeal = false;
            for (let i = visStart; i < visEnd; i++) {
                const geom = this.getCompositeBarGeometry(i);
                if (geom.mode !== 'composite' || geom.tealHeight <= 0) continue;
                const x = (i * sp) - r.cameraX;
                const yTop = toY(geom.tealHeight);
                g.rect(x, yTop, barW, Math.max(1, yBottom - yTop));
                hasTeal = true;
            }
            if (hasTeal) g.fill({ color: tealStyle.color, alpha: tealStyle.alpha * barOpacity });

            // Batch B: Amber Overflow (def -> vcs when vcs > def, capped at 4x)
            g.beginPath();
            let hasAmber = false;
            for (let i = visStart; i < visEnd; i++) {
                const geom = this.getCompositeBarGeometry(i);
                if (geom.mode !== 'composite' || geom.amberTop <= geom.amberBottom) continue;
                const x = (i * sp) - r.cameraX;
                const yTop = toY(geom.amberTop);
                const yBot = toY(geom.amberBottom);
                g.rect(x, yTop, barW, Math.max(1, yBot - yTop));
                hasAmber = true;
            }
            if (hasAmber) g.fill({ color: amberStyle.color, alpha: amberStyle.alpha * barOpacity });

            // Batch C: Grey Remaining Default Volume (vcs -> def when def > vcs, capped at 4x)
            g.beginPath();
            let hasGrey = false;
            for (let i = visStart; i < visEnd; i++) {
                const geom = this.getCompositeBarGeometry(i);
                if (geom.mode !== 'composite' || geom.greyTop <= geom.greyBottom) continue;
                const x = (i * sp) - r.cameraX;
                const yTop = toY(geom.greyTop);
                const yBot = toY(geom.greyBottom);
                g.rect(x, yTop, barW, Math.max(1, yBot - yTop));
                hasGrey = true;
            }
            if (hasGrey) g.fill({ color: greyStyle.color, alpha: greyStyle.alpha * barOpacity });

            // Batch D: Small overflow caret (▲) above 4x-capped bars
            for (const [side, style] of [['teal', tealStyle], ['amber', amberStyle], ['grey', greyStyle]] as const) {
                g.beginPath();
                let hasOver = false;
                for (let i = visStart; i < visEnd; i++) {
                    const geom = this.getCompositeBarGeometry(i);
                    if (geom.mode !== 'composite' || !geom.isOverflow || geom.overflowSide !== side) continue;
                    const cx = (i * sp) - r.cameraX + barW * 0.5;
                    g.moveTo(cx, yCap - 5).lineTo(cx - 3.5, yCap - 1).lineTo(cx + 3.5, yCap - 1).closePath();
                    hasOver = true;
                }
                if (hasOver) g.fill({ color: style.color, alpha: 1.0 });
            }
        }

        // 4. Classic VCS Regime Rendering (when comparison disabled OR comparison data unavailable for bar i)
        const cExt = parseColorAndAlpha(this.getParam<string>('extremeColor', '#EF5350'), 1.0);
        const rawElev = String(this.getParam('elevatedColor', '#FFEB3B')).toUpperCase();
        const cElev = parseColorAndAlpha(rawElev, 0.95);
        const elevColor = (!r.isDarkTheme && rawElev.startsWith('#FFEB3B')) ? 0xD97706 : cElev.color;
        const cNorm = parseColorAndAlpha(this.getParam<string>('normalColor', '#787B86'), 0.85);

        for (const [targetRegime, color, alpha] of [
            [0, cNorm.color, cNorm.alpha * barOpacity],
            [1, elevColor, cElev.alpha * barOpacity],
            [2, cExt.color, cExt.alpha * barOpacity]
        ] as const) {
            g.beginPath();
            let hasAny = false;
            for (let i = visStart; i < visEnd; i++) {
                const geom = this.getCompositeBarGeometry(i);
                if (geom.mode !== 'classic' || this.regimes[i] !== targetRegime) continue;
                const x = (i * sp) - r.cameraX;
                const topY = toY(this.ratios[i]);
                g.rect(x, topY, barW, Math.max(1, yBottom - topY));
                hasAny = true;
            }
            if (hasAny) g.fill({ color, alpha });
        }
    }

    public override getValueAt(idx: number, ds: DataStore, isDark: boolean, defaultTextClr: number) {
        if (idx < 0 || idx >= ds.length) return { label: this.name, valueStr: '—', valueColor: defaultTextClr };
        const intervalMs = (ds.length >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60_000;
        if (intervalMs !== 60_000) return { label: this.name, valueStr: '1m Only', valueColor: 0x787B86 };
        if (this.validMask[idx] !== 1) return { label: this.name, valueStr: 'Warmup / Invalid', valueColor: 0x787B86 };

        const reg = this.regimes[idx];
        const vcsRatio = this.ratios[idx];
        const elevRaw = String(this.getParam('elevatedColor', '#FFEB3B')).toUpperCase();
        const classicClr = reg === 2
            ? parseColor(this.getParam('extremeColor', '#EF5350'))
            : reg === 1
                ? ((!isDark && elevRaw.startsWith('#FFEB3B')) ? 0xD97706 : parseColor(elevRaw))
                : parseColor(this.getParam('normalColor', '#787B86'));

        const compareDefault = this.getParam<boolean>('compareDefaultVolume', true);
        if (!compareDefault) {
            return {
                label: this.name,
                valueStr: `${vcsRatio.toFixed(2)}x (Z=${this.zScores[idx].toFixed(2)}, R${reg})`,
                valueColor: classicClr
            };
        }

        if (this.defaultVolValid[idx] !== 1) {
            return {
                label: this.name,
                valueStr: `VCS: ${vcsRatio.toFixed(2)}x (R${reg}) | Comparison: Unavailable`,
                valueColor: classicClr
            };
        }

        const fmtVol = (v: number) =>
            v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M`
                : v >= 1_000 ? v.toLocaleString(undefined, { maximumFractionDigits: 1 })
                    : v.toFixed(2);

        const defVol = ds.data[idx * 6 + 5];
        const defRatio = this.defaultVolRatios[idx];

        if (defVol <= 0 || defRatio <= 0) {
            return {
                label: this.name,
                valueStr: `Vol: ${fmtVol(defVol)} (${defRatio.toFixed(2)}x) | VCS: ${vcsRatio.toFixed(2)}x | Diff: N/A`,
                valueColor: classicClr
            };
        }

        const diffPct = ((vcsRatio - defRatio) / defRatio) * 100;
        const sign = diffPct > 0 ? '+' : '';
        const compClr = Math.abs(diffPct) < 1e-6
            ? parseColor(this.getParam('compTealColor', '#26A69A'))
            : diffPct > 0
                ? parseColor(this.getParam('compAmberColor', '#FF9800'))
                : parseColor(this.getParam('compGreyColor', '#787B86'));
        return {
            label: this.name,
            valueStr: `Vol: ${fmtVol(defVol)} (${defRatio.toFixed(2)}x) | VCS: ${vcsRatio.toFixed(2)}x | Diff: ${sign}${diffPct.toFixed(1)}%`,
            valueColor: compClr
        };
    }

    public destroy(): void {
        this.ratios = new Float64Array(0);
        this.zScores = new Float64Array(0);
        this.regimes = new Int8Array(0);
        this.validMask = new Uint8Array(0);
        this.candleDirs = new Int8Array(0);
        this.defaultVolRatios = new Float64Array(0);
        this.defaultVolMeans = new Float64Array(0);
        this.defaultVolValid = new Uint8Array(0);
    }
}
