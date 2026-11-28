// Duration labels, from apps/web/src/laravelToolbar/model.ts.

const numberFormats = new Map<number, Intl.NumberFormat>();
function formatNumber(value: number, fractionDigits = 0): string {
  let format = numberFormats.get(fractionDigits);
  if (!format) {
    format = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    numberFormats.set(fractionDigits, format);
  }
  return format.format(value);
}

/** Three significant digits up to a minute, as `4.27 ms`, `245 ms` or `30.2 s`. */
export function formatMs(value: number): string {
  if (value < 10) return `${formatNumber(value, 2)} ms`;
  if (value < 100) return `${formatNumber(value, 1)} ms`;
  if (value < 999.5) return `${formatNumber(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 9.995) return `${formatNumber(seconds, 2)} s`;
  if (seconds < 59.95) return `${formatNumber(seconds, 1)} s`;
  const minutes = Math.floor(Math.round(seconds) / 60);
  const rest = Math.round(seconds) % 60;
  return minutes < 60 && rest > 0 ? `${minutes} min ${rest} s` : `${formatNumber(minutes)} min`;
}
