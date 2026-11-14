/**
 * CSV parser used by the Sofia Public Transport API upstream project.
 * Handles quoted fields, BOMs and common Bulgarian encodings.
 */
import { parse } from 'csv-parse/sync';

const CANDIDATE_ENCODINGS = ['utf8', 'win1251', 'win1250', 'latin1'];

function decodeString(data) {
  // Buffer.toString() does not throw for unsupported encodings. Keep the
  // explicit candidate list for clarity and use UTF-8 as the safe fallback.
  for (const encoding of CANDIDATE_ENCODINGS) {
    try {
      return data.toString(encoding);
    } catch {
      // Try the next encoding.
    }
  }
  return data.toString('utf8');
}

export function parseCSV(data) {
  const source = Buffer.isBuffer(data) ? decodeString(data) : String(data ?? '');
  const records = parse(source, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  });
  return {
    headers: records.length ? Object.keys(records[0]) : [],
    rows: records.map((row) => ({ ...row })),
  };
}
