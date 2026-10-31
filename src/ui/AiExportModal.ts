import { AiExportService, type AiExportConfig, type ExportProgress } from '../data/AiExportService';
import type { DataStore } from '../data/DataStore';

export class AiExportModal {
    private static dialog: HTMLDialogElement | null = null;
    private static isRunning = false;

    public static open(symbol: string, interval: string, dataStore: DataStore): void {
        this.ensureDialog(symbol, interval, dataStore);
        if (this.dialog && !this.dialog.open) {
            this.dialog.showModal();
        }
    }

    public static close(): void {
        if (this.dialog && this.dialog.open) {
            this.dialog.close();
        }
    }

    private static ensureDialog(symbol: string, interval: string, dataStore: DataStore): void {
        if (!this.dialog) {
            this.dialog = document.createElement('dialog');
            this.dialog.id = 'ai-export-modal';
            this.dialog.style.cssText = `
                border: 1px solid var(--chart-grid, #363A45);
                border-radius: 8px;
                background: var(--chart-panel-bg, #181c27);
                color: var(--chart-text, #D1D4DC);
                padding: 0;
                width: 540px;
                max-width: 94vw;
                box-shadow: 0 16px 40px rgba(0, 0, 0, 0.65);
                outline: none;
                z-index: 1000;
            `;

            // Close when clicking on backdrop
            this.dialog.addEventListener('click', (e) => {
                const rect = this.dialog!.getBoundingClientRect();
                const isInDialog = (
                    rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
                    rect.left <= e.clientX && e.clientX <= rect.left + rect.width
                );
                if (!isInDialog && !this.isRunning) {
                    this.dialog!.close();
                }
            });

            document.body.appendChild(this.dialog);
        }

        // Render contents with fresh symbol and interval
        this.render(symbol, interval, dataStore);
    }

    private static render(symbol: string, interval: string, dataStore: DataStore): void {
        if (!this.dialog) return;

        let selectedRangeDays = 30; // Default 1 Month
        let selectedPackageMode: 'single_csv' | 'daily_zip' = 'single_csv';
        let selectedRR = 2.0;
        let selectedHorizon = 30;

        const now = new Date();
        const defaultEndDate = now.toISOString().split('T')[0];
        const defaultStartDate = new Date(now.getTime() - 30 * 86400000).toISOString().split('T')[0];

        this.dialog.innerHTML = `
            <div style="display: flex; flex-direction: column; width: 100%;">
                <!-- Header -->
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--chart-grid, #2A2E39);">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 18px;">🧠</span>
                        <div>
                            <div style="font-weight: 700; font-size: 14px; color: var(--chart-text, #F0F3FA); letter-spacing: -0.01em;">
                                Export AI Training Data (.csv)
                            </div>
                            <div style="font-size: 11px; color: #787B86; margin-top: 1px;">
                                ${symbol} · ${interval} · Ground truth signal outcomes & range detection
                            </div>
                        </div>
                    </div>
                    <button id="btn-close-ai-export" type="button" style="background: transparent; border: none; color: #787B86; font-size: 18px; cursor: pointer; padding: 4px; line-height: 1; border-radius: 4px;">✕</button>
                </div>

                <!-- Body -->
                <div style="padding: 18px; display: flex; flex-direction: column; gap: 16px; font-size: 12px;">
                    
                    <!-- 1. Range Selection -->
                    <div>
                        <div style="font-weight: 600; color: #9AA0A6; margin-bottom: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">
                            Historical Range
                        </div>
                        <div id="ai-range-presets" style="display: flex; gap: 6px; background: rgba(0,0,0,0.25); padding: 3px; border-radius: 6px; border: 1px solid var(--chart-grid, #2A2E39);">
                            <button type="button" data-days="7" class="ai-range-btn" style="flex: 1; background: transparent; border: none; color: #787B86; padding: 6px 0; font-size: 12px; font-weight: 600; border-radius: 4px; cursor: pointer;">1 Week</button>
                            <button type="button" data-days="14" class="ai-range-btn" style="flex: 1; background: transparent; border: none; color: #787B86; padding: 6px 0; font-size: 12px; font-weight: 600; border-radius: 4px; cursor: pointer;">2 Weeks</button>
                            <button type="button" data-days="30" class="ai-range-btn active" style="flex: 1; background: var(--chart-grid, #2A2E39); border: none; color: var(--chart-accent, #2962FF); padding: 6px 0; font-size: 12px; font-weight: 600; border-radius: 4px; cursor: pointer;">1 Month</button>
                            <button type="button" data-days="90" class="ai-range-btn" style="flex: 1; background: transparent; border: none; color: #787B86; padding: 6px 0; font-size: 12px; font-weight: 600; border-radius: 4px; cursor: pointer;">3 Months</button>
                            <button type="button" data-days="custom" class="ai-range-btn" style="flex: 1; background: transparent; border: none; color: #787B86; padding: 6px 0; font-size: 12px; font-weight: 600; border-radius: 4px; cursor: pointer;">Custom</button>
                        </div>

                        <!-- Custom Date Pickers (Conditional) -->
                        <div id="ai-custom-dates" style="display: none; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px;">
                            <div>
                                <label style="display: block; font-size: 10px; color: #787B86; margin-bottom: 2px;">START DATE</label>
                                <input type="date" id="ai-start-date" value="${defaultStartDate}" style="width: 100%; box-sizing: border-box; background: var(--chart-bg, #131722); color: var(--chart-text, #D1D4DC); border: 1px solid var(--chart-grid, #363A45); border-radius: 4px; padding: 5px 8px; font-size: 12px;" />
                            </div>
                            <div>
                                <label style="display: block; font-size: 10px; color: #787B86; margin-bottom: 2px;">END DATE</label>
                                <input type="date" id="ai-end-date" value="${defaultEndDate}" style="width: 100%; box-sizing: border-box; background: var(--chart-bg, #131722); color: var(--chart-text, #D1D4DC); border: 1px solid var(--chart-grid, #363A45); border-radius: 4px; padding: 5px 8px; font-size: 12px;" />
                            </div>
                        </div>
                    </div>

                    <!-- 2. Packaging Format (Single CSV vs. Daily ZIP) -->
                    <div>
                        <div style="font-weight: 600; color: #9AA0A6; margin-bottom: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">
                            Packaging Format
                        </div>
                        <div id="ai-pkg-presets" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                            <button type="button" data-mode="single_csv" class="ai-pkg-btn active" style="background: rgba(41, 98, 255, 0.12); border: 1.5px solid var(--chart-accent, #2962FF); color: var(--chart-text, #F0F3FA); padding: 8px 12px; border-radius: 6px; cursor: pointer; text-align: left;">
                                <div style="font-weight: 700; font-size: 12px;">📄 Single Consolidated CSV</div>
                                <div style="font-size: 10px; color: #787B86; margin-top: 2px;">One continuous chronological dataset</div>
                            </button>
                            <button type="button" data-mode="daily_zip" class="ai-pkg-btn" style="background: rgba(0,0,0,0.25); border: 1.5px solid var(--chart-grid, #2A2E39); color: var(--chart-text, #787B86); padding: 8px 12px; border-radius: 6px; cursor: pointer; text-align: left;">
                                <div style="font-weight: 700; font-size: 12px;">📦 Daily Partitioned ZIP</div>
                                <div style="font-size: 10px; color: #787B86; margin-top: 2px;">One CSV per calendar day in a .zip</div>
                            </button>
                        </div>
                    </div>

                    <!-- 3. Target Risk-to-Reward & Outcome Horizon -->
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                        <div>
                            <label style="display: block; font-size: 11px; font-weight: 600; color: #9AA0A6; margin-bottom: 4px;">TARGET REWARD : RISK</label>
                            <select id="ai-target-rr" style="width: 100%; background: var(--chart-bg, #131722); color: var(--chart-text, #D1D4DC); border: 1px solid var(--chart-grid, #363A45); border-radius: 4px; padding: 6px 8px; font-size: 12px;">
                                <option value="1.5">1.5 : 1 (Conservative)</option>
                                <option value="2.0" selected>2.0 : 1 (Recommended)</option>
                                <option value="2.5">2.5 : 1 (Aggressive)</option>
                                <option value="3.0">3.0 : 1 (High R:R)</option>
                            </select>
                        </div>
                        <div>
                            <label style="display: block; font-size: 11px; font-weight: 600; color: #9AA0A6; margin-bottom: 4px;">FORWARD HORIZON (BARS)</label>
                            <input type="number" id="ai-horizon-bars" value="30" min="5" max="200" step="5" style="width: 100%; box-sizing: border-box; background: var(--chart-bg, #131722); color: var(--chart-text, #D1D4DC); border: 1px solid var(--chart-grid, #363A45); border-radius: 4px; padding: 6px 8px; font-size: 12px;" />
                        </div>
                    </div>

                    <!-- 4. Feature Schema Details Box -->
                    <div style="background: rgba(0, 0, 0, 0.2); border: 1px solid var(--chart-grid, #2A2E39); border-radius: 6px; padding: 10px 12px;">
                        <div style="font-weight: 600; font-size: 11px; color: var(--chart-text, #D1D4DC); margin-bottom: 4px;">
                            Included Indicator & Signal Columns:
                        </div>
                        <div style="font-size: 10.5px; color: #787B86; line-height: 1.5;">
                            • <b style="color: #00E5FF;">EMA 10 / SMA 30</b>: Values, spread difference, and cross events (+1/-1)<br/>
                            • <b style="color: #EF5350;">Market Structure Pullback Zones</b>: In-zone status, zone ceiling & floor<br/>
                            • <b style="color: #26A69A;">Strict CBC Pullback Zones</b>: Trend (+1/-1), Flip triggers, Anchor high/low<br/>
                            • <b style="color: #FF9800;">Range & Chop Detection</b>: 10-bar signal cluster density counter<br/>
                            • <b style="color: #F0F3FA;">Forward Outcomes</b>: Target hit (1 = Win), Stop hit (0 = Loss), Drawdown %
                        </div>
                    </div>

                    <!-- 5. Live Progress Bar (Hidden initially) -->
                    <div id="ai-progress-container" style="display: none; flex-direction: column; gap: 6px;">
                        <div style="display: flex; justify-content: space-between; font-size: 11px;">
                            <span id="ai-progress-status" style="color: var(--chart-accent, #2962FF);">Initializing export...</span>
                            <span id="ai-progress-pct" style="font-weight: 700; color: var(--chart-text, #F0F3FA);">0%</span>
                        </div>
                        <div style="width: 100%; height: 6px; background: rgba(0,0,0,0.4); border-radius: 3px; overflow: hidden; border: 1px solid var(--chart-grid, #2A2E39);">
                            <div id="ai-progress-bar" style="width: 0%; height: 100%; background: var(--chart-accent, #2962FF); transition: width 0.2s ease;"></div>
                        </div>
                        <div id="ai-progress-stats" style="font-size: 10.5px; color: #26A69A; display: none; margin-top: 2px;"></div>
                    </div>

                </div>

                <!-- Footer Actions -->
                <div style="display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--chart-grid, #2A2E39); background: var(--chart-bg, #131722);">
                    <button id="btn-cancel-ai-export" type="button" style="background: transparent; border: 1px solid var(--chart-grid, #363A45); color: var(--chart-text, #D1D4DC); padding: 7px 14px; font-size: 12px; font-weight: 600; border-radius: 4px; cursor: pointer;">
                        Cancel
                    </button>
                    <button id="btn-execute-ai-export" type="button" style="background: var(--chart-accent, #2962FF); border: none; color: #fff; padding: 7px 18px; font-size: 12px; font-weight: 700; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 6px; box-shadow: 0 2px 8px rgba(41, 98, 255, 0.35);">
                        <span>Download CSV Dataset</span>
                    </button>
                </div>
            </div>
        `;

        // Wire Up Event Handlers
        const btnClose = this.dialog.querySelector('#btn-close-ai-export');
        const btnCancel = this.dialog.querySelector('#btn-cancel-ai-export');
        const btnExecute = this.dialog.querySelector('#btn-execute-ai-export') as HTMLButtonElement;
        const customDateBox = this.dialog.querySelector('#ai-custom-dates') as HTMLElement;
        const progressContainer = this.dialog.querySelector('#ai-progress-container') as HTMLElement;
        const progressBar = this.dialog.querySelector('#ai-progress-bar') as HTMLElement;
        const progressStatus = this.dialog.querySelector('#ai-progress-status') as HTMLElement;
        const progressPct = this.dialog.querySelector('#ai-progress-pct') as HTMLElement;
        const progressStats = this.dialog.querySelector('#ai-progress-stats') as HTMLElement;

        btnClose?.addEventListener('click', () => this.close());
        btnCancel?.addEventListener('click', () => this.close());

        // Range Presets
        const rangeBtns = this.dialog.querySelectorAll('.ai-range-btn');
        rangeBtns.forEach((btn) => {
            btn.addEventListener('click', () => {
                rangeBtns.forEach((b) => {
                    (b as HTMLElement).style.background = 'transparent';
                    (b as HTMLElement).style.color = '#787B86';
                    b.classList.remove('active');
                });
                btn.classList.add('active');
                (btn as HTMLElement).style.background = 'var(--chart-grid, #2A2E39)';
                (btn as HTMLElement).style.color = 'var(--chart-accent, #2962FF)';

                const daysVal = (btn as HTMLElement).dataset.days;
                if (daysVal === 'custom') {
                    customDateBox.style.display = 'grid';
                    selectedRangeDays = -1;
                } else {
                    customDateBox.style.display = 'none';
                    selectedRangeDays = parseInt(daysVal || '30', 10);
                }
            });
        });

        // Package Mode Presets
        const pkgBtns = this.dialog.querySelectorAll('.ai-pkg-btn');
        pkgBtns.forEach((btn) => {
            btn.addEventListener('click', () => {
                pkgBtns.forEach((b) => {
                    (b as HTMLElement).style.background = 'rgba(0,0,0,0.25)';
                    (b as HTMLElement).style.borderColor = 'var(--chart-grid, #2A2E39)';
                    (b as HTMLElement).style.color = 'var(--chart-text, #787B86)';
                    b.classList.remove('active');
                });
                btn.classList.add('active');
                (btn as HTMLElement).style.background = 'rgba(41, 98, 255, 0.12)';
                (btn as HTMLElement).style.borderColor = 'var(--chart-accent, #2962FF)';
                (btn as HTMLElement).style.color = 'var(--chart-text, #F0F3FA)';

                selectedPackageMode = ((btn as HTMLElement).dataset.mode as any) || 'single_csv';
                if (btnExecute) {
                    btnExecute.innerHTML = selectedPackageMode === 'single_csv'
                        ? '<span>Download CSV Dataset</span>'
                        : '<span>Download Daily ZIP Archive</span>';
                }
            });
        });

        // Target RR
        const selectRR = this.dialog.querySelector('#ai-target-rr') as HTMLSelectElement;
        selectRR?.addEventListener('change', () => {
            selectedRR = parseFloat(selectRR.value);
        });

        // Horizon Bars
        const inputHorizon = this.dialog.querySelector('#ai-horizon-bars') as HTMLInputElement;
        inputHorizon?.addEventListener('change', () => {
            selectedHorizon = parseInt(inputHorizon.value, 10) || 30;
        });

        // Execution Handler
        btnExecute?.addEventListener('click', async () => {
            if (this.isRunning) return;
            this.isRunning = true;

            btnExecute.disabled = true;
            btnExecute.style.opacity = '0.6';
            btnExecute.textContent = 'Processing...';

            progressContainer.style.display = 'flex';
            progressBar.style.width = '0%';
            progressPct.textContent = '0%';
            progressStatus.textContent = 'Preparing export...';
            progressStats.style.display = 'none';

            let customStart: number | undefined;
            let customEnd: number | undefined;

            if (selectedRangeDays === -1) {
                const sDate = (this.dialog!.querySelector('#ai-start-date') as HTMLInputElement).value;
                const eDate = (this.dialog!.querySelector('#ai-end-date') as HTMLInputElement).value;
                if (sDate) customStart = new Date(sDate).getTime();
                if (eDate) customEnd = new Date(eDate).getTime() + 86399999;
            }

            const config: AiExportConfig = {
                symbol,
                interval,
                rangeDays: selectedRangeDays > 0 ? selectedRangeDays : 30,
                customStartTime: customStart,
                customEndTime: customEnd,
                packageMode: selectedPackageMode,
                targetRR: selectedRR,
                horizonBars: selectedHorizon,
                includeAllCandles: true
            };

            try {
                const result = await AiExportService.runExport(config, dataStore, (p: ExportProgress) => {
                    progressBar.style.width = `${p.percent}%`;
                    progressPct.textContent = `${p.percent}%`;
                    progressStatus.textContent = p.message;

                    if (p.signalCount !== undefined && p.positiveCount !== undefined && p.negativeCount !== undefined) {
                        const winRate = (p.positiveCount + p.negativeCount) > 0
                            ? Math.round((p.positiveCount / (p.positiveCount + p.negativeCount)) * 1000) / 10
                            : 0;
                        progressStats.style.display = 'block';
                        progressStats.innerHTML = `Signals Evaluated: <b>${p.signalCount}</b> · Wins: <b style="color:#26A69A;">${p.positiveCount}</b> · Losses: <b style="color:#EF5350;">${p.negativeCount}</b> · Historical Win Rate: <b>${winRate}%</b>`;
                    }
                });

                progressStatus.textContent = `Export complete! ${result.rowCount.toLocaleString()} bars exported (${result.winRatePct}% win rate). Download triggered.`;
                progressStatus.style.color = 'var(--chart-bull, #26A69A)';
                btnExecute.textContent = 'Export Complete ✓';
                btnExecute.style.background = '#26A69A';

                setTimeout(() => {
                    this.isRunning = false;
                    btnExecute.disabled = false;
                    btnExecute.style.opacity = '1';
                    btnExecute.style.background = 'var(--chart-accent, #2962FF)';
                    btnExecute.innerHTML = selectedPackageMode === 'single_csv'
                        ? '<span>Download CSV Dataset</span>'
                        : '<span>Download Daily ZIP Archive</span>';
                }, 3000);
            } catch (err: any) {
                console.error('[AiExportModal] Export failed:', err);
                progressStatus.textContent = `Error: ${err?.message || 'Export failed'}`;
                progressStatus.style.color = '#EF5350';
                this.isRunning = false;
                btnExecute.disabled = false;
                btnExecute.style.opacity = '1';
                btnExecute.textContent = 'Retry Export';
            }
        });
    }
}
