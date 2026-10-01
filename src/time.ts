const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export function formatLocalIso(d: Date): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const date = `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${date}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function localDateStamp(d: Date): string {
  return `${pad(d.getFullYear(), 4)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

export function isIso8601(value: string): boolean {
  return ISO_8601.test(value) && !Number.isNaN(Date.parse(value));
}
