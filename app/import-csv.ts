/**
 * Reads a CSV in the browser. The export is full of names and addresses and never leaves the page:
 * only each contact's email and whether they cancelled go to the app. Handles quotes, doubled quotes,
 * commas and line breaks inside quotes, CRLF and a byte-order mark.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

export type BrowserContact = { number: number; email: string; cancelled: boolean };

/** Column names and cancelled values are the merchant's: another app's export won't match Conjured's. */
export function contactsFrom(
  text: string,
  columns: { email: string; status: string; cancelled: string },
): { ok: true; contacts: BrowserContact[] } | { ok: false; error: string } {
  const [header, ...rows] = parseCsv(text);
  if (!header) return { ok: false, error: "That file is empty." };
  const find = (name: string) =>
    header.findIndex((cell) => cell.trim().toLowerCase() === name.trim().toLowerCase());
  const email = find(columns.email);
  if (email < 0) return { ok: false, error: `No column called "${columns.email}" in that file.` };
  const status = columns.status.trim() ? find(columns.status) : -1;
  if (columns.status.trim() && status < 0) {
    return { ok: false, error: `No column called "${columns.status}" in that file.` };
  }
  const cancelled = columns.cancelled
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return {
    ok: true,
    contacts: rows.map((row, index) => ({
      number: index + 1,
      email: (row[email] ?? "").trim(),
      cancelled: status >= 0 && cancelled.includes((row[status] ?? "").trim().toLowerCase()),
    })),
  };
}
