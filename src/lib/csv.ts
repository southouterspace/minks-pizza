export type CsvCell = string | number | null;

/**
 * RFC 4180 field: quoted when it holds a comma, quote or line break. A
 * leading =, +, - or @ gets a ' so spreadsheets don't run it as a formula;
 * a plain negative number like "-1.00" is left alone.
 */
export function csvField(value: CsvCell): string {
  if (value === null) return "";
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvResponse(
  filename: string,
  header: readonly string[],
  rows: readonly (readonly CsvCell[])[],
): Response {
  const lines = [header, ...rows].map((row) => row.map(csvField).join(","));
  return new Response(`${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
