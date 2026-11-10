(() => {
  const REFRESH_MS = 15000;
  const SOFIA_TIME_ZONE = "Europe/Sofia";
  const SOFIA_CENTER = [42.6977, 23.3219];

  let map = null;
  let selectedStopId = null;
  let refreshTimer = null;
  let countdownTimer = null;
  let refreshInFlight = false;
  let lastExpiredPrimaryArrival = null;
  let boardRenderToken = 0;
  let stopMarkers = null;
  let selectedStopMarker = null;
  let stopMarkersById = new Map();
  let transportData = null;
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

    // Arrival has reached the stop.
    if (remainingSeconds <= 0) {
      return "0 мин.";
    }

    // Display whole minutes only, rounded to the nearest minute from the exact
    // remaining seconds (half a minute rounds up): 9:01 -> 9 мин., 9:30 ->
    // 10 мин. A remaining time below 30 seconds rounds to 0 мин.; the actual
    // countdown is recalculated from the timestamp on each refresh.
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
    showLive
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
        timestamp
      );

    return (
      `<div class="vb-arrival-main">`
      + `${live}`
      + `<span class="vb-arrival-clock">`
      + `${escapeHtml(clock)}`
      + `</span>`
      + `<span class="vb-arrival-separator" aria-hidden="true">·</span>`
      + `<span class="vb-arrival-minutes"`
      + ` data-arrival-timestamp="${timestamp}">`
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
    const stopCode = String(
      stop?.stop_code || stop?.stop_id || ''
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

    return {
      status: data?.status || 'empty',
      routes: Array.isArray(data?.routes) ? data.routes : []
    };
  }

  function bindRefreshButton() {
    const button =
      document.getElementById(
        "virtualBoardRefresh"
      );

    if (!button) return;

    button.onclick =
      () =>
        refreshSelectedBoard(true);
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
                      time.timestamp
                    );

                  const clock =
                    formatArrivalClock(
                      time.timestamp
                    );

                  return (
                    `<span class="vb-next-time"`
                    + ` tabindex="0"`
                    + ` data-arrival-timestamp="${time.timestamp}"`
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
                  !arrivals[0]?.scheduled
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

    const panel =
      boardPanel();

    if (!panel) return;

    panel.innerHTML = `
      <div class="virtual-board-header">
        <div>
          <div class="virtual-board-kicker">Спирка ${escapeHtml(
            stop.stop_code
            || stop.stop_id
            || ""
          )}</div>
          <h2>${escapeHtml(
            getStopDisplayName(stop)
          )}</h2>
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

          lastExpiredPrimaryArrival =
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

      panel.querySelector(
        ".virtual-board-list"
      ).innerHTML =
        `<div class="virtual-board-error">Realtime данните не могат да бъдат заредени.</div>`;
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

  function updateBoardCountdowns() {
    const panel =
      boardPanel();

    if (
      !panel
      || !selectedStopId
    ) {
      return;
    }

    const nowSeconds =
      Date.now() / 1000;

    let primaryArrivalExpired =
      null;

    panel
      .querySelectorAll(
        "[data-arrival-timestamp]"
      )
      .forEach(
        element => {
          const timestamp =
            Number(
              element.dataset
                .arrivalTimestamp
            );

          if (
            !Number.isFinite(
              timestamp
            )
          ) {
            return;
          }

          const countdown =
            formatArrivalCountdown(
              timestamp,
              nowSeconds
            );

          if (
            element.classList.contains(
              "vb-arrival-minutes"
            )
          ) {
            element.textContent =
              countdown;

            if (
              timestamp
              <= nowSeconds
            ) {
              primaryArrivalExpired =
                timestamp;
            }

            return;
          }

          element.dataset.tooltip =
            countdown;

          element.setAttribute(
            "aria-label",
            countdown
          );
        }
      );

    if (
      primaryArrivalExpired
        !== null
      && primaryArrivalExpired
        !== lastExpiredPrimaryArrival
      && !refreshInFlight
    ) {
      lastExpiredPrimaryArrival =
        primaryArrivalExpired;

      refreshSelectedBoard(true);
    }
  }

  function startTimers() {
    clearInterval(
      refreshTimer
    );

    clearInterval(
      countdownTimer
    );

    countdownTimer =
      setInterval(
        updateBoardCountdowns,
        1000
      );

    refreshTimer =
      setInterval(
        () => {
          if (
            selectedStopId
          ) {
            refreshSelectedBoard(true);
          }
        },
        REFRESH_MS
      );

    updateBoardCountdowns();
  }

  async function refreshSelectedBoard(
    force = false
  ) {
    if (
      !selectedStopId
      || refreshInFlight
    ) {
      return;
    }

    const requestedStopId =
      String(
        selectedStopId
      );

    const requestToken =
      boardRenderToken;

    const stop =
      findStopById(
        requestedStopId
      );

    if (!stop) {
      return;
    }

    const refreshButton =
      document.getElementById(
        "virtualBoardRefresh"
      );

    refreshButton?.classList.add(
      "is-loading"
    );

    if (refreshButton) {
      refreshButton.disabled =
        true;
    }

    refreshInFlight =
      true;

    try {
      const data =
        await fetchVirtualBoardViaServer(
          stop
        );

      if (
        requestToken
          !== boardRenderToken
        || selectedStopId
          !== requestedStopId
      ) {
        return;
      }

      const displayedPrimaryArrival =
        Number(
          boardPanel()
            ?.querySelector(
              ".vb-arrival-minutes"
            )
            ?.dataset
              .arrivalTimestamp
        );

      if (
        !force
        && Number.isFinite(
          displayedPrimaryArrival
        )
        && displayedPrimaryArrival
          <= Date.now() / 1000
      ) {
        lastExpiredPrimaryArrival =
          displayedPrimaryArrival;

        updateBoardCountdowns();

        return;
      }

      // IMPORTANT:
      // Do not rebuild the complete virtual-board panel here.
      // The header, buttons and event listeners are already present.
      // Only replace the arrival list. This removes a substantial amount of
      // synchronous DOM work from every 15-second refresh.
      renderBoardList(
        boardPanel(),
        data
      );
    } catch (error) {
      if (
        requestToken
          !== boardRenderToken
        || selectedStopId
          !== requestedStopId
      ) {
        return;
      }

      console.error(
        "Неуспешно зареждане на GTFS-Realtime виртуално табло:",
        error
      );

      const list =
        boardPanel()
          ?.querySelector(
            ".virtual-board-list"
          );

      if (list) {
        list.innerHTML =
          `<div class="virtual-board-error">Realtime данните не могат да бъдат заредени.</div>`;
      }
    } finally {
      refreshInFlight =
        false;

      if (
        requestToken
          === boardRenderToken
        && selectedStopId
          === requestedStopId
      ) {
        const button =
          document.getElementById(
            "virtualBoardRefresh"
          );

        if (button) {
          button.disabled =
            false;

          button.classList.remove(
            "is-loading"
          );

          bindRefreshButton();
        }
      }

      const primaryArrival =
        boardPanel()
          ?.querySelector(
            ".vb-arrival-minutes"
          )
          ?.dataset
            .arrivalTimestamp;

      lastExpiredPrimaryArrival =
        Number.isFinite(
          Number(primaryArrival)
        )
          ? Number(primaryArrival)
          : null;
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

      startTimers();
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
    formatArrivalCountdown
  };
})();
