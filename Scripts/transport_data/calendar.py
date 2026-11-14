"""GTFS service-calendar evaluation without persisted raw exceptions."""
from collections import defaultdict
import json
from datetime import timedelta

from .config import (
    CALENDAR_CONFIG_FILE, GTFS_WEEKDAY_FIELDS,
    gtfs_date_string, iso_date_string, normalize, parse_date,
)


def _calendar_row_covers_date(row, current):
    start_date = parse_date(row.get("start_date"))
    end_date = parse_date(row.get("end_date"))
    if start_date is None or end_date is None:
        return False
    if current < start_date or current > end_date:
        return False
    field = GTFS_WEEKDAY_FIELDS[current.weekday()]
    return normalize(row.get(field)) == "1"


def _apply_calendar_date_exceptions(service_ids, calendar_dates_by_date, current):
    effective = set(service_ids)
    for row in calendar_dates_by_date.get(gtfs_date_string(current), []):
        service_id = normalize(row.get("service_id"))
        exception_type = normalize(row.get("exception_type"))
        if not service_id:
            continue
        if exception_type == "1":
            effective.add(service_id)
        elif exception_type == "2":
            effective.discard(service_id)
    return effective


def load_calendar_config(path=CALENDAR_CONFIG_FILE):
    if not path.exists():
        return {"dateOverrides": {}}

    with path.open("r", encoding="utf-8") as file:
        raw = json.load(file)

    if not isinstance(raw, dict):
        raise ValueError("Calendar config must be a JSON object.")

    overrides = raw.get("dateOverrides", {})
    if not isinstance(overrides, dict):
        raise ValueError("calendar.json dateOverrides must be an object.")

    normalized_overrides = {}
    for raw_date, raw_day_type in overrides.items():
        date_value = parse_date(raw_date.replace("-", ""))
        if date_value is None:
            raise ValueError(f"Invalid calendar override date: {raw_date}")
        day_type = normalize(raw_day_type).lower()
        if day_type not in {"weekday", "weekend"}:
            raise ValueError(
                f"Invalid calendar override type for {raw_date}: {raw_day_type}"
            )
        normalized_overrides[iso_date_string(date_value)] = day_type

    return {"dateOverrides": normalized_overrides}


def build_calendar_context(
    calendar,
    calendar_dates,
    today,
    horizon_days=15,
    calendar_config=None,
):
    """Return schedule day types plus a compact, full-range active-service index.

    The static schedule grouping remains limited to ``today..today+horizon``
    for compatibility with the existing generator. ``serviceIdsByDate`` covers
    today's date through the end of the feed's published service range, allowing
    live boards to check a date in O(1) without storing or scanning hundreds of
    thousands of raw calendar exception records.
    """
    horizon_end = today + timedelta(days=horizon_days)
    calendar_config = calendar_config or {"dateOverrides": {}}
    date_overrides = calendar_config.get("dateOverrides", {})

    calendar_by_service = {}
    relevant_dates = [horizon_end]
    for row in calendar:
        service_id = normalize(row.get("service_id"))
        if service_id:
            calendar_by_service[service_id] = dict(row)
        end_date = parse_date(row.get("end_date"))
        if end_date is not None and end_date >= today:
            relevant_dates.append(end_date)

    calendar_dates_by_date = defaultdict(list)
    for row in calendar_dates:
        service_id = normalize(row.get("service_id"))
        date_value = parse_date(row.get("date"))
        exception_type = normalize(row.get("exception_type"))
        if not service_id or date_value is None or exception_type not in {"1", "2"}:
            continue
        if date_value >= today:
            relevant_dates.append(date_value)
        calendar_dates_by_date[gtfs_date_string(date_value)].append(dict(row))

    coverage_end = max(relevant_dates)
    date_types = {}
    service_ids_by_date = {}
    service_day_types = defaultdict(set)

    current = today
    while current <= coverage_end:
        base_service_ids = {
            service_id
            for service_id, row in calendar_by_service.items()
            if _calendar_row_covers_date(row, current)
        }
        effective_service_ids = _apply_calendar_date_exceptions(
            base_service_ids, calendar_dates_by_date, current
        )
        date_key = iso_date_string(current)
        service_ids_by_date[date_key] = sorted(effective_service_ids)

        # Day-type buckets only decide which schedule list to publish. Keep
        # this window unchanged rather than pulling future-only services into
        # the generated timetable before the normal daily refresh.
        if current <= horizon_end:
            day_type = date_overrides.get(
                date_key,
                "weekend" if current.weekday() >= 5 else "weekday",
            )
            date_types[date_key] = day_type
            for service_id in effective_service_ids:
                service_day_types[service_id].add(day_type)

        current += timedelta(days=1)

    result = {
        service_id: sorted(
            day_types,
            key=lambda value: 0 if value == "weekday" else 1,
        )
        for service_id, day_types in service_day_types.items()
    }
    calendar_result = {
        "referenceDate": today.isoformat(),
        "endDate": horizon_end.isoformat(),
        "serviceCoverageEndDate": coverage_end.isoformat(),
        # Kept as empty arrays for older consumers that expect these keys.
        # Full raw GTFS rows are deliberately not retained in the public data.
        "servicePatterns": [],
        "exceptions": [],
        "serviceIdsByDate": service_ids_by_date,
        "dateTypes": date_types,
        "serviceDayTypes": result,
        "config": calendar_config,
    }

    print(f"Service date window: {today} -> {horizon_end}")
    print(f"Calendar services: {len(calendar_by_service)}")
    print(f"Raw calendar exceptions read: {len(calendar_dates)} (not persisted)")
    print(f"Calendar service-date coverage: {today} -> {coverage_end}")
    print(f"Weekday service IDs: {sum('weekday' in types for types in result.values())}")
    print(f"Weekend/holiday service IDs: {sum('weekend' in types for types in result.values())}")

    return result, calendar_result
