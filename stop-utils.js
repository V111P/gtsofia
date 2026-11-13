(function (root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.GTSofiaStopUtils = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalize(value) {
    return String(value ?? '').trim();
  }

  // Keep this ranking aligned with Scripts/transport_data/stops.py.
  // Prefer OSM-enriched public names, then a GTFS name and stop code;
  // physical stops win only as the final tie-breaker. Stable first record wins
  // when all ranking fields are equal.
  function stopPreferenceScore(stop) {
    return [
      Boolean(normalize(stop?.osm_stop_name)),
      Boolean(normalize(stop?.stop_name)),
      Boolean(normalize(stop?.stop_code)),
      normalize(stop?.location_type) === '0'
    ];
  }

  function compareStopPreference(left, right) {
    const leftScore = stopPreferenceScore(left);
    const rightScore = stopPreferenceScore(right);

    for (let index = 0; index < leftScore.length; index++) {
      if (leftScore[index] === rightScore[index]) continue;
      return leftScore[index] ? 1 : -1;
    }

    return 0;
  }

  function findPreferredStop(stops, predicate) {
    let preferred = null;

    for (const stop of Array.isArray(stops) ? stops : []) {
      if (!predicate(stop)) continue;
      if (!preferred || compareStopPreference(stop, preferred) > 0) {
        preferred = stop;
      }
    }

    return preferred;
  }

  function buildStopIndexes(stops) {
    const byId = new Map();
    const byCode = new Map();

    for (const stop of Array.isArray(stops) ? stops : []) {
      const id = normalize(stop?.stop_id);
      const code = normalize(stop?.stop_code);

      if (id) {
        const current = byId.get(id);
        if (!current || compareStopPreference(stop, current) > 0) {
          byId.set(id, stop);
        }
      }

      if (code) {
        const current = byCode.get(code);
        if (!current || compareStopPreference(stop, current) > 0) {
          byCode.set(code, stop);
        }
      }
    }

    return { byId, byCode };
  }

  function uniqueStopsById(stops) {
    const byId = new Map();

    for (const stop of Array.isArray(stops) ? stops : []) {
      const id = normalize(stop?.stop_id);
      if (!id) continue;

      const current = byId.get(id);
      if (!current || compareStopPreference(stop, current) > 0) {
        byId.set(id, stop);
      }
    }

    return [...byId.values()];
  }

  return {
    stopPreferenceScore,
    compareStopPreference,
    findPreferredStop,
    buildStopIndexes,
    uniqueStopsById
  };
});
