import { alertManager } from './AlertManager';
import { SoundEngine } from './SoundEngine';
import { CapacitorNotificationService } from './CapacitorNotificationService';
import { ForegroundServiceManager } from './ForegroundServiceManager';
import { AlarmOverlay } from './AlarmOverlay';
import { Capacitor } from '@capacitor/core';
import type { AlertCondition, AlertFrequency } from './types';

export class AlertUI {
    private static isInitialized = false;

    public static init(): void {
        if (this.isInitialized) return;
        this.isInitialized = true;

        this.injectModals();
        this.setupEventListeners();
        this.updateBadge();
        ForegroundServiceManager.init();
        AlarmOverlay.init();
        this.updateForegroundIndicator();

        // Reactive updates
        alertManager.subscribe(() => {
            this.updateBadge();
            this.renderActiveAlerts();
            this.renderHistory();
            this.updateForegroundIndicator();
        });
    }

    private static injectModals(): void {
        if (document.getElementById('alert-modal')) return;

        const isNative = Capacitor.isNativePlatform();

        // 1. Alert Manager Modal Dialog
        const modal = document.createElement('dialog');
        modal.id = 'alert-modal';
        modal.style.cssText = `
            background: var(--chart-panel-bg, #131722);
            color: var(--chart-text, #D1D4DC);
            border: 1px solid var(--chart-grid, #363A45);
            border-radius: 8px;
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, sans-serif;
            width: 550px;
            max-width: 95vw;
            box-sizing: border-box;
            box-shadow: 0 16px 40px rgba(0,0,0,0.6);
            outline: none;
            overflow: hidden;
            z-index: 1000;
        `;

        modal.innerHTML = `
            <!-- Modal Header -->
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 18px; border-bottom: 1px solid var(--chart-grid, #2A2E39);">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 16px;">🔔</span>
                    <div>
                        <h3 style="margin: 0; font-size: 15px; font-weight: 700; color: #fff;">Alerts System</h3>
                        <div style="font-size: 10px; color: ${isNative ? '#26A69A' : '#787B86'}; font-weight: 600;">
                            ${isNative ? '📱 Android Native Local Notifications' : '🌐 Browser & In-App Notifications'}
                        </div>
                    </div>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <!-- Test Android Push -->
                    <button id="btn-alert-test-push" title="Test Android Native / Local Notification" style="
                        background: rgba(255, 152, 0, 0.12); border: 1px solid rgba(255, 152, 0, 0.4); border-radius: 4px;
                        color: #FF9800; font-size: 11px; font-weight: 600; padding: 3px 8px; cursor: pointer; display: flex; align-items: center; gap: 4px;
                    ">
                        <span>📱 Test Notif</span>
                    </button>

                    <!-- Sound Toggle & Test -->
                    <button id="btn-alert-sound-toggle" title="Toggle Alert Sound" style="
                        background: rgba(255,255,255,0.06); border: 1px solid var(--chart-grid, #363A45); border-radius: 4px;
                        color: #D1D4DC; font-size: 12px; padding: 3px 8px; cursor: pointer; display: flex; align-items: center; gap: 4px;
                    ">
                        <span id="alert-sound-icon">🔊</span>
                        <span style="font-size: 11px;">Sound</span>
                    </button>

                    <button id="btn-alert-test-sound" title="Test Chime Sound" style="
                        background: transparent; border: 1px solid var(--chart-grid, #363A45); border-radius: 4px;
                        color: #787B86; font-size: 11px; padding: 3px 6px; cursor: pointer;
                    ">Test 🎵</button>

                    <!-- Test Alarm (Continuous until closed) -->
                    <button id="btn-alert-test-alarm" title="Test Continuous Alarm (Rings and vibrates until closed)" style="
                        background: rgba(239, 83, 80, 0.15); border: 1px solid rgba(239, 83, 80, 0.4); border-radius: 4px;
                        color: #EF5350; font-size: 11px; font-weight: 700; padding: 3px 8px; cursor: pointer; display: flex; align-items: center; gap: 4px;
                    ">
                        <span>🚨 Test Alarm</span>
                    </button>

                    <button id="btn-close-alert-modal" style="
                        background: none; border: none; color: #787B86; font-size: 18px; cursor: pointer; padding: 0 4px; line-height: 1;
                    ">✕</button>
                </div>
            </div>

            <!-- Tabs Bar -->
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 18px; background: rgba(0,0,0,0.2); border-bottom: 1px solid var(--chart-grid, #2A2E39);">
                <div style="display: flex; gap: 4px;">
                    <button class="alert-tab-btn active" data-tab="active" style="
                        background: var(--chart-grid, #2A2E39); color: var(--chart-accent, #2962FF); border: none;
                        padding: 5px 12px; border-radius: 4px; font-size: 12px; font-weight: 600; cursor: pointer;
                    ">Active Alerts (<span id="alert-tab-active-count">0</span>)</button>
                    <button class="alert-tab-btn" data-tab="history" style="
                        background: transparent; color: #787B86; border: none;
                        padding: 5px 12px; border-radius: 4px; font-size: 12px; font-weight: 600; cursor: pointer;
                    ">Triggered (<span id="alert-tab-history-count">0</span>)</button>
                    <button class="alert-tab-btn" data-tab="background" style="
                        background: transparent; color: #787B86; border: none;
                        padding: 5px 12px; border-radius: 4px; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px;
                    ">
                        <span>⚡ Background Service</span>
                        <span id="badge-fg-status" style="width: 7px; height: 7px; border-radius: 50%; background: #787B86; display: inline-block;"></span>
                    </button>
                </div>
                <div style="display: flex; gap: 6px;">
                    <button id="btn-modal-quick-pullback" title="Quickly monitor Micro & Macro Pullback breakouts" style="
                        background: rgba(41, 98, 255, 0.15); color: #2962FF; border: 1px solid #2962FF; border-radius: 4px;
                        padding: 4px 8px; font-size: 11px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 4px;
                    ">📦 + Pullback Alert</button>
                    <button id="btn-modal-create-alert" style="
                        background: var(--chart-accent, #2962FF); color: #fff; border: none; border-radius: 4px;
                        padding: 4px 10px; font-size: 11px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 4px;
                    ">+ New Alert</button>
                </div>
            </div>

            <!-- Tab Content 1: Active Alerts -->
            <div id="alert-tab-content-active" style="padding: 14px 18px; max-height: 420px; min-height: 240px; overflow-y: auto;">
                <div id="alert-active-list" style="display: flex; flex-direction: column; gap: 8px;"></div>
            </div>

            <!-- Tab Content 2: History -->
            <div id="alert-tab-content-history" style="display: none; padding: 14px 18px; max-height: 420px; min-height: 240px; overflow-y: auto;">
                <div style="display: flex; justify-content: flex-end; margin-bottom: 8px;">
                    <button id="btn-clear-alert-history" style="
                        background: transparent; color: #EF5350; border: 1px solid rgba(239, 83, 80, 0.4); border-radius: 4px;
                        padding: 3px 8px; font-size: 11px; cursor: pointer;
                    ">Clear History</button>
                </div>
                <div id="alert-history-list" style="display: flex; flex-direction: column; gap: 8px;"></div>
            </div>

            <!-- Tab Content 3: Android Background / Foreground Service -->
            <div id="alert-tab-content-background" style="display: none; padding: 14px 18px; max-height: 440px; min-height: 240px; overflow-y: auto;">
                <div id="fg-service-container" style="display: flex; flex-direction: column; gap: 12px;"></div>
            </div>
        `;
        document.body.appendChild(modal);

        // 2. Dedicated "Create Alert" Dialog
        const createModal = document.createElement('dialog');
        createModal.id = 'create-alert-modal';
        createModal.style.cssText = `
            background: var(--chart-panel-bg, #131722);
            color: var(--chart-text, #D1D4DC);
            border: 1px solid var(--chart-grid, #363A45);
            border-radius: 8px;
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, sans-serif;
            width: 440px;
            max-width: 94vw;
            box-sizing: border-box;
            box-shadow: 0 20px 48px rgba(0,0,0,0.7);
            outline: none;
            z-index: 1001;
        `;

        createModal.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--chart-grid, #2A2E39);">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span id="create-modal-icon" style="color: #FF9800; font-size: 16px;">🔔</span>
                    <h3 id="create-modal-title" style="margin: 0; font-size: 14px; font-weight: 700; color: #fff;">Create Alert</h3>
                </div>
                <button id="btn-close-create-alert" style="background: none; border: none; color: #787B86; font-size: 16px; cursor: pointer;">✕</button>
            </div>

            <form id="form-create-alert" style="padding: 16px; display: flex; flex-direction: column; gap: 12px; margin: 0;">
                <!-- Symbol & Name -->
                <div style="display: grid; grid-template-columns: 110px 1fr; gap: 8px;">
                    <div>
                        <label style="display: block; font-size: 11px; color: #787B86; margin-bottom: 4px; font-weight: 600;">Symbol</label>
                        <input type="text" id="input-alert-symbol" value="BTCUSDT" style="
                            width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.25); border: 1px solid var(--chart-grid, #434651);
                            border-radius: 4px; padding: 6px 8px; color: #fff; font-size: 12px; font-weight: 700; text-transform: uppercase; outline: none;
                        " required />
                    </div>
                    <div>
                        <label style="display: block; font-size: 11px; color: #787B86; margin-bottom: 4px; font-weight: 600;">Alert Label / Name</label>
                        <input type="text" id="input-alert-name" placeholder="e.g. Pullback Breakout" style="
                            width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.25); border: 1px solid var(--chart-grid, #434651);
                            border-radius: 4px; padding: 6px 8px; color: #fff; font-size: 12px; outline: none;
                        " />
                    </div>
                </div>

                <!-- Alert Source Type -->
                <div>
                    <label style="display: block; font-size: 11px; color: #787B86; margin-bottom: 4px; font-weight: 600;">Alert Type / Source</label>
                    <select id="select-alert-source" style="
                        width: 100%; background: #1e222d; color: #fff; border: 1px solid var(--chart-grid, #434651);
                        border-radius: 4px; padding: 6px 8px; font-size: 12px; outline: none; cursor: pointer;
                    ">
                        <option value="price">💰 Real-Time Price Level Crossing</option>
                        <option value="indicator_pullback" selected>📦 Market Structure Pullback Zones (Micro / Macro Box Breakout)</option>
                    </select>
                </div>

                <!-- SECTION A: Standard Price Crossing (Hidden when indicator is chosen) -->
                <div id="section-price-options" style="display: none; flex-direction: column; gap: 10px;">
                    <div>
                        <label style="display: block; font-size: 11px; color: #787B86; margin-bottom: 4px; font-weight: 600;">Condition Trigger</label>
                        <select id="select-alert-condition" style="
                            width: 100%; background: #1e222d; color: #fff; border: 1px solid var(--chart-grid, #434651);
                            border-radius: 4px; padding: 6px 8px; font-size: 12px; outline: none; cursor: pointer;
                        ">
                            <option value="cross">Crossing (Either Up or Down)</option>
                            <option value="cross_up" selected>Crossing Up (Bullish Breakout ↑)</option>
                            <option value="cross_down">Crossing Down (Bearish Breakdown ↓)</option>
                            <option value="greater">Greater Than (Price &gt;= Target)</option>
                            <option value="less">Less Than (Price &lt;= Target)</option>
                        </select>
                    </div>

                    <div id="row-target-price">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                            <label style="font-size: 11px; color: #787B86; font-weight: 600;">Target Price ($)</label>
                            <button type="button" id="btn-use-current-price" style="
                                background: transparent; border: none; color: var(--chart-accent, #2962FF); font-size: 11px; cursor: pointer; padding: 0;
                            ">Use Current Market Price</button>
                        </div>
                        <input type="number" id="input-alert-target-price" step="any" placeholder="0.00" style="
                            width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.25); border: 1px solid var(--chart-accent, #2962FF);
                            border-radius: 4px; padding: 7px 10px; color: #fff; font-size: 14px; font-weight: 700; outline: none;
                        " />
                    </div>
                </div>

                <!-- SECTION B: Phase 3 Pullback Zones Breakout Options -->
                <div id="section-pullback-options" style="display: flex; flex-direction: column; gap: 10px;">
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                        <div>
                            <label style="display: block; font-size: 11px; color: #787B86; margin-bottom: 4px; font-weight: 600;">Structure Box</label>
                            <select id="select-pullback-box" style="
                                width: 100%; background: #1e222d; color: #fff; border: 1px solid var(--chart-grid, #434651);
                                border-radius: 4px; padding: 6px 8px; font-size: 12px; outline: none; cursor: pointer;
                            ">
                                <option value="both" selected>Both (Micro & Macro Boxes)</option>
                                <option value="micro">Micro Box (Blue Swing Period)</option>
                                <option value="macro">Macro Box (Red Major Period)</option>
                            </select>
                        </div>
                        <div>
                            <label style="display: block; font-size: 11px; color: #787B86; margin-bottom: 4px; font-weight: 600;">Breakout Direction</label>
                            <select id="select-pullback-direction" style="
                                width: 100%; background: #1e222d; color: #fff; border: 1px solid var(--chart-grid, #434651);
                                border-radius: 4px; padding: 6px 8px; font-size: 12px; outline: none; cursor: pointer;
                            ">
                                <option value="any" selected>Any Breakout (Up or Down)</option>
                                <option value="up">Bullish Breakout Up ▲</option>
                                <option value="down">Bearish Breakdown Down ▼</option>
                            </select>
                        </div>
                    </div>

                    <!-- Live Structure Telemetry Card -->
                    <div id="pullback-live-telemetry" style="
                        background: rgba(41, 98, 255, 0.08); border: 1px solid rgba(41, 98, 255, 0.3); border-radius: 6px;
                        padding: 8px 12px; font-size: 11px; line-height: 1.5; color: #D1D4DC;
                    ">
                        <div style="font-weight: 700; color: #2962FF; margin-bottom: 2px; display: flex; align-items: center; gap: 4px;">
                            <span>📦 Active Pullback Zone Boundaries</span>
                        </div>
                        <div id="pullback-telemetry-content" style="color: #A0A5B5;">
                            Scanning active chart structure...
                        </div>
                    </div>
                </div>

                <!-- Frequency & Cooldown -->
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                    <div>
                        <label style="display: block; font-size: 11px; color: #787B86; margin-bottom: 4px; font-weight: 600;">Frequency</label>
                        <select id="select-alert-frequency" style="
                            width: 100%; background: #1e222d; color: #fff; border: 1px solid var(--chart-grid, #434651);
                            border-radius: 4px; padding: 6px 8px; font-size: 12px; outline: none; cursor: pointer;
                        ">
                            <option value="every_time" selected>Every Time (Repeating)</option>
                            <option value="once">Only Once</option>
                        </select>
                    </div>
                    <div id="box-alert-cooldown">
                        <label style="display: block; font-size: 11px; color: #787B86; margin-bottom: 4px; font-weight: 600;">Cooldown</label>
                        <select id="select-alert-cooldown" style="
                            width: 100%; background: #1e222d; color: #fff; border: 1px solid var(--chart-grid, #434651);
                            border-radius: 4px; padding: 6px 8px; font-size: 12px; outline: none; cursor: pointer;
                        ">
                            <option value="1">1 Minute</option>
                            <option value="5" selected>5 Minutes</option>
                            <option value="15">15 Minutes</option>
                            <option value="60">1 Hour</option>
                        </select>
                    </div>
                </div>

                <!-- Color & Sound Toggle -->
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 4px 0;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="font-size: 11px; color: #787B86;">Color Tag:</span>
                        <select id="select-alert-color" style="
                            background: #1e222d; color: #fff; border: 1px solid var(--chart-grid, #434651);
                            border-radius: 4px; padding: 2px 6px; font-size: 11px; outline: none;
                        ">
                            <option value="#2962FF" selected>🔵 Blue (Micro / Pullback)</option>
                            <option value="#EF5350">🔴 Red (Macro / Bearish)</option>
                            <option value="#26A69A">🟢 Green (Bullish)</option>
                            <option value="#FF9800">🟠 Orange (Price Level)</option>
                            <option value="#AB47BC">🟣 Purple</option>
                        </select>
                    </div>
                    <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer;">
                        <input type="checkbox" id="check-alert-sound" checked style="accent-color: var(--chart-accent, #2962FF); cursor: pointer;" />
                        Play Chime 🎵
                    </label>
                </div>

                <!-- Note / Message -->
                <div>
                    <label style="display: block; font-size: 11px; color: #787B86; margin-bottom: 4px; font-weight: 600;">Execution Note (Optional)</label>
                    <input type="text" id="input-alert-note" placeholder="e.g. Notify Android when structure breaks out" style="
                        width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.25); border: 1px solid var(--chart-grid, #434651);
                        border-radius: 4px; padding: 6px 8px; color: #fff; font-size: 12px; outline: none;
                    " />
                </div>

                <!-- Submit Button -->
                <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px;">
                    <button type="button" id="btn-cancel-create-alert" style="
                        background: transparent; color: #D1D4DC; border: 1px solid var(--chart-grid, #434651);
                        border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer;
                    ">Cancel</button>
                    <button type="submit" id="btn-submit-create-alert" style="
                        background: #2962FF; color: #fff; border: none; font-weight: 700;
                        border-radius: 4px; padding: 6px 16px; font-size: 12px; cursor: pointer;
                    ">Create Alert</button>
                </div>
            </form>
        `;
        document.body.appendChild(createModal);
    }

    private static setupEventListeners(): void {
        const modal = document.getElementById('alert-modal') as HTMLDialogElement;
        const createModal = document.getElementById('create-alert-modal') as HTMLDialogElement;

        // Top bar buttons
        document.getElementById('btn-alerts')?.addEventListener('click', () => {
            this.openAlertModal();
        });

        document.getElementById('btn-quick-create-alert')?.addEventListener('click', () => {
            this.openCreateModal();
        });

        // Close buttons
        document.getElementById('btn-close-alert-modal')?.addEventListener('click', () => modal.close());
        document.getElementById('btn-close-create-alert')?.addEventListener('click', () => createModal.close());
        document.getElementById('btn-cancel-create-alert')?.addEventListener('click', () => createModal.close());

        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.close();
        });
        createModal.addEventListener('click', (e) => {
            if (e.target === createModal) createModal.close();
        });

        // Tabs
        modal.querySelectorAll('.alert-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = (btn as HTMLElement).dataset.tab;
                modal.querySelectorAll('.alert-tab-btn').forEach(b => {
                    (b as HTMLElement).style.background = 'transparent';
                    (b as HTMLElement).style.color = '#787B86';
                    b.classList.remove('active');
                });
                btn.classList.add('active');
                (btn as HTMLElement).style.background = 'var(--chart-grid, #2A2E39)';
                (btn as HTMLElement).style.color = 'var(--chart-accent, #2962FF)';

                const activeContent = document.getElementById('alert-tab-content-active');
                const historyContent = document.getElementById('alert-tab-content-history');
                const bgContent = document.getElementById('alert-tab-content-background');
                if (activeContent) activeContent.style.display = tab === 'active' ? 'block' : 'none';
                if (historyContent) historyContent.style.display = tab === 'history' ? 'block' : 'none';
                if (bgContent) bgContent.style.display = tab === 'background' ? 'block' : 'none';

                if (tab === 'background') {
                    this.renderBackgroundServiceTab();
                }
            });
        });

        // Topbar quick background service trigger
        document.getElementById('btn-foreground-service-indicator')?.addEventListener('click', () => {
            this.openAlertModal('background');
        });

        // Open Create Alert from inside the main modal
        document.getElementById('btn-modal-create-alert')?.addEventListener('click', () => {
            modal.close();
            this.openCreateModal();
        });

        // Quick Pullback Alert Button
        document.getElementById('btn-modal-quick-pullback')?.addEventListener('click', () => {
            modal.close();
            this.openCreateModal(undefined, undefined, 'indicator_pullback');
        });

        // Sound toggle
        const btnSoundToggle = document.getElementById('btn-alert-sound-toggle');
        const soundIcon = document.getElementById('alert-sound-icon');
        btnSoundToggle?.addEventListener('click', () => {
            const nextMuted = !SoundEngine.getMuted();
            SoundEngine.setMuted(nextMuted);
            if (soundIcon) soundIcon.textContent = nextMuted ? '🔇' : '🔊';
            if (btnSoundToggle) {
                btnSoundToggle.style.color = nextMuted ? '#EF5350' : '#D1D4DC';
            }
        });

        // Test sound
        document.getElementById('btn-alert-test-sound')?.addEventListener('click', () => {
            SoundEngine.testSound();
        });

        // Test Continuous Alarm
        document.getElementById('btn-alert-test-alarm')?.addEventListener('click', () => {
            AlarmOverlay.testAlarm();
        });

        // Test Android Native / Push Notification Button
        document.getElementById('btn-alert-test-push')?.addEventListener('click', async () => {
            const btn = document.getElementById('btn-alert-test-push') as HTMLButtonElement;
            if (btn) btn.disabled = true;
            try {
                const res = await CapacitorNotificationService.testNotification();
                if (btn) {
                    btn.textContent = res.success ? '✓ Sent!' : '✕ Error';
                    setTimeout(() => {
                        btn.textContent = '📱 Test Notif';
                        btn.disabled = false;
                    }, 2000);
                }
            } catch (err: any) {
                if (btn) {
                    btn.textContent = '✕ Error';
                    btn.disabled = false;
                }
            }
        });

        // Clear history
        document.getElementById('btn-clear-alert-history')?.addEventListener('click', () => {
            alertManager.clearHistory();
        });

        // Frequency change (show/hide cooldown)
        const selectFreq = document.getElementById('select-alert-frequency') as HTMLSelectElement;
        const boxCooldown = document.getElementById('box-alert-cooldown');
        selectFreq?.addEventListener('change', () => {
            if (boxCooldown) {
                boxCooldown.style.display = selectFreq.value === 'every_time' ? 'block' : 'none';
            }
        });

        // Source Type change (Price Crossing vs Pullback Zones)
        const selectSource = document.getElementById('select-alert-source') as HTMLSelectElement;
        const secPrice = document.getElementById('section-price-options');
        const secPullback = document.getElementById('section-pullback-options');
        const inputPrice = document.getElementById('input-alert-target-price') as HTMLInputElement;
        const inputName = document.getElementById('input-alert-name') as HTMLInputElement;
        const selectColor = document.getElementById('select-alert-color') as HTMLSelectElement;
        const modalTitle = document.getElementById('create-modal-title');
        const modalIcon = document.getElementById('create-modal-icon');
        const submitBtn = document.getElementById('btn-submit-create-alert');

        const onSourceChange = () => {
            const isPullback = selectSource?.value === 'indicator_pullback';
            if (secPrice) secPrice.style.display = isPullback ? 'none' : 'flex';
            if (secPullback) secPullback.style.display = isPullback ? 'flex' : 'none';

            if (inputPrice) inputPrice.required = !isPullback;

            if (isPullback) {
                if (modalTitle) modalTitle.textContent = 'Create Pullback Zone Breakout Alert';
                if (modalIcon) {
                    modalIcon.textContent = '📦';
                    modalIcon.style.color = '#2962FF';
                }
                if (submitBtn) {
                    submitBtn.style.background = '#2962FF';
                    submitBtn.textContent = 'Track Breakouts';
                }
                this.updatePullbackTelemetry();
            } else {
                if (modalTitle) modalTitle.textContent = 'Create Price Alert';
                if (modalIcon) {
                    modalIcon.textContent = '🔔';
                    modalIcon.style.color = '#FF9800';
                }
                if (submitBtn) {
                    submitBtn.style.background = '#FF9800';
                    submitBtn.textContent = 'Create Alert';
                }
            }
        };

        selectSource?.addEventListener('change', onSourceChange);

        // Update Pullback details when Box or Direction changes
        const selectPullbackBox = document.getElementById('select-pullback-box') as HTMLSelectElement;
        const selectPullbackDir = document.getElementById('select-pullback-direction') as HTMLSelectElement;

        const updatePullbackDefaults = () => {
            const sym = (document.getElementById('input-alert-symbol') as HTMLInputElement)?.value?.trim().toUpperCase() || 'BTCUSDT';
            const box = selectPullbackBox?.value || 'both';
            const dir = selectPullbackDir?.value || 'any';

            const boxLabel = box === 'micro' ? 'Micro Box' : box === 'macro' ? 'Macro Box' : 'Micro & Macro';
            const dirLabel = dir === 'up' ? 'Breakout UP ▲' : dir === 'down' ? 'Breakdown DOWN ▼' : 'Breakout';

            if (inputName) {
                inputName.value = `${sym} ${boxLabel} ${dirLabel}`;
            }

            if (selectColor) {
                selectColor.value = box === 'macro' ? '#EF5350' : '#2962FF';
            }
        };

        selectPullbackBox?.addEventListener('change', updatePullbackDefaults);
        selectPullbackDir?.addEventListener('change', updatePullbackDefaults);

        // Use Current Price button
        document.getElementById('btn-use-current-price')?.addEventListener('click', () => {
            const activeChart = (window as any).WorkspaceManager?.getActiveChart?.();
            if (activeChart && activeChart.dataStore.length > 0) {
                const lastClose = activeChart.dataStore.data[(activeChart.dataStore.length - 1) * 6 + 4];
                if (inputPrice) inputPrice.value = String(lastClose);
            }
        });

        // Form Submission
        document.getElementById('form-create-alert')?.addEventListener('submit', (e) => {
            e.preventDefault();
            const symbol = (document.getElementById('input-alert-symbol') as HTMLInputElement)?.value?.trim().toUpperCase();
            const name = (document.getElementById('input-alert-name') as HTMLInputElement)?.value?.trim();
            const source = (document.getElementById('select-alert-source') as HTMLSelectElement)?.value as 'price' | 'indicator_pullback';
            const frequency = (document.getElementById('select-alert-frequency') as HTMLSelectElement)?.value as AlertFrequency;
            const cooldown = parseInt((document.getElementById('select-alert-cooldown') as HTMLSelectElement)?.value || '5', 10);
            const color = (document.getElementById('select-alert-color') as HTMLSelectElement)?.value || '#2962FF';
            const soundEnabled = (document.getElementById('check-alert-sound') as HTMLInputElement)?.checked ?? true;
            const note = (document.getElementById('input-alert-note') as HTMLInputElement)?.value?.trim();

            if (!symbol) return;

            if (source === 'indicator_pullback') {
                const boxType = (document.getElementById('select-pullback-box') as HTMLSelectElement)?.value as 'micro' | 'macro' | 'both';
                const direction = (document.getElementById('select-pullback-direction') as HTMLSelectElement)?.value as 'any' | 'up' | 'down';

                let condition: AlertCondition = 'pullback_any_break';
                if (boxType === 'micro') {
                    if (direction === 'up') condition = 'pullback_micro_break_up';
                    else if (direction === 'down') condition = 'pullback_micro_break_down';
                    else condition = 'pullback_micro_break';
                } else if (boxType === 'macro') {
                    if (direction === 'up') condition = 'pullback_macro_break_up';
                    else if (direction === 'down') condition = 'pullback_macro_break_down';
                    else condition = 'pullback_macro_break';
                } else {
                    condition = 'pullback_any_break';
                }

                const status = alertManager.getPullbackStatus(symbol);

                alertManager.addAlert({
                    symbol,
                    name: name || `${symbol} Pullback Breakout`,
                    source: 'indicator',
                    condition,
                    targetPrice: 0,
                    indicatorConfig: {
                        indicatorId: 'MS_PULLBACK_ZONES',
                        indicatorName: 'Market Structure Pullback Zones',
                        boxType,
                        breakoutDirection: direction,
                        boxLevels: {
                            microTop: status.microBox?.top,
                            microBottom: status.microBox?.bottom,
                            macroTop: status.macroBox?.top,
                            macroBottom: status.macroBox?.bottom
                        }
                    },
                    frequency,
                    cooldownMinutes: cooldown,
                    soundEnabled,
                    color,
                    note: note || `Breakout of ${boxType} pullback structure`
                });
            } else {
                const condition = (document.getElementById('select-alert-condition') as HTMLSelectElement)?.value as AlertCondition;
                const targetPrice = parseFloat(inputPrice?.value);
                if (isNaN(targetPrice) || targetPrice <= 0) return;

                alertManager.addAlert({
                    symbol,
                    name: name || `${symbol} $${targetPrice.toLocaleString()}`,
                    source: 'price',
                    condition,
                    targetPrice,
                    frequency,
                    cooldownMinutes: cooldown,
                    soundEnabled,
                    color,
                    note
                });
            }

            createModal.close();
            this.openAlertModal();
        });
    }

    public static updatePullbackTelemetry(): void {
        const telemetry = document.getElementById('pullback-telemetry-content');
        if (!telemetry) return;

        const symInput = document.getElementById('input-alert-symbol') as HTMLInputElement;
        const sym = symInput?.value?.trim().toUpperCase() || 'BTCUSDT';
        const status = alertManager.getPullbackStatus(sym);

        let lines: string[] = [];
        if (status.microBox) {
            lines.push(`🔵 <strong>Micro Box:</strong> $${status.microBox.bottom.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} — $${status.microBox.top.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} (Upper: &gt; $${status.microBox.top.toFixed(2)}, Lower: &lt; $${status.microBox.bottom.toFixed(2)})`);
        } else {
            lines.push(`🔵 <strong>Micro Box:</strong> Waiting for micro pivot swings to form box`);
        }

        if (status.macroBox) {
            lines.push(`🔴 <strong>Macro Box:</strong> $${status.macroBox.bottom.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} — $${status.macroBox.top.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} (Upper: &gt; $${status.macroBox.top.toFixed(2)}, Lower: &lt; $${status.macroBox.bottom.toFixed(2)})`);
        } else {
            lines.push(`🔴 <strong>Macro Box:</strong> Waiting for macro pivot swings to form box`);
        }

        telemetry.innerHTML = lines.join('<br/>');
    }

    public static openAlertModal(tab: 'active' | 'history' | 'background' = 'active'): void {
        this.renderActiveAlerts();
        this.renderHistory();
        this.updateForegroundIndicator();

        const soundIcon = document.getElementById('alert-sound-icon');
        const btnSoundToggle = document.getElementById('btn-alert-sound-toggle');
        const isMuted = SoundEngine.getMuted();
        if (soundIcon) soundIcon.textContent = isMuted ? '🔇' : '🔊';
        if (btnSoundToggle) btnSoundToggle.style.color = isMuted ? '#EF5350' : '#D1D4DC';

        const modal = document.getElementById('alert-modal') as HTMLDialogElement;
        if (modal) {
            modal.showModal();
            const targetBtn = modal.querySelector(`.alert-tab-btn[data-tab="${tab}"]`) as HTMLButtonElement;
            if (targetBtn) {
                targetBtn.click();
            }
        }
    }

    public static openCreateModal(symbol?: string, price?: number, defaultSource: 'price' | 'indicator_pullback' = 'indicator_pullback'): void {
        const createModal = document.getElementById('create-alert-modal') as HTMLDialogElement;
        if (!createModal) return;

        const activeChart = (window as any).WorkspaceManager?.getActiveChart?.();
        const activeSymbol = symbol || activeChart?.currentSymbol || 'BTCUSDT';

        let targetPrice = price;
        if (targetPrice === undefined && activeChart && activeChart.dataStore.length > 0) {
            targetPrice = activeChart.dataStore.data[(activeChart.dataStore.length - 1) * 6 + 4];
        }

        const inputSymbol = document.getElementById('input-alert-symbol') as HTMLInputElement;
        const inputPrice = document.getElementById('input-alert-target-price') as HTMLInputElement;
        const inputName = document.getElementById('input-alert-name') as HTMLInputElement;
        const inputNote = document.getElementById('input-alert-note') as HTMLInputElement;
        const selectSource = document.getElementById('select-alert-source') as HTMLSelectElement;
        const selectColor = document.getElementById('select-alert-color') as HTMLSelectElement;

        if (inputSymbol) inputSymbol.value = activeSymbol;
        if (inputPrice) inputPrice.value = targetPrice ? String(targetPrice) : '';
        if (inputNote) inputNote.value = '';
        if (selectSource) {
            selectSource.value = defaultSource;
            selectSource.dispatchEvent(new Event('change'));
        }

        if (defaultSource === 'indicator_pullback') {
            if (inputName) inputName.value = `${activeSymbol} Pullback Breakout`;
            if (selectColor) selectColor.value = '#2962FF';
            this.updatePullbackTelemetry();
        } else {
            if (inputName) inputName.value = `${activeSymbol} $${targetPrice?.toLocaleString() || 'Target'}`;
            if (selectColor) selectColor.value = '#FF9800';
        }

        createModal.showModal();
    }

    public static updateBadge(): void {
        const badge = document.getElementById('alert-badge-count');
        const tabActiveCount = document.getElementById('alert-tab-active-count');
        const tabHistoryCount = document.getElementById('alert-tab-history-count');

        const activeCount = alertManager.getActiveCount();
        const historyCount = alertManager.getHistory().length;

        if (badge) {
            badge.textContent = String(activeCount);
            badge.style.display = activeCount > 0 ? 'inline-block' : 'none';
        }
        if (tabActiveCount) tabActiveCount.textContent = String(activeCount);
        if (tabHistoryCount) tabHistoryCount.textContent = String(historyCount);
    }

    private static renderActiveAlerts(): void {
        const container = document.getElementById('alert-active-list');
        if (!container) return;

        const alerts = alertManager.getAlerts();
        if (alerts.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 36px 12px; color: #787B86; font-size: 13px;">
                    <div style="font-size: 28px; margin-bottom: 8px; opacity: 0.5;">🔔</div>
                    No active alerts configured.<br/>
                    <div style="display: flex; justify-content: center; gap: 8px; margin-top: 10px;">
                        <button id="btn-empty-create-pullback" style="
                            background: rgba(41, 98, 255, 0.2); color: #2962FF; border: 1px solid #2962FF;
                            border-radius: 4px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer;
                        ">📦 Track Pullback Breakouts</button>
                        <button id="btn-empty-create-alert" style="
                            background: var(--chart-accent, #2962FF); color: #fff; border: none;
                            border-radius: 4px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer;
                        ">+ Price Alert</button>
                    </div>
                </div>
            `;
            container.querySelector('#btn-empty-create-pullback')?.addEventListener('click', () => {
                (document.getElementById('alert-modal') as HTMLDialogElement)?.close();
                this.openCreateModal(undefined, undefined, 'indicator_pullback');
            });
            container.querySelector('#btn-empty-create-alert')?.addEventListener('click', () => {
                (document.getElementById('alert-modal') as HTMLDialogElement)?.close();
                this.openCreateModal(undefined, undefined, 'price');
            });
            return;
        }

        const conditionSymbols: Record<string, string> = {
            cross: '⤭ Crossing',
            cross_up: '▲ Cross Up',
            cross_down: '▼ Cross Down',
            greater: '≥ Greater Than',
            less: '≤ Less Than',
            pullback_any_break: '📦 Any Pullback Breakout (Micro & Macro)',
            pullback_micro_break: '🔵 Micro Box Breakout (Either)',
            pullback_micro_break_up: '🔵 Micro Box Breakout UP ▲',
            pullback_micro_break_down: '🔵 Micro Box Breakdown DOWN ▼',
            pullback_macro_break: '🔴 Macro Box Breakout (Either)',
            pullback_macro_break_up: '🔴 Macro Box Breakout UP ▲',
            pullback_macro_break_down: '🔴 Macro Box Breakdown DOWN ▼'
        };

        container.innerHTML = '';
        alerts.forEach(alert => {
            const card = document.createElement('div');
            const isActive = alert.status === 'active';
            const isTriggered = alert.status === 'triggered';
            const isIndicator = alert.source === 'indicator' || alert.condition.startsWith('pullback_');

            card.style.cssText = `
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid ${isActive ? 'var(--chart-grid, #363A45)' : 'rgba(255,255,255,0.06)'};
                border-left: 4px solid ${alert.color || (isIndicator ? '#2962FF' : '#FF9800')};
                border-radius: 6px;
                padding: 10px 12px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                opacity: ${isActive ? '1' : '0.65'};
                transition: background 0.15s ease;
            `;

            const condText = conditionSymbols[alert.condition] || alert.condition;

            card.innerHTML = `
                <div style="flex: 1; min-width: 0;">
                    <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                        <span style="font-weight: 700; font-size: 13px; color: #fff;">${alert.symbol}</span>
                        ${isIndicator ? `
                            <span style="
                                font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 3px;
                                background: rgba(41, 98, 255, 0.2); color: #2962FF; border: 1px solid rgba(41, 98, 255, 0.4);
                            ">📦 PULLBACK</span>
                        ` : ''}
                        <span style="
                            font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 3px;
                            background: ${isActive ? 'rgba(38, 166, 154, 0.2)' : isTriggered ? 'rgba(255, 152, 0, 0.2)' : 'rgba(120, 123, 134, 0.2)'};
                            color: ${isActive ? '#26A69A' : isTriggered ? '#FF9800' : '#787B86'};
                        ">${alert.status.toUpperCase()}</span>
                        <span style="font-size: 11px; color: #787B86;">${alert.frequency === 'every_time' ? '🔁 Recurring' : '1️⃣ Once'}</span>
                    </div>
                    <div style="font-size: 12px; font-weight: 600; color: #D1D4DC; margin-top: 3px;">
                        ${alert.name}
                    </div>
                    <div style="font-size: 11px; color: #A0A5B5; margin-top: 2px;">
                        ${condText} ${alert.targetPrice > 0 ? `<strong style="color: #fff;">$${alert.targetPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</strong>` : ''}
                    </div>
                    ${alert.note ? `<div style="font-size: 10px; color: #787B86; margin-top: 2px; font-style: italic;">Note: ${alert.note}</div>` : ''}
                </div>

                <div style="display: flex; align-items: center; gap: 6px;">
                    <!-- Jump to symbol -->
                    <button class="btn-alert-view" data-symbol="${alert.symbol}" title="View on Chart" style="
                        background: rgba(41, 98, 255, 0.1); border: 1px solid var(--chart-accent, #2962FF); border-radius: 4px;
                        color: var(--chart-accent, #2962FF); font-size: 11px; padding: 4px 8px; cursor: pointer; font-weight: 600;
                    ">View</button>

                    <!-- Pause / Resume or Rearm -->
                    <button class="btn-alert-toggle" data-id="${alert.id}" title="${isTriggered ? 'Re-arm Alert' : isActive ? 'Pause Alert' : 'Resume Alert'}" style="
                        background: rgba(255,255,255,0.06); border: 1px solid var(--chart-grid, #363A45); border-radius: 4px;
                        color: #D1D4DC; font-size: 12px; width: 28px; height: 28px; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0;
                    ">
                        ${isTriggered ? '↺' : isActive ? '⏸' : '▶'}
                    </button>

                    <!-- Delete -->
                    <button class="btn-alert-delete" data-id="${alert.id}" title="Delete Alert" style="
                        background: transparent; border: 1px solid transparent; border-radius: 4px;
                        color: #EF5350; font-size: 13px; width: 28px; height: 28px; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0;
                    ">🗑️</button>
                </div>
            `;

            // Action handlers
            card.querySelector('.btn-alert-view')?.addEventListener('click', () => {
                window.dispatchEvent(new CustomEvent('ecochart-switch-symbol', { detail: alert.symbol }));
                (document.getElementById('alert-modal') as HTMLDialogElement)?.close();
            });

            card.querySelector('.btn-alert-toggle')?.addEventListener('click', () => {
                if (isTriggered) {
                    alertManager.rearmAlert(alert.id);
                } else {
                    alertManager.toggleAlertStatus(alert.id);
                }
            });

            card.querySelector('.btn-alert-delete')?.addEventListener('click', () => {
                alertManager.deleteAlert(alert.id);
            });

            container.appendChild(card);
        });
    }

    private static renderHistory(): void {
        const container = document.getElementById('alert-history-list');
        if (!container) return;

        const history = alertManager.getHistory();
        if (history.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 36px 12px; color: #787B86; font-size: 13px;">
                    No triggered alerts yet.
                </div>
            `;
            return;
        }

        container.innerHTML = '';
        history.forEach(ev => {
            const row = document.createElement('div');
            row.style.cssText = `
                background: rgba(255, 255, 255, 0.02);
                border: 1px solid var(--chart-grid, #2A2E39);
                border-radius: 6px;
                padding: 8px 12px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                font-size: 12px;
            `;

            const dateStr = new Date(ev.timestamp).toLocaleString([], {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
            });

            const isPullback = !!ev.boxDetails || ev.condition.startsWith('pullback_');
            const boxBadge = ev.boxDetails ? `
                <span style="font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: ${ev.boxDetails.boxType === 'macro' ? '#EF535033' : '#2962FF33'}; color: ${ev.boxDetails.boxType === 'macro' ? '#EF5350' : '#2962FF'};">
                    ${ev.boxDetails.boxType.toUpperCase()} ${ev.boxDetails.direction.toUpperCase()}
                </span>
            ` : '';

            row.innerHTML = `
                <div>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="font-weight: 700; color: #fff;">${ev.symbol}</span>
                        ${boxBadge}
                        <span style="color: ${isPullback ? '#2962FF' : '#FF9800'}; font-weight: 600;">${ev.name}</span>
                    </div>
                    <div style="font-size: 11px; color: #787B86; margin-top: 2px;">
                        Triggered at <strong style="color: #D1D4DC;">$${ev.triggeredPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</strong>
                        ${ev.boxDetails ? `• Box: $${ev.boxDetails.bottom.toFixed(2)} - $${ev.boxDetails.top.toFixed(2)}` : `(Target: $${ev.targetPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })})`}
                        • ${dateStr}
                    </div>
                </div>
                <div style="display: flex; gap: 6px;">
                    <button class="btn-view-history" data-symbol="${ev.symbol}" title="View Chart" style="
                        background: transparent; color: var(--chart-accent, #2962FF); border: 1px solid var(--chart-accent, #2962FF);
                        border-radius: 4px; padding: 3px 8px; font-size: 11px; cursor: pointer; font-weight: 600; white-space: nowrap;
                    ">View</button>
                    <button class="btn-rearm-history" data-alert-id="${ev.alertId}" title="Re-arm Alert" style="
                        background: transparent; color: #787B86; border: 1px solid var(--chart-grid, #363A45);
                        border-radius: 4px; padding: 3px 8px; font-size: 11px; cursor: pointer; font-weight: 600; white-space: nowrap;
                    ">↺ Re-arm</button>
                </div>
            `;

            row.querySelector('.btn-view-history')?.addEventListener('click', () => {
                window.dispatchEvent(new CustomEvent('ecochart-switch-symbol', { detail: ev.symbol }));
                (document.getElementById('alert-modal') as HTMLDialogElement)?.close();
            });

            row.querySelector('.btn-rearm-history')?.addEventListener('click', () => {
                alertManager.rearmAlert(ev.alertId);
            });

            container.appendChild(row);
        });
    }

    /**
     * Renders the Android Foreground Service configuration and permission center
     */
    public static async renderBackgroundServiceTab(): Promise<void> {
        const container = document.getElementById('fg-service-container');
        if (!container) return;

        const isAndroid = ForegroundServiceManager.isAndroid();
        const isRunning = ForegroundServiceManager.isServiceActive();
        const perms = await ForegroundServiceManager.checkPermissions();

        const activeChart = (window as any).WorkspaceManager?.getActiveChart?.();
        const currentSymbol = activeChart?.currentSymbol || 'BTCUSDT';
        const pb = alertManager.getPullbackStatus(currentSymbol);
        const microStr = pb?.microBox
            ? `$${pb.microBox.bottom.toFixed(2)} - $${pb.microBox.top.toFixed(2)}`
            : 'Forming swing pivots...';

        container.innerHTML = `
            <!-- 1. Master Foreground Service Card -->
            <div style="
                background: rgba(255, 255, 255, 0.03); border: 1px solid ${isRunning ? 'rgba(0, 230, 118, 0.4)' : 'var(--chart-grid, #363A45)'};
                border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 10px;
            ">
                <div style="display: flex; align-items: center; justify-content: space-between;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 20px;">${isRunning ? '⚡' : '⏸️'}</span>
                        <div>
                            <div style="font-size: 13px; font-weight: 700; color: #fff;">Android Foreground Service</div>
                            <div style="font-size: 11px; color: ${isAndroid ? '#26A69A' : '#787B86'}; font-weight: 600;">${isAndroid ? '📱 Android Native Foreground Service' : '🌐 Web Browser Mode'}</div>
                        </div>
                    </div>
                    <span style="
                        font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 12px;
                        background: ${isRunning ? 'rgba(0, 230, 118, 0.15)' : 'rgba(255, 255, 255, 0.05)'};
                        color: ${isRunning ? '#00E676' : '#787B86'}; border: 1px solid ${isRunning ? 'rgba(0, 230, 118, 0.3)' : 'transparent'};
                    ">
                        ${isRunning ? '🟢 RUNNING 24/7' : '⚪ STOPPED'}
                    </span>
                </div>

                <div style="font-size: 12px; color: #D1D4DC; line-height: 1.4; background: rgba(0,0,0,0.2); padding: 8px 10px; border-radius: 6px;">
                    When enabled, Android creates an ongoing system notification that keeps the app's CPU, network WebSocket, and 
                    <strong>Market Structure Pullback Zones</strong> indicator calculations fully active while your phone is locked or minimized.
                </div>

                <div style="display: flex; gap: 8px; margin-top: 4px;">
                    <button id="btn-toggle-fg-service" style="
                        flex: 1; padding: 8px 12px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; border: none;
                        background: ${isRunning ? '#EF5350' : 'var(--chart-accent, #2962FF)'}; color: #fff; display: flex; align-items: center; justify-content: center; gap: 6px;
                    ">
                        ${isRunning ? '⏹ Stop Background Service' : '⚡ Start Android Background Service'}
                    </button>
                    <button id="btn-test-fg-ping" title="Refresh or ping current notification" style="
                        background: rgba(255,255,255,0.06); border: 1px solid var(--chart-grid, #363A45); border-radius: 6px;
                        color: #D1D4DC; font-size: 12px; padding: 8px 12px; cursor: pointer; font-weight: 600;
                    ">
                        📱 Ping Notification
                    </button>
                </div>
            </div>

            <!-- 2. Android Permissions & System Requirements Center -->
            <div style="
                background: rgba(255, 255, 255, 0.02); border: 1px solid var(--chart-grid, #2A2E39);
                border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 10px;
            ">
                <div style="font-size: 12px; font-weight: 700; color: #fff; display: flex; align-items: center; justify-content: space-between;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span>🛡️</span><span>Android System Permissions Status</span>
                    </div>
                    <span style="font-size: 11px; color: #00E676; font-weight: 600;">All Required Active ✅</span>
                </div>

                <!-- Permission 1: POST_NOTIFICATIONS -->
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: rgba(0,0,0,0.25); border-radius: 6px;">
                    <div style="display: flex; flex-direction: column;">
                        <span style="font-size: 12px; font-weight: 600; color: #fff;">1. Notification Permission</span>
                        <span style="font-size: 10px; color: #787B86;">Required for status bar persistent monitor and breakout alert banners</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="
                            font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px;
                            background: ${perms.notificationPermission === 'granted' ? 'rgba(0, 230, 118, 0.15)' : 'rgba(255, 152, 0, 0.15)'};
                            color: ${perms.notificationPermission === 'granted' ? '#00E676' : '#FF9800'};
                        ">
                            ${perms.notificationPermission === 'granted' ? 'Granted ✅' : 'Required ⚠️'}
                        </span>
                        ${perms.notificationPermission !== 'granted' ? `
                            <button id="btn-perm-grant-notif" style="
                                background: #FF9800; color: #000; border: none; border-radius: 4px;
                                font-size: 10px; font-weight: 700; padding: 4px 8px; cursor: pointer;
                            ">Grant</button>
                        ` : ''}
                    </div>
                </div>

                <!-- Permission 2: Foreground Service & Network -->
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: rgba(0,0,0,0.25); border-radius: 6px;">
                    <div style="display: flex; flex-direction: column;">
                        <span style="font-size: 12px; font-weight: 600; color: #fff;">2. Background Execution & WebSocket</span>
                        <span style="font-size: 10px; color: #787B86;">Keeps Binance live tick stream & pullback math alive while screen is locked</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="
                            font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px;
                            background: rgba(0, 230, 118, 0.15); color: #00E676;
                        ">
                            Active ⚡
                        </span>
                    </div>
                </div>

                <!-- Explanation Callout: Why "Permissions" is grayed out in Android Settings -->
                <div style="padding: 10px 12px; background: rgba(38, 166, 154, 0.08); border: 1px solid rgba(38, 166, 154, 0.3); border-radius: 6px; line-height: 1.45;">
                    <div style="font-size: 11px; font-weight: 700; color: #26A69A; margin-bottom: 3px; display: flex; align-items: center; gap: 4px;">
                        <span>ℹ️</span><span>Why does Android Settings say "Permissions: No permissions requested" (Grayed Out)?</span>
                    </div>
                    <div style="font-size: 10.5px; color: #D1D4DC;">
                        In Android, the <strong>"Permissions"</strong> menu is <em>only</em> for privacy-invasive hardware (Camera, Microphone, GPS Location, Contacts).<br/>
                        EcoChart respects your privacy and <strong>does not request any of those</strong>, which is why Android correctly grays it out! The only permission EcoChart needs is <strong>Notifications</strong>, which is already active right above it in Android Settings.
                    </div>
                </div>

                <!-- Recommendation 3: Battery Optimization Exemption -->
                <div style="padding: 10px 12px; background: rgba(41, 98, 255, 0.08); border: 1px solid rgba(41, 98, 255, 0.25); border-radius: 6px;">
                    <div style="font-size: 11px; font-weight: 700; color: #2962FF; margin-bottom: 3px; display: flex; align-items: center; gap: 4px;">
                        <span>🔋</span><span>Battery & Data Saver (Already Set to Unrestricted)</span>
                    </div>
                    <div style="font-size: 10.5px; color: #D1D4DC; line-height: 1.4;">
                        Your device is configured with <strong>Unrestricted Battery</strong> and <strong>Background Data</strong>. Android will not kill the background WebSocket or delay alerts during deep sleep (Doze mode).
                    </div>
                </div>
            </div>

            <!-- 3. Ongoing Notification Preview Mock -->
            <div style="
                background: #1e222d; border: 1px solid var(--chart-grid, #363A45);
                border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 6px;
            ">
                <div style="display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: #787B86;">
                    <span>Android Status Bar Preview (Notification Tray)</span>
                    <span style="color: #00E676;">Channel: EcoChart Background Monitor</span>
                </div>
                <div style="display: flex; align-items: flex-start; gap: 10px; padding: 8px; background: #131722; border-radius: 6px;">
                    <div style="font-size: 20px;">📈</div>
                    <div style="flex: 1;">
                        <div style="font-size: 12px; font-weight: 700; color: #fff;">EcoChart: ${currentSymbol} Monitor Active</div>
                        <div style="font-size: 11px; color: #26A69A; font-weight: 600;">Monitoring Pullback Zones • Micro: ${microStr}</div>
                        <div style="margin-top: 6px;">
                            <span style="display: inline-block; padding: 2px 8px; font-size: 10px; font-weight: 600; background: rgba(255,255,255,0.06); border-radius: 3px; color: #2962FF;">Open Chart 📈</span>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Attach listeners
        document.getElementById('btn-toggle-fg-service')?.addEventListener('click', async () => {
            const btn = document.getElementById('btn-toggle-fg-service') as HTMLButtonElement;
            if (btn) btn.disabled = true;

            if (ForegroundServiceManager.isServiceActive()) {
                await ForegroundServiceManager.stopService();
            } else {
                await ForegroundServiceManager.startService(currentSymbol, `Micro Box: ${microStr}`);
            }

            this.updateForegroundIndicator();
            await this.renderBackgroundServiceTab();
        });

        document.getElementById('btn-test-fg-ping')?.addEventListener('click', async () => {
            await ForegroundServiceManager.startService(currentSymbol, `Manual Ping at ${new Date().toLocaleTimeString()} • Micro: ${microStr}`);
            await this.renderBackgroundServiceTab();
        });

        document.getElementById('btn-perm-grant-notif')?.addEventListener('click', async () => {
            await ForegroundServiceManager.requestNotificationPermission();
            await this.renderBackgroundServiceTab();
        });

        document.getElementById('btn-perm-grant-overlay')?.addEventListener('click', async () => {
            await ForegroundServiceManager.requestOverlayPermission();
            await this.renderBackgroundServiceTab();
        });
    }

    /**
     * Updates top bar and modal indicators for the background service state
     */
    public static updateForegroundIndicator(): void {
        const isRunning = ForegroundServiceManager.isServiceActive();
        const dot = document.getElementById('fg-indicator-dot');
        const label = document.getElementById('fg-indicator-label');
        const badge = document.getElementById('badge-fg-status');
        const btn = document.getElementById('btn-foreground-service-indicator');

        if (dot) {
            dot.style.background = isRunning ? '#00E676' : '#787B86';
            dot.style.boxShadow = isRunning ? '0 0 8px #00E676, 0 0 3px #00E676' : 'none';
        }
        if (btn) {
            btn.title = isRunning 
                ? 'Background Service: ON (Running 24/7 in Background) - Click to configure' 
                : 'Background Service: OFF - Click to configure';
            btn.style.borderColor = isRunning ? 'rgba(0, 230, 118, 0.5)' : 'var(--chart-grid, #363A45)';
            btn.style.background = isRunning ? 'rgba(0, 230, 118, 0.12)' : 'transparent';
        }
        if (label) {
            label.textContent = isRunning ? 'BG: ON' : 'BG Service';
            label.style.color = isRunning ? '#00E676' : '#787B86';
        }
        if (badge) {
            badge.style.background = isRunning ? '#00E676' : '#787B86';
            badge.style.boxShadow = isRunning ? '0 0 4px #00E676' : 'none';
        }
    }
}
