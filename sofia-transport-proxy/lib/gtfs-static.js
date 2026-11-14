/**
 * GTFS static data fetcher. Adapted from tanislavivanov/sofia-transport-api.
 * The proxy keeps a warm in-memory cache; GTSofia's own static timetable
 * remains authoritative for final virtual-board generation.
 */
import AdmZip from 'adm-zip';
import { parseCSV } from './csv.js';

const BASE_URL = 'https://gtfs.sofiatraffic.bg/api/v1/static';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 45_000;
const cache = new Map();
const inflight = new Map();

function isZip(buffer) {
  return buffer.length >= 4
    && buffer[0] === 0x50
    && buffer[1] === 0x4b
    && buffer[2] === 0x03
    && buffer[3] === 0x04;
}

async function fetchFile(filename) {
  const cached = cache.get(filename);
  if (cached && Date.now() < cached.expires) return cached.data;
  if (inflight.has(filename)) return inflight.get(filename);

  const request = (async () => {
    const url = `${BASE_URL}?file=${encodeURIComponent(filename)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`GTFS static ${filename}: HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error(`GTFS static ${filename}: empty response`);

    let payload = buffer;
    if (response.headers.get('content-type')?.includes('zip') || isZip(buffer)) {
      const zip = new AdmZip(buffer);
      const entry = zip.getEntry(filename);
      if (!entry) throw new Error(`GTFS static: ${filename} not found in ZIP`);
      payload = entry.getData();
    }

    cache.set(filename, { data: payload, expires: Date.now() + CACHE_TTL_MS });
    return payload;
  })().finally(() => inflight.delete(filename));

  inflight.set(filename, request);
  return request;
}

export async function getStops() {
  const raw = await fetchFile('stops.txt');
  const { rows } = parseCSV(raw);
  return rows
    .filter((row) => row.stop_id?.trim())
    .map((row) => ({
      id: row.stop_id,
      code: row.stop_code ?? '',
      name: row.stop_name ?? 'Unknown stop',
      latitude: Number.parseFloat(row.stop_lat) || 0,
      longitude: Number.parseFloat(row.stop_lon) || 0,
      description: row.stop_desc ?? '',
      title: (row.stop_code?.trim() ? `${row.stop_code} · ` : '') + (row.stop_name ?? ''),
    }))
    .sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
}

export async function getStopIdsByCode(code) {
  const stops = await getStops();
  const normalized = String(code ?? '').trim();
  if (!normalized) return [];
  return stops.filter((stop) => String(stop.code ?? '').trim() === normalized).map((stop) => stop.id);
}

export async function getStopByCode(code) {
  const stops = await getStops();
  const normalized = String(code ?? '').trim();
  if (!normalized) return null;
  const matches = stops.filter((stop) => String(stop.code ?? '').trim() === normalized);
  if (!matches.length) return null;
  const first = matches[0];
  const name = matches.map((stop) => stop.name).find((value) => value?.trim()) ?? first.name;
  const description = matches.map((stop) => stop.description).find((value) => value?.trim()) ?? first.description;
  return {
    code: normalized,
    name,
    latitude: first.latitude,
    longitude: first.longitude,
    description: description ?? '',
    title: first.code?.trim() ? `${first.code} · ${name}` : name,
    stopIds: matches.map((stop) => stop.id),
  };
}

export async function getTripLookup() {
  const [routesRaw, tripsRaw] = await Promise.all([fetchFile('routes.txt'), fetchFile('trips.txt')]);
  const routeRows = parseCSV(routesRaw).rows;
  const tripRows = parseCSV(tripsRaw).rows;
  const routesById = new Map();
  for (const row of routeRows) {
    if (!row.route_id?.trim()) continue;
    routesById.set(row.route_id, {
      short: (row.route_short_name ?? '').trim(),
      long: (row.route_long_name ?? '').trim(),
    });
  }

  const lookup = {};
  for (const row of tripRows) {
    if (!row.trip_id?.trim() || !row.route_id?.trim()) continue;
    const route = routesById.get(row.route_id);
    lookup[row.trip_id] = {
      tripId: row.trip_id,
      routeId: row.route_id,
      routeShortName: route?.short || route?.long || row.route_id,
      headsign: row.trip_headsign ?? '',
    };
  }
  return lookup;
}

export async function getRoutes() {
  const { rows } = parseCSV(await fetchFile('routes.txt'));
  return rows.filter((row) => row.route_id?.trim()).map((row) => ({
    route_id: row.route_id,
    route_short_name: (row.route_short_name ?? '').trim(),
    route_long_name: (row.route_long_name ?? '').trim(),
  }));
}

export async function getTrips() {
  const { rows } = parseCSV(await fetchFile('trips.txt'));
  return rows.filter((row) => row.trip_id?.trim()).map((row) => ({
    trip_id: row.trip_id,
    route_id: row.route_id,
    trip_headsign: row.trip_headsign ?? '',
  }));
}
