import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

export class CapacitorNotificationService {
    private static isInitialized = false;
    private static isChannelCreated = false;
    private static notificationIdCounter = 1;
    private static isListenerRegistered = false;

    public static isNative(): boolean {
        return Capacitor.isNativePlatform();
    }

    public static async init(): Promise<void> {
        if (this.isInitialized) return;
        this.isInitialized = true;

        if (this.isNative()) {
            try {
                // Check and request permissions on Android 13+ (POST_NOTIFICATIONS)
                const perm = await LocalNotifications.checkPermissions();
                if (perm.display !== 'granted') {
                    await LocalNotifications.requestPermissions();
                }

                // Create dedicated Android notification channel with high priority (heads-up pop-up)
                if (!this.isChannelCreated) {
                    await LocalNotifications.createChannel({
                        id: 'ecochart_alerts',
                        name: 'EcoChart Market Alerts',
                        description: 'Real-time notifications for Price breakouts and Market Structure Pullback Zones',
                        importance: 5, // NotificationManager.IMPORTANCE_HIGH (heads-up pop-up with sound)
                        visibility: 1, // NotificationCompat.VISIBILITY_PUBLIC (visible on lockscreen)
                        vibration: true,
                        lights: true,
                        lightColor: '#FF9800'
                    });
                    this.isChannelCreated = true;
                }

                // Register interactive action type
                try {
                    await LocalNotifications.registerActionTypes({
                        types: [
                            {
                                id: 'OPEN_CHART',
                                actions: [
                                    { id: 'view', title: 'Open Chart 📈', foreground: true }
                                ]
                            }
                        ]
                    });
                } catch {}

                // Register notification tap listener to automatically switch chart symbol
                if (!this.isListenerRegistered) {
                    this.isListenerRegistered = true;
                    LocalNotifications.addListener('localNotificationActionPerformed', (notificationAction) => {
                        const sym = notificationAction.notification?.extra?.symbol;
                        if (sym) {
                            window.dispatchEvent(new CustomEvent('ecochart-switch-symbol', { detail: sym }));
                        }
                    });
                }
            } catch (err) {
                console.warn('[CapacitorNotificationService] Native Android init error:', err);
            }
        } else if ('Notification' in window) {
            // Web fallback permission
            if (Notification.permission === 'default') {
                try {
                    await Notification.requestPermission();
                } catch {}
            }
        }
    }

    public static async requestNotificationPermission(): Promise<boolean> {
        if (this.isNative()) {
            try {
                const res = await LocalNotifications.requestPermissions();
                return res.display === 'granted';
            } catch (e) {
                console.warn('[CapacitorNotificationService] Permission request error:', e);
                return false;
            }
        }

        if ('Notification' in window) {
            try {
                const res = await Notification.requestPermission();
                return res === 'granted';
            } catch {
                return false;
            }
        }

        return false;
    }

    public static async send(title: string, body: string, data?: Record<string, any>): Promise<void> {
        await this.init();

        // 1. Native Android Local Notifications via Capacitor
        if (this.isNative()) {
            try {
                // Ensure a safe 32-bit positive integer for Android NotificationManager
                this.notificationIdCounter = (this.notificationIdCounter + 1) % 100000;
                const notifId = ((Date.now() % 20000) * 10000 + this.notificationIdCounter) % 2147483647;

                await LocalNotifications.schedule({
                    notifications: [
                        {
                            id: Math.max(1, notifId),
                            title,
                            body,
                            channelId: 'ecochart_alerts',
                            smallIcon: 'res://drawable/ic_launcher',
                            iconColor: '#FF9800',
                            extra: data || {},
                            actionTypeId: 'OPEN_CHART',
                            schedule: {
                                at: new Date(Date.now() + 50),
                                allowWhileIdle: true
                            }
                        }
                    ]
                });
                return;
            } catch (err) {
                console.warn('[CapacitorNotificationService] Native schedule error, falling back:', err);
            }
        }

        // 2. Browser Desktop & Mobile Fallback (HTML5 Notification API)
        if ('Notification' in window && Notification.permission === 'granted') {
            try {
                const notif = new Notification(title, {
                    body,
                    icon: '/favicon.svg',
                    data: data || {},
                    badge: '/favicon.svg'
                });

                notif.onclick = () => {
                    window.focus();
                    if (data?.symbol) {
                        window.dispatchEvent(new CustomEvent('ecochart-switch-symbol', { detail: data.symbol }));
                    }
                    notif.close();
                };
            } catch (e) {
                console.warn('[CapacitorNotificationService] Browser Notification error:', e);
            }
        }

        // Haptic feedback if supported
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
            try {
                navigator.vibrate([150, 80, 150]);
            } catch {}
        }
    }

    /**
     * Sends an immediate test notification so user can verify Android Native / Push notifications.
     */
    public static async testNotification(): Promise<{ success: boolean; mode: 'native_android' | 'browser' | 'denied'; message: string }> {
        await this.init();

        if (this.isNative()) {
            try {
                await this.send(
                    '🔔 EcoChart Native Android Alert',
                    'Capacitor Local Notifications are active! Ready for Micro & Macro Pullback breakouts.',
                    { symbol: 'BTCUSDT' }
                );
                return {
                    success: true,
                    mode: 'native_android',
                    message: 'Sent native Android local notification via Capacitor!'
                };
            } catch (err: any) {
                return {
                    success: false,
                    mode: 'native_android',
                    message: `Native Android notification error: ${err?.message || err}`
                };
            }
        }

        if ('Notification' in window) {
            if (Notification.permission !== 'granted') {
                const granted = await this.requestNotificationPermission();
                if (!granted) {
                    return {
                        success: false,
                        mode: 'denied',
                        message: 'Notification permission was denied. Please allow notifications in device/browser settings.'
                    };
                }
            }

            await this.send(
                '🔔 EcoChart Alert Test',
                'Notifications are active! Breakout alerts for Micro & Macro Pullback zones will notify you.',
                { symbol: 'BTCUSDT' }
            );

            return {
                success: true,
                mode: 'browser',
                message: 'Notification sent successfully!'
            };
        }

        return {
            success: false,
            mode: 'denied',
            message: 'Notifications are not supported in this environment.'
        };
    }
}

// Auto-initialize service on load
CapacitorNotificationService.init().catch(() => {});
