import type { BaseIndicator } from './Indicator';
import type { DataStore } from '../data/DataStore';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import { Graphics } from 'pixi.js';

export class IndicatorManager {
    public activeIndicators: BaseIndicator[] = [];

    public addIndicator(indicator: BaseIndicator) {
        this.activeIndicators.push(indicator);
    }

    public removeIndicator(id: string) {
        const ind = this.activeIndicators.find(i => i.id === id);
        if (ind && typeof (ind as any).destroy === 'function') {
            (ind as any).destroy();
        }
        this.activeIndicators = this.activeIndicators.filter(i => i.id !== id);
    }

    public clearAll() {
        for (const ind of this.activeIndicators) {
            if (typeof (ind as any).destroy === 'function') {
                (ind as any).destroy();
            }
        }
        this.activeIndicators = [];
    }

    // Calculates total stacked height for all active, visible oscillators
    public getTotalOscillatorHeight(): number {
        const count = this.activeIndicators.filter(i => i.isOscillator && i.visible).length;
        return count * 80; // 80px per panel
    }

    public hasOscillators(): boolean {
        return this.getTotalOscillatorHeight() > 0;
    }

    public getActiveOscillator(): BaseIndicator | undefined {
        return this.activeIndicators.find(i => i.isOscillator && i.visible);
    }

    public update(dataStore: DataStore, isClosed: boolean = true) {
        for (const ind of this.activeIndicators) {
            if (ind.visible) {
                ind.update(dataStore, isClosed);
            }
        }
    }

    public render(renderer: ChartRenderer, mainGraphics: Graphics, oscGraphics: Graphics) {
        const totalOscH = this.getTotalOscillatorHeight();
        const screenH = renderer.app.screen.height - renderer.timeAxisHeight;
        const mainChartHeight = screenH - totalOscH;
        const chartWidth = renderer.app.screen.width - renderer.priceAxisWidth;

        let currentOscY = mainChartHeight;

        for (const ind of this.activeIndicators) {
            if (!ind.visible) {
                // Hide any pooled text containers (fixes stuck ZigZag numbers)
                if ((ind as any).labelContainer) {
                    (ind as any).labelContainer.visible = false;
                }
                continue;
            }

            if (ind.isOscillator) {
                const layout = {
                    mainChartHeight,
                    oscY: currentOscY,
                    oscHeight: 80,
                    chartWidth
                };
                ind.render(renderer, layout, oscGraphics);
                currentOscY += 80; // Stack downwards
            } else {
                const layout = {
                    mainChartHeight,
                    oscY: 0,
                    oscHeight: 0,
                    chartWidth
                };
                ind.render(renderer, layout, mainGraphics);
            }
        }
    }
}