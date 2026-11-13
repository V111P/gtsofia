/**
 * Minimal static GTFS lookup adapted from tanislavivanov/sofia-transport-api (MIT).
 * Static data is used only to resolve GTFS stop IDs/public stop codes and route display metadata.
 * It is never used to invent arrival times.
 */
import AdmZip from 'adm-zip';
import { parseCSV } from './csv.js';
import { findStopIds } from './stop-id-matcher.js';

const BASE_URL = 'https://gtfs.sofiatraffic.bg/api/v1/static';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const cache = new Map();
let lookupPromise = null;
let stopsPromise = null;

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

  const url = `${BASE_URL}?file=${encodeURIComponent(filename)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`GTFS static ${filename}: HTTP ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  let content = buffer;
  if (response.headers.get('content-type')?.includes('zip') || isZip(buffer)) {
    const archive = new AdmZip(buffer);
    const entry = archive.getEntry(filename);
    if (!entry) throw new Error(`GTFS static: ${filename} was not found in the ZIP archive.`);
    content = entry.getData();
  }

  cache.set(filename, { data: content, expires: Date.now() + CACHE_TTL_MS });
  return content;
}

export async function getStops() {
  if (!stopsPromise) {
    stopsPromise = (async () => {
      const { rows } = parseCSV(await fetchFile('stops.txt'));
      return rows
        .filter(row => row.stop_id?.trim())
        .map(row => ({
          id: row.stop_id.trim(),
          code: (row.stop_code ?? '').trim(),
          name: row.stop_name ?? '',
          latitude: Number.parseFloat(row.stop_lat) || 0,
          longitude: Number.parseFloat(row.stop_lon) || 0
        }));
    })().catch(error => {
      stopsPromise = null;
      throw error;
    });
  }
  return stopsPromise;
}

export async function getStopIdsByIdentifier(identifier) {
  return findStopIds(await getStops(), identifier);
}

export async function getTripLookup() {
  if (!lookupPromise) {
    lookupPromise = (async () => {
      const [routesRaw, tripsRaw] = await Promise.all([
        fetchFile('routes.txt'),
        fetchFile('trips.txt')
      ]);
      const { rows: routeRows } = parseCSV(routesRaw);
      const { rows: tripRows } = parseCSV(tripsRaw);
      const routesById = new Map();

      for (const row of routeRows) {
        const routeId = String(row.route_id ?? '').trim();
        if (!routeId) continue;
        routesById.set(routeId, {
          short: String(row.route_short_name ?? '').trim(),
          long: String(row.route_long_name ?? '').trim(),
          type: String(row.route_type ?? '').trim(),
          color: String(row.route_color ?? '').trim(),
          textColor: String(row.route_text_color ?? '').trim()
        });
      }

      const lookup = Object.create(null);
      for (const row of tripRows) {
        const tripId = String(row.trip_id ?? '').trim();
        const routeId = String(row.route_id ?? '').trim();
        if (!tripId || !routeId) continue;
        const route = routesById.get(routeId);
        lookup[tripId] = {
          tripId,
          routeId,
          routeShortName: route?.short || route?.long || routeId,
          routeType: route?.type || '',
          routeColor: route?.color || '',
          routeTextColor: route?.textColor || '',
          headsign: String(row.trip_headsign ?? '').trim()
        };
      }
      return lookup;
    })().catch(error => {
      lookupPromise = null;
      throw error;
    });
  }
  return lookupPromise;
}
