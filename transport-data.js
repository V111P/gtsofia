let gtfsRoutes = [];
let gtfsStops = [];
let transportDataPromise = null;

const TRANSPORT_DATA_FILES = [
    ['metadata', './data/metadata.json'],
    ['calendar', './data/calendar.json'],
    ['routes', './data/routes.json'],
    ['stops', './data/stops.json'],
    ['trips', './data/trips.json'],
    ['directions', './data/directions.json'],
    ['shapes', './data/shapes.json'],
    ['schedules', './data/schedules.json'],
    ['routeOverrides', './config/route-overrides.json'],
];

async function loadTransportData() {
    if (transportDataPromise) {
        return transportDataPromise;
    }

    transportDataPromise = (async () => {
        const entries = await Promise.all(
            TRANSPORT_DATA_FILES.map(async ([key, path]) => {
                const response = await fetch(path, { cache: 'no-store' });
                if (!response.ok) {
                    throw new Error(
                        `Неуспешно зареждане на ${path}: ${response.status}`
                    );
                }
                return [key, await response.json()];
            })
        );
        const parts = Object.fromEntries(entries);
        const routeMetadata = window.GTSofiaRouteMetadata;
        if (!routeMetadata || typeof routeMetadata.getRouteMetadata !== 'function') {
            throw new Error('Липсва route-metadata.js.');
        }
        routeMetadata.setRouteOverrides?.(parts.routeOverrides || {});
        const normalizedRoutes = (parts.routes || []).map(route => ({
            ...route,
            ...routeMetadata.getRouteMetadata(route)
        }));
        const data = {
            ...(parts.metadata || {}),
            calendar: parts.calendar || {},
            routes: normalizedRoutes,
            stops: parts.stops || [],
            trips: parts.trips || [],
            directions: parts.directions || {},
            shapes: parts.shapes || {},
            schedules: parts.schedules || {},
        };

        gtfsRoutes = data.routes;
        gtfsStops = data.stops;
        window.transportData = data;

        console.log('GTFS routes:', gtfsRoutes.length);
        console.log('GTFS stops:', gtfsStops.length);
        console.log('GTFS shapes:', Object.keys(data.shapes).length);

        return data;
    })();

    try {
        return await transportDataPromise;
    } catch (error) {
        // A failed request must not permanently cache a rejected promise.
        transportDataPromise = null;
        throw error;
    }
}


const TRANSPORT_TIME_ZONE = 'Europe/Sofia';
function getTransportCalendarDateKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TRANSPORT_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);

    const get = type =>
        parts.find(part => part.type === type)?.value || '';

    return `${get('year')}-${get('month')}-${get('day')}`;
}

function getTransportCalendarWeekday(date = new Date()) {
    const value = new Intl.DateTimeFormat('en-US', {
        timeZone: TRANSPORT_TIME_ZONE,
        weekday: 'short'
    }).format(date);

    return value;
}

function getTransportCalendarDayType(date = new Date()) {
    const key = getTransportCalendarDateKey(date);
    const calendar = window.transportData?.calendar;

    const cachedType =
        calendar?.dateTypes?.[key];

    if (
        cachedType === 'weekday' ||
        cachedType === 'weekend'
    ) {
        return cachedType;
    }

    const configuredType =
        calendar?.config?.dateOverrides?.[key];

    if (
        configuredType === 'weekday' ||
        configuredType === 'weekend'
    ) {
        return configuredType;
    }

    const weekday = getTransportCalendarWeekday(date);

    return weekday === 'Sat' || weekday === 'Sun'
        ? 'weekend'
        : 'weekday';
}

window.getTransportCalendarDateKey =
    getTransportCalendarDateKey;
window.getTransportCalendarDayType =
    getTransportCalendarDayType;


function getRouteMetadata(route) {
    const existing = route && route.type && route.number
        ? route
        : window.GTSofiaRouteMetadata?.getRouteMetadata(route);

    if (!existing) {
        return {
            type: 'other',
            number: '—',
            subtype: '',
            color: '#BE1E2D'
        };
    }

    return existing;
}

function getLineType(route) {
    return getRouteMetadata(route).type;
}

function getLineDisplayNumber(route, type) {
    return getRouteMetadata(route).number;
}

function getLineSubtype(route, type, displayNumber) {
    return getRouteMetadata(route).subtype || '';
}

function getTransportIcon(
    type,
    number,
    subtype = ''
) {
    if (type === 'bus' && subtype === 'night') {
        return 'Icons/Active icons/night-bus.svg';
    }

    switch (type) {
        case 'bus':
            return 'Icons/Active icons/bus.svg';

        case 'trolley':
            return 'Icons/Active icons/trolley.svg';

        case 'tram':
            return 'Icons/Active icons/tram.svg';

        case 'metro':
            return 'Icons/Active icons/metro.svg';

        default:
            return '';
    }
}


function getLineColor(route, type) {
    return getRouteMetadata(route).color;
}


function getDirections(
    routeLongName
) {
    const parts =
        String(
            routeLongName || ''
        )
            .split(' - ')
            .map(
                part =>
                    part.trim()
            )
            .filter(Boolean);

    return {
        A:
            parts[1]
                || parts[0]
                || '',

        B:
            parts[0]
                || parts[1]
                || ''
    };
}


function convertGtfsRoutes(
    routes,
    trips,
    directionsData
) {
    const activeRouteIds =
        new Set(
            trips
                .map(
                    trip =>
                        String(
                            trip.route_id || ''
                        ).trim()
                )
                .filter(Boolean)
        );

    return routes
        .filter(route =>
            activeRouteIds.has(
                String(
                    route.route_id || ''
                ).trim()
            )
        )
        .map(route => {

            const routeId =
                String(
                    route.route_id || ''
                ).trim();

            const type =
                getLineType(
                    route
                );

            const directionSource =
                directionsData &&
                directionsData[
                    routeId
                ]
                    ? directionsData[
                        routeId
                    ]
                    : {};

            const directionEntries =
                Object.entries(
                    directionSource
                );

            const directions =
                directionEntries
                    .map(
                        ([key, direction]) => ({
                            key,
                            ...direction
                        })
                    )
                    .filter(
                        direction =>
                            direction &&
                            direction.headsign
                    );

            /*
             * Старият A/B формат се запазва само
             * за съвместимост.
             */
            const directionA =
                directions[0]
                    || null;

            const directionB =
                directions[1]
                    || null;

            const fallback =
                getDirections(
                    route.route_long_name
                );

            const displayNumber = getLineDisplayNumber(
                route,
                type
            );

            const subtype = getLineSubtype(
                route,
                type,
                displayNumber
            );

            return {
                id:
                    routeId,

                number:
                    displayNumber,

                type,

                subtype,

                color:
                    getLineColor(
                        route,
                        type
                    ),

                textColor:
                    route.route_text_color
                        ? `#${route.route_text_color}`
                        : '#FFFFFF',

                icon:
                    getTransportIcon(
                        type,
                        displayNumber,
                        subtype
                    ),

                /*
                 * Новият реален списък от ВСИЧКИ
                 * направления.
                 */
                directions,

                /*
                 * Стар API за останалата част
                 * от стария сайт.
                 */
                directionA:
                    directionA || {
                        key: 'A',
                        headsign:
                            fallback.A,
                        stops: []
                    },

                directionB:
                    directionB || {
                        key: 'B',
                        headsign:
                            fallback.B,
                        stops: []
                    },

                stopsA:
                    directionA?.stops || [],

                stopsB:
                    directionB?.stops || [],

                activeDirection:
                    directionA?.key
                        || directions[0]?.key
                        || 'D1'
            };
        });
}


window.getLineDisplayNumber = getLineDisplayNumber;
window.getLineType = getLineType;
window.getLineSubtype = getLineSubtype;
window.getLineColor = getLineColor;
window.getTransportIcon = getTransportIcon;


async function loadTransportLines() {
    const data =
        await loadTransportData();

    return convertGtfsRoutes(
        data.routes || [],
        data.trips || [],
        data.directions || {}
    );
}
