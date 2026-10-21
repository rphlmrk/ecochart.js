export class SoundEngine {
    private static audioCtx: AudioContext | null = null;
    private static isMuted = false;
    private static volume = 0.85;

    // Alarm state
    private static alarmInterval: any = null;
    private static isAlarmRinging = false;
    private static activeOscillators: OscillatorNode[] = [];
    private static activeAlarmCount = 0;

    public static init(): void {
        try {
            const rawMute = localStorage.getItem('ecochart_alerts_muted');
            if (rawMute !== null) {
                this.isMuted = rawMute === 'true';
            }
            const rawVol = localStorage.getItem('ecochart_alerts_volume');
            if (rawVol !== null) {
                const parsed = parseFloat(rawVol);
                if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
                    this.volume = parsed;
                }
            }
        } catch {
            // Ignore localStorage errors
        }
    }

    private static getContext(): AudioContext | null {
        if (!this.audioCtx) {
            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            if (AudioContextClass) {
                this.audioCtx = new AudioContextClass();
            }
        }
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(() => {});
        }
        return this.audioCtx;
    }

    public static setMuted(muted: boolean): void {
        this.isMuted = muted;
        try {
            localStorage.setItem('ecochart_alerts_muted', String(muted));
        } catch {}
        if (muted && this.isAlarmRinging) {
            this.stopAlarm();
        }
    }

    public static getMuted(): boolean {
        return this.isMuted;
    }

    public static setVolume(val: number): void {
        this.volume = Math.max(0, Math.min(1, val));
        try {
            localStorage.setItem('ecochart_alerts_volume', String(this.volume));
        } catch {}
    }

    public static getVolume(): number {
        return this.volume;
    }

    /**
     * Synthesizes a crisp, elegant single-fire trading alert chime.
     */
    public static playAlertChime(): void {
        if (this.isMuted) return;

        const ctx = this.getContext();
        if (!ctx) return;

        try {
            const now = ctx.currentTime;
            const masterGain = ctx.createGain();
            masterGain.gain.setValueAtTime(this.volume * 0.45, now);
            masterGain.connect(ctx.destination);

            // Major Triad Chime sequence: C6 (1046.5Hz) -> E6 (1318.5Hz) -> G6 (1568Hz)
            const notes = [
                { freq: 1046.5, time: now, duration: 0.35 },
                { freq: 1318.5, time: now + 0.08, duration: 0.45 },
                { freq: 1568.0, time: now + 0.16, duration: 0.75 }
            ];

            notes.forEach(({ freq, time, duration }) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();

                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, time);

                gain.gain.setValueAtTime(0.0001, time);
                gain.gain.exponentialRampToValueAtTime(0.9, time + 0.015);
                gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

                osc.connect(gain);
                gain.connect(masterGain);

                osc.start(time);
                osc.stop(time + duration + 0.05);
            });
        } catch (err) {
            console.warn('[SoundEngine] Audio playback error:', err);
        }
    }

    /**
     * Synthesizes a single cycle of an urgent, dual-tone alarm pattern.
     * High attention, piercing yet non-distorted alarm sound.
     */
    private static playAlarmCycle(): void {
        if (this.isMuted) return;

        const ctx = this.getContext();
        if (!ctx) return;

        try {
            const now = ctx.currentTime;
            const masterGain = ctx.createGain();
            masterGain.gain.setValueAtTime(this.volume * 0.65, now);
            masterGain.connect(ctx.destination);

            // Repeating dual-tone alarm pulse: 4 rapid beeps (high-low-high-high)
            const beeps = [
                { freq: 960, time: now + 0.00, dur: 0.11, type: 'triangle' as OscillatorType },
                { freq: 1280, time: now + 0.14, dur: 0.11, type: 'triangle' as OscillatorType },
                { freq: 960, time: now + 0.28, dur: 0.11, type: 'triangle' as OscillatorType },
                { freq: 1350, time: now + 0.42, dur: 0.22, type: 'sine' as OscillatorType }
            ];

            beeps.forEach(({ freq, time, dur, type }) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();

                osc.type = type;
                osc.frequency.setValueAtTime(freq, time);

                gain.gain.setValueAtTime(0.001, time);
                gain.gain.exponentialRampToValueAtTime(1.0, time + 0.015);
                gain.gain.exponentialRampToValueAtTime(0.001, time + dur);

                osc.connect(gain);
                gain.connect(masterGain);

                osc.start(time);
                osc.stop(time + dur + 0.02);

                this.activeOscillators.push(osc);
                osc.onended = () => {
                    const idx = this.activeOscillators.indexOf(osc);
                    if (idx !== -1) this.activeOscillators.splice(idx, 1);
                };
            });

            // Trigger hardware vibration if supported by device
            if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
                try {
                    navigator.vibrate([180, 80, 180, 80, 260]);
                } catch {}
            }
        } catch (err) {
            console.warn('[SoundEngine] Alarm audio cycle error:', err);
        }
    }

    /**
     * Starts continuous alarm sound.
     * Loops the alarm until stopAlarm() is explicitly called by the user.
     */
    public static startAlarm(): void {
        this.activeAlarmCount++;
        if (this.isAlarmRinging) return; // Already looping

        this.isAlarmRinging = true;

        // Unlock audio context immediately
        const ctx = this.getContext();
        if (ctx && ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }

        // Play first cycle immediately
        this.playAlarmCycle();

        // Loop every 850ms
        this.alarmInterval = setInterval(() => {
            if (!this.isAlarmRinging) {
                if (this.alarmInterval) clearInterval(this.alarmInterval);
                return;
            }
            this.playAlarmCycle();
        }, 850);

        window.dispatchEvent(new CustomEvent('ecochart-alarm-started'));
    }

    /**
     * Explicitly stops the repeating alarm, stops vibration, and silences all nodes.
     */
    public static stopAlarm(): void {
        this.isAlarmRinging = false;
        this.activeAlarmCount = 0;

        if (this.alarmInterval) {
            clearInterval(this.alarmInterval);
            this.alarmInterval = null;
        }

        // Stop any oscillators playing currently
        for (const osc of this.activeOscillators) {
            try {
                osc.stop();
                osc.disconnect();
            } catch {}
        }
        this.activeOscillators = [];

        // Cancel vibration
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
            try {
                navigator.vibrate(0);
            } catch {}
        }

        window.dispatchEvent(new CustomEvent('ecochart-alarm-stopped'));
    }

    public static isRinging(): boolean {
        return this.isAlarmRinging;
    }

    public static testSound(): void {
        const wasMuted = this.isMuted;
        this.isMuted = false;
        this.playAlertChime();
        this.isMuted = wasMuted;
    }

    public static testAlarm(): void {
        const wasMuted = this.isMuted;
        this.isMuted = false;
        this.startAlarm();
        this.isMuted = wasMuted;
    }
}

SoundEngine.init();
