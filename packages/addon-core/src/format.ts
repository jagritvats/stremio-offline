const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Human-readable size using 1024-based units, e.g. "9.4 GB". */
export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit >= 3 && value < 100 ? 1 : 0;
  return `${value.toFixed(digits)} ${UNITS[unit] ?? "B"}`;
}

/** Whole-number percentage string, e.g. "58%"; undefined when total is unknown. */
export function formatPercent(done: number, total: number | undefined): string | undefined {
  if (total === undefined || !(total > 0)) return undefined;
  // Floor, but not through float noise: 58/100*100 is 57.999…, and that is 58%, not 57%.
  const percent = Math.floor((done / total) * 100 + 1e-9);
  return `${Math.max(0, Math.min(100, percent))}%`;
}
