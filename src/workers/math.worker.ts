// src/workers/math.worker.ts

self.onmessage = (e) => {
    const { id, type, data, params } = e.data;
    let result: any = {};

    try {
        if (type === 'SMA') {
            const period = params.period;
            const len = data.length / 6;
            const values = new Float64Array(len);
            for (let i = period - 1; i < len; i++) {
                let sum = 0;
                for (let j = 0; j < period; j++) {
                    sum += data[(i - j) * 6 + 4]; // Close price
                }
                values[i] = sum / period;
            }
            result = { values, transferables: [values.buffer] };
        }
        else if (type === 'EMA') {
            const period = params.period;
            const len = data.length / 6;
            const values = new Float64Array(len);
            const k = 2 / (period + 1);
            if (len > 0) values[0] = data[4];
            for (let i = 1; i < len; i++) {
                const close = data[i * 6 + 4];
                values[i] = (close - values[i - 1]) * k + values[i - 1];
            }
            result = { values, transferables: [values.buffer] };
        }
        else if (type === 'EXHAUSTION') {
            const period = params.period;
            const len = data.length / 6;
            const values = new Float64Array(len);
            const tps = new Float64Array(period * 2);

            for (let i = period - 1; i < len; i++) {
                let sum = 0;
                for (let j = 0; j < period; j++) {
                    const base = (i - j) * 6;
                    const tp = (data[base + 2] + data[base + 3] + data[base + 4]) / 3;
                    tps[j] = tp;
                    sum += tp;
                }
                const sma = sum / period;
                let madSum = 0;
                for (let j = 0; j < period; j++) {
                    madSum += Math.abs(tps[j] - sma);
                }
                const mad = madSum / period;
                const rawVal = mad === 0 ? 0 : (tps[0] - sma) / (0.015 * mad);
                values[i] = Math.max(-300, Math.min(300, rawVal));
            }
            result = { values, transferables: [values.buffer] };
        }
        else if (type === 'ZIGZAG123') {
            const zzLength = params.zzLength;
            const offset = params.offset;
            const len = data.length / 6;

            const zzPoints: any[] = [];
            const breakoutLines: any[] = [];
            const labels: any[] = [];

            const swingBars: number[] = [];
            const swingPrices: number[] = [];
            const swingTypes: number[] = [];

            let trend = 0;
            let guardLow: number | null = null, guardLowBar: number | null = null, guardLowBroken = false;
            let guardHigh: number | null = null, guardHighBar: number | null = null, guardHighBroken = false;
            let s1Low: number | null = null, s1LowBar: number | null = null, s1LowBroken = false;
            let s1High: number | null = null, s1HighBar: number | null = null, s1HighBroken = false;
            let seqStep = 0, s2Price: number | null = null, s2Bar: number | null = null, lastLabelIdx = -1;

            const getRecentSwing = (targetType: number): [number | null, number | null] => {
                for (let i = swingTypes.length - 1; i >= 0; i--) {
                    if (swingTypes[i] === targetType) return [swingPrices[i], swingBars[i]];
                }
                return [null, null];
            };

            for (let i = 0; i < len; i++) {
                let newSwing = false, updatedSwing = false, newSwingType = 0, newSwingBar = 0, newSwingPrice = 0;
                const pBar = i - zzLength;
                const absolutePBar = pBar + offset;
                const absoluteI = i + offset;

                // 1. Pivot High
                if (pBar >= zzLength && i < len) {
                    const candH = data[pBar * 6 + 2];
                    let isPh = true;
                    for (let k = 1; k <= zzLength; k++) {
                        if (data[(pBar - k) * 6 + 2] > candH || data[(pBar + k) * 6 + 2] >= candH) { isPh = false; break; }
                    }
                    if (isPh) {
                        const n = swingTypes.length;
                        if (n === 0) {
                            swingBars.push(absolutePBar); swingPrices.push(candH); swingTypes.push(1);
                            newSwing = true; newSwingType = 1; newSwingBar = absolutePBar; newSwingPrice = candH;
                        } else {
                            if (swingTypes[n - 1] === 1) {
                                if (candH >= swingPrices[n - 1]) {
                                    swingBars[n - 1] = absolutePBar; swingPrices[n - 1] = candH;
                                    updatedSwing = true; newSwingType = 1; newSwingBar = absolutePBar; newSwingPrice = candH;
                                }
                            } else {
                                swingBars.push(absolutePBar); swingPrices.push(candH); swingTypes.push(1);
                                newSwing = true; newSwingType = 1; newSwingBar = absolutePBar; newSwingPrice = candH;
                            }
                        }
                    }
                }

                // 2. Pivot Low
                if (pBar >= zzLength && i < len) {
                    const candL = data[pBar * 6 + 3];
                    let isPl = true;
                    for (let k = 1; k <= zzLength; k++) {
                        if (data[(pBar - k) * 6 + 3] < candL || data[(pBar + k) * 6 + 3] <= candL) { isPl = false; break; }
                    }
                    if (isPl) {
                        const n = swingTypes.length;
                        if (n === 0) {
                            swingBars.push(absolutePBar); swingPrices.push(candL); swingTypes.push(-1);
                            newSwing = true; newSwingType = -1; newSwingBar = absolutePBar; newSwingPrice = candL;
                        } else {
                            if (swingTypes[n - 1] === -1) {
                                if (candL <= swingPrices[n - 1]) {
                                    swingBars[n - 1] = absolutePBar; swingPrices[n - 1] = candL;
                                    updatedSwing = true; newSwingType = -1; newSwingBar = absolutePBar; newSwingPrice = candL;
                                }
                            } else {
                                swingBars.push(absolutePBar); swingPrices.push(candL); swingTypes.push(-1);
                                newSwing = true; newSwingType = -1; newSwingBar = absolutePBar; newSwingPrice = candL;
                            }
                        }
                    }
                }

                if (trend === 0 && swingTypes.length >= 3) {
                    const n = swingTypes.length;
                    if (swingTypes[n - 1] === 1 && swingPrices[n - 1] > swingPrices[n - 3]) {
                        trend = 1; guardLow = swingPrices[n - 2]; guardLowBar = swingBars[n - 2];
                    } else if (swingTypes[n - 1] === -1 && swingPrices[n - 1] < swingPrices[n - 3]) {
                        trend = -1; guardHigh = swingPrices[n - 2]; guardHighBar = swingBars[n - 2];
                    }
                }

                const close = data[i * 6 + 4];

                if (trend === 1 && !guardLowBroken && guardLow !== null && close < guardLow && seqStep === 0) {
                    if (guardLowBar !== null) breakoutLines.push({ startBar: guardLowBar, endBar: absoluteI, price: guardLow });
                    guardLowBroken = true; trend = -1; seqStep = 1;
                    const [p, b] = getRecentSwing(1); s1High = p; s1HighBar = b; s1HighBroken = false;
                }

                if (trend === -1 && !guardHighBroken && guardHigh !== null && close > guardHigh && seqStep === 0) {
                    if (guardHighBar !== null) breakoutLines.push({ startBar: guardHighBar, endBar: absoluteI, price: guardHigh });
                    guardHighBroken = true; trend = 1; seqStep = 1;
                    const [p, b] = getRecentSwing(-1); s1Low = p; s1LowBar = b; s1LowBroken = false;
                }

                if (trend === 1 && seqStep >= 2 && s1Low !== null && !s1LowBroken && close < s1Low) {
                    if (s1LowBar !== null) breakoutLines.push({ startBar: s1LowBar, endBar: absoluteI, price: s1Low });
                    s1LowBroken = true; trend = -1; seqStep = 1;
                    const [p, b] = getRecentSwing(1); s1High = p; s1HighBar = b; s1HighBroken = false;
                }

                if (trend === -1 && seqStep >= 2 && s1High !== null && !s1HighBroken && close > s1High) {
                    if (s1HighBar !== null) breakoutLines.push({ startBar: s1HighBar, endBar: absoluteI, price: s1High });
                    s1HighBroken = true; trend = 1; seqStep = 1;
                    const [p, b] = getRecentSwing(-1); s1Low = p; s1LowBar = b; s1LowBroken = false;
                }

                if (newSwing) {
                    if (trend === -1) {
                        if (seqStep === 1 && newSwingType === -1) {
                            labels.push({ barIdx: newSwingBar, price: newSwingPrice, text: '1', isHigh: false });
                            lastLabelIdx = labels.length - 1; seqStep = 2;
                        } else if (seqStep === 2 && newSwingType === 1) {
                            labels.push({ barIdx: newSwingBar, price: newSwingPrice, text: '2', isHigh: true });
                            lastLabelIdx = labels.length - 1; s2Price = newSwingPrice; s2Bar = newSwingBar; seqStep = 3;
                        } else if (seqStep === 3 && newSwingType === -1) {
                            labels.push({ barIdx: newSwingBar, price: newSwingPrice, text: '3', isHigh: false });
                            lastLabelIdx = labels.length - 1; seqStep = 0;
                            guardHigh = s2Price; guardHighBar = s2Bar; guardHighBroken = false;
                        } else if (seqStep === 0 && newSwingType === 1) {
                            guardHigh = newSwingPrice; guardHighBar = newSwingBar; guardHighBroken = false;
                        }
                    } else if (trend === 1) {
                        if (seqStep === 1 && newSwingType === 1) {
                            labels.push({ barIdx: newSwingBar, price: newSwingPrice, text: '1', isHigh: true });
                            lastLabelIdx = labels.length - 1; seqStep = 2;
                        } else if (seqStep === 2 && newSwingType === -1) {
                            labels.push({ barIdx: newSwingBar, price: newSwingPrice, text: '2', isHigh: false });
                            lastLabelIdx = labels.length - 1; s2Price = newSwingPrice; s2Bar = newSwingBar; seqStep = 3;
                        } else if (seqStep === 3 && newSwingType === 1) {
                            labels.push({ barIdx: newSwingBar, price: newSwingPrice, text: '3', isHigh: true });
                            lastLabelIdx = labels.length - 1; seqStep = 0;
                            guardLow = s2Price; guardLowBar = s2Bar; guardLowBroken = false;
                        } else if (seqStep === 0 && newSwingType === -1) {
                            guardLow = newSwingPrice; guardLowBar = newSwingBar; guardLowBroken = false;
                        }
                    }
                }

                if (updatedSwing && lastLabelIdx >= 0 && lastLabelIdx < labels.length) {
                    labels[lastLabelIdx].barIdx = newSwingBar;
                    labels[lastLabelIdx].price = newSwingPrice;
                    if (seqStep === 3) s2Price = newSwingPrice;
                }
            }

            for (let i = 0; i < swingBars.length; i++) {
                zzPoints.push({ barIdx: swingBars[i], price: swingPrices[i], type: swingTypes[i] });
            }

            result = { zzPoints, breakoutLines, labels };
        }

        self.postMessage({ id, result }, result.transferables || []);
    } catch (err: any) {
        self.postMessage({ id, error: err.message });
    }
};