import type { PriceAlert, TriggerEvent, AlertCondition, AlertFrequency } from './types';
import { SoundEngine } from './SoundEngine';
import { AlertToastManager } from './AlertToast';

export class AlertManager {
    private static instance: AlertManager;
    private alerts: PriceAlert[] = [];
    private history: TriggerEvent[] = [];
    private lastPrices = new Map<string, number>();
    private subscribers = new Set<() => void>();

    private constructor() {
        this.load();
        this.requestNotificationPermission();
    }

    public static getInstance(): AlertManager {
        if (!AlertManager.instance) {
            AlertManager.instance = new AlertManager();
        }
        return AlertManager.instance;
    }

    private load(): void {
        try {
            const rawAlerts = localStorage.getItem('ecochart_alerts_v1');
            if (rawAlerts) {
                this.alerts = JSON.parse(rawAlerts);
            }
            const rawHistory = localStorage.getItem('ecochart_alert_history_v1');
            if (rawHistory) {
                this.history = JSON.parse(rawHistory);
            }
        } catch (e) {
            console.warn('[AlertManager] Failed to load alerts from storage:', e);
        }

        // Seed default educational alerts if empty so the user immediately sees how it works!
        if (this.alerts.length === 0) {
            this.alerts = [
                {
                    id: 'alert_sample_btc_100k',
                    name: 'BTC $100,000 Milestone',
                    symbol: 'BTCUSDT',
                    source: 'price',
                    condition: 'cross_up',
                    targetPrice: 100000,
                    frequency: 'once',
                    cooldownMinutes: 5,
                    status: 'active',
                    createdAt: Date.now() - 3600000,
                    soundEnabled: true,
                    color: '#FF9800',
                    note: 'Key psychological resistance level'
                },
                {
                    id: 'alert_sample_eth_3k',
                    name: 'ETH $3,000 Support Level',
                    symbol: 'ETHUSDT',
                    source: 'price',
                    condition: 'cross_down',
                    targetPrice: 3000,
                    frequency: 'every_time',
                    cooldownMinutes: 15,
                    status: 'active',
                    createdAt: Date.now() - 1800000,
                    soundEnabled: true,
                    color: '#2962FF',
                    note: 'Major daily support bounce test'
                }
            ];
            this.save();
        }
    }

    private save(): void {
        try {
            localStorage.setItem('ecochart_alerts_v1', JSON.stringify(this.alerts));
            localStorage.setItem('ecochart_alert_history_v1', JSON.stringify(this.history.slice(0, 100)));
        } catch (e) {
            console.warn('[AlertManager] Failed to save alerts:', e);
        }
        this.notifySubscribers();
    }

    public requestNotificationPermission(): void {
        if ('Notification' in window && Notification.permission === 'default') {
            try {
                Notification.requestPermission().catch(() => {});
            } catch {}
        }
    }

    public subscribe(callback: () => void): () => void {
        this.subscribers.add(callback);
        return () => this.subscribers.delete(callback);
    }

    private notifySubscribers(): void {
        for (const cb of this.subscribers) {
            try {
                cb();
            } catch (err) {
                console.error('[AlertManager] Subscriber error:', err);
            }
        }
        window.dispatchEvent(new CustomEvent('ecochart-alerts-updated'));
    }

    public getAlerts(): PriceAlert[] {
        return [...this.alerts];
    }

    public getAlertsForSymbol(symbol: string): PriceAlert[] {
        const norm = symbol.toUpperCase();
        return this.alerts.filter(a => a.symbol.toUpperCase() === norm);
    }

    public getActiveAlertsForSymbol(symbol: string): PriceAlert[] {
        const norm = symbol.toUpperCase();
        return this.alerts.filter(a => a.symbol.toUpperCase() === norm && a.status === 'active');
    }

    public getHistory(): TriggerEvent[] {
        return [...this.history];
    }

    public getActiveCount(): number {
        return this.alerts.filter(a => a.status === 'active').length;
    }

    public addAlert(data: {
        name: string;
        symbol: string;
        condition: AlertCondition;
        targetPrice: number;
        frequency: AlertFrequency;
        cooldownMinutes?: number;
        soundEnabled?: boolean;
        color?: string;
        note?: string;
    }): PriceAlert {
        const newAlert: PriceAlert = {
            id: 'alert_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
            name: data.name || `${data.symbol} Alert`,
            symbol: data.symbol.toUpperCase(),
            source: 'price',
            condition: data.condition,
            targetPrice: data.targetPrice,
            frequency: data.frequency,
            cooldownMinutes: data.cooldownMinutes ?? 5,
            status: 'active',
            createdAt: Date.now(),
            soundEnabled: data.soundEnabled ?? true,
            color: data.color || '#FF9800',
            note: data.note || ''
        };

        this.alerts.unshift(newAlert);
        this.save();
        return newAlert;
    }

    public updateAlert(id: string, updates: Partial<PriceAlert>): void {
        const idx = this.alerts.findIndex(a => a.id === id);
        if (idx !== -1) {
            this.alerts[idx] = { ...this.alerts[idx], ...updates };
            this.save();
        }
    }

    public deleteAlert(id: string): void {
        this.alerts = this.alerts.filter(a => a.id !== id);
        this.save();
    }

    public toggleAlertStatus(id: string): void {
        const alert = this.alerts.find(a => a.id === id);
        if (alert) {
            alert.status = alert.status === 'active' ? 'paused' : 'active';
            this.save();
        }
    }

    public rearmAlert(id: string): void {
        const alert = this.alerts.find(a => a.id === id);
        if (alert) {
            alert.status = 'active';
            alert.lastTriggeredAt = undefined;
            this.save();
        }
    }

    public clearTriggered(): void {
        this.alerts = this.alerts.filter(a => a.status !== 'triggered');
        this.save();
    }

    public clearHistory(): void {
        this.history = [];
        this.save();
    }

    /**
     * Core Real-Time Alert Evaluation Engine.
     * Evaluates incoming real-time price ticks from Binance WebSockets or rest feeds against active alerts.
     */
    public checkPrice(symbol: string, currentPrice: number, high?: number, low?: number): void {
        if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) return;

        const normSymbol = symbol.toUpperCase();
        const prevPrice = this.lastPrices.get(normSymbol);
        this.lastPrices.set(normSymbol, currentPrice);

        // If we don't have a previous price yet, record it and wait for next tick to detect crossing
        if (prevPrice === undefined) {
            return;
        }

        const now = Date.now();
        const activeAlerts = this.alerts.filter(a => a.symbol.toUpperCase() === normSymbol && a.status === 'active');

        for (const alert of activeAlerts) {
            // Check cooldown for repeating alerts
            if (alert.frequency === 'every_time' && alert.lastTriggeredAt) {
                const cooldownMs = (alert.cooldownMinutes || 1) * 60 * 1000;
                if (now - alert.lastTriggeredAt < cooldownMs) {
                    continue; // In cooldown
                }
            }

            let triggered = false;
            const target = alert.targetPrice;
            const barHigh = high !== undefined ? high : Math.max(prevPrice, currentPrice);
            const barLow = low !== undefined ? low : Math.min(prevPrice, currentPrice);

            switch (alert.condition) {
                case 'cross':
                    // Crossed either upwards or downwards
                    if ((prevPrice <= target && currentPrice >= target) ||
                        (prevPrice >= target && currentPrice <= target) ||
                        (barLow <= target && barHigh >= target)) {
                        triggered = true;
                    }
                    break;

                case 'cross_up':
                    // Was below target, now crossed strictly above
                    if (prevPrice <= target && (currentPrice > target || barHigh > target)) {
                        triggered = true;
                    }
                    break;

                case 'cross_down':
                    // Was above target, now crossed strictly below
                    if (prevPrice >= target && (currentPrice < target || barLow < target)) {
                        triggered = true;
                    }
                    break;

                case 'greater':
                    if (currentPrice >= target) {
                        triggered = true;
                    }
                    break;

                case 'less':
                    if (currentPrice <= target) {
                        triggered = true;
                    }
                    break;
            }

            if (triggered) {
                this.triggerAlert(alert, currentPrice);
            }
        }
    }

    private triggerAlert(alert: PriceAlert, price: number): void {
        const now = Date.now();
        alert.lastTriggeredAt = now;

        if (alert.frequency === 'once') {
            alert.status = 'triggered';
        }

        const triggerEvent: TriggerEvent = {
            id: 'trig_' + now + '_' + Math.random().toString(36).substring(2, 6),
            alertId: alert.id,
            symbol: alert.symbol,
            targetPrice: alert.targetPrice,
            triggeredPrice: price,
            timestamp: now,
            condition: alert.condition,
            name: alert.name,
            note: alert.note
        };

        this.history.unshift(triggerEvent);
        if (this.history.length > 200) {
            this.history = this.history.slice(0, 200);
        }

        this.save();

        // 1. Play synthesized chime sound
        if (alert.soundEnabled) {
            SoundEngine.playAlertChime();
        }

        // 2. Display on-screen toast notification banner
        AlertToastManager.show(triggerEvent, (sym) => {
            window.dispatchEvent(new CustomEvent('ecochart-switch-symbol', { detail: sym }));
        });

        // 3. Desktop Native Push Notification (if tab is backgrounded)
        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
            try {
                new Notification(`🔔 EcoChart Alert: ${alert.symbol}`, {
                    body: `${alert.name} triggered! Price is $${price.toLocaleString()} (Target: $${alert.targetPrice.toLocaleString()})`,
                    icon: '/favicon.svg'
                });
            } catch {}
        }

        window.dispatchEvent(new CustomEvent('ecochart-alert-triggered', { detail: triggerEvent }));
    }
}

export const alertManager = AlertManager.getInstance();
