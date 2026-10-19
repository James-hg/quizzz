export interface StorageAdapter {
  /** Stores bytes under a freshly generated random key and returns that key. */
  put(data: Uint8Array): Promise<string>;
  get(key: string): Promise<Buffer>;
  /** Deleting a missing key is a no-op. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class StorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid storage key: ${JSON.stringify(key)}`);
    this.name = "StorageKeyError";
  }
}

export class StorageNotFoundError extends Error {
  constructor(key: string) {
    super(`Storage key not found: ${key}`);
    this.name = "StorageNotFoundError";
  }
}
