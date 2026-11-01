import type { ML1FeatureValues, ML1FeatureValidity } from '../ML1FeatureTypes';

export function calculateTemporalFeatures(timestamp: number): {
    features: ML1FeatureValues;
    validity: ML1FeatureValidity;
} {
    const fallbackInvalid = {
        features: {
            MinuteOfHour: 0,
            HourOfDay: 0,
            DayOfWeek: 0,
            SinMinuteOfHour: 0,
            CosMinuteOfHour: 0,
            SinHourOfDay: 0,
            CosHourOfDay: 0,
            SinDayOfWeek: 0,
            CosDayOfWeek: 0
        },
        validity: {
            MinuteOfHour: false,
            HourOfDay: false,
            DayOfWeek: false,
            SinMinuteOfHour: false,
            CosMinuteOfHour: false,
            SinHourOfDay: false,
            CosHourOfDay: false,
            SinDayOfWeek: false,
            CosDayOfWeek: false
        }
    };

    if (!Number.isFinite(timestamp) || timestamp < 0) {
        return fallbackInvalid;
    }

    const d = new Date(timestamp);
    if (!Number.isFinite(d.getTime())) {
        return fallbackInvalid;
    }
    const minute = d.getUTCMinutes();
    const hour = d.getUTCHours();
    const day = d.getUTCDay(); // 0 = Sunday, 1 = Monday, ... 6 = Saturday

    const sinMin = Math.sin((2 * Math.PI * minute) / 60);
    const cosMin = Math.cos((2 * Math.PI * minute) / 60);
    const sinHour = Math.sin((2 * Math.PI * hour) / 24);
    const cosHour = Math.cos((2 * Math.PI * hour) / 24);
    const sinDay = Math.sin((2 * Math.PI * day) / 7);
    const cosDay = Math.cos((2 * Math.PI * day) / 7);

    return {
        features: {
            MinuteOfHour: minute,
            HourOfDay: hour,
            DayOfWeek: day,
            SinMinuteOfHour: sinMin,
            CosMinuteOfHour: cosMin,
            SinHourOfDay: sinHour,
            CosHourOfDay: cosHour,
            SinDayOfWeek: sinDay,
            CosDayOfWeek: cosDay
        },
        validity: {
            MinuteOfHour: true,
            HourOfDay: true,
            DayOfWeek: true,
            SinMinuteOfHour: Number.isFinite(sinMin),
            CosMinuteOfHour: Number.isFinite(cosMin),
            SinHourOfDay: Number.isFinite(sinHour),
            CosHourOfDay: Number.isFinite(cosHour),
            SinDayOfWeek: Number.isFinite(sinDay),
            CosDayOfWeek: Number.isFinite(cosDay)
        }
    };
}
