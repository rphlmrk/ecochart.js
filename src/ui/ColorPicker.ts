import type { LineStyle } from '../theme/types';
import './ColorPicker.css';

export interface ColorPickerOptions {
    anchorElement: HTMLElement;
    initialColor: string;
    initialOpacity?: number;      // 0 to 1
    initialThickness?: number;    // 1 to 4
    initialStyle?: LineStyle;
    showOpacity?: boolean;
    showStrokeOptions?: boolean;
    onChange: (result: {
        color: string;
        opacity: number;
        thickness?: number;
        style?: LineStyle;
    }) => void;
}

export class ColorPicker {
    private static instance: ColorPicker | null = null;
    private popover: HTMLDivElement | null = null;
    private currentOptions: ColorPickerOptions | null = null;

    private currentColor = '#26A69A';
    private currentOpacity = 1;
    private currentThickness = 1;
    private currentStyle: LineStyle = 'solid';
    private recentColors: string[] = ['#2962FF', '#26A69A', '#EF5350', '#FF9800', '#E040FB', '#FFFFFF'];

    // 10 Columns x 8 Rows Swatch Matrix (Achromatic row + 7 spectrum tiers)
    private readonly PALETTE_MATRIX: string[][] = [
        ['#FFFFFF', '#E1E3EB', '#CFD3DC', '#B2B5BE', '#9598A1', '#787B86', '#5D606B', '#434651', '#2A2E39', '#000000'],
        ['#EF5350', '#FF9800', '#FBC02D', '#4CAF50', '#009688', '#00BCD4', '#2962FF', '#673AB7', '#9C27B0', '#E91E63'],
        ['#FCE4EC', '#FFF3E0', '#FFFDE7', '#E8F5E9', '#E0F2F1', '#E0F7FA', '#E8EAF6', '#EDE7F6', '#F3E5F5', '#FCE4EC'],
        ['#FFCDD2', '#FFE0B2', '#FFF9C4', '#C8E6C9', '#B2DFDB', '#B2EBF2', '#C5CAE9', '#D1C4E9', '#E1BEE7', '#F8BBD0'],
        ['#EF9A9A', '#FFCC80', '#FFF59D', '#A5D6A7', '#80CBC4', '#80DEEA', '#9FA8DA', '#B39DDB', '#CE93D8', '#F48FB1'],
        ['#E57373', '#FFB74D', '#FFF176', '#81C784', '#4DB6AC', '#4DD0E1', '#7986CB', '#9575CD', '#BA68C8', '#F06292'],
        ['#D32F2F', '#F57C00', '#FBC02D', '#388E3C', '#00796B', '#0097A7', '#1976D2', '#512DA8', '#7B1FA2', '#C2185B'],
        ['#B71C1C', '#E65100', '#F57F17', '#1B5E20', '#004D40', '#006064', '#0D47A1', '#311B92', '#4A148C', '#880E4F'],
    ];

    private constructor() {
        this.loadRecents();
    }

    public static getInstance(): ColorPicker {
        if (!ColorPicker.instance) {
            ColorPicker.instance = new ColorPicker();
        }
        return ColorPicker.instance;
    }

    public open(options: ColorPickerOptions) {
        this.close();
        this.currentOptions = options;
        this.currentColor = options.initialColor.toUpperCase();
        this.currentOpacity = options.initialOpacity ?? 1;
        this.currentThickness = options.initialThickness ?? 1;
        this.currentStyle = options.initialStyle ?? 'solid';

        this.popover = document.createElement('div');
        this.popover.className = 'tv-picker-popover';

        this.renderContent();
        // Append inside the dialog so it inherits the browser's Top Layer
        const container = options.anchorElement.closest('dialog') || document.body;
        container.appendChild(this.popover);
        this.positionPopover(options.anchorElement);

        setTimeout(() => {
            document.addEventListener('pointerdown', this.handleOutsideClick);
        }, 0);
    }

    public close() {
        if (this.popover) {
            this.popover.remove();
            this.popover = null;
            document.removeEventListener('pointerdown', this.handleOutsideClick);
        }
    }

    private renderContent() {
        if (!this.popover) return;
        this.popover.innerHTML = '';

        // 1. Swatch Grid
        const grid = document.createElement('div');
        grid.className = 'tv-swatch-grid';
        for (const row of this.PALETTE_MATRIX) {
            for (const color of row) {
                const swatch = document.createElement('div');
                swatch.className = `tv-swatch ${this.currentColor === color ? 'active' : ''}`;
                swatch.style.backgroundColor = color;
                swatch.onclick = () => this.selectColor(color);
                grid.appendChild(swatch);
            }
        }
        this.popover.appendChild(grid);

        // 2. Divider
        const div1 = document.createElement('div');
        div1.className = 'tv-picker-divider';
        this.popover.appendChild(div1);

        // 3. Custom / Recent Colors Row
        const recentRow = document.createElement('div');
        recentRow.className = 'tv-custom-row';
        for (const color of this.recentColors) {
            const swatch = document.createElement('div');
            swatch.className = `tv-swatch ${this.currentColor === color ? 'active' : ''}`;
            swatch.style.backgroundColor = color;
            swatch.onclick = () => this.selectColor(color);
            recentRow.appendChild(swatch);
        }

        const addBtn = document.createElement('button');
        addBtn.className = 'tv-add-color-btn';
        addBtn.textContent = '+';
        addBtn.onclick = () => {
            const pickerInput = document.createElement('input');
            pickerInput.type = 'color';
            pickerInput.value = this.currentColor;
            pickerInput.onchange = (e) => {
                const newColor = (e.target as HTMLInputElement).value.toUpperCase();
                this.addRecentColor(newColor);
                this.selectColor(newColor);
            };
            pickerInput.click();
        };
        recentRow.appendChild(addBtn);
        this.popover.appendChild(recentRow);

        // 4. Opacity Slider
        if (this.currentOptions?.showOpacity !== false) {
            const opacityLabel = document.createElement('div');
            opacityLabel.className = 'tv-picker-label';
            opacityLabel.innerHTML = `<span>Opacity</span><span class="tv-opacity-badge">${Math.round(this.currentOpacity * 100)}%</span>`;
            this.popover.appendChild(opacityLabel);

            const opacityContainer = document.createElement('div');
            opacityContainer.className = 'tv-opacity-container';

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '0';
            slider.max = '100';
            slider.value = String(Math.round(this.currentOpacity * 100));
            slider.className = 'tv-opacity-track';
            slider.style.background = `linear-gradient(to right, transparent, ${this.currentColor})`;

            slider.oninput = (e) => {
                const val = Number((e.target as HTMLInputElement).value);
                this.currentOpacity = val / 100;
                const badge = this.popover?.querySelector('.tv-opacity-badge');
                if (badge) badge.textContent = `${val}%`;
                this.emitChange();
            };

            opacityContainer.appendChild(slider);
            this.popover.appendChild(opacityContainer);
        }

        // 5. Stroke Thickness & Line Style (Optional)
        if (this.currentOptions?.showStrokeOptions) {
            const div2 = document.createElement('div');
            div2.className = 'tv-picker-divider';
            this.popover.appendChild(div2);

            // Thickness
            const thickLabel = document.createElement('div');
            thickLabel.className = 'tv-picker-label';
            thickLabel.textContent = 'Thickness';
            this.popover.appendChild(thickLabel);

            const thickGroup = document.createElement('div');
            thickGroup.className = 'tv-segmented-control';
            thickGroup.style.gridTemplateColumns = 'repeat(4, 1fr)';

            [1, 2, 3, 4].forEach((thick) => {
                const btn = document.createElement('button');
                btn.className = this.currentThickness === thick ? 'active' : '';
                btn.innerHTML = `<span style="display:block;width:24px;height:${thick}px;background:currentColor;border-radius:1px;"></span>`;
                btn.onclick = () => {
                    this.currentThickness = thick;
                    this.renderContent();
                    this.emitChange();
                };
                thickGroup.appendChild(btn);
            });
            this.popover.appendChild(thickGroup);

            // Line Style
            const styleLabel = document.createElement('div');
            styleLabel.className = 'tv-picker-label';
            styleLabel.style.marginTop = '10px';
            styleLabel.textContent = 'Line style';
            this.popover.appendChild(styleLabel);

            const styleGroup = document.createElement('div');
            styleGroup.className = 'tv-segmented-control';
            styleGroup.style.gridTemplateColumns = 'repeat(3, 1fr)';

            const styles: { id: LineStyle; svg: string }[] = [
                { id: 'solid', svg: '<line x1="2" y1="6" x2="38" y2="6" stroke="currentColor" stroke-width="2"/>' },
                { id: 'dashed', svg: '<line x1="2" y1="6" x2="38" y2="6" stroke="currentColor" stroke-width="2" stroke-dasharray="6,4"/>' },
                { id: 'dotted', svg: '<line x1="2" y1="6" x2="38" y2="6" stroke="currentColor" stroke-width="2" stroke-dasharray="2,3"/>' }
            ];

            styles.forEach((st) => {
                const btn = document.createElement('button');
                btn.className = this.currentStyle === st.id ? 'active' : '';
                btn.innerHTML = `<svg width="40" height="12">${st.svg}</svg>`;
                btn.onclick = () => {
                    this.currentStyle = st.id;
                    this.renderContent();
                    this.emitChange();
                };
                styleGroup.appendChild(btn);
            });
            this.popover.appendChild(styleGroup);
        }
    }

    private selectColor(color: string) {
        this.currentColor = color.toUpperCase();
        this.renderContent();
        this.emitChange();
    }

    private emitChange() {
        if (!this.currentOptions) return;
        this.currentOptions.onChange({
            color: this.currentColor,
            opacity: this.currentOpacity,
            thickness: this.currentThickness,
            style: this.currentStyle
        });
    }

    private positionPopover(anchor: HTMLElement) {
        if (!this.popover) return;
        const rect = anchor.getBoundingClientRect();
        const popW = 268;
        const popH = this.popover.offsetHeight || 300;

        let left = rect.left;
        let top = rect.bottom + 6;

        if (left + popW > window.innerWidth - 10) {
            left = window.innerWidth - popW - 10;
        }
        if (top + popH > window.innerHeight - 10) {
            top = rect.top - popH - 6;
        }

        this.popover.style.left = `${Math.max(10, left)}px`;
        this.popover.style.top = `${Math.max(10, top)}px`;
    }

    private addRecentColor(hex: string) {
        if (!this.recentColors.includes(hex)) {
            this.recentColors.unshift(hex);
            if (this.recentColors.length > 6) this.recentColors.pop();
            try {
                localStorage.setItem('ecochart_recent_colors', JSON.stringify(this.recentColors));
            } catch {
                // Ignore storage limits
            }
        }
    }

    private loadRecents() {
        try {
            const raw = localStorage.getItem('ecochart_recent_colors');
            if (raw) this.recentColors = JSON.parse(raw);
        } catch {
            // Fallback to default presets
        }
    }

    private handleOutsideClick = (e: PointerEvent) => {
        if (this.popover && !this.popover.contains(e.target as Node) && !this.currentOptions?.anchorElement.contains(e.target as Node)) {
            this.close();
        }
    };
}

export const colorPicker = ColorPicker.getInstance();