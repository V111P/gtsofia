(function exposeVirtualBoardProxy(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.GTSofiaVirtualBoardProxy = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createVirtualBoardProxyApi() {
  'use strict';

  const PROXY_URL = 'https://sft-proxy.onrender.com/virtual-board?stop_code=';

  function normalizeText(value) {
    return String(value ?? '').trim();
  }

  function isMetroStop(stop) {
    return /^M/i.test(normalizeText(stop?.stop_id))
      || /^M/i.test(normalizeText(stop?.stop_code));
  }

  function buildProxyUrl(stop) {
    const metro = isMetroStop(stop);
    const stopId = normalizeText(stop?.stop_id);
    const stopCode = normalizeText(stop?.stop_code);
    let code = stopCode || stopId;

    if (metro) {
      // The legacy proxy expects a numeric metro station code and the
      // standalone `&metro` flag, matching sofiatraffic-schedules.
      code = code.replace(/\D/g, '') || stopId.replace(/\D/g, '');
    }

    if (!code) {
      throw new Error('Липсва код на спирката.');
    }

    return `${PROXY_URL}${encodeURIComponent(code)}${metro ? '&metro' : ''}`;
  }

  function normalizeColor(value) {
    let color = normalizeText(value);
    if (!color) return '';
    if (!color.startsWith('#')) color = `#${color}`;
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color.toUpperCase() : '';
  }

  function normalizeRouteType(value) {
    const type = normalizeText(value).toLowerCase();
    if (type === 'subway' || type === 'underground') return 'metro';
    if (type === 'trolleybus' || type === 'trolley_bus') return 'trolley';
    if (['bus', 'tram', 'trolley', 'metro', 'other'].includes(type)) return type;
    return '';
  }

  function getStopDisplayName(stop) {
    return normalizeText(
      stop?.osm_stop_name
      || stop?.osm_name
      || stop?.name
      || stop?.stop_name
      || stop?.gtfs_stop_name
    );
  }

  function resolveDestination(value, options = {}) {
    if (value === null || value === undefined || value === '') return '';

    const original = typeof value === 'object'
      ? normalizeText(value.name || value.stop_name || value.headsign || value.stop_code || value.code || value.stop_id)
      : normalizeText(value);
    if (!original) return '';

    const metro = Boolean(options.isMetro);
    const byId = options.stopsById instanceof Map ? options.stopsById : new Map();
    const byCode = options.stopsByCode instanceof Map ? options.stopsByCode : new Map();
    const candidates = [original];

    if (metro) {
      const digits = original.replace(/\D/g, '');
      if (digits) {
        candidates.push(`M${digits}`, digits, `M${digits}St`);
      }
    } else if (/^M\d+$/i.test(original)) {
      candidates.push(original.replace(/^M/i, ''));
    }

    for (const candidate of [...new Set(candidates)]) {
      const stop = byId.get(candidate) || byCode.get(candidate);
      const name = getStopDisplayName(stop);
      if (name) return name;
    }

    return original;
  }

  function getMinutesUntilArrival(time) {
    if (time === null || time === undefined) return null;

    const source = typeof time === 'object' ? time : { t: time };
    if (source.t === null || source.t === undefined || source.t === '') return null;

    const minutes = Number(source.t);
    return Number.isFinite(minutes) ? minutes : null;
  }

  function normalizeBoard(payload, options = {}) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const loadedAt = Number.isFinite(Number(options.nowSeconds))
      ? Number(options.nowSeconds)
      : Date.now() / 1000;
    const metro = isMetroStop(options.stop);
    const resolveRouteMetadata = typeof options.resolveRouteMetadata === 'function'
      ? options.resolveRouteMetadata
      : () => null;

    // Keep every route and every arrival returned by the proxy. The proxy is
    // the source of truth for arrival calculations; the browser only sorts
    // the provided relative-minute values for presentation.
    const routes = (Array.isArray(source.routes) ? source.routes : [])
      .map((route, index) => {
        const rawRoute = route && typeof route === 'object'
          ? route
          : { value: route };
        const meta = resolveRouteMetadata(rawRoute) || {};
        const routeRef = normalizeText(rawRoute.route_ref || rawRoute.number || meta.number || '—');
        const times = (Array.isArray(rawRoute.times) ? rawRoute.times : [])
          .slice()
          .sort((left, right) => {
            const leftMinutes = getMinutesUntilArrival(left);
            const rightMinutes = getMinutesUntilArrival(right);
            if (leftMinutes === null) return rightMinutes === null ? 0 : 1;
            if (rightMinutes === null) return -1;
            return leftMinutes - rightMinutes;
          });

        return {
          ...rawRoute,
          route_id: normalizeText(rawRoute.cgm_id || rawRoute.route_id || meta.id || `${rawRoute.type || 'line'}:${routeRef}:${index}`),
          route_ref: routeRef,
          meta: {
            id: normalizeText(meta.id || rawRoute.cgm_id || rawRoute.route_id),
            number: normalizeText(meta.number || (normalizeRouteType(rawRoute.type) === 'metro' ? routeRef.replace(/^M/i, '') : routeRef)) || '—',
            type: normalizeRouteType(rawRoute.type) || normalizeRouteType(meta.type) || 'bus',
            subtype: normalizeText(rawRoute.subtype || meta.subtype),
            icon: normalizeText(meta.icon),
            color: normalizeColor(rawRoute.bg_color || rawRoute.color || rawRoute.route_color || meta.color) || '#BE1E2D',
            textColor: normalizeColor(rawRoute.text_color || rawRoute.textColor || meta.textColor) || '#FFFFFF'
          },
          destination: resolveDestination(
            rawRoute.destination ?? rawRoute.destination_stop_code ?? rawRoute.headsign ?? '',
            {
              isMetro: metro,
              stopsById: options.stopsById,
              stopsByCode: options.stopsByCode
            }
          ),
          // Preserve the proxy's original arrival objects, including `t`,
          // `extras`, and any optional status fields.
          times
        };
      });

    return {
      ...source,
      status: normalizeText(source.status) || (routes.length ? 'ok' : 'empty'),
      routes,
      loaded_at: loadedAt,
      realtime_status: normalizeText(source.realtime_status)
        || (metro ? 'not_applicable' : 'available')
    };
  }

  return Object.freeze({
    PROXY_URL,
    buildProxyUrl,
    isMetroStop,
    normalizeRouteType,
    getMinutesUntilArrival,
    normalizeBoard,
    resolveDestination
  });
});
