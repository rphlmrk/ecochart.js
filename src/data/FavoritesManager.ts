export class FavoritesManager {
    private static instance: FavoritesManager;

    private readonly STORAGE_KEY = 'ecochart_favorite_symbols_v1';
    private readonly PERSIST_FLAG_KEY = 'ecochart_only_save_favorites_v1';
    private readonly DEFAULT_FAVORITES = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];

    public favorites: Set<string>;
    public onlySaveFavorites: boolean = false;

    private constructor() {
        this.favorites = this.loadFavorites();
        this.onlySaveFavorites = this.loadOnlySaveFavorites();
    }

    public static getInstance(): FavoritesManager {
        if (!FavoritesManager.instance) {
            FavoritesManager.instance = new FavoritesManager();
        }
        return FavoritesManager.instance;
    }

    public isFavorite(symbol: string): boolean {
        return this.favorites.has(symbol.toUpperCase());
    }

    public toggleFavorite(symbol: string): boolean {
        const cleanSymbol = symbol.toUpperCase();
        if (this.favorites.has(cleanSymbol)) {
            this.favorites.delete(cleanSymbol);
        } else {
            this.favorites.add(cleanSymbol);
        }
        this.saveFavorites();
        this.emitChangeEvent();
        return this.isFavorite(cleanSymbol);
    }

    public getFavorites(): string[] {
        return Array.from(this.favorites);
    }

    public setFavorites(symbols: string[]): void {
        this.favorites = new Set(symbols.map(s => s.toUpperCase()));
        this.saveFavorites();
        this.emitChangeEvent();
    }

    public setOnlySaveFavorites(enabled: boolean): void {
        this.onlySaveFavorites = enabled;
        try {
            localStorage.setItem(this.PERSIST_FLAG_KEY, JSON.stringify(enabled));
        } catch { }
        this.emitChangeEvent();
    }

    /**
     * Multi-Pane Safe check:
     * Returns true if the symbol is in favorites OR currently open in any active pane.
     */
    public isProtected(symbol: string, activeSymbols: string[] = []): boolean {
        const cleanSymbol = symbol.toUpperCase();
        if (this.favorites.has(cleanSymbol)) return true;
        return activeSymbols.map(s => s.toUpperCase()).includes(cleanSymbol);
    }

    private emitChangeEvent(): void {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('ecochart-favorites-changed', {
                detail: {
                    favorites: this.getFavorites(),
                    onlySaveFavorites: this.onlySaveFavorites
                }
            }));
        }
    }

    private saveFavorites(): void {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.getFavorites()));
        } catch { }
    }

    private loadFavorites(): Set<string> {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return new Set(parsed.map((s: string) => s.toUpperCase()));
                }
            }
        } catch { }
        return new Set(this.DEFAULT_FAVORITES);
    }

    private loadOnlySaveFavorites(): boolean {
        try {
            const raw = localStorage.getItem(this.PERSIST_FLAG_KEY);
            return raw ? JSON.parse(raw) === true : false;
        } catch {
            return false;
        }
    }
}

export const favoritesManager = FavoritesManager.getInstance();