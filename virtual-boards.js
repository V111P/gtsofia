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
  const REALTIME_ARRIVAL_HISTORY_KEY = 'gtsofia.virtualBoard.realtimeArrivalHistory.v1';
  const REALTIME_ARRIVAL_HISTORY_TTL_SECONDS = 36 * 60 * 60;
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
      trip_start_date: normalizeTripDate(
        time?.trip_start_date || route?.trip_start_date || ''
      ),
      trip_start_time: String(
        time?.trip_start_time || route?.trip_start_time || ''
      ).trim(),
      direction_id: String(time?.direction_id || route?.direction_id || '').trim()
    };

    if (!identity.stop_id || !identity.route_id) return null;
    if (!identity.trip_id && !identity.trip_start_time) return null;
    return identity;
  }

  function sameArrivalTrip(left, right) {
    if (!left || !right) return false;
    if (left.stop_id !== right.stop_id || left.route_id !== right.route_id) return false;

    if (left.trip_id && right.trip_id) {
      if (left.trip_id !== right.trip_id) return false;
    } else if (!left.trip_start_time || !right.trip_start_time
      || left.trip_start_time !== right.trip_start_time) {
      return false;
    }

    if (left.trip_start_date && right.trip_start_date
      && left.trip_start_date !== right.trip_start_date) return false;
    if (left.trip_start_time && right.trip_start_time
      && left.trip_start_time !== right.trip_start_time) return false;
    if (left.direction_id && right.direction_id
      && left.direction_id !== right.direction_id) return false;

    return true;
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
      const key = [
        identity.stop_id,
        identity.route_id,
        identity.trip_id,
        identity.trip_start_date,
        identity.trip_start_time,
        identity.direction_id
      ].join('|');
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
        const record = { identity, timestamp, remembered_at: nowSeconds };
        if (matchingIndex >= 0) next[matchingIndex] = record;
        else next.push(record);
      }
    }

    writeRealtimeArrivalHistory(next.filter(item =>
      Number(item?.remembered_at) >= nowSeconds - REALTIME_ARRIVAL_HISTORY_TTL_SECONDS
    ));
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

          const wasPredictedRealtime = history.some(item =>
            sameArrivalTrip(item.identity, identity)
            && Number(item.timestamp) <= nowSeconds
          );
          if (wasPredictedRealtime) removedAny = true;
          return !wasPredictedRealtime;
        });
        return { ...route, times };
      })
      .filter(route => route.times.length > 0);

    return {
      ...boardData,
      status: routes.length ? (boardData?.status || 'ok') : 'empty',
      routes,
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
      + ` aria-hidden="true">`
      + `<img src="Icons/destinationarrow.svg" alt="">`
      + `</span>`
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
    // fixed until the user explicitly presses the refresh button.
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
    // manual refresh that same trip can otherwise reappear from GTFS with its
    // later scheduled time (e.g. actual 14:39 vs timetable 14:42).
    rememberRealtimeArrivalPredictions(normalized, stopCode, normalized.loaded_at);
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
        refreshSelectedBoard();
  }

  function formatBoardUpdatedAt(timestamp) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return '—';
    return new Intl.DateTimeFormat('bg-BG', {
      timeZone: SOFIA_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(new Date(seconds * 1000));
  }

  function renderBoardStatus(panel, data, snapshotSeconds, warning = '') {
    const statusElement = panel?.querySelector('.vb-board-status');
    if (!statusElement) return;

    const realtimeStatus = String(data?.realtime_status || 'available');
    let label = '';
    let statusClass = 'is-live';

    if (realtimeStatus === 'unavailable') {
      label = data?.realtime_message || 'Realtime временно недостъпен — показваме разписанието.';
      statusClass = 'is-warning';
    } else if (realtimeStatus === 'not_applicable') {
      label = data?.realtime_message || 'По разписание';
      statusClass = 'is-scheduled';
    }

    if (warning) {
      statusElement.innerHTML = `
        <span class="vb-board-status-label is-warning">${escapeHtml(warning)}</span>
        <span class="vb-board-updated">Последно успешно зареждане: ${escapeHtml(formatBoardUpdatedAt(snapshotSeconds))}</span>
      `;
      return;
    }

    statusElement.innerHTML = `
      ${label ? `<span class="vb-board-status-label ${statusClass}">${escapeHtml(label)}</span>` : ''}
      <span class="vb-board-updated">Обновено: ${escapeHtml(formatBoardUpdatedAt(snapshotSeconds))}</span>
    `;
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
    renderBoardStatus(panel, data, snapshotSeconds);

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
    const rows = data.routes.filter(
      route => Array.isArray(route?.times) && route.times.length > 0
    );

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
    const renderToken =
      ++boardRenderToken;

    selectedStopId =
      String(
        stop.stop_id
      );
    lastBoardData = null;

    const panel =
      boardPanel();

    if (!panel) return;

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

      const list = panel.querySelector('.virtual-board-list');
      if (list) {
        list.innerHTML = `<div class="virtual-board-error">Таблото не може да бъде заредено. Опитайте отново с бутона за обновяване.</div>`;
      }
      renderBoardStatus(panel, { realtime_status: 'unavailable' }, null, 'Неуспешно зареждане');
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

  async function refreshSelectedBoard() {
    if (!selectedStopId || refreshInFlight) return;

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
      renderBoardList(boardPanel(), data);
    } catch (error) {
      if (requestToken !== boardRenderToken || selectedStopId !== requestedStopId) return;

      console.error('Неуспешно ръчно обновяване на виртуалното табло:', error);
      const panel = boardPanel();
      const list = panel?.querySelector('.virtual-board-list');
      if (lastBoardData) {
        renderBoardStatus(
          panel,
          lastBoardData,
          lastBoardData.loaded_at,
          'Обновяването не успя — показваме последните заредени данни.'
        );
      } else if (list) {
        list.innerHTML = `<div class="virtual-board-error">Таблото не може да бъде заредено. Опитайте отново.</div>`;
        renderBoardStatus(panel, { realtime_status: 'unavailable' }, null, 'Неуспешно зареждане');
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
    "DOMContentLoaded",
    initializeVirtualBoards
  );

  // Small test seam; production pages do not use this object.
  globalThis.__gtsofiaVirtualBoardTestInternals = {
    formatArrivalCountdown,
    rememberRealtimeArrivalPredictions,
    suppressPassedRealtimeFallbacks
  };
})();
