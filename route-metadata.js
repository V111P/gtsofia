(function exposeRouteMetadata(root, factory) {
    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.GTSofiaRouteMetadata = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRouteMetadataApi() {
    'use strict';

    const TYPE_BY_GTFS_CODE = Object.freeze({
        '0': 'tram',
        '1': 'metro',
        '3': 'bus',
        '11': 'trolley'
    });

    const ALLOWED_TYPES = new Set(['bus', 'tram', 'trolley', 'metro', 'other']);
    const ALLOWED_SUBTYPES = new Set(['', 'night', 'school', 'temporary']);

    const TYPE_COLORS = Object.freeze({
        bus: '#BE1E2D',
        tram: '#F7941D',
        trolley: '#27AAE1',
        metro: '#1C75BC',
        other: '#BE1E2D'
    });

    let routeOverrides = loadDefaultOverrides();

    function loadDefaultOverrides() {
        // The same module is used in Node (API) and in the browser. Load the
        // local JSON file automatically on the server; browsers inject it via
        // setRouteOverrides() after fetching config/route-overrides.json.
        if (typeof module !== 'object' || !module.exports || typeof require !== 'function') {
            return Object.freeze({});
        }

        try {
            // Keep this as a static JSON import so serverless bundlers include
            // the configuration file in the deployed API function.
            return normalizeOverrides(require('./config/route-overrides.json'));
        } catch (error) {
            // A malformed optional configuration must not prevent the API
            // from starting. The tests validate the configuration separately.
            return Object.freeze({});
        }
    }

    function normalizeOverrides(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return Object.freeze({});
        }

        const normalized = {};
        for (const [routeId, rawOverride] of Object.entries(value)) {
            const id = String(routeId || '').trim();
            if (!id || !rawOverride || typeof rawOverride !== 'object' || Array.isArray(rawOverride)) {
                continue;
            }

            const override = {};
            if (Object.hasOwn(rawOverride, 'number')) {
                override.number = String(rawOverride.number ?? '').trim();
            }
            if (Object.hasOwn(rawOverride, 'type')) {
                const type = String(rawOverride.type ?? '').trim().toLowerCase();
                if (ALLOWED_TYPES.has(type)) override.type = type;
            }
            if (Object.hasOwn(rawOverride, 'subtype')) {
                const subtype = String(rawOverride.subtype ?? '').trim().toLowerCase();
                if (ALLOWED_SUBTYPES.has(subtype)) override.subtype = subtype;
            }
            if (Object.hasOwn(rawOverride, 'color')) {
                const color = normalizeColor(rawOverride.color);
                if (color) override.color = color;
            }
            if (Object.hasOwn(rawOverride, 'textColor')) {
                const textColor = normalizeColor(rawOverride.textColor);
                if (textColor) override.textColor = textColor;
            }

            if (Object.keys(override).length) normalized[id] = Object.freeze(override);
        }

        return Object.freeze(normalized);
    }

    function setRouteOverrides(value) {
        routeOverrides = normalizeOverrides(value);
        return routeOverrides;
    }

    function getRouteOverrides() {
        return routeOverrides;
    }

    function normalizeRouteRef(value) {
        let ref = String(value ?? '').trim().toUpperCase();
        if (!ref) return '';

        const number = ref.replace(/[a-zа-я]/gi, '');

        if (ref.startsWith('E') || ref.startsWith('Е')) {
            ref = number;
        } else if (ref.startsWith('N')) {
            ref = `N${number}`;
        } else if (ref.startsWith('Y')) {
            ref = `У${number}`;
        } else if (ref.endsWith('ТБ') || ref.endsWith('TB')) {
            ref = `${number}ТБ`;
        } else if (
            ref.endsWith('ТМ')
            || ref.endsWith('TM')
            || ref.endsWith('Т')
            || ref.endsWith('T')
        ) {
            ref = `${number}ТМ`;
        }

        return ref;
    }

    function determineRouteType(routeRef, routeTypeCode) {
        let type = TYPE_BY_GTFS_CODE[String(routeTypeCode ?? '')] || 'other';

        if (
            routeRef.endsWith('ТБ')
            || routeRef.endsWith('ТМ')
            || ((routeRef.startsWith('М') || routeRef.startsWith('M')) && type === 'bus')
        ) {
            type = 'bus';
        }

        // Match Dimitar's route sort rule: trolleybus route refs numbered 50+
        // are replacement bus services in the Sofia GTFS feed.
        const sortRef = Number.parseInt(routeRef.replace(/[a-zа-я]/gi, ''), 10);
        if (Number.isFinite(sortRef) && sortRef >= 50 && type === 'trolley') {
            type = 'bus';
        }

        return type;
    }

    function determineRouteSubtype(routeRef, type) {
        if (routeRef.startsWith('N')) return 'night';
        if (routeRef.startsWith('У')) return 'school';

        if (
            type === 'bus'
            && (
                routeRef.endsWith('ТБ')
                || routeRef.endsWith('ТМ')
                || routeRef.startsWith('M')
                || routeRef.startsWith('М')
            )
        ) {
            return 'temporary';
        }

        return '';
    }

    function normalizeColor(value) {
        let color = String(value ?? '').trim();
        if (!color) return '';
        if (!color.startsWith('#')) color = `#${color}`;
        return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color.toUpperCase() : '';
    }

    function getRouteMetadata(route, overrides = routeOverrides) {
        if (!route || typeof route !== 'object') return null;

        const id = String(route.route_id ?? '').trim();
        const normalizedRef = normalizeRouteRef(route.route_short_name);
        const computedType = determineRouteType(normalizedRef, route.route_type);
        const override = overrides && typeof overrides === 'object'
            ? (overrides[id] || {})
            : {};

        const type = ALLOWED_TYPES.has(String(override.type || '').toLowerCase())
            ? String(override.type).toLowerCase()
            : computedType;
        const computedSubtype = determineRouteSubtype(normalizedRef, type);
        const subtype = Object.hasOwn(override, 'subtype')
            && ALLOWED_SUBTYPES.has(String(override.subtype ?? '').toLowerCase())
            ? String(override.subtype ?? '').toLowerCase()
            : computedSubtype;

        // Metro line IDs in GTFS are prefixed with M, but this project displays
        // metro numbers without it. A temporary bus M3 keeps its M prefix.
        const computedNumber = type === 'metro'
            ? normalizedRef.replace(/^[МM]/i, '')
            : normalizedRef;
        const number = Object.hasOwn(override, 'number')
            ? String(override.number ?? '').trim()
            : computedNumber;

        const icon = type === 'bus' && subtype === 'night'
            ? 'Icons/Active icons/night-bus.svg'
            : ({
                bus: 'Icons/Active icons/bus.svg',
                trolley: 'Icons/Active icons/trolley.svg',
                tram: 'Icons/Active icons/tram.svg',
                metro: 'Icons/Active icons/metro.svg'
            })[type] || '';

        // Night routes publish route_color=000000 in the current GTFS feed.
        // Keep that dedicated colour instead of falling back to the generic
        // red bus colour; other surface modes use the shared type palette.
        const sourceColor = normalizeColor(route.route_color);
        const defaultColor = type === 'metro'
            ? (sourceColor || TYPE_COLORS.metro)
            : (subtype === 'night'
                ? (sourceColor || '#000000')
                : (TYPE_COLORS[type] || TYPE_COLORS.bus));
        const color = normalizeColor(override.color) || defaultColor;
        const textColor = normalizeColor(override.textColor)
            || normalizeColor(route.route_text_color)
            || '#FFFFFF';

        return {
            id,
            number: number || '—',
            type,
            subtype,
            icon,
            color,
            textColor
        };
    }

    return Object.freeze({
        normalizeRouteRef,
        determineRouteType,
        determineRouteSubtype,
        normalizeOverrides,
        setRouteOverrides,
        getRouteOverrides,
        getRouteMetadata
    });
});
