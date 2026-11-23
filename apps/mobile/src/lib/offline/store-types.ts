export interface LocalStore {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  insert(key: string, value: unknown): Promise<void>;
  list<T>(prefix: string): Promise<{ key: string; value: T }[]>;
  remove(key: string): Promise<void>;
}
