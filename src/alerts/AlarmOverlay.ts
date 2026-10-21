import type { TriggerEvent } from './types';
import { SoundEngine } from './SoundEngine';

export class AlarmOverlay {
    private static isInitialized = false;
    private static modal: HTMLDialogElement | null = null;
    private static activeEvents: TriggerEvent[] = [];

    public static init(): void {
        if (this.isInitialized) return;
        this.isInitialized = true;

        this.injectModal();
        this.setupListeners();
    }

    private static injectModal(): void {
        if (document.getElementById('ecochart-alarm-modal')) {
            this.modal = document.getElementById('ecochart-alarm-modal') as HTMLDialogElement;
            return;
        }

        // Add keyframe styling for urgent alarm blinking & pulsing
        if (!document.getElementById('ecochart-alarm-styles')) {
            const style = document.createElement('style');
            style.id = 'ecochart-alarm-styles';
            style.textContent = `
                @keyframes eco-alarm-pulse-glow {
                    0% {
                        box-shadow: 0 0 0 0 rgba(239, 83, 80, 0.8), 0 20px 50px rgba(0,0,0,0.85);
                        border-color: #EF5350;
                    }
                    50% {
                        box-shadow: 0 0 35px 8px rgba(255, 82, 82, 0.9), 0 20px 50px rgba(0,0,0,0.85);
                        border-color: #FF5252;
                    }
                    100% {
                        box-shadow: 0 0 0 0 rgba(239, 83, 80, 0.8), 0 20px 50px rgba(0,0,0,0.85);
                        border-color: #EF5350;
                    }
                }
                @keyframes eco-siren-bounce {
                    0%, 100% { transform: scale(1) rotate(0deg); }
                    25% { transform: scale(1.2) rotate(-8deg); }
                    75% { transform: scale(1.2) rotate(8deg); }
                }
                @keyframes eco-badge-flash {
                    0%, 100% { background: #EF5350; color: #fff; }
                    50% { background: #FFD600; color: #000; }
                }
            `;
            document.head.appendChild(style);
        }

        const modal = document.createElement('dialog');
        modal.id = 'ecochart-alarm-modal';
        modal.style.cssText = `
            background: #12151e;
            color: #D1D4DC;
            border: 2px solid #EF5350;
            border-radius: 12px;
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, sans-serif;
            width: 480px;
            max-width: 94vw;
            box-sizing: border-box;
            outline: none;
            overflow: hidden;
            z-index: 10000;
            animation: eco-alarm-pulse-glow 1.2s infinite ease-in-out;
        `;

        modal.innerHTML = `
            <!-- Urgent Alarm Header -->
            <div style="background: linear-gradient(90deg, rgba(239, 83, 80, 0.3) 0%, rgba(255, 110, 64, 0.25) 100%); padding: 14px 18px; border-bottom: 1px solid rgba(239, 83, 80, 0.4); display: flex; align-items: center; justify-content: space-between;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 26px; display: inline-block; animation: eco-siren-bounce 0.8s infinite ease-in-out;">🚨</span>
                    <div>
                        <div style="font-size: 11px; font-weight: 800; letter-spacing: 1px; color: #FF5252; text-transform: uppercase;">
                            URGENT ALERT • ALARM RINGING
                        </div>
                        <h2 id="alarm-header-title" style="margin: 0; font-size: 17px; font-weight: 800; color: #fff;">
                            Price Alert Triggered
                        </h2>
                    </div>
                </div>
                <div style="text-align: right;">
                    <span style="font-size: 10px; font-weight: 700; padding: 3px 7px; border-radius: 4px; animation: eco-badge-flash 1s infinite; text-transform: uppercase;">
                        RINGS UNTIL CLOSED
                    </span>
                </div>
            </div>

            <!-- Alarm Body / Event Cards -->
            <div id="alarm-events-container" style="padding: 16px 18px; max-height: 50vh; overflow-y: auto; display: flex; flex-direction: column; gap: 10px;">
                <!-- Populated dynamically -->
            </div>

            <!-- Footer with Big Stop Button -->
            <div style="background: #161a25; padding: 14px 18px; border-top: 1px solid var(--chart-grid, #2A2E39); display: flex; align-items: center; justify-content: space-between; gap: 12px;">
                <div style="font-size: 11px; color: #787B86;">
                    Press <kbd style="background: rgba(255,255,255,0.1); border: 1px solid #434651; border-radius: 3px; padding: 2px 5px; color: #D1D4DC;">ESC</kbd> to silence
                </div>
                <button id="btn-stop-alarm-action" style="
                    background: #EF5350;
                    color: #fff;
                    border: none;
                    border-radius: 6px;
                    padding: 10px 22px;
                    font-size: 14px;
                    font-weight: 800;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    box-shadow: 0 4px 14px rgba(239, 83, 80, 0.4);
                    transition: transform 0.1s ease, background 0.15s ease;
                ">
                    <span>🔕</span>
                    <span>STOP ALARM / CLOSE</span>
                </button>
            </div>
        `;

        document.body.appendChild(modal);
        this.modal = modal;
    }

    private static setupListeners(): void {
        const modal = this.modal;
        if (!modal) return;

        // Big Stop Button
        document.getElementById('btn-stop-alarm-action')?.addEventListener('click', () => {
            this.stopAndClose();
        });

        // Top bar floating stop button (if clicked)
        document.getElementById('btn-toolbar-alarm-indicator')?.addEventListener('click', () => {
            this.stopAndClose();
        });

        // Escape Key
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && SoundEngine.isRinging()) {
                this.stopAndClose();
            }
        });

        // Listen for alarm stop event dispatched elsewhere
        window.addEventListener('ecochart-alarm-stopped', () => {
            this.updateToolbarAlarmIndicator(false);
            if (this.modal && this.modal.open) {
                this.modal.close();
            }
            this.activeEvents = [];
        });
    }

    /**
     * Triggers the continuous alarm and displays the persistent Alarm dialog
     */
    public static triggerAlarm(event: TriggerEvent): void {
        this.init();
        this.activeEvents.unshift(event);

        // Keep last 5 active events
        if (this.activeEvents.length > 5) {
            this.activeEvents = this.activeEvents.slice(0, 5);
        }

        // Start repeating alarm sound and device vibration
        SoundEngine.startAlarm();
        this.updateToolbarAlarmIndicator(true);

        this.renderEvents();

        if (this.modal && !this.modal.open) {
            this.modal.showModal();
        }
    }

    private static renderEvents(): void {
        const container = document.getElementById('alarm-events-container');
        const titleEl = document.getElementById('alarm-header-title');
        if (!container) return;

        if (titleEl && this.activeEvents.length > 0) {
            const first = this.activeEvents[0];
            titleEl.textContent = `${first.symbol} • ${first.name || 'Alert Triggered'}`;
        }

        container.innerHTML = this.activeEvents.map((evt, idx) => {
            const timeStr = new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const isPullback = !!evt.boxDetails || evt.condition.startsWith('pullback_');
            const color = evt.boxDetails?.boxType === 'macro' ? '#EF5350' : evt.boxDetails?.boxType === 'micro' ? '#2962FF' : '#FF9800';

            const conditionLabels: Record<string, string> = {
                cross: 'Crossed Level',
                cross_up: 'Crossed Up (Bullish Breakout ↑)',
                cross_down: 'Crossed Down (Bearish Breakdown ↓)',
                greater: 'Price Greater Than Target (>=)',
                less: 'Price Less Than Target (<=)',
                pullback_micro_break: 'Micro Box Breakout',
                pullback_micro_break_up: 'Micro Box Breakout UP ▲',
                pullback_micro_break_down: 'Micro Box Breakdown DOWN ▼',
                pullback_macro_break: 'Macro Box Breakout',
                pullback_macro_break_up: 'Macro Box Breakout UP ▲',
                pullback_macro_break_down: 'Macro Box Breakdown DOWN ▼'
            };

            const condText = conditionLabels[evt.condition] || evt.condition;

            return `
                <div style="
                    background: rgba(255, 255, 255, 0.03);
                    border: 1px solid ${idx === 0 ? color : 'var(--chart-grid, #363A45)'};
                    border-left: 4px solid ${color};
                    border-radius: 8px;
                    padding: 12px;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                ">
                    <div style="display: flex; align-items: center; justify-content: space-between;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span style="font-size: 16px;">${isPullback ? '📦' : '🔔'}</span>
                            <span style="font-size: 14px; font-weight: 800; color: #fff; letter-spacing: 0.5px;">${evt.symbol}</span>
                            <span style="font-size: 11px; font-weight: 700; color: ${color}; background: ${color}20; padding: 2px 6px; border-radius: 4px;">
                                ${evt.name || 'Alert'}
                            </span>
                        </div>
                        <span style="font-size: 11px; color: #787B86;">${timeStr}</span>
                    </div>

                    <div style="font-size: 12px; color: #D1D4DC; line-height: 1.4;">
                        ${condText}
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; background: rgba(0,0,0,0.25); padding: 8px 10px; border-radius: 6px; margin-top: 2px;">
                        <div>
                            <div style="font-size: 10px; color: #787B86; font-weight: 600;">TRIGGERED PRICE</div>
                            <div style="font-size: 15px; font-weight: 800; color: #00E676;">
                                $${evt.triggeredPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                            </div>
                        </div>
                        <div>
                            <div style="font-size: 10px; color: #787B86; font-weight: 600;">TARGET / BOUNDARY</div>
                            <div style="font-size: 15px; font-weight: 800; color: #fff;">
                                $${evt.targetPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                            </div>
                        </div>
                    </div>

                    ${evt.note ? `<div style="font-size: 11px; color: #A0A5B5; font-style: italic;">"${evt.note}"</div>` : ''}
                </div>
            `;
        }).join('');
    }

    public static stopAndClose(): void {
        SoundEngine.stopAlarm();
        this.activeEvents = [];
        this.updateToolbarAlarmIndicator(false);
        if (this.modal && this.modal.open) {
            this.modal.close();
        }
    }

    private static updateToolbarAlarmIndicator(ringing: boolean): void {
        const btn = document.getElementById('btn-toolbar-alarm-indicator');
        if (btn) {
            btn.style.display = ringing ? 'flex' : 'none';
        }
    }

    /**
     * Sample test alarm for user verification
     */
    public static testAlarm(): void {
        const sampleEvent: TriggerEvent = {
            id: 'test_alarm_' + Date.now(),
            alertId: 'test_sample',
            symbol: 'BTCUSDT',
            targetPrice: 68500,
            triggeredPrice: 68540.25,
            timestamp: Date.now(),
            condition: 'pullback_micro_break_up',
            name: 'Micro Box Bullish Breakout Test',
            note: 'Continuous alarm test — sounds and vibrates until you click STOP ALARM / CLOSE.',
            boxDetails: {
                boxType: 'micro',
                direction: 'up',
                top: 68500,
                bottom: 67200
            }
        };

        this.triggerAlarm(sampleEvent);
    }
}
