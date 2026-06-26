import process from 'node:process';

export function die(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

export function emitJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

export function emitJsonOrTable<T>(
  data: T,
  options: { json: boolean },
  formatTable: (d: T) => string,
): void {
  if (options.json) {
    emitJson(data);
    return;
  }
  process.stdout.write(formatTable(data));
}

export interface TableColumn<T> {
  header: string;
  width: number;
  value: (row: T) => string;
}

export function formatRows<T>(rows: T[], columns: TableColumn<T>[]): string {
  const header = columns.map((c) => c.header.padEnd(c.width)).join('  ');
  const lines: string[] = [header];
  for (const row of rows) {
    lines.push(columns.map((c) => c.value(row).padEnd(c.width)).join('  '));
  }
  return lines.join('\n') + '\n';
}

export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
