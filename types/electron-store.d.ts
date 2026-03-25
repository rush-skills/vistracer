declare module "electron-store" {
  export interface StoreOptions<T extends Record<string, any>> {
    name?: string;
    defaults?: Partial<T>;
  }

  export default class Store<T extends Record<string, any> = Record<string, unknown>> {
    constructor(options?: StoreOptions<T>);

    get<K extends keyof T>(key: K): T[K];
    get<K extends keyof T>(key: K, defaultValue: T[K]): T[K];
    get<R = unknown>(key: string, defaultValue?: R): R;

    set<K extends keyof T>(key: K, value: T[K]): void;
    set(key: string, value: unknown): void;
    set(object: Partial<T>): void;

    has(key: keyof T | string): boolean;
    delete(key: keyof T | string): void;
    clear(): void;
  }
}
