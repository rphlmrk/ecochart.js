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
        this.activeIndicators = this.activeIndicators.filter(i => i.id !== id);
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

    public update(dataStore: DataStore) {
        for (const ind of this.activeIndicators) {
            if (ind.visible) {
                ind.update(dataStore);
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
            if (!ind.visible) continue;

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