/** Resolve either a GTFS stop_id or public stop_code to its GTFS stop_id(s). */
export function findStopIds(stops, identifier) {
  const normalized = String(identifier ?? '').trim();
  if (!normalized || !Array.isArray(stops)) return [];

  return [...new Set(stops
    .filter(stop => String(stop?.id ?? '').trim() === normalized
      || String(stop?.code ?? '').trim() === normalized)
    .map(stop => String(stop.id ?? '').trim())
    .filter(Boolean))];
}
