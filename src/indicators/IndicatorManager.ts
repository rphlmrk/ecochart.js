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

    // Only reserve space if an oscillator is both present AND visible
    public hasOscillators(): boolean {
        return this.activeIndicators.some(i => i.isOscillator && i.visible);
    }

    // Returns the active oscillator that owns the bottom scale
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
        const hasOsc = this.hasOscillators();
        const screenH = renderer.app.screen.height - renderer.timeAxisHeight;
        const oscHeight = hasOsc ? 80 : 0;
        
        const layout = {
            mainChartHeight: screenH - oscHeight,
            oscY: screenH - oscHeight,
            oscHeight: oscHeight,
            chartWidth: renderer.app.screen.width - renderer.priceAxisWidth
        };

        for (const ind of this.activeIndicators) {
            if (!ind.visible) continue;
            
            if (ind.isOscillator) {
                ind.render(renderer, layout, oscGraphics);
            } else {
                ind.render(renderer, layout, mainGraphics);
            }
        }
    }
}