import { Capacitor } from '@capacitor/core';
import { ForegroundService, Importance } from '@capawesome-team/capacitor-android-foreground-service';
import { CapacitorNotificationService } from './CapacitorNotificationService';
import { alertToast } from './AlertToast';

export interface ForegroundPermissionsState {
    isAndroid: boolean;
    notificationPermission: 'granted' | 'denied' | 'prompt' | 'unknown';
    overlayPermission: boolean;
    serviceRunning: boolean;
}

export class ForegroundServiceManager {
    private static readonly SERVICE_ID = 9999;
    private static readonly CHANNEL_ID = 'ecochart_foreground_channel';
    private static isRunning = false;
    private static isInitialized = false;
    private static lastUpdateTs = 0;
    private static currentStatusText = 'Monitoring live market & pullback breakout zones';
    private static currentSymbol = 'BTCUSDT';

    /**
     * Check if running on native Android
     */
    public static isAndroid(): boolean {
        return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
    }

    /**
     * Check if running on any native platform
     */
    public static isNative(): boolean {
        return Capacitor.isNativePlatform();
    }

    /**
     * Initialize service listeners & restore state if enabled
     */
    public static async init(): Promise<void> {
        if (this.isInitialized) return;
        this.isInitialized = true;

        if (this.isAndroid()) {
            try {
                // Set up tap listener to bring app back to foreground
                await ForegroundService.addListener('notificationTapped', async () => {
                    try {
                        await ForegroundService.moveToForeground();
                    } catch (e) {
                        console.warn('[ForegroundService] moveToForeground error:', e);
                    }
                });

                // Set up action button listener
                await ForegroundService.addListener('buttonClicked', async (event) => {
                    if (event.buttonId === 1) {
                        try {
                            await ForegroundService.moveToForeground();
                        } catch (e) {
                            console.warn('[ForegroundService] moveToForeground error:', e);
                        }
                    }
                });

                // Auto-resume if user had background service enabled previously
                const savedPref = localStorage.getItem('ecochart_foreground_service_enabled');
                if (savedPref === 'true') {
                    // Small delay to allow other modules to boot
                    setTimeout(() => {
                        this.startService().catch(err => {
                            console.warn('[ForegroundService] Auto-start failed:', err);
                        });
                    }, 1200);
                }
            } catch (err) {
                console.warn('[ForegroundService] Init listeners warning:', err);
            }
        }
    }

    /**
     * Check Android permissions needed for background execution
     */
    public static async checkPermissions(): Promise<ForegroundPermissionsState> {
        const state: ForegroundPermissionsState = {
            isAndroid: this.isAndroid(),
            notificationPermission: 'unknown',
            overlayPermission: false,
            serviceRunning: this.isRunning
        };

        if (this.isAndroid()) {
            try {
                const notifPerm = await ForegroundService.checkPermissions();
                state.notificationPermission = notifPerm.display || 'unknown';
            } catch (e) {
                console.warn('[ForegroundService] Check notif permissions error:', e);
            }

            try {
                const overlayPerm = await ForegroundService.checkManageOverlayPermission();
                state.overlayPermission = overlayPerm.granted;
            } catch (e) {
                console.warn('[ForegroundService] Check overlay permission error:', e);
            }
        } else if ('Notification' in window) {
            state.notificationPermission = (Notification.permission as any) || 'unknown';
        }

        return state;
    }

    /**
     * Request Android Notification Permission (POST_NOTIFICATIONS)
     */
    public static async requestNotificationPermission(): Promise<boolean> {
        if (this.isAndroid()) {
            try {
                const res = await ForegroundService.requestPermissions();
                const granted = res.display === 'granted';
                if (granted) {
                    alertToast.show({
                        title: 'Permission Granted',
                        message: 'Android Notification permission enabled for Foreground Service.',
                        type: 'info'
                    });
                }
                return granted;
            } catch (e) {
                console.error('[ForegroundService] Request notification permission error:', e);
                return false;
            }
        }

        // Web fallback
        return await CapacitorNotificationService.requestNotificationPermission();
    }

    /**
     * Request Android "Display Over Other Apps" / Overlay Permission
     * This opens the Android OS System Settings page for the user to toggle ON
     */
    public static async requestOverlayPermission(): Promise<boolean> {
        if (this.isAndroid()) {
            try {
                const res = await ForegroundService.requestManageOverlayPermission();
                return res.granted;
            } catch (e) {
                console.error('[ForegroundService] Request overlay permission error:', e);
                return false;
            }
        }
        return false;
    }

    /**
     * Create the persistent notification channel on Android
     */
    private static async ensureChannelCreated(): Promise<void> {
        if (!this.isAndroid()) return;
        try {
            await ForegroundService.createNotificationChannel({
                id: this.CHANNEL_ID,
                name: 'EcoChart Background Monitor',
                description: 'Keeps live market prices and indicator pullback breakout checks running when minimized or screen is locked',
                importance: Importance.Low // Low importance = persistent non-intrusive icon in status bar without annoying beeps
            });
        } catch (e) {
            console.warn('[ForegroundService] Create channel warning (may already exist):', e);
        }
    }

    /**
     * Start the Android Foreground Service
     */
    public static async startService(symbol?: string, customDetails?: string): Promise<boolean> {
        if (symbol) this.currentSymbol = symbol;
        if (customDetails) this.currentStatusText = customDetails;

        if (this.isAndroid()) {
            try {
                // 1. Ensure permissions
                const perms = await this.checkPermissions();
                if (perms.notificationPermission !== 'granted') {
                    const granted = await this.requestNotificationPermission();
                    if (!granted) {
                        alertToast.show({
                            title: 'Permission Required',
                            message: 'Please grant Android Notification permission to keep background service active.',
                            type: 'bearish'
                        });
                        return false;
                    }
                }

                // 2. Ensure notification channel
                await this.ensureChannelCreated();

                // 3. Start foreground service
                await ForegroundService.startForegroundService({
                    id: this.SERVICE_ID,
                    title: `EcoChart: ${this.currentSymbol} Monitor Active`,
                    body: this.currentStatusText,
                    smallIcon: 'ic_stat_icon_config_sample',
                    notificationChannelId: this.CHANNEL_ID,
                    silent: true,
                    buttons: [
                        { id: 1, title: 'Open Chart 📈' }
                    ]
                });

                this.isRunning = true;
                localStorage.setItem('ecochart_foreground_service_enabled', 'true');

                alertToast.show({
                    title: '⚡ Background Service Active',
                    message: `Foreground service running. Pullback breakout checks continue while screen is locked.`,
                    type: 'bullish'
                });

                return true;
            } catch (err: any) {
                console.error('[ForegroundService] Failed to start service:', err);
                alertToast.show({
                    title: 'Service Start Failed',
                    message: err?.message || 'Could not start Android Foreground Service.',
                    type: 'bearish'
                });
                return false;
            }
        }

        // Web fallback simulation
        this.isRunning = true;
        localStorage.setItem('ecochart_foreground_service_enabled', 'true');
        alertToast.show({
            title: '🌐 Browser Background Mode',
            message: 'Web Background Mode enabled. In web browsers, keep tab open to receive alerts.',
            type: 'info'
        });
        return true;
    }

    /**
     * Update the persistent notification with real-time price & pullback box boundaries
     */
    public static async updateServiceStatus(symbol: string, details: string): Promise<void> {
        this.currentSymbol = symbol;
        this.currentStatusText = details;

        if (!this.isRunning || !this.isAndroid()) return;

        // Throttle updates to avoid flooding Android NotificationManager
        const now = Date.now();
        if (now - this.lastUpdateTs < 4000) return;
        this.lastUpdateTs = now;

        try {
            await ForegroundService.updateForegroundService({
                id: this.SERVICE_ID,
                title: `EcoChart: ${symbol} Monitor Active`,
                body: details,
                smallIcon: 'ic_stat_icon_config_sample',
                notificationChannelId: this.CHANNEL_ID,
                silent: true,
                buttons: [
                    { id: 1, title: 'Open Chart 📈' }
                ]
            });
        } catch (e) {
            console.warn('[ForegroundService] Update service warning:', e);
        }
    }

    /**
     * Stop the Android Foreground Service
     */
    public static async stopService(): Promise<void> {
        if (this.isAndroid()) {
            try {
                await ForegroundService.stopForegroundService();
            } catch (e) {
                console.warn('[ForegroundService] Stop service error:', e);
            }
        }

        this.isRunning = false;
        localStorage.setItem('ecochart_foreground_service_enabled', 'false');

        alertToast.show({
            title: 'Background Service Stopped',
            message: 'Android Foreground Service has been deactivated.',
            type: 'info'
        });
    }

    /**
     * Check if service is currently active
     */
    public static isServiceActive(): boolean {
        return this.isRunning;
    }

    /**
     * Bring app to foreground
     */
    public static async bringToForeground(): Promise<void> {
        if (this.isAndroid()) {
            try {
                await ForegroundService.moveToForeground();
            } catch (e) {
                console.warn('[ForegroundService] Move to foreground error:', e);
            }
        }
    }
}
