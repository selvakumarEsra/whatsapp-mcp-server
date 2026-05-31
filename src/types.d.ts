declare module 'qrcode-terminal' {
  export function generate(text: string, options?: { small?: boolean }, cb?: (output: string) => void): void;
}

declare module 'node:sqlite' {
  type SqliteValue = string | number | bigint | null | Uint8Array;
  export class StatementSync {
    run(...params: SqliteValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: SqliteValue[]): unknown;
    all(...params: SqliteValue[]): unknown[];
    iterate(...params: SqliteValue[]): IterableIterator<unknown>;
  }
  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean; enableForeignKeyConstraints?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
    open(): void;
  }
}
