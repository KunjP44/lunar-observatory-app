from datetime import date, timedelta, datetime
from typing import List

# from backend.moon.logic import get_moon_data
# from backend.events.models import Event

from moon.logic import get_moon_data
from events.models import Event

from skyfield.api import load
import math


# 🇮🇳 India Observer (Ahmedabad for now)
INDIA_LAT = 23.0225
INDIA_LON = 72.5714


eph = None
ts = None
sun = None
earth = None
PLANETS = None


def get_skyfield():
    global eph, ts, sun, earth, PLANETS

    if eph is None:
        eph = load("de421.bsp")
        ts = load.timescale(builtin=True)
        sun = eph["sun"]
        earth = eph["earth"]

        PLANETS = {
            "mars": eph["mars"],
            "jupiter": eph["jupiter_barycenter"],
            "saturn": eph["saturn_barycenter"],
        }

    return eph, ts, sun, earth, PLANETS


def extract_moon_events(d: date) -> List[Event]:
    events = []

    data = get_moon_data(
        location_name="India",
        date_str=d.isoformat(),
        latitude=INDIA_LAT,
        longitude=INDIA_LON,
    )

    # Lunar Eclipse
    if data.get("lunar_eclipse"):
        events.append(
            Event(
                id=f"lunar_eclipse_{d}",
                date=d.isoformat(),
                type="lunar_eclipse",
                title="Lunar Eclipse",
                priority="major",
                visible_from_india=data["lunar_eclipse"]["visible_here"],
                visibility_regions=data["lunar_eclipse"]["global_visibility"],
                peak_time_ist=None,
            )
        )

    # Solar Eclipse
    if data.get("solar_eclipse"):
        events.append(
            Event(
                id=f"solar_eclipse_{d}",
                date=d.isoformat(),
                type="solar_eclipse",
                title="Solar Eclipse",
                priority="major",
                visible_from_india=data["solar_eclipse"]["visible_here"],
                visibility_regions=data["solar_eclipse"]["global_visibility"],
                peak_time_ist=None,
            )
        )

    # Supermoon
    if data.get("event") == "supermoon":
        events.append(
            Event(
                id=f"supermoon_{d}",
                date=d.isoformat(),
                type="supermoon",
                title="Supermoon",
                priority="major",
                visible_from_india=True,
                visibility_regions=["India"],
            )
        )

    return events


def is_opposition(planet_name: str, d: date) -> bool:
    eph, ts, sun, earth, PLANETS = get_skyfield()

    dt = datetime(d.year, d.month, d.day)
    t = ts.utc(dt.year, dt.month, dt.day)

    planet = PLANETS[planet_name]

    astrometric = earth.at(t).observe(planet)
    elongation = astrometric.separation_from(earth.at(t).observe(sun)).degrees

    return abs(elongation - 180) < 1.0


def extract_opposition_events(d: date) -> List[Event]:
    events = []

    # Ensure Skyfield is initialized
    eph, ts, sun, earth, PLANETS = get_skyfield()

    for name in PLANETS:
        if is_opposition(name, d):
            events.append(
                Event(
                    id=f"{name}_opposition_{d}",
                    date=d.isoformat(),
                    type="planetary_opposition",
                    title=f"{name.capitalize()} Opposition",
                    priority="major",
                    visible_from_india=True,
                    visibility_regions=["India"],
                    planet=name.capitalize(),
                )
            )

    return events


def generate_events_for_year(year: int) -> List[Event]:
    events = []

    start = date(year, 1, 1)
    end = date(year, 12, 31)

    d = start
    while d <= end:
        events.extend(extract_moon_events(d))
        events.extend(extract_opposition_events(d))
        d += timedelta(days=1)

    return events
