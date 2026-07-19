export class Settings {
    static get(key: string): string | number | boolean | null {
        throw new Error('Must be run inside LutherManager client');
    }

    static getString(key: string, defaultValue?: string): string {
        throw new Error('Must be run inside LutherManager client');
    }

    static getNumber(key: string, defaultValue?: number): number {
        throw new Error('Must be run inside LutherManager client');
    }

    static getBoolean(key: string, defaultValue?: boolean): boolean {
        throw new Error('Must be run inside LutherManager client');
    }
}
