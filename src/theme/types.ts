export type LineStyle = 'solid' | 'dashed' | 'dotted';
export type AccentSource = 'bull' | 'custom';

export interface ChartTheme {
    id: string;
    name: string;
    isDark: boolean;

    // Canvas & UI Shell
    background: string;
    panelBackground: string;
    gridLines: string;
    axisText: string;
    crosshair: string;

    // Candlesticks
    bullBody: string;
    bearBody: string;
    bullWick: string;
    bearWick: string;
    bullBorder: string;
    bearBorder: string;

    // Dynamic Accent
    accentColor: string;
    accentSource: AccentSource;

    // Line Styles
    crosshairLineStyle?: LineStyle;
    livePriceLineStyle?: LineStyle;
}