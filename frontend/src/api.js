// ================= Environment Detection =================
const IS_LOCAL =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1";

const API_BASE = IS_LOCAL
    ? "http://127.0.0.1:8000"
    : "https://lunar-observatory.onrender.com";

// ================= 🌕 Moon API =================
export async function fetchMoonData(date) {
    const formatted = date.replaceAll("/", "-");

    const res = await fetch(`${API_BASE}/moon?d=${formatted}`);
    if (!res.ok) throw new Error("Moon API failed");

    return await res.json();
}

// ================= 🪐 Solar API =================
export async function fetchPlanetPositions(date) {
    const formatted = date.replaceAll("/", "-");

    const res = await fetch(`${API_BASE}/api/solar/positions?date=${formatted}`);
    if (!res.ok) throw new Error("Solar API failed");

    const data = await res.json();
    return data.positions;
}

export async function fetchVisibility() {
    return {};
}

export async function fetchEventsForYear() {
    return [];
}