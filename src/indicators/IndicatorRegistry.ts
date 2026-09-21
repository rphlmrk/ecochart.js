import type { BaseIndicator } from './Indicator';
import { 
    SMAIndicator, EMAIndicator, VolumeIndicator, 
    ExhaustionIndicator, HTFBoxIndicator, HTFBiasIndicator, 
    HTFProjectionsIndicator, ZigZag123Indicator 
} from './plugins';

export interface SavedIndicatorState {
    type: string;
    visible: boolean;
    params: Record<string, any>;
}

export class IndicatorRegistry {
    public static serialize(ind: BaseIndicator): SavedIndicatorState {
        let type = 'UNKNOWN';
        if (ind instanceof SMAIndicator) type = 'SMA';
        else if (ind instanceof EMAIndicator) type = 'EMA';
        else if (ind instanceof VolumeIndicator) type = 'VOL';
        else if (ind instanceof ExhaustionIndicator) type = 'EXHAUST';
        else if (ind instanceof HTFBoxIndicator) type = 'HTF_BOX';
        else if (ind instanceof HTFBiasIndicator) type = 'HTF_BIAS';
        else if (ind instanceof HTFProjectionsIndicator) type = 'HTF_PROJ';
        else if (ind instanceof ZigZag123Indicator) type = 'ZZ123';

        const params: Record<string, any> = {};
        ind.params.forEach(p => { params[p.id] = p.value; });

        return { type, visible: ind.visible, params };
    }

    public static deserialize(state: SavedIndicatorState): BaseIndicator | null {
        let ind: BaseIndicator | null = null;
        switch (state.type) {
            case 'SMA': ind = new SMAIndicator(); break;
            case 'EMA': ind = new EMAIndicator(); break;
            case 'VOL': ind = new VolumeIndicator(); break;
            case 'EXHAUST': ind = new ExhaustionIndicator(); break;
            case 'HTF_BOX': ind = new HTFBoxIndicator(); break;
            case 'HTF_BIAS': ind = new HTFBiasIndicator(); break;
            case 'HTF_PROJ': ind = new HTFProjectionsIndicator(); break;
            case 'ZZ123': ind = new ZigZag123Indicator(); break;
        }

        if (ind) {
            ind.visible = state.visible ?? true;
            if (state.params) ind.updateParams(state.params);
        }
        return ind;
    }
}