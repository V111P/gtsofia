let scheduleLines = [];
let selectedScheduleLine = null;
let selectedDirectionKey = null;
let selectedStopIndex = 0;
let selectedDayType = "weekday";
let selectedCourse = null;

const lineGroups = [
  { type: "metro", subtype: "", label: "Метролинии" },
  { type: "tram", subtype: "", label: "Трамваи" },
  { type: "trolley", subtype: "", label: "Тролейбуси" },
  { type: "bus", subtype: "", label: "Автобуси" },
  { type: "bus", subtype: "school", label: "Училищни автобуси" },
  { type: "bus", subtype: "temporary", label: "Заместващи автобуси" },
  { type: "bus", subtype: "night", label: "Нощни автобуси" }
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getScheduleStopDisplayName(stop) {
  return String(
    stop?.osm_name
    || stop?.osm_stop_name
    || stop?.name
    || stop?.gtfs_name
    || stop?.stop_name
    || ""
  ).trim();
}

function getDirectionDisplayName(direction) {
  const stops = Array.isArray(direction?.stops)
    ? direction.stops
    : [];
  const terminalStop = stops[stops.length - 1];

  return String(
    terminalStop?.osm_name
    || terminalStop?.osm_stop_name
    || direction?.osm_headsign
    || direction?.destination
    || direction?.headsign
    || getScheduleStopDisplayName(terminalStop)
    || ""
  ).trim();
}

function parseTime(value) {
  const match = String(value || "").match(
    /^(\d+):(\d{2})(?::(\d{2}))?$/
  );

  if (!match) {
    return null;
  }

  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3] || 0)
  );
}

function formatTime(value) {
  const match = String(value || "").match(
    /^(\d+):(\d{2})/
  );

  if (!match) {
    return "—";
  }

  const hour =
    Number(match[1]) % 24;

  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function linePillHtml(line) {
  const variantClass = line.type === "metro"
    ? " metro"
    : (line.subtype === "night" ? " night" : "");
  const background = escapeHtml(line.color || "#BE1E2D");
  const foreground = escapeHtml(line.textColor || "#FFFFFF");

  return `
    <span
      class="schedule-line-pill${variantClass}"
      style="background:${background};color:${foreground}"
    >
      ${escapeHtml(line.number)}
    </span>`;
}

function lineIdentityHtml(line) {
  return `
    <span class="schedule-line-identity">
      <span class="schedule-line-icon">
        <img src="${escapeHtml(line.icon)}" alt="" />
      </span>

      ${linePillHtml(line)}
    </span>`;
}

function renderLineDropdown() {
  const menu =
    document.getElementById(
      "lineDropdownMenu"
    );

  menu.innerHTML = "";

  for (const groupDefinition of lineGroups) {
    const lines =
      scheduleLines
        .filter(line =>
          line.type === groupDefinition.type &&
          String(line.subtype || "") === groupDefinition.subtype
        )
        .sort(
          (a, b) =>
            String(a.number).localeCompare(
              String(b.number),
              "bg",
              {
                numeric: true,
                sensitivity: "base"
              }
            )
        );

    if (!lines.length) {
      continue;
    }

    const group =
      document.createElement(
        "div"
      );

    group.className =
      "schedule-dropdown-group";

    group.innerHTML = `
      <div class="schedule-dropdown-group-title">
        ${groupDefinition.label}
      </div>`;

    for (const line of lines) {
      const item =
        document.createElement(
          "button"
        );

      item.type = "button";

      item.className =
        "schedule-line-option";

      item.innerHTML = `
        ${lineIdentityHtml(line)}
        <span class="schedule-option-arrow">›</span>`;

      item.addEventListener(
        "click",
        () =>
          selectScheduleLine(line)
      );

      group.appendChild(item);
    }

    menu.appendChild(group);
  }
}

function openLineDropdown() {
  const button =
    document.getElementById(
      "lineDropdownButton"
    );

  const menu =
    document.getElementById(
      "lineDropdownMenu"
    );

  const isOpen =
    !menu.hidden;

  menu.hidden =
    isOpen;

  button.setAttribute(
    "aria-expanded",
    String(!isOpen)
  );
}

function closeLineDropdown() {
  document.getElementById(
    "lineDropdownMenu"
  ).hidden = true;

  document
    .getElementById(
      "lineDropdownButton"
    )
    .setAttribute(
      "aria-expanded",
      "false"
    );
}

function selectScheduleLine(line) {
  selectedScheduleLine =
    line;

  selectedDirectionKey =
    line.directions?.[0]?.key
      || "A";

  selectedStopIndex = 0;
  selectedCourse = null;

  closeLineDropdown();

  const button =
    document.getElementById(
      "lineDropdownButton"
    );

  button
    .querySelector(
      ".schedule-placeholder"
    )
    ?.remove();

  button
    .querySelector(
      ".schedule-selected-line"
    )
    ?.remove();

  const chevron =
    button.querySelector(
      ".schedule-chevron"
    );

  const selected =
    document.createElement(
      "span"
    );

  selected.className =
    "schedule-selected-line";

  selected.innerHTML =
    lineIdentityHtml(line);

  button.insertBefore(
    selected,
    chevron
  );

  renderDirections();
  renderSchedule();
}

function getSelectedDirection() {
  if (!selectedScheduleLine) {
    return null;
  }

  const directions =
    Array.isArray(
      selectedScheduleLine.directions
    )
      ? selectedScheduleLine.directions
      : [];

  if (directions.length) {
    return (
      directions.find(
        direction =>
          direction.key ===
          selectedDirectionKey
      )
      || directions[0]
      || null
    );
  }

  return (
    selectedScheduleLine[
      selectedDirectionKey === "A"
        ? "directionA"
        : "directionB"
    ] || null
  );
}

function renderDirections() {
  const select =
    document.getElementById(
      "directionSelect"
    );

  const directions =
    Array.isArray(
      selectedScheduleLine?.directions
    )
      ? selectedScheduleLine.directions
      : [];

  if (directions.length) {
    if (
      !directions.some(
        direction =>
          direction.key ===
          selectedDirectionKey
      )
    ) {
      selectedDirectionKey =
        directions[0].key;
    }

    select.innerHTML =
      directions
        .filter(
          direction =>
            direction &&
            getDirectionDisplayName(direction)
        )
        .map(
          direction => `
            <option value="${escapeHtml(
              direction.key
            )}">
              ${escapeHtml(
                getDirectionDisplayName(direction)
              )}
            </option>`
        )
        .join("");

    select.disabled =
      !directions.length;

    select.value =
      selectedDirectionKey || "";

    renderStops();

    return;
  }

  const directionA =
    selectedScheduleLine?.directionA;

  const directionB =
    selectedScheduleLine?.directionB;

  const legacyDirections = [
    ["A", directionA],
    ["B", directionB]
  ].filter(
    ([, direction]) =>
      direction &&
      getDirectionDisplayName(direction)
  );

  select.innerHTML =
    legacyDirections
      .map(
        ([key, direction]) => `
          <option value="${key}">
            ${escapeHtml(
              getDirectionDisplayName(direction)
            )}
          </option>`
      )
      .join("");

  select.disabled =
    !legacyDirections.length;

  if (
    !legacyDirections.some(
      ([key]) =>
        key === selectedDirectionKey
    )
  ) {
    selectedDirectionKey =
      legacyDirections[0]?.[0]
      || "A";
  }

  select.value =
    selectedDirectionKey;

  renderStops();
}

function renderStops() {
  const select =
    document.getElementById(
      "stopSelect"
    );

  const direction =
    getSelectedDirection();

  const stops =
    direction?.stops || [];

  select.innerHTML =
    stops
      .map(
        (stop, index) => `
          <option value="${index}">
            ${escapeHtml(getScheduleStopDisplayName(stop))}
          </option>`
      )
      .join("");

  select.disabled =
    !stops.length;

  selectedStopIndex =
    Math.min(
      selectedStopIndex,
      Math.max(
        0,
        stops.length - 1
      )
    );

  if (stops.length) {
    select.value =
      String(
        selectedStopIndex
      );
  }
}

function getCourses() {
  if (!selectedScheduleLine) {
    return [];
  }

  const schedules =
    window.transportData?.schedules
      || {};

  const routeSchedule =
    schedules[
      selectedScheduleLine.id
    ];

  /*
   * Новият модел:
   *
   * D1 / D2 / D3 / ...
   */
  if (
    routeSchedule &&
    routeSchedule[
      selectedDirectionKey
    ]
  ) {
    return (
      routeSchedule[
        selectedDirectionKey
      ]?.[
        selectedDayType
      ] || []
    );
  }

  /*
   * Стар fallback.
   */
  const legacyKey =
    selectedDirectionKey === "B"
      ? "B"
      : "A";

  const directionSchedule =
    routeSchedule?.[
      legacyKey
    ];

  return (
    directionSchedule?.[
      selectedDayType
    ] || []
  );
}

function getStopTime(
  course,
  index
) {
  return (
    course?.times?.[index] ||
    ""
  );
}


/*
 * Проверява дали даден курс е частичен.
 *
 * Частичният курс има поне едно липсващо
 * време след последното реално време.
 */
function isPartialCourse(course) {
  const times =
    Array.isArray(course?.times)
      ? course.times
      : [];

  if (!times.length) {
    return false;
  }

  let lastRealIndex = -1;

  for (
    let index = 0;
    index < times.length;
    index++
  ) {
    if (
      times[index] !== null &&
      times[index] !== undefined &&
      String(
        times[index]
      ).trim() !== ""
    ) {
      lastRealIndex = index;
    }
  }

  if (lastRealIndex < 0) {
    return false;
  }

  for (
    let index =
      lastRealIndex + 1;
    index < times.length;
    index++
  ) {
    if (
      times[index] === null ||
      times[index] === undefined ||
      String(
        times[index]
      ).trim() === ""
    ) {
      return true;
    }
  }

  return false;
}


/*
 * Частичните курсове са с:
 *   background: #dc3545
 *   color: white
 */
function getCourseMinuteStyle(
  course
) {
  if (
    !isPartialCourse(course)
  ) {
    return "";
  }

  return `
    background:#dc3545;
    color:#ffffff;
    border-color:#dc3545;
  `;
}


function renderSummary(courses) {
  const summary =
    document.getElementById(
      "scheduleSummary"
    );

  if (
    !selectedScheduleLine ||
    !getSelectedDirection()
  ) {
    summary.hidden = true;
    return;
  }

  const direction =
    getSelectedDirection();

  /*
   * Търсим всички реални времена
   * за избраната спирка.
   */
  const validTimes =
    courses
      .map(
        course =>
          getStopTime(
            course,
            selectedStopIndex
          )
      )
      .filter(
        time =>
          parseTime(time) !==
          null
      )
      .sort(
        (a, b) =>
          parseTime(a) -
          parseTime(b)
      );

  const first =
    validTimes.length
      ? formatTime(
          validTimes[0]
        )
      : "—";

  const last =
    validTimes.length
      ? formatTime(
          validTimes[
            validTimes.length - 1
          ]
        )
      : "—";

  const stop =
    direction.stops?.[
      selectedStopIndex
    ];

  const courseCount =
    validTimes.length;

  summary.innerHTML = `
    <div class="schedule-summary-main">
      <div class="schedule-summary-route-row">
        ${lineIdentityHtml(
          selectedScheduleLine
        )}

        <img
          class="direction-arrow"
          src="https://raw.githubusercontent.com/nikolay5555/gtsofia/5a0d684503c222b5e385176ad7a478ffff8ca8fb/Icons/destinationarrow.svg"
          alt=""
        />

        <strong class="schedule-summary-destination">
          ${escapeHtml(
            getDirectionDisplayName(direction)
          )}
        </strong>
      </div>

      <span class="schedule-summary-stop">
        От спирка: ${escapeHtml(
          getScheduleStopDisplayName(stop)
        )}
      </span>
    </div>

    <div class="schedule-summary-stats">
      <div>
        <span>Първи курс</span>
        <strong>${first}</strong>
      </div>

      <div>
        <span>Последен курс</span>
        <strong>${last}</strong>
      </div>

      <div>
        <span>Общо курсове</span>
        <strong>${courseCount}</strong>
      </div>
    </div>
  `;

  summary.hidden = false;
}


function renderTimetable(courses) {
  const section =
    document.getElementById(
      "timetableSection"
    );

  const container =
    document.getElementById(
      "timetableContainer"
    );

  section.hidden = false;

  if (!courses.length) {
    container.innerHTML = `
      <div class="schedule-no-data">
        Няма налични курсове за избрания ден.
      </div>`;

    return;
  }

  const byHour =
    new Map();

  for (const course of courses) {
    const time =
      getStopTime(
        course,
        selectedStopIndex
      );

    const seconds =
      parseTime(time);

    if (seconds == null) {
      continue;
    }

    const hour =
      Math.floor(
        seconds / 3600
      ) % 24;

    const minute =
      Math.floor(
        (seconds % 3600) / 60
      );

    if (!byHour.has(hour)) {
      byHour.set(
        hour,
        []
      );
    }

    byHour
      .get(hour)
      .push({
        minute,
        course
      });
  }

  /*
   * Показваме всички 24 часа винаги,
   * независимо дали за дадения час има
   * налични минути.
   *
   * Редът започва от 01:00 и завършва
   * с 00:00, т.е.:
   * 1, 2, 3, ..., 23, 0
   */
  const hours = Array.from(
    { length: 24 },
    (_, index) =>
      (index + 1) % 24
  );

  const header =
    hours
      .map(
        hour =>
          `<th>${hour}</th>`
      )
      .join("");

  const cells =
    hours
      .map(hour => {
        const entries =
          (
            byHour.get(hour) || []
          ).sort(
            (a, b) =>
              a.minute -
              b.minute
          );

        return `
          <td>
            <div class="schedule-minute-list">
              ${entries
                .map(entry => {
                  const label =
                    String(
                      entry.minute
                    ).padStart(
                      2,
                      "0"
                    );

                  const partialStyle =
                    getCourseMinuteStyle(
                      entry.course
                    );

                  /*
                   * КЛЮЧОВАТА ПРОМЯНА:
                   *
                   * Не използваме trip_id за намиране
                   * на курса, защото няколко курса могат
                   * да имат един и същ trip_id след
                   * обработката.
                   *
                   * Вместо това записваме реалния индекс
                   * на конкретния course object в courses.
                   */
                  const courseIndex =
                    courses.indexOf(
                      entry.course
                    );

                  return `
                    <button
                      class="schedule-minute"
                      type="button"
                      data-course-index="${courseIndex}"
                      style="${partialStyle}"
                    >
                      ${label}
                    </button>`;
                })
                .join("")}
            </div>
          </td>`;
      })
      .join("");

  container.innerHTML = `
    <table class="schedule-timetable">
      <thead>
        <tr>
          ${header}
        </tr>
      </thead>

      <tbody>
        <tr>
          ${cells}
        </tr>
      </tbody>
    </table>`;

  container
    .querySelectorAll(
      ".schedule-minute"
    )
    .forEach(button => {
      button.addEventListener(
        "click",
        () => {

          /*
           * Вече взимаме точно курса,
           * който е представен от този бутон.
           */
          const courseIndex =
            Number(
              button.dataset.courseIndex
            );

          const course =
            courses[
              courseIndex
            ];

          if (course) {
            showCourse(course);
          }
        }
      );
    });
}


function showCourse(course) {
  selectedCourse =
    course;

  const section =
    document.getElementById(
      "courseSection"
    );

  const container =
    document.getElementById(
      "courseStops"
    );

  const direction =
    getSelectedDirection();

  const stops =
    direction?.stops || [];

  /*
   * Намираме последната спирка,
   * за която конкретният курс има
   * реално време.
   */
  let lastRealIndex = -1;

  for (
    let index = 0;
    index < stops.length;
    index++
  ) {
    const time =
      course.times?.[
        index
      ];

    if (
      time !== null &&
      time !== undefined &&
      String(time).trim() !== ""
    ) {
      lastRealIndex =
        index;
    }
  }

  /*
   * Показваме ВСИЧКИ спирки на
   * редовното направление.
   *
   * След последната обслужена спирка
   * конкретният курс получава "—".
   */
  container.innerHTML =
    stops
      .map(
        (stop, index) => {

          const rawTime =
            course.times?.[
              index
            ];

          const hasRealTime =
            rawTime !== null &&
            rawTime !== undefined &&
            String(rawTime).trim() !== "";

          const displayTime =
            hasRealTime
              ? formatTime(
                  rawTime
                )
              : "—";

          const selected =
            index ===
            selectedStopIndex;

          return `
            <div
              class="course-stop ${
                selected
                  ? "selected"
                  : ""
              }"
            >
              <div class="course-stop-marker"></div>

              <div class="course-stop-name">
                <span class="course-stop-name-text">
                  ${escapeHtml(
                    getScheduleStopDisplayName(stop)
                  )}
                </span>
                <span class="course-stop-code">
                  [${escapeHtml(
                    stop.stop_code || stop.stop_id || ""
                  )}]
                </span>
              </div>

              <div class="course-stop-time">
                ${displayTime}
              </div>
            </div>`;
        }
      )
      .join("");

  section.hidden = false;

  section.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}


function renderSchedule() {
  const empty =
    document.getElementById(
      "scheduleEmpty"
    );

  if (!selectedScheduleLine) {
    empty.hidden = false;

    document.getElementById(
      "scheduleSummary"
    ).hidden = true;

    document.getElementById(
      "timetableSection"
    ).hidden = true;

    document.getElementById(
      "courseSection"
    ).hidden = true;

    return;
  }

  empty.hidden = true;

  const courses =
    getCourses();

  renderStops();

  renderSummary(
    courses
  );

  renderTimetable(
    courses
  );

  document.getElementById(
    "courseSection"
  ).hidden = true;
}


async function initializeSchedules() {
  try {
    const data =
      await loadTransportData();

    scheduleLines =
      convertGtfsRoutes(
        data.routes || [],
        data.trips || [],
        data.directions || {}
      );

    window.scheduleLines =
      scheduleLines;

    selectedDayType =
      typeof getTransportCalendarDayType === 'function'
        ? getTransportCalendarDayType()
        : 'weekday';

    document
      .querySelectorAll('.schedule-day-tab')
      .forEach(button => {
        button.classList.toggle(
          'active',
          button.dataset.dayType === selectedDayType
        );
      });

    renderLineDropdown();

  } catch (error) {
    console.error(error);

    document.getElementById(
      "scheduleEmpty"
    ).textContent =
      "Разписанията не могат да бъдат заредени в момента.";
  }
}


document.addEventListener(
  "DOMContentLoaded",
  () => {

    document
      .getElementById(
        "lineDropdownButton"
      )
      .addEventListener(
        "click",
        openLineDropdown
      );

    document.addEventListener(
      "click",
      event => {

        if (
          !event.target.closest(
            "#lineDropdown"
          )
        ) {

          closeLineDropdown();

        }

      }
    );

    document
      .getElementById(
        "directionSelect"
      )
      .addEventListener(
        "change",
        event => {

          selectedDirectionKey =
            event.target.value;

          selectedStopIndex =
            0;

          selectedCourse =
            null;

          renderSchedule();

        }
      );

    document
      .getElementById(
        "stopSelect"
      )
      .addEventListener(
        "change",
        event => {

          selectedStopIndex =
            Number(
              event.target.value
            );

          selectedCourse =
            null;

          renderSchedule();

        }
      );

    document
      .querySelectorAll(
        ".schedule-day-tab"
      )
      .forEach(
        button => {

          button.addEventListener(
            "click",
            () => {

              document
                .querySelectorAll(
                  ".schedule-day-tab"
                )
                .forEach(
                  item =>
                    item.classList.remove(
                      "active"
                    )
                );

              button.classList.add(
                "active"
              );

              selectedDayType =
                button.dataset.dayType;

              selectedCourse =
                null;

              renderSchedule();

            }
          );

        }
      );

    document
      .getElementById(
        "closeCourseButton"
      )
      .addEventListener(
        "click",
        () => {

          document.getElementById(
            "courseSection"
          ).hidden = true;

          selectedCourse =
            null;

        }
      );

    initializeSchedules();

  }
);
