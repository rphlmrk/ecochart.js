import type { TriggerEvent } from './types';

export class AlertToastManager {
    private static container: HTMLDivElement | null = null;

    private static ensureContainer(): HTMLDivElement {
        if (!this.container || !document.body.contains(this.container)) {
            this.container = document.createElement('div');
            this.container.id = 'alert-toast-container';
            this.container.style.cssText = `
                position: fixed;
                top: 48px;
                right: 16px;
                z-index: 9999;
                display: flex;
                flex-direction: column;
                gap: 8px;
                pointer-events: none;
                max-width: 360px;
                width: calc(100vw - 32px);
                box-sizing: border-box;
                font-family: -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, sans-serif;
            `;
            document.body.appendChild(this.container);
        }
        return this.container;
    }

    public static show(event: TriggerEvent, onClickSymbol?: (symbol: string) => void): void {
        const container = this.ensureContainer();

        const toast = document.createElement('div');
        toast.className = 'alert-toast-card';
        const isPullback = !!event.boxDetails || event.condition.startsWith('pullback_');
        const borderColor = event.boxDetails?.boxType === 'macro' ? '#EF5350' : event.boxDetails?.boxType === 'micro' ? '#2962FF' : '#FF9800';

        toast.style.cssText = `
            pointer-events: auto;
            background: rgba(22, 26, 37, 0.95);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid ${borderColor};
            border-left: 4px solid ${borderColor};
            border-radius: 8px;
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6), 0 0 16px ${borderColor}40;
            padding: 10px 14px;
            color: #D1D4DC;
            display: flex;
            align-items: flex-start;
            gap: 10px;
            transform: translateX(120%);
            opacity: 0;
            transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease;
            cursor: pointer;
            user-select: none;
        `;

        const conditionLabels: Record<string, string> = {
            cross: 'Crossed',
            cross_up: 'Crossed Up ↑',
            cross_down: 'Crossed Down ↓',
            greater: 'Greater Than >',
            less: 'Less Than <',
            pullback_micro_break: 'Micro Box Breakout',
            pullback_micro_break_up: 'Micro Box Breakout Up ▲',
            pullback_micro_break_down: 'Micro Box Breakdown Down ▼',
            pullback_macro_break: 'Macro Box Breakout',
            pullback_macro_break_up: 'Macro Box Breakout Up ▲',
            pullback_macro_break_down: 'Macro Box Breakdown Down ▼'
        };

        const condLabel = conditionLabels[event.condition] || event.condition;
        const timeStr = new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const icon = isPullback ? '📦' : '🔔';

        toast.innerHTML = `
            <div style="font-size: 18px; line-height: 1; margin-top: 2px;">${icon}</div>
            <div style="flex: 1; min-width: 0;">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
                    <span style="font-weight: 700; font-size: 13px; color: #fff;">${event.symbol}</span>
                    <span style="font-size: 10px; color: #787B86;">${timeStr}</span>
                </div>
                <div style="font-size: 12px; font-weight: 600; color: ${borderColor}; margin-top: 2px;">
                    ${event.name || 'Price Alert'}
                </div>
                <div style="font-size: 11px; color: #A0A5B5; margin-top: 2px;">
                    ${condLabel} <strong>$${event.targetPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</strong>
                    (Triggered at <strong>$${event.triggeredPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</strong>)
                </div>
                ${event.note ? `<div style="font-size: 10px; color: #787B86; margin-top: 3px; font-style: italic;">"${event.note}"</div>` : ''}
            </div>
            <button class="toast-close-btn" style="
                background: transparent; border: none; color: #787B86; font-size: 14px; cursor: pointer; padding: 0 4px; line-height: 1;
            " title="Dismiss">✕</button>
        `;

        toast.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.toast-close-btn')) {
                dismiss();
                return;
            }
            if (onClickSymbol) {
                onClickSymbol(event.symbol);
            }
            dismiss();
        });

        const dismiss = () => {
            toast.style.transform = 'translateX(120%)';
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        };

        container.appendChild(toast);

        // Trigger animation
        requestAnimationFrame(() => {
            toast.style.transform = 'translateX(0)';
            toast.style.opacity = '1';
        });

        // Auto dismiss after 7 seconds
        setTimeout(dismiss, 7000);
    }

    public static showNotice(options: { title: string; message: string; type?: 'info' | 'bullish' | 'bearish' }): void {
        const container = this.ensureContainer();
        const toast = document.createElement('div');
        toast.className = 'alert-toast-card';

        const color = options.type === 'bullish' ? '#00E676' : options.type === 'bearish' ? '#EF5350' : '#2962FF';
        const icon = options.type === 'bullish' ? '⚡' : options.type === 'bearish' ? '⚠️' : 'ℹ️';

        toast.style.cssText = `
            pointer-events: auto;
            background: rgba(22, 26, 37, 0.95);
            backdrop-filter: blur(12px);
            border-left: 4px solid ${color};
            border: 1px solid var(--chart-grid, #363A45);
            border-left-width: 4px;
            border-radius: 6px;
            padding: 10px 12px;
            color: #D1D4DC;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            display: flex;
            align-items: flex-start;
            gap: 10px;
            transition: transform 0.25s ease, opacity 0.25s ease;
            transform: translateX(120%);
            opacity: 0;
        `;

        toast.innerHTML = `
            <span style="font-size: 16px;">${icon}</span>
            <div style="flex: 1;">
                <div style="font-size: 12px; font-weight: 700; color: #fff;">${options.title}</div>
                <div style="font-size: 11px; color: #787B86; margin-top: 2px; line-height: 1.3;">${options.message}</div>
            </div>
            <button style="background: none; border: none; color: #787B86; font-size: 14px; cursor: pointer; padding: 0 2px;">✕</button>
        `;

        const dismiss = () => {
            toast.style.transform = 'translateX(120%)';
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        };

        toast.querySelector('button')?.addEventListener('click', dismiss);
        container.appendChild(toast);

        requestAnimationFrame(() => {
            toast.style.transform = 'translateX(0)';
            toast.style.opacity = '1';
        });

        setTimeout(dismiss, 5000);
    }
}

export const alertToast = {
    show: (options: { title: string; message: string; type?: 'info' | 'bullish' | 'bearish' }) => {
        AlertToastManager.showNotice(options);
    }
};
