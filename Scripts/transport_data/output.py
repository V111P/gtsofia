"""Write generated transport data as independently cacheable JSON files."""
import json
from pathlib import Path

from .config import DATA_DIR, LEGACY_OUTPUT_FILE


def _write_json_atomic(path: Path, value):
    temporary_path = path.with_name(path.name + ".tmp")
    with temporary_path.open("w", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False, separators=(",", ":"))
    temporary_path.replace(path)


def write_transport_data(result):
    """Split the in-memory model into files consumed by GTSofia's frontend."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    files = {
        "metadata.json": {
            "schemaVersion": 2,
            "updatedAt": result["updatedAt"],
            "source": result["source"],
            "osmSource": result["osmSource"],
            "osmUpdatedAt": result["osmUpdatedAt"],
        },
        "calendar.json": result["calendar"],
        "routes.json": result["routes"],
        "stops.json": result["stops"],
        "trips.json": result["trips"],
        "directions.json": result["directions"],
        "shapes.json": result["shapes"],
        "schedules.json": result["schedules"],
    }

    for filename, value in files.items():
        _write_json_atomic(DATA_DIR / filename, value)

    # Do not leave the obsolete monolithic file in the published site/repo.
    if LEGACY_OUTPUT_FILE.exists():
        LEGACY_OUTPUT_FILE.unlink()

    print("Written modular data files:")
    for filename in files:
        path = DATA_DIR / filename
        print(f"  {path.relative_to(DATA_DIR.parent)} ({path.stat().st_size / 1024 / 1024:.2f} MiB)")
