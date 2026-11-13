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
  let boardAutoRefreshTimer = null;
  let boardAutoRefreshFailures = 0;
  let boardInitialLoadInFlight = false;
  const BOARD_AUTO_REFRESH_INTERVAL_MS = 30_000;
  const BOARD_AUTO_REFRESH_MAX_INTERVAL_MS = 120_000;
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

  function destinationHtml(destination) {
    const label = String(destination || '').trim();
    if (!label) return '';
    return (
      `<span class="schedule-summary-arrow direction-arrow" aria-hidden="true">`
      + `<img src="Icons/destinationarrow.svg" alt="">`
      + `</span>`
      + `<strong class="schedule-summary-destination vb-destination">`
      + `${escapeHtml(label)}`
      + `</strong>`
    );
  }

  function formatArrivalCountdown(
    timestamp,
    nowSeconds = Date.now() / 1000
  ) {
    const seconds = Number(timestamp);

    if (!Number.isFinite(seconds)) return "";

    // Display-only ETA: round up so a positive wait never appears as 0 min.
    // The event timestamp from the RT/timetable source is never modified.
    const remainingSeconds = seconds - nowSeconds;
    const minutes = Math.max(0, Math.ceil(remainingSeconds / 60));
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

    const countdown = formatArrivalCountdown(timestamp, snapshotSeconds);
    const scheduleLabel = arrival?.scheduled
      ? '<span class="vb-scheduled-label">По разписание</span>'
      : '';

    return (
      `<div class="vb-arrival-main">`
      + `${live}`
      + `<span class="vb-arrival-clock">${escapeHtml(clock)}</span>`
      + `<span class="vb-arrival-separator" aria-hidden="true">·</span>`
      + `<span class="vb-arrival-minutes">${escapeHtml(countdown)}</span>`
      + `${scheduleLabel}`
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
    // The map needs only stop coordinates and route patterns. The board API
    // selects the source per mode: RT for surface transport, timetable for metro.
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
    // The proxy resolves this identifier against both GTFS stop_id and stop_code.
    // Prefer stop_id to avoid collisions between different physical stops.
    const stopCode = String(
      stop?.stop_id || stop?.stop_code || ''
    ).trim();

    if (!stopCode) {
      throw new Error('Липсва код на спирката.');
    }

    // GitHub Pages serves the frontend as static files and cannot execute the
    // Vercel API function. When the site is hosted on GitHub Pages,
    // virtual-board-config.js supplies the separate Vercel API origin.
    // Leave the setting empty when the frontend itself is served by Vercel.
    const apiBase = String(
      window.GTSOFIA_VIRTUAL_BOARD_API_BASE || ''
    ).trim().replace(/\/+$/, '');
    const apiPath = `/api/virtual-board?stop_id=${encodeURIComponent(stopCode)}`;
    const url = apiBase ? `${apiBase}${apiPath}` : `api/virtual-board?stop_id=${encodeURIComponent(stopCode)}`;
    const { response, data } = await fetchJsonWithTimeout(
      url,
      {
        headers: {
          Accept: 'application/json'
        }
      },
      45000
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

    // Arrival sources are selected server-side: surface transport uses explicit
    // RT events, while metro uses clearly labelled official timetable rows.
    normalized.routes = normalized.routes
      .map(route => {
        const isMetro = route?.meta?.type === 'metro';
        const times = (Array.isArray(route?.times) ? route.times : [])
          .filter(time => isMetro
            ? time?.source === 'schedule' || time?.scheduled === true
            : time?.source === 'realtime' || time?.realtime === true)
          .map(time => ({
            ...time,
            scheduled: isMetro,
            source: isMetro ? 'schedule' : 'realtime',
            realtime: !isMetro
          }));
        return { ...route, realtime: !isMetro, scheduled: isMetro, times };
      })
      .filter(route => route.times.length > 0);
    normalized.status = normalized.routes.length ? 'ok' : 'empty';
    return normalized;
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

    if (data) boardAutoRefreshFailures = 0;
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
    const label = realtimeStatus === 'unavailable' || realtimeStatus === 'not_applicable'
      ? (data?.realtime_message || 'Realtime информацията временно не е налична.')
      : '';

    if (warning) {
      statusElement.innerHTML = `
        <span class="vb-board-status-label is-warning">${escapeHtml(warning)}</span>
      `;
      return;
    }

    const statusClass = realtimeStatus === 'not_applicable' ? 'is-info' : 'is-warning';
    statusElement.innerHTML = label
      ? `<span class="vb-board-status-label ${statusClass}">${escapeHtml(label)}</span>`
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
      const emptyMessage = data?.board_mode === 'metro-schedule'
        ? 'Няма предстоящи метрокурсове по разписание.'
        : 'Няма налични realtime пристигания.';
      list.innerHTML = `<div class="virtual-board-no-data">${emptyMessage}</div>`;
      return;
    }

    const rows = sortBoardRoutesByNextArrival(data.routes.map(route => {
      const isMetro = route?.meta?.type === 'metro';
      const times = (Array.isArray(route?.times) ? route.times : []).filter(time => isMetro
        ? time?.source === 'schedule' || time?.scheduled === true
        : time?.source === 'realtime' || time?.realtime === true);
      return {
        ...route,
        realtime: !isMetro,
        scheduled: isMetro,
        times: times.map(time => ({
          ...time,
          scheduled: isMetro,
          realtime: !isMetro,
          source: isMetro ? 'schedule' : 'realtime'
        }))
      };
    }).filter(route => route.times.length));

    if (!rows.length) {
      const emptyMessage = data?.board_mode === 'metro-schedule'
        ? 'Няма предстоящи метрокурсове по разписание.'
        : 'Няма налични realtime пристигания.';
      list.innerHTML = `<div class="virtual-board-no-data">${emptyMessage}</div>`;

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
        "Virtual board error:",
        error
      );
      recordBoardRefreshOutcome(null, error);

      const list = panel.querySelector('.virtual-board-list');
      if (list) {
        list.innerHTML = `<div class="virtual-board-error">Таблото не може да бъде заредено. Ще опитаме отново автоматично.</div>`;
      }
      renderBoardStatus(panel, { realtime_status: 'unavailable' }, error?.message || 'Зареждането на таблото не успя');
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

      recordBoardRefreshOutcome(data);
      renderBoardList(boardPanel(), data);
    } catch (error) {
      if (requestToken !== boardRenderToken || selectedStopId !== requestedStopId) return;

      console.error('Неуспешно обновяване на виртуалното табло:', error);
      recordBoardRefreshOutcome(null, error);
      const panel = boardPanel();
      const list = panel?.querySelector('.virtual-board-list');
      // Never keep an old prediction visible after an unsuccessful refresh:
      // this board intentionally has no static or stale-data fallback.
      if (list) {
        list.innerHTML = `<div class="virtual-board-error">Данните за таблото временно не могат да бъдат заредени. Няма да показваме стари или заместващи времена.</div>`;
      }
      renderBoardStatus(
        panel,
        { realtime_status: 'unavailable' },
        error?.message || (automatic ? 'Неуспешно realtime обновяване' : 'Realtime обновяването не успя')
      );
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

})();
