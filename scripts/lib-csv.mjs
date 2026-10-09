// Minimal RFC 4180 CSV helpers shared by the analysis scripts.
import { readFileSync, existsSync } from "node:fs";

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || (ch === "\r" && next === "\n")) {
      row.push(field);
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      field = "";
      if (ch === "\r") i++;
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.length > 0)) rows.push(row);
  }
  return rows;
}

export function readCsvObjects(path) {
  if (!existsSync(path)) return [];
  const table = parseCsv(readFileSync(path, "utf8").replace(/^﻿/, ""));
  if (table.length < 2) return [];
  const headers = table[0];
  return table.slice(1).map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""])));
}

function escapeCsv(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers, records) {
  const lines = [headers.map(escapeCsv).join(",")];
  for (const record of records) lines.push(headers.map((h) => escapeCsv(record[h])).join(","));
  return lines.join("\n") + "\n";
}
