export type AlertCondition = 
    | 'cross' 
    | 'cross_up' 
    | 'cross_down' 
    | 'greater' 
    | 'less';

export type AlertFrequency = 'once' | 'every_time';

export type AlertStatus = 'active' | 'triggered' | 'paused';

export type AlertSourceType = 'price' | 'indicator';

export interface IndicatorAlertConfig {
    indicatorId: string;
    indicatorName: string;
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
    targetPrice: number;
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
}
