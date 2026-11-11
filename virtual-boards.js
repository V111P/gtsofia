(() => {
  const SOFIA_TIME_ZONE = "Europe/Sofia";
  const SOFIA_CENTER = [42.6977, 23.3219];

  let map = null;
  let selectedStopId = null;
  let refreshInFlight = false;
  let boardRenderToken = 0;
  let stopMarkers = null;
  let selectedStopMarker = null;
  let stopMarkersById = new Map();
  let transportData = null;
  let lastBoardData = null;
  let boardAutoRefreshTimer = null;
  let boardAutoRefreshFailures = 0;
  let boardInitialLoadInFlight = false;
  const BOARD_AUTO_REFRESH_INTERVAL_MS = 30_000;
  const BOARD_AUTO_REFRESH_STATIC_INTERVAL_MS = 60_000;
  const BOARD_AUTO_REFRESH_MAX_INTERVAL_MS = 120_000;
  const REALTIME_ARRIVAL_HISTORY_KEY = 'gtsofia.virtualBoard.realtimeArrivalHistory.v1';
  const REALTIME_ARRIVAL_HISTORY_TTL_SECONDS = 36 * 60 * 60;
  const REALTIME_FEED_MAX_AGE_SECONDS = 120;
  const REALTIME_FEED_MAX_FUTURE_SKEW_SECONDS = 60;
  let realtimeArrivalHistoryMemory = [];
  const boardPanel = () =>
    document.getElementById("virtualBoardBody");

  const FAVORITE_STOPS_KEY =
    "gtsofia.favoriteStops";

  function getFavoriteStops() {
    try {
      const value = JSON.parse(
        localStorage.getItem(
          FAVORITE_STOPS_KEY
        ) || "[]"
      );

      return Array.isArray(value)
        ? value
        : [];
    } catch {
      return [];
    }
  }

  function isFavoriteStop(stopId) {
    return getFavoriteStops().some(
      item =>
        String(item.stop_id)
        === String(stopId)
    );
  }

  function setFavoriteStop(stop) {
    const favorites =
      getFavoriteStops();

    const index =
      favorites.findIndex(
        item =>
          String(item.stop_id)
          === String(stop.stop_id)
      );

    if (index >= 0) {
      favorites.splice(index, 1);
    } else {
      favorites.push({
        stop_id: String(stop.stop_id),
        stop_code: String(
          stop.stop_code
          || stop.stop_id
          || ""
        ),
        stop_name: getStopDisplayName(stop)
      });
    }

    localStorage.setItem(
      FAVORITE_STOPS_KEY,
      JSON.stringify(favorites)
    );

    return index < 0;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalizeTripDate(value) {
    return String(value ?? '').trim().replace(/-/g, '');
  }

  function getArrivalTripIdentity(route, time, stopId) {
    const identity = {
      stop_id: String(stopId ?? '').trim(),
      route_id: String(time?.route_id || route?.route_id || '').trim(),
      trip_id: String(
        time?.trip_id
        || route?.matched_static_trip_id
        || route?.trip_id
        || route?.original_trip_id
        || ''
      ).trim(),
      realtime_trip_id: String(
        time?.realtime_trip_id || route?.realtime_trip_id || ''
      ).trim(),
      stop_update_state: String(time?.stop_update_state || route?.stop_update_state || '').trim(),
      trip_start_date: normalizeTripDate(
        time?.trip_start_date || route?.trip_start_date || ''
      ),
      trip_start_time: String(
        time?.trip_start_time || route?.trip_start_time || ''
      ).trim(),
      direction_id: String(time?.direction_id || route?.direction_id || '').trim(),
      terminal_stop_id: String(
        time?.terminal_stop_id || route?.terminal_stop_id || route?.destination_stop_id || ''
      ).trim(),
      // Scheduled event time is a stronger cross-version alias than a
      // producer-specific Trip ID. It lets older history entries match the
      // canonical GTFS Trip ID after backend identity normalization.
      scheduled_time: (() => {
        const hasValue = value => value !== null && value !== undefined && value !== '';
        const explicit = hasValue(time?.scheduled_time) ? Number(time.scheduled_time) : NaN;
        if (Number.isFinite(explicit)) return explicit;
        if (time?.scheduled === true) {
          const planned = hasValue(time?.timestamp) ? Number(time.timestamp) : NaN;
          return Number.isFinite(planned) ? planned : null;
        }
        const actual = hasValue(time?.timestamp) ? Number(time.timestamp) : NaN;
        const delay = hasValue(time?.delay) ? Number(time.delay) : NaN;
        return Number.isFinite(actual) && Number.isFinite(delay) ? actual - delay : null;
      })()
    };

    if (!identity.stop_id || !identity.route_id) return null;
    if (!identity.trip_id && !identity.trip_start_time) return null;
    return identity;
  }

  function sameArrivalTrip(left, right) {
    if (!left || !right) return false;
    if (left.stop_id !== right.stop_id || left.route_id !== right.route_id) return false;

    const leftTripIds = new Set([left.trip_id, left.realtime_trip_id].filter(Boolean));
    const rightTripIds = new Set([right.trip_id, right.realtime_trip_id].filter(Boolean));
    const sharedTripIds = [...leftTripIds].filter(id => rightTripIds.has(id));
    const hasSharedTripId = leftTripIds.size > 0 && rightTripIds.size > 0;
    const sameTripId = sharedTripIds.length > 0;
    const leftScheduledTime = left.scheduled_time === null || left.scheduled_time === undefined
      || left.scheduled_time === '' ? NaN : Number(left.scheduled_time);
    const rightScheduledTime = right.scheduled_time === null || right.scheduled_time === undefined
      || right.scheduled_time === '' ? NaN : Number(right.scheduled_time);
    const hasSameScheduledStopTime = Number.isFinite(leftScheduledTime)
      && Number.isFinite(rightScheduledTime)
      && Math.abs(leftScheduledTime - rightScheduledTime) <= 1;
    const hasConflictingScheduledTimes = Number.isFinite(leftScheduledTime)
      && Number.isFinite(rightScheduledTime)
      && !hasSameScheduledStopTime;
    const hasSameStartTime = Boolean(left.trip_start_time && right.trip_start_time
      && left.trip_start_time === right.trip_start_time);
    const hasSameDirection = Boolean(left.direction_id && right.direction_id
      && left.direction_id === right.direction_id);
    const hasConflictingDirections = Boolean(left.direction_id && right.direction_id
      && left.direction_id !== right.direction_id);
    const hasConflictingTerminals = Boolean(left.terminal_stop_id && right.terminal_stop_id
      && left.terminal_stop_id !== right.terminal_stop_id);

    // The absolute scheduled passage time at this exact stop already includes
    // the service date. It is therefore a stronger cross-version identity than
    // TripDescriptor.start_date/start_time, which some feed variants omit or
    // encode differently for trips crossing midnight (e.g. 24:10 vs 00:10).
    // Keep route, stop, direction and terminal as safeguards against matching
    // a different course that happens to use the same timetable minute.
    const exactScheduledTimeAlias = hasSameScheduledStopTime
      && !hasConflictingDirections
      && !hasConflictingTerminals;
    const legacyIdAlias = hasSameStartTime && hasSameDirection && !hasConflictingScheduledTimes;

    if (hasSharedTripId && !sameTripId && !exactScheduledTimeAlias && !legacyIdAlias) {
      // Older browser history may contain the producer's Trip ID while a
      // newer API response carries the canonical GTFS original_trip_id.
      // Exact stop-time identity can bridge that difference even when the
      // producer's service-date/start-time representation differs.
      return false;
    }
    if (!hasSharedTripId && !exactScheduledTimeAlias && (!left.trip_start_time || !right.trip_start_time
      || left.trip_start_time !== right.trip_start_time)) {
      return false;
    }

    if (!exactScheduledTimeAlias && left.trip_start_date && right.trip_start_date
      && left.trip_start_date !== right.trip_start_date) return false;
    if (!exactScheduledTimeAlias && left.trip_start_time && right.trip_start_time
      && left.trip_start_time !== right.trip_start_time) return false;

    // Matching Trip IDs are strongest. If the IDs conflict and we are using
    // a scheduled-time alias to bridge producer/GTFS identities, direction is
    // still a required discriminator whenever both versions provide it.
    // Otherwise two opposite-direction trips at the same stop/time could be
    // mistaken for the same vehicle and the wrong GTFS fallback suppressed.
    if (!sameTripId && left.direction_id && right.direction_id
      && left.direction_id !== right.direction_id) return false;

    return true;
  }

  function getArrivalHistoryKey(identity) {
    if (!identity) return '';
    const tripIdentity = identity.trip_id
      ? `trip:${identity.trip_id}`
      : `start:${identity.trip_start_time}`;
    const directionIdentity = identity.trip_id ? '' : identity.direction_id;
    return [
      identity.stop_id,
      identity.route_id,
      tripIdentity,
      identity.trip_start_date,
      identity.trip_start_time,
      directionIdentity
    ].join('|');
  }

  function getRouteFirstArrivalTimestamp(route) {
    const timestamps = (Array.isArray(route?.times) ? route.times : [])
      .filter(time => time?.timestamp !== null && time?.timestamp !== undefined && time?.timestamp !== '')
      .map(time => Number(time.timestamp))
      .filter(Number.isFinite);
    return timestamps.length ? Math.min(...timestamps) : Number.POSITIVE_INFINITY;
  }

  function sortBoardRoutesByNextArrival(routes) {
    return (Array.isArray(routes) ? routes : [])
      .map(route => ({
        ...route,
        times: (Array.isArray(route?.times) ? route.times : [])
          .slice()
          .sort((left, right) => Number(left?.timestamp) - Number(right?.timestamp))
      }))
      .sort((left, right) => {
        const timeDifference = getRouteFirstArrivalTimestamp(left)
          - getRouteFirstArrivalTimestamp(right);
        if (timeDifference) return timeDifference;

        const lineDifference = String(left?.route_ref || left?.meta?.number || '')
          .localeCompare(String(right?.route_ref || right?.meta?.number || ''), 'bg', { numeric: true });
        if (lineDifference) return lineDifference;

        const destinationDifference = String(left?.destination || left?.headsign || '')
          .localeCompare(String(right?.destination || right?.headsign || ''), 'bg');
        if (destinationDifference) return destinationDifference;

        return String(left?.route_id || '').localeCompare(String(right?.route_id || ''));
      });
  }

  function readRealtimeArrivalHistory(nowSeconds = Date.now() / 1000) {
    let stored = [];
    try {
      if (typeof localStorage !== 'undefined') {
        const parsed = JSON.parse(
          localStorage.getItem(REALTIME_ARRIVAL_HISTORY_KEY) || '[]'
        );
        if (Array.isArray(parsed)) stored = parsed;
      }
    } catch {
      // Storage may be unavailable in private/restricted browsing contexts.
    }

    const cutoff = nowSeconds - REALTIME_ARRIVAL_HISTORY_TTL_SECONDS;
    const combined = [...stored, ...realtimeArrivalHistoryMemory]
      .filter(item => Number(item?.remembered_at) >= cutoff
        && Number.isFinite(Number(item?.timestamp)));

    const unique = new Map();
    for (const item of combined) {
      const identity = item?.identity;
      if (!identity) continue;
      const key = getArrivalHistoryKey(identity);
      const existing = unique.get(key);
      if (!existing || Number(item.remembered_at) >= Number(existing.remembered_at)) {
        unique.set(key, item);
      }
    }

    return [...unique.values()].slice(-500);
  }

  function writeRealtimeArrivalHistory(history) {
    realtimeArrivalHistoryMemory = history.slice(-500);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(
          REALTIME_ARRIVAL_HISTORY_KEY,
          JSON.stringify(realtimeArrivalHistoryMemory)
        );
      }
    } catch {
      // The in-memory copy still protects refreshes in the current page.
    }
  }

  function rememberRealtimeArrivalPredictions(boardData, stopId, nowSeconds = Date.now() / 1000) {
    const history = readRealtimeArrivalHistory(nowSeconds);
    const next = [...history];

    for (const route of Array.isArray(boardData?.routes) ? boardData.routes : []) {
      for (const time of Array.isArray(route?.times) ? route.times : []) {
        if (time?.scheduled === true || (route?.realtime !== true && time?.source !== 'realtime')) continue;
        const timestamp = Number(time?.timestamp);
        if (!Number.isFinite(timestamp)) continue;
        const identity = getArrivalTripIdentity(route, time, stopId);
        if (!identity) continue;

        const matchingIndex = next.findIndex(item => sameArrivalTrip(item.identity, identity));
        const previous = matchingIndex >= 0 ? next[matchingIndex] : null;
        const previousEarliest = Number(previous?.earliest_timestamp ?? previous?.timestamp);
        const earliestTimestamp = Number.isFinite(previousEarliest)
          ? Math.min(previousEarliest, timestamp)
          : timestamp;
        const previousPassedAt = previous?.passed_at === null || previous?.passed_at === undefined
          ? null
          : Number(previous.passed_at);
        const passedAt = previousPassedAt !== null && Number.isFinite(previousPassedAt)
          ? previousPassedAt
          : (earliestTimestamp <= nowSeconds ? nowSeconds : null);
        const record = {
          identity: {
            ...(previous?.identity || {}),
            ...identity,
            // Preserve a known identity field if this refresh omits it.
            trip_start_date: identity.trip_start_date || previous?.identity?.trip_start_date || '',
            trip_start_time: identity.trip_start_time || previous?.identity?.trip_start_time || '',
            direction_id: identity.direction_id || previous?.identity?.direction_id || '',
            realtime_trip_id: identity.realtime_trip_id || previous?.identity?.realtime_trip_id || ''
          },
          timestamp,
          earliest_timestamp: earliestTimestamp,
          passed_at: passedAt,
          missing_from_realtime_at: null,
          last_seen_realtime_at: nowSeconds,
          remembered_at: nowSeconds
        };
        if (matchingIndex >= 0) next[matchingIndex] = record;
        else next.push(record);
      }
    }

    writeRealtimeArrivalHistory(next.filter(item =>
      Number(item?.remembered_at) >= nowSeconds - REALTIME_ARRIVAL_HISTORY_TTL_SECONDS
    ));
  }

  function reconcileRealtimeCoursePresence(boardData, stopId, nowSeconds = Date.now() / 1000) {
    // Only a fresh, successfully fetched feed can prove that a previously
    // observed course has disappeared. An API outage, stale feed, metro board
    // or old server response must not retire realtime history.
    if (boardData?.realtime_status !== 'available') return false;
    if (!Array.isArray(boardData?.realtime_courses)) return false;

    const feedTimestamp = Number(boardData?.realtime_feed_timestamp);
    if (!Number.isFinite(feedTimestamp) || feedTimestamp <= 0) return false;
    const feedAge = nowSeconds - feedTimestamp;
    if (feedAge > REALTIME_FEED_MAX_AGE_SECONDS
      || feedAge < -REALTIME_FEED_MAX_FUTURE_SKEW_SECONDS) return false;

    const selectedStopId = String(stopId ?? '').trim();
    if (!selectedStopId) return false;

    const currentCourses = boardData.realtime_courses
      .map(course => getArrivalTripIdentity(course, {}, selectedStopId))
      .filter(Boolean);
    const history = readRealtimeArrivalHistory(nowSeconds);
    let changed = false;

    const reconciled = history.map(item => {
      const identity = item?.identity;
      if (!identity || String(identity.stop_id || '').trim() !== selectedStopId) return item;

      const matchingCourses = currentCourses.filter(course => sameArrivalTrip(identity, course));
      if (matchingCourses.length) {
        // If multiple descriptors describe the same physical course, any
        // target/upstream/unknown state takes precedence over a downstream-only
        // descriptor. This prevents duplicate raw-route + TripUpdate records
        // from falsely marking a course as already past the selected stop.
        const passedSelectedStop = matchingCourses.every(
          course => course.stop_update_state === 'downstream-only'
        );
        if (!passedSelectedStop) {
          const alreadyConfirmedPassed = item?.passed_at !== null
            && item?.passed_at !== undefined
            && Number.isFinite(Number(item.passed_at));
          // Once a later stop update has confirmed that this exact trip passed
          // the selected stop, a stale/reappearing descriptor must not undo
          // that fact on a subsequent poll.
          if (alreadyConfirmedPassed) return item;

          if (item.missing_from_realtime_at !== null && item.missing_from_realtime_at !== undefined) {
            changed = true;
            return { ...item, missing_from_realtime_at: null, last_seen_realtime_at: nowSeconds };
          }
          return item;
        }

        // If this exact course was previously shown realtime at the selected
        // stop, and the fresh TripUpdate now carries timed updates only for
        // downstream stops, the feed has advanced beyond this stop. This is
        // strong, monotonic evidence of passage: preserve it even if a later
        // snapshot briefly reintroduces an older target-stop update.
        const previousPassedAt = item?.passed_at === null || item?.passed_at === undefined
          ? null
          : Number(item.passed_at);
        const confirmedPassedAt = previousPassedAt !== null && Number.isFinite(previousPassedAt)
          ? previousPassedAt
          : nowSeconds;
        changed = true;
        return {
          ...item,
          passed_at: confirmedPassedAt,
          passed_reason: item?.passed_reason || 'downstream-only',
          missing_from_realtime_at: item?.missing_from_realtime_at ?? nowSeconds
        };
      }

      if (item?.passed_at !== null && item?.passed_at !== undefined
        && Number.isFinite(Number(item.passed_at))) {
        return item;
      }

      if (item.missing_from_realtime_at !== null && item.missing_from_realtime_at !== undefined
        && Number.isFinite(Number(item.missing_from_realtime_at))) {
        return item;
      }

      // A fresh feed no longer carries the descriptor for a course that was
      // previously displayed realtime at this exact stop. The vehicle may
      // have passed earlier than its last ETA, so waiting for that ETA would
      // resurrect the later GTFS timetable time. A descriptor with NO_DATA,
      // unknown coverage, or an upstream/target update is retained as present;
      // only a vanished descriptor or downstream-only progression retires it.
      changed = true;
      return { ...item, missing_from_realtime_at: nowSeconds };
    });

    if (changed) writeRealtimeArrivalHistory(reconciled);
    return changed;
  }

  function suppressPassedRealtimeFallbacks(boardData, stopId, nowSeconds = Date.now() / 1000) {
    const history = readRealtimeArrivalHistory(nowSeconds);
    let removedAny = false;
    const routes = (Array.isArray(boardData?.routes) ? boardData.routes : [])
      .map(route => {
        const times = (Array.isArray(route?.times) ? route.times : []).filter(time => {
          if (time?.scheduled !== true) return true;
          const identity = getArrivalTripIdentity(route, time, stopId);
          if (!identity) return true;

          const wasPredictedRealtime = history.some(item => {
            if (!sameArrivalTrip(item.identity, identity)) return false;
            const earliestTimestamp = Number(item.earliest_timestamp ?? item.timestamp);
            const hasPassedAt = item?.passed_at !== null
              && item?.passed_at !== undefined
              && Number.isFinite(Number(item.passed_at));
            const disappearedFromFreshFeed = item?.missing_from_realtime_at !== null
              && item?.missing_from_realtime_at !== undefined
              && Number.isFinite(Number(item.missing_from_realtime_at));
            return hasPassedAt
              || disappearedFromFreshFeed
              || (Number.isFinite(earliestTimestamp) && earliestTimestamp <= nowSeconds);
          });
          if (wasPredictedRealtime) removedAny = true;
          return !wasPredictedRealtime;
        });
        return { ...route, times };
      })
      .filter(route => route.times.length > 0);

    return {
      ...boardData,
      status: routes.length ? (boardData?.status || 'ok') : 'empty',
      // Client-side suppression can remove the first course from a grouped
      // line row. Re-sort after that removal so a line whose next remaining
      // course is later cannot stay above another line with an earlier arrival.
      routes: sortBoardRoutesByNextArrival(routes),
      passed_realtime_fallbacks_suppressed: removedAny
    };
  }

  function getStopDisplayName(stop) {
    return String(
      stop?.osm_stop_name
      || stop?.osm_name
      || stop?.name
      || stop?.stop_name
      || stop?.gtfs_stop_name
      || "Спирка"
    ).trim();
  }

  function getFavoriteStopDisplayName(favorite) {
    const currentStop = findStopById(favorite?.stop_id);
    return currentStop
      ? getStopDisplayName(currentStop)
      : String(favorite?.stop_name || "Спирка").trim();
  }

  function linePillHtml(line) {
    const number =
      escapeHtml(
        line?.number || "—"
      );

    const typeClass =
      line?.type === "metro"
        ? " metro"
        : (line?.subtype === "night" ? " night" : "");

    const color =
      escapeHtml(
        line?.color
        || "#BE1E2D"
      );

    const textColor =
      escapeHtml(
        line?.textColor
        || "#FFFFFF"
      );

    return (
      `<span class="schedule-line-pill${typeClass}"`
      + ` style="--line-color:${color};`
      + ` --line-text-color:${textColor};`
      + ` background-color:${color};`
      + ` color:${textColor};">`
      + `${number}</span>`
    );
  }

  function lineIdentityHtml(line) {
    const icon =
      line?.icon
        ? (
          `<span class="schedule-line-icon">`
          + `<img src="${escapeHtml(
              line.icon
            )}" alt="" aria-hidden="true">`
          + `</span>`
        )
        : "";

    return (
      `<span class="schedule-line-identity">`
      + `${icon}${linePillHtml(line)}`
      + `</span>`
    );
  }

  function destinationHtml(
    destination
  ) {
    return (
      `<span class="schedule-summary-arrow direction-arrow"`
      + ` aria-hidden="true">🞂</span>`
      + `<strong class="schedule-summary-destination vb-destination">`
      + `${escapeHtml(destination || "—")}`
      + `</strong>`
    );
  }

  function formatArrivalCountdown(
    timestamp,
    nowSeconds = Date.now() / 1000
  ) {
    const seconds = Number(timestamp);

    if (!Number.isFinite(seconds)) return "";

    const remainingSeconds =
      seconds - nowSeconds;

    // Minutes are calculated once from the board's load timestamp. They stay
    // fixed until the next automatic or manual board refresh.
    // Arrival has reached the stop.
    if (remainingSeconds <= 0) {
      return "0 мин.";
    }

    // Display whole minutes only, rounded to the nearest minute from the exact
    // remaining seconds (half a minute rounds up): 9:01 -> 9 мин., 9:30 ->
    // 10 мин. A remaining time below 30 seconds rounds to 0 мин.
    const minutes = Math.round(remainingSeconds / 60);

    return `${minutes} мин.`;
  }

  function formatArrivalClock(
    timestamp
  ) {
    const seconds =
      Number(timestamp);

    if (!Number.isFinite(seconds)) {
      return "—";
    }

    return new Intl.DateTimeFormat(
      "bg-BG",
      {
        timeZone: SOFIA_TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }
    ).format(
      new Date(seconds * 1000)
    );
  }

  function countdownHtml(
    arrival,
    showLive,
    snapshotSeconds = Date.now() / 1000
  ) {
    const timestamp =
      Number(arrival?.timestamp);

    if (!Number.isFinite(timestamp)) {
      return "";
    }

    const clock =
      formatArrivalClock(
        timestamp
      );

    const live =
      showLive
        ? '<span class="vb-arrival-live" aria-hidden="true"></span>'
        : "";

    const countdown =
      formatArrivalCountdown(
        timestamp,
        snapshotSeconds
      );

    return (
      `<div class="vb-arrival-main">`
      + `${live}`
      + `<span class="vb-arrival-clock">`
      + `${escapeHtml(clock)}`
      + `</span>`
      + `<span class="vb-arrival-separator" aria-hidden="true">·</span>`
      + `<span class="vb-arrival-minutes">`
      + `${escapeHtml(countdown)}`
      + `</span>`
      + `</div>`
    );
  }

  async function fetchStaticJson(url) {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(
        `Неуспешно зареждане на ${url}: ${response.status}`
      );
    }

    return response.json();
  }

  async function loadBoardMapData() {
    // The map needs only stop coordinates and the list of stops served by
    // each direction. Timetables and realtime data are now processed by API.
    const [rawStops, directions] = await Promise.all([
      fetchStaticJson("data/stops.json"),
      fetchStaticJson("data/directions.json")
    ]);

    const stopUtils = window.GTSofiaStopUtils;
    if (!stopUtils || typeof stopUtils.uniqueStopsById !== "function") {
      throw new Error("Липсва stop-utils.js.");
    }

    const indexes = stopUtils.buildStopIndexes(rawStops);
    return {
      stops: stopUtils.uniqueStopsById(rawStops),
      stopById: indexes.byId,
      stopByCode: indexes.byCode,
      directions
    };
  }

  async function fetchJsonWithTimeout(
    url,
    options = {},
    timeoutMs = 45000
  ) {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        timeoutMs
      );

    try {
      const response =
        await fetch(
          url,
          {
            ...options,
            signal:
              controller.signal,
            cache: "no-store"
          }
        );

      const data =
        await response.json();

      return {
        response,
        data
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchVirtualBoardViaServer(stop) {
    // stop_id is unambiguous for metro stops, whose stop_code may overlap
    // with a road-transport stop code.
    const stopCode = String(
      stop?.stop_id || stop?.stop_code || ''
    ).trim();

    if (!stopCode) {
      throw new Error('Липсва код на спирката.');
    }

    const url = `api/virtual-board?stop_code=${encodeURIComponent(stopCode)}`;
    const { response, data } = await fetchJsonWithTimeout(
      url,
      {
        headers: {
          Accept: 'application/json'
        }
      },
      20000
    );

    if (!response.ok) {
      throw new Error(
        data?.error || `Virtual board API returned ${response.status}.`
      );
    }

    const normalized = {
      ...data,
      status: data?.status || 'empty',
      routes: Array.isArray(data?.routes) ? data.routes : [],
      loaded_at: Date.now() / 1000
    };

    // Remember the last realtime prediction for each exact trip. Some feeds
    // remove a vehicle as soon as it has passed the selected stop; on the next
    // refresh that same trip can otherwise reappear from GTFS with its
    // later scheduled time (e.g. actual 14:39 vs timetable 14:42).
    rememberRealtimeArrivalPredictions(normalized, stopCode, normalized.loaded_at);
    reconcileRealtimeCoursePresence(normalized, stopCode, normalized.loaded_at);
    return suppressPassedRealtimeFallbacks(normalized, stopCode, normalized.loaded_at);
  }

  function bindRefreshButton() {
    const button =
      document.getElementById(
        "virtualBoardRefresh"
      );

    if (!button) return;

    button.onclick =
      () =>
        refreshSelectedBoard({ automatic: false });
  }

  function clearBoardAutoRefreshTimer() {
    if (boardAutoRefreshTimer !== null) {
      window.clearTimeout(boardAutoRefreshTimer);
      boardAutoRefreshTimer = null;
    }
  }

  function getBoardAutoRefreshDelay() {
    // Metro is schedule-only and does not need a frequent realtime poll.
    if (lastBoardData?.realtime_status === 'not_applicable') {
      return BOARD_AUTO_REFRESH_STATIC_INTERVAL_MS;
    }

    const backoffMultiplier = 2 ** Math.min(boardAutoRefreshFailures, 2);
    return Math.min(
      BOARD_AUTO_REFRESH_INTERVAL_MS * backoffMultiplier,
      BOARD_AUTO_REFRESH_MAX_INTERVAL_MS
    );
  }

  function recordBoardRefreshOutcome(data = null, error = null) {
    if (error || data?.realtime_status === 'unavailable') {
      boardAutoRefreshFailures = Math.min(boardAutoRefreshFailures + 1, 2);
      return;
    }

    if (data) {
      boardAutoRefreshFailures = 0;
      lastBoardData = data;
    }
  }

  function canAutoRefreshBoard() {
    return Boolean(selectedStopId)
      && document.visibilityState !== 'hidden'
      && Boolean(boardPanel()?.querySelector('.virtual-board-header'));
  }

  function scheduleBoardAutoRefresh(delayMs = getBoardAutoRefreshDelay()) {
    clearBoardAutoRefreshTimer();
    if (!canAutoRefreshBoard()) return;

    boardAutoRefreshTimer = window.setTimeout(() => {
      boardAutoRefreshTimer = null;
      if (!canAutoRefreshBoard()) return;

      // Never overlap requests. If an initial or manual request is still active,
      // retry the scheduling decision shortly instead of starting another call.
      if (refreshInFlight || boardInitialLoadInFlight) {
        scheduleBoardAutoRefresh(5_000);
        return;
      }

      refreshSelectedBoard({ automatic: true });
    }, delayMs);
  }

  function stopBoardAutoRefresh() {
    clearBoardAutoRefreshTimer();
    boardAutoRefreshFailures = 0;
  }

  function handleBoardVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      clearBoardAutoRefreshTimer();
      return;
    }

    if (!selectedStopId) return;
    clearBoardAutoRefreshTimer();

    if (refreshInFlight || boardInitialLoadInFlight) {
      scheduleBoardAutoRefresh(5_000);
      return;
    }

    // Refresh once when the user returns to the tab; the regular schedule
    // resumes only after that request completes.
    refreshSelectedBoard({ automatic: true });
  }

  function renderBoardStatus(panel, data, warning = '') {
    const statusElement = panel?.querySelector('.vb-board-status');
    if (!statusElement) return;

    const realtimeStatus = String(data?.realtime_status || 'available');
    const label = realtimeStatus === 'unavailable'
      ? (data?.realtime_message || 'Realtime временно недостъпен — показваме разписанието.')
      : '';

    if (warning) {
      statusElement.innerHTML = `
        <span class="vb-board-status-label is-warning">${escapeHtml(warning)}</span>
      `;
      return;
    }

    statusElement.innerHTML = label
      ? `<span class="vb-board-status-label is-warning">${escapeHtml(label)}</span>`
      : '';
  }

  function renderBoardList(
    panel,
    data
  ) {
    const list =
      panel?.querySelector(
        ".virtual-board-list"
      );

    if (!list) return;

    const snapshotSeconds = Number(data?.loaded_at) || Date.now() / 1000;
    renderBoardStatus(panel, data);

    if (
      data.status !== "ok"
      || !data.routes.length
    ) {
      list.innerHTML =
        `<div class="virtual-board-no-data">Няма предстоящи заминавания.</div>`;

      return;
    }

    // The API owns timetable selection, realtime/static merging, destination
    // resolution, deduplication and ordering. The browser only renders rows.
    const rows = sortBoardRoutesByNextArrival(data.routes.filter(
      route => Array.isArray(route?.times) && route.times.length > 0
    ));

    if (!rows.length) {
      list.innerHTML =
        `<div class="virtual-board-no-data">Няма предстоящи заминавания.</div>`;

      return;
    }

    list.innerHTML =
      rows.map(
        row => {
          const meta = row.meta || {
            id: row.route_id || row.routeId || '',
            number: row.route_ref || '—',
            type: 'bus',
            subtype: '',
            icon: '',
            color: '#BE1E2D',
            textColor: '#FFFFFF'
          };

          const arrivals =
            row.times;

          const nextTimes =
            arrivals
              .slice(1)
              .map(
                time => {
                  const tooltip =
                    formatArrivalCountdown(
                      time.timestamp,
                      snapshotSeconds
                    );

                  const clock =
                    formatArrivalClock(
                      time.timestamp
                    );

                  return (
                    `<span class="vb-next-time"`
                    + ` tabindex="0"`
                    + ` data-tooltip="${escapeHtml(
                        tooltip
                      )}"`
                    + ` aria-label="${escapeHtml(
                        tooltip
                      )}">`
                    + `${escapeHtml(clock)}`
                    + `</span>`
                  );
                }
              )
              .join("");

          return `
            <article class="vb-row">
              <div class="schedule-summary-route-row vb-route-row">
                ${lineIdentityHtml(meta)}
                ${destinationHtml(
                  row.destination
                  || row.headsign
                  || ""
                )}
              </div>
              <div class="vb-time-block">
                ${countdownHtml(
                  arrivals[0],
                  !arrivals[0]?.scheduled,
                  snapshotSeconds
                )}
                ${
                  arrivals.length > 1
                    ? (
                      `<div class="vb-next-times">`
                      + `${nextTimes}`
                      + `</div>`
                    )
                    : ""
                }
              </div>
            </article>
          `;
        }
      ).join("");
  }

  async function renderStopBoard(
    stop,
    boardData = null
  ) {
    stopBoardAutoRefresh();
    boardInitialLoadInFlight = true;

    const renderToken =
      ++boardRenderToken;

    selectedStopId =
      String(
        stop.stop_id
      );
    lastBoardData = null;

    const panel =
      boardPanel();

    if (!panel) {
      boardInitialLoadInFlight = false;
      return;
    }

    panel.innerHTML = `
      <div class="virtual-board-header">
        <div class="vb-board-heading">
          <div class="virtual-board-kicker">Спирка ${escapeHtml(
            stop.stop_code
            || stop.stop_id
            || ""
          )}</div>
          <h2>${escapeHtml(
            getStopDisplayName(stop)
          )}</h2>
          <div class="vb-board-status" role="status" aria-live="polite"></div>
        </div>
        <div class="virtual-board-header-actions">
          <button type="button" class="virtual-board-refresh is-loading" id="virtualBoardRefresh" disabled aria-label="Обнови таблото" title="Обнови таблото"><span aria-hidden="true">↻</span></button>
          <button type="button" class="virtual-board-favorite${
            isFavoriteStop(
              stop.stop_id
            )
              ? " is-favorite"
              : ""
          }" id="virtualBoardFavorite" aria-label="${
            isFavoriteStop(stop.stop_id)
              ? "Премахни от любими"
              : "Добави в любими"
          }" title="${
            isFavoriteStop(stop.stop_id)
              ? "Премахни от любими"
              : "Добави в любими"
          }"><span aria-hidden="true">${
            isFavoriteStop(
              stop.stop_id
            )
              ? "★"
              : "☆"
          }</span></button>
          <button type="button" class="virtual-board-close" id="virtualBoardClose" aria-label="Затвори таблото">×</button>
        </div>
      </div>
      <div class="virtual-board-list"><div class="virtual-board-loading">Зареждане…</div></div>
    `;

    document
      .getElementById(
        "virtualBoardClose"
      )
      ?.addEventListener(
        "click",
        () => {
          ++boardRenderToken;
          stopBoardAutoRefresh();
          boardInitialLoadInFlight = false;

          selectedStopId =
            null;
          lastBoardData = null;

          if (selectedStopMarker) {
            selectedStopMarker.setStyle(
              {
                fillColor:
                  "#111827",
                color:
                  "#ffffff",
                fillOpacity:
                  1
              }
            );

            selectedStopMarker =
              null;
          }

          renderEmptyBoard();
        }
      );

    document
      .getElementById(
        "virtualBoardFavorite"
      )
      ?.addEventListener(
        "click",
        event => {
          const button =
            event.currentTarget;

          const favorite =
            setFavoriteStop(
              stop
            );

          button.classList.toggle(
            "is-favorite",
            favorite
          );

          button.querySelector(
            "span"
          ).textContent =
            favorite
              ? "★"
              : "☆";

          button.setAttribute(
            "aria-label",
            favorite
              ? "Премахни от любими"
              : "Добави в любими"
          );

          button.setAttribute(
            "title",
            favorite
              ? "Премахни от любими"
              : "Добави в любими"
          );
        }
      );

    try {
      const data =
        boardData
        || await fetchVirtualBoardViaServer(
          stop
        );

      if (
        renderToken
          !== boardRenderToken
        || selectedStopId
          !== String(
            stop.stop_id
          )
      ) {
        return;
      }

      lastBoardData = data;
      recordBoardRefreshOutcome(data);
      renderBoardList(
        panel,
        data
      );
    } catch (error) {
      if (
        renderToken
          !== boardRenderToken
        || selectedStopId
          !== String(
            stop.stop_id
          )
      ) {
        return;
      }

      console.error(
        "Realtime virtual board error:",
        error
      );
      recordBoardRefreshOutcome(null, error);

      const list = panel.querySelector('.virtual-board-list');
      if (list) {
        list.innerHTML = `<div class="virtual-board-error">Таблото не може да бъде заредено. Ще опитаме отново автоматично.</div>`;
      }
      renderBoardStatus(panel, { realtime_status: 'unavailable' }, 'Неуспешно зареждане');
    } finally {
      if (
        renderToken
          !== boardRenderToken
        || selectedStopId
          !== String(
            stop.stop_id
          )
      ) {
        return;
      }

      boardInitialLoadInFlight = false;
      const refreshButton =
        document.getElementById(
          "virtualBoardRefresh"
        );

      if (refreshButton) {
        refreshButton.disabled =
          false;

        refreshButton.classList.remove(
          "is-loading"
        );

        bindRefreshButton();
      }
      scheduleBoardAutoRefresh();
    }
  }

  function renderEmptyBoard() {
    const panel =
      boardPanel();

    if (!panel) return;

    const favorites =
      getFavoriteStops();

    const favoritesHtml =
      favorites.length
        ? `
        <div class="virtual-board-favorites">
          <div class="virtual-board-favorites-heading">
            <h3>Любими спирки</h3>
          </div>
          <div class="virtual-board-favorites-list">
            ${favorites.map(
              stop => `
              <button type="button" class="virtual-board-favorite-stop" data-stop-id="${escapeHtml(
                stop.stop_id
              )}">
                <span class="virtual-board-favorite-stop-star" aria-hidden="true">★</span>
                <span class="virtual-board-favorite-stop-info">
                  <strong>${escapeHtml(
                    getFavoriteStopDisplayName(stop)
                  )}</strong>
                  <span>[${escapeHtml(
                    stop.stop_code
                    || stop.stop_id
                    || ""
                  )}]</span>
                </span>
                <span class="virtual-board-favorite-stop-arrow" aria-hidden="true">→</span>
              </button>
            `
            ).join("")}
          </div>
        </div>
      `
        : "";

    panel.innerHTML = `
      <div class="virtual-board-empty">
        <p>Изберете спирка от картата, за да видите следващите пристигания</p>
        ${favoritesHtml}
      </div>
    `;

    panel
      .querySelectorAll(
        ".virtual-board-favorite-stop"
      )
      .forEach(
        button => {
          button.addEventListener(
            "click",
            () => {
              const stop =
                findStopById(
                  button.dataset.stopId
                );

              if (stop) {
                selectStopOnMap(
                  stop
                );
              }
            }
          );
        }
      );
  }

  function findStopById(
    stopId
  ) {
    const key = String(stopId ?? "").trim();
    return transportData?.stopById?.get(key)
      || transportData?.stopByCode?.get(key)
      || null;
  }

  function selectStopOnMap(
    stop
  ) {
    if (
      !stop
      || !map
    ) {
      return;
    }

    if (selectedStopMarker) {
      selectedStopMarker.setStyle(
        {
          fillColor:
            "#111827",
          color:
            "#ffffff",
          fillOpacity:
            1
        }
      );
    }

    const lat =
      Number(
        stop.stop_lat
      );

    const lon =
      Number(
        stop.stop_lon
      );

    if (
      !Number.isFinite(lat)
      || !Number.isFinite(lon)
    ) {
      return;
    }

    const marker =
      stopMarkersById.get(
        String(
          stop.stop_id
        )
      );

    if (marker) {
      marker.setStyle(
        {
          fillColor:
            "#BE1E2D",
          color:
            "#ffffff",
          fillOpacity:
            1
        }
      );

      selectedStopMarker =
        marker;
    } else {
      selectedStopMarker =
        null;
    }

    renderStopBoard(
      stop
    );

    map.setView(
      [lat, lon],
      Math.max(
        map.getZoom(),
        15
      ),
      {
        animate: true
      }
    );
  }

  function setupStopSearch(
    stops
  ) {
    const input =
      document.getElementById(
        "stopSearch"
      );

    const results =
      document.getElementById(
        "stopSearchResults"
      );

    if (
      !input
      || !results
    ) {
      return;
    }

    const normalized =
      value =>
        String(value || "")
          .toLocaleLowerCase(
            "bg-BG"
          )
          .normalize("NFD")
          .replace(
            /[\u0300-\u036f]/g,
            ""
          );

    const searchStops =
      query => {
        const needle =
          normalized(
            query
          ).trim();

        if (!needle) {
          return [];
        }

        const seen =
          new Set();

        return stops
          .filter(
            stop => {
              const searchableNames = [
                getStopDisplayName(stop),
                stop.osm_stop_name_en,
                stop.gtfs_stop_name
              ].map(normalized);

              const code =
                normalized(
                  stop.stop_code
                  || stop.stop_id
                );

              return (
                searchableNames.some(name => name.includes(needle))
                || code.includes(
                  needle
                )
              );
            }
          )
          .filter(
            stop => {
              const key =
                String(
                  stop.stop_code
                  || stop.stop_id
                  || ""
                ).trim();

              if (
                !key
                || seen.has(key)
              ) {
                return false;
              }

              seen.add(key);

              return true;
            }
          )
          .slice(0, 8);
      };

    const renderResults =
      matches => {
        results.innerHTML =
          matches.length
            ? matches
                .map(
                  stop => `
                  <button type="button" class="virtual-stop-search-result" data-stop-id="${escapeHtml(
                    stop.stop_id
                  )}">
                    <strong>${escapeHtml(
                      getStopDisplayName(stop)
                    )}</strong>
                    <span>${escapeHtml(
                      stop.stop_code
                      || stop.stop_id
                      || ""
                    )}</span>
                  </button>
                `
                )
                .join("")
            : `<div class="virtual-stop-search-empty">Няма намерени спирки.</div>`;

        results.hidden =
          false;

        results
          .querySelectorAll(
            "[data-stop-id]"
          )
          .forEach(
            button => {
              button.addEventListener(
                "click",
                () => {
                  const stop =
                    findStopById(
                      button.dataset.stopId
                    );

                  if (stop) {
                    input.value = getStopDisplayName(stop);

                    results.hidden =
                      true;

                    selectStopOnMap(
                      stop
                    );
                  }
                }
              );
            }
          );
      };

    input.addEventListener(
      "input",
      () => {
        const query =
          input.value.trim();

        if (!query) {
          results.hidden =
            true;

          results.innerHTML =
            "";

          return;
        }

        renderResults(
          searchStops(
            query
          )
        );
      }
    );

    input.addEventListener(
      "focus",
      () => {
        if (
          input.value.trim()
        ) {
          renderResults(
            searchStops(
              input.value
            )
          );
        }
      }
    );

    document.addEventListener(
      "click",
      event => {
        if (
          !event.target.closest(
            ".virtual-stop-search"
          )
        ) {
          results.hidden =
            true;
        }
      }
    );
  }

  function setupGeolocation() {
    const button =
      document.getElementById(
        "locateUserButton"
      );

    if (!button) return;

    let userMarker =
      null;

    const locate = () => {
      if (
        !navigator.geolocation
      ) {
        window.alert(
          "Този браузър не поддържа определяне на локация."
        );

        return;
      }

      button.disabled =
        true;

      button.classList.add(
        "is-loading"
      );

      navigator.geolocation.getCurrentPosition(
        position => {
          const lat =
            position.coords.latitude;

          const lon =
            position.coords.longitude;

          if (!userMarker) {
            userMarker =
              L.circleMarker(
                [lat, lon],
                {
                  radius: 8,
                  weight: 3,
                  color: "#ffffff",
                  fillColor: "#2563eb",
                  fillOpacity: 1
                }
              ).addTo(map);

            userMarker.bindTooltip(
              "Вашата локация",
              {
                direction: "top",
                offset: [0, -8]
              }
            );
          } else {
            userMarker.setLatLng(
              [lat, lon]
            );
          }

          map.setView(
            [lat, lon],
            Math.max(
              map.getZoom(),
              15
            ),
            {
              animate: true
            }
          );

          button.disabled =
            false;

          button.classList.remove(
            "is-loading"
          );
        },
        error => {
          console.warn(
            "Грешка при определяне на локацията:",
            error
          );

          button.disabled =
            false;

          button.classList.remove(
            "is-loading"
          );

          window.alert(
            "Не успяхме да определим вашата локация. Проверете разрешението за достъп до местоположението."
          );
        },
        {
          enableHighAccuracy:
            true,
          timeout:
            10000,
          maximumAge:
            30000
        }
      );
    };

    button.addEventListener(
      "click",
      locate
    );
  }

  function addStopMarkers(
    stops
  ) {
    stopMarkers.clearLayers();
    stopMarkersById.clear();
    selectedStopMarker = null;

    const renderer =
      L.svg();

    for (
      const stop
      of stops
    ) {
      const lat =
        Number(
          stop.stop_lat
        );

      const lon =
        Number(
          stop.stop_lon
        );

      if (
        !Number.isFinite(lat)
        || !Number.isFinite(lon)
      ) {
        continue;
      }

      const clickTarget =
        L.circleMarker(
          [lat, lon],
          {
            radius: 16,
            weight: 0,
            stroke: false,
            fillColor:
              "#111827",
            fillOpacity:
              0.01,
            renderer,
            pane:
              "markerPane"
          }
        );

      const marker =
        L.circleMarker(
          [lat, lon],
          {
            radius: 7,
            weight: 2,
            color:
              "#ffffff",
            fillColor:
              "#111827",
            fillOpacity:
              1,
            renderer,
            pane:
              "markerPane"
          }
        );

      const stopTooltip =
        escapeHtml(getStopDisplayName(stop));

      marker.bindTooltip(
        stopTooltip,
        {
          direction:
            "top",
          offset:
            [0, -5]
        }
      );

      clickTarget.bindTooltip(
        stopTooltip,
        {
          direction:
            "top",
          offset:
            [0, -12]
        }
      );

      const select =
        () =>
          selectStopOnMap(
            stop
          );

      clickTarget.on(
        "click",
        select
      );

      marker.on(
        "click",
        select
      );

      clickTarget.addTo(
        stopMarkers
      );

      marker.addTo(
        stopMarkers
      );

      stopMarkersById.set(
        String(
          stop.stop_id
        ),
        marker
      );
    }
  }

  function getActiveStops(
    stops
  ) {
    const activeStopIds =
      new Set();

    for (
      const directionSet
      of Object.values(
        transportData?.directions
        || {}
      )
    ) {
      for (
        const direction
        of Object.values(
          directionSet || {}
        )
      ) {
        for (
          const stop
          of direction?.stops
          || []
        ) {
          const stopId =
            String(
              stop?.stop_id
              ?? ""
            ).trim();

          if (stopId) {
            activeStopIds.add(
              stopId
            );
          }
        }
      }
    }

    return stops.filter(
      stop => {
        const stopId =
          String(
            stop?.stop_id
            ?? ""
          ).trim();

        if (
          !activeStopIds.has(
            stopId
          )
        ) {
          return false;
        }

        const locationType =
          String(
            stop?.location_type
            ?? "0"
          ).trim();

        return (
          locationType === "0"
        );
      }
    );
  }

  function initMap(
    stops
  ) {
    if (
      typeof L === "undefined"
    ) {
      const mapElement =
        document.getElementById(
          "virtualMap"
        );

      if (mapElement) {
        mapElement.innerHTML =
          '<div class="virtual-map-error">Картата не може да бъде заредена.</div>';
      }

      return;
    }

    map =
      L.map(
        "virtualMap",
        {
          center:
            SOFIA_CENTER,
          zoom:
            12,
          minZoom:
            10,
          preferCanvas:
            true,
          zoomControl:
            true
        }
      );

    L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom:
          19,
        attribution:
          '&copy; OpenStreetMap contributors'
      }
    ).addTo(map);

    stopMarkers =
      L.layerGroup()
        .addTo(map);

    addStopMarkers(
      stops
    );

    setTimeout(
      () =>
        map.invalidateSize(),
      100
    );
  }

  async function refreshSelectedBoard({ automatic = false } = {}) {
    if (!selectedStopId) return;
    clearBoardAutoRefreshTimer();

    if (refreshInFlight || boardInitialLoadInFlight) {
      scheduleBoardAutoRefresh(5_000);
      return;
    }

    const requestedStopId = String(selectedStopId);
    const requestToken = boardRenderToken;
    const stop = findStopById(requestedStopId);
    if (!stop) return;

    const refreshButton = document.getElementById('virtualBoardRefresh');
    refreshButton?.classList.add('is-loading');
    if (refreshButton) refreshButton.disabled = true;

    refreshInFlight = true;
    try {
      const data = await fetchVirtualBoardViaServer(stop);
      if (requestToken !== boardRenderToken || selectedStopId !== requestedStopId) return;

      lastBoardData = data;
      recordBoardRefreshOutcome(data);
      renderBoardList(boardPanel(), data);
    } catch (error) {
      if (requestToken !== boardRenderToken || selectedStopId !== requestedStopId) return;

      console.error('Неуспешно обновяване на виртуалното табло:', error);
      recordBoardRefreshOutcome(null, error);
      const panel = boardPanel();
      const list = panel?.querySelector('.virtual-board-list');
      if (lastBoardData) {
        renderBoardStatus(
          panel,
          lastBoardData,
          automatic
            ? 'Временно няма връзка — показваме последните заредени данни.'
            : 'Обновяването не успя — показваме последните заредени данни.'
        );
      } else if (list) {
        list.innerHTML = `<div class="virtual-board-error">Таблото не може да бъде заредено. Ще опитаме отново автоматично.</div>`;
        renderBoardStatus(panel, { realtime_status: 'unavailable' }, 'Неуспешно зареждане');
      }
    } finally {
      refreshInFlight = false;
      if (requestToken === boardRenderToken && selectedStopId === requestedStopId) {
        const button = document.getElementById('virtualBoardRefresh');
        if (button) {
          button.disabled = false;
          button.classList.remove('is-loading');
          bindRefreshButton();
        }
      }
      scheduleBoardAutoRefresh();
    }
  }

  async function initializeVirtualBoards() {
    try {
      transportData =
        await loadBoardMapData();

      const allStops =
        transportData.stops || [];

      const stops =
        getActiveStops(
          allStops
        );

      initMap(
        stops
      );

      setupStopSearch(
        stops
      );

      setupGeolocation();

      renderEmptyBoard();

      const requestedStopId =
        new URLSearchParams(
          window.location.search
        ).get("stop");

      if (requestedStopId) {
        const requestedStop =
          findStopById(
            requestedStopId
          );

        if (requestedStop) {
          selectStopOnMap(
            requestedStop
          );
        }
      }

    } catch (error) {
      console.error(
        "Неуспешно зареждане на GTFS за виртуалните табла:",
        error
      );

      const panel =
        boardPanel();

      if (panel) {
        panel.innerHTML = `
          <div class="virtual-board-error">
            <strong>Виртуалното табло не може да бъде заредено.</strong>
            <span>${escapeHtml(
              error.message
              || "Неизвестна грешка."
            )}</span>
          </div>
        `;
      }
    }
  }

  document.addEventListener(
    "visibilitychange",
    handleBoardVisibilityChange
  );

  document.addEventListener(
    "DOMContentLoaded",
    initializeVirtualBoards
  );

  // Small test seam; production pages do not use this object.
  globalThis.__gtsofiaVirtualBoardTestInternals = {
    formatArrivalCountdown,
    rememberRealtimeArrivalPredictions,
    reconcileRealtimeCoursePresence,
    suppressPassedRealtimeFallbacks,
    sameArrivalTrip,
    sortBoardRoutesByNextArrival,
    getBoardAutoRefreshDelay,
    recordBoardRefreshOutcome,
    scheduleBoardAutoRefresh,
    clearBoardAutoRefreshTimer
  };
})();
