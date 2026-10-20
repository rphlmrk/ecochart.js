export class SoundEngine {
    private static audioCtx: AudioContext | null = null;
    private static isMuted = false;
    private static volume = 0.8;

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
     * Synthesizes a crisp, elegant multi-tone trading alert chime using the native Web Audio API.
     */
    public static playAlertChime(): void {
        if (this.isMuted) return;

        const ctx = this.getContext();
        if (!ctx) return;

        try {
            const now = ctx.currentTime;
            const masterGain = ctx.createGain();
            masterGain.gain.setValueAtTime(this.volume * 0.4, now);
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

                // Crisp sine with gentle warmth
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, time);

                // Attack and exponential decay envelope
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

    public static testSound(): void {
        const wasMuted = this.isMuted;
        this.isMuted = false;
        this.playAlertChime();
        this.isMuted = wasMuted;
    }
}

SoundEngine.init();
