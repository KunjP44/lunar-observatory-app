import json
from datetime import date, timedelta

# Correct imports based on YOUR backend
from moon.calendar import get_ui_moon_data
from solar.kepler import get_positions
from visibility.engine import compute_visibility
from events.engine import generate_events_for_year

YEAR = 2027

start_date = date(YEAR, 1, 1)
end_date = date(YEAR, 12, 31)

bundle = {}

current = start_date
while current <= end_date:
    iso = current.isoformat()

    print(f"Computing {iso}...")

    # Moon (expects string)
    moon_data = get_ui_moon_data(iso)

    # Solar (expects string)
    solar_data = {"positions": get_positions(iso)}

    # Visibility (expects string)
    visibility_data = compute_visibility(iso)

    bundle[iso] = {
        "moon": moon_data,
        "solar": solar_data,
        "visibility": visibility_data,
    }

    current += timedelta(days=1)

print("Generating events for full year...")
events = generate_events_for_year(YEAR)

# Convert Pydantic models to dict
events_serialized = [e.model_dump() for e in events]

final_output = {
    "year": YEAR,
    "days": bundle,
    "events": events_serialized,
}

with open(f"year_{YEAR}_bundle.json", "w", encoding="utf-8") as f:
    json.dump(final_output, f, indent=2)

print("✅ Done. JSON generated.")
