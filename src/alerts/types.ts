export type AlertCondition = 
    | 'cross' 
    | 'cross_up' 
    | 'cross_down' 
    | 'greater' 
    | 'less'
    | 'pullback_any_break'
    | 'pullback_micro_break'
    | 'pullback_micro_break_up'
    | 'pullback_micro_break_down'
    | 'pullback_macro_break'
    | 'pullback_macro_break_up'
    | 'pullback_macro_break_down';

export type AlertFrequency = 'once' | 'every_time';

export type AlertStatus = 'active' | 'triggered' | 'paused';

export type AlertSourceType = 'price' | 'indicator';

export interface IndicatorAlertConfig {
    indicatorId: string; // 'MS_PULLBACK_ZONES'
    indicatorName: string; // 'Market Structure Pullback Zones'
    boxType?: 'micro' | 'macro' | 'both';
    breakoutDirection?: 'any' | 'up' | 'down';
    useWicks?: boolean;
    boxLevels?: {
        microTop?: number;
        microBottom?: number;
        macroTop?: number;
        macroBottom?: number;
    };
    outputChannel?: string;
    compareWith?: 'price' | 'indicator' | 'constant';
    compareIndicatorId?: string;
    constantValue?: number;
}

export interface PriceAlert {
    id: string;
    name: string;
    symbol: string;
    source: AlertSourceType;
    condition: AlertCondition;
    targetPrice: number; // For price alerts, or current boundary for indicator alerts
    indicatorConfig?: IndicatorAlertConfig;
    frequency: AlertFrequency;
    cooldownMinutes: number; // For 'every_time' frequency
    lastTriggeredAt?: number;
    status: AlertStatus;
    createdAt: number;
    soundEnabled: boolean;
    color: string;
    note?: string;
}

export interface TriggerEvent {
    id: string;
    alertId: string;
    symbol: string;
    targetPrice: number;
    triggeredPrice: number;
    timestamp: number;
    condition: AlertCondition;
    name: string;
    note?: string;
    boxDetails?: {
        boxType: 'micro' | 'macro';
        direction: 'up' | 'down';
        top: number;
        bottom: number;
    };
}
