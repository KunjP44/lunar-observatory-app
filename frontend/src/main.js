const ASSET_BASE = "./public/";
const IS_LOCAL =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1";

const API_BASE = IS_LOCAL
    ? "http://127.0.0.1:8000"
    : "https://lunar-observatory.onrender.com"; // we will deploy here

import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
import { loadInfoCard } from "./infoCard.js";
import { fetchMoonData, fetchPlanetPositions } from "./api.js";
import { initLearnMode } from "./learn.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-messaging.js";

window.addEventListener("error", e => {
    console.error("GLOBAL ERROR:", e.message);
    document.getElementById("loader")?.remove();
});


// 🔥 Detect if running inside Capacitor native app
const isNativeApp =
    typeof window !== "undefined" &&
    window.Capacitor &&
    window.Capacitor.isNativePlatform &&
    window.Capacitor.isNativePlatform();

console.log("Is Native App:", isNativeApp);

// ============================== LOGIC CONTROLLER ==============================
let targetPhaseAngle = 0; // from backend (degrees)
let visualPhaseAngle = 0; // smoothed (degrees)
const PHASE_LERP_SPEED = 0.05;
// ============================== LOGIC CONTROLLER ==============================
function updateMoonCards(data) {
    if (!data) return;

    const d = new Date(data.date);

    // ---------------- DATE ----------------
    document.getElementById("date-day").textContent = d.getDate();
    document.getElementById("date-month").textContent =
        d.toLocaleString("default", { month: "long", year: "numeric" });
    document.getElementById("date-weekday").textContent =
        data.day || d.toLocaleString("default", { weekday: "long" });

    // ---------------- PHASE ----------------
    document.getElementById("ui-phase").textContent = data.phase;
    document.getElementById("ui-illum").textContent = `${data.illumination}%`;
    document.getElementById("ui-age").textContent = `${data.age} days`;

    // ---------------- PANCHANG ----------------
    document.getElementById("ui-tithi").textContent = data.phase;
    document.getElementById("ui-paksha").textContent = data.paksha;
    document.getElementById("ui-nakshatra").textContent = data.constellation;

    // ---------------- PHYSICS ----------------
    document.getElementById("ui-distance").textContent =
        `${data.distance_km.toLocaleString()} km`;

    // ---------------- PHASE → LIGHT ----------------
    // backend sends phase_angle in degrees (0–360)
    if (typeof data.phase_angle === "number") {
        targetPhaseAngle = data.phase_angle % 360;
    }
}
// ================= SIMULATION TIME ================= 
// Date Logic
let realToday = new Date(); // today, never auto-advances
let simDate = new Date(realToday); // simulation clock  
const BACKEND_SYNC_MS = 60 * 1000; // sync every 1 simulated minute
let lastBackendSyncMs = 0;
const dateInput = document.getElementById("date-input");
let currentDate = new Date(); // UI reference date
const MS_PER_REAL_SECOND = 1000; // real milliseconds
const MS_PER_SIM_SECOND = 1000;  // 1× = real-time


async function loadMoonForDate(dateObj) {
    try {
        const iso = dateObj.toISOString().slice(0, 10);
        const data = await fetchMoonData(iso);
        updateMoonCards(data);
    } catch (e) {
        console.error("API Error:", e);
    }
}


// Event Listeners for Date Picker
document.getElementById("open-date-picker").onclick = () => {
    document.getElementById("date-display").classList.add("hidden");
    document.getElementById("date-picker").classList.remove("hidden");
    // dateInput.valueAsDate = currentDate;
    if (dateInput) dateInput.valueAsDate = currentDate;
};

document.getElementById("cancel-date").onclick = () => {
    document.getElementById("date-picker").classList.add("hidden");
    document.getElementById("date-display").classList.remove("hidden");
};

document.getElementById("apply-date").onclick = async () => {
    if (!dateInput.value) return;

    // 🛑 FREEZE SIMULATION IMMEDIATELY
    isTimePaused = true;
    isTimeTraveling = false;

    const selected = dateInput.value;
    const newDate = new Date(selected);

    document.getElementById("date-picker").classList.add("hidden");
    document.getElementById("date-display").classList.remove("hidden");

    // SNAP DATE
    simDate = new Date(newDate);
    currentDate = new Date(newDate);

    // FORCE BACKEND UPDATE
    await loadMoonForDate(newDate);
    await loadSolarForDate(newDate);
    await loadPlanetVisibilityForDate(newDate);

    updateDateDisplay();

    // Optional: Resume simulation
    isTimePaused = false;
};

function startTimeTravelAnimation(diffMs) {
    isTimeTraveling = true;
    travelStartTime = clock.getElapsedTime();
    isTimePaused = true;

    // STORE START + END TIMES
    travelStartDate = new Date(simDate);
    travelEndDate = new Date(simDate.getTime() + diffMs);

    const MS_IN_YEAR = 3.15576e10;

    for (const name in PLANETS) {
        const p = PLANETS[name];

        travelStartAngles[name] = planetAngles[name] || 0;

        const addedAngle =
            (diffMs / MS_IN_YEAR) *
            (Math.PI * 2) /
            p.period;

        travelTargetAngles[name] =
            travelStartAngles[name] + addedAngle;
    }
}



/* =====================================================
THREE.JS ENGINE
===================================================== */
const scene = new THREE.Scene();
const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.domElement.style.zIndex = "0";
document.body.appendChild(renderer.domElement);

const clock = new THREE.Clock();

/* =====================================================
CAMERA & STATE
===================================================== */
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 15000);

let theta = Math.PI / 4;
let phi = Math.PI / 3;
let targetRadius = 180;
let currentRadius = 200;
let targetTheta = Math.PI / 4;
let targetPhi = Math.PI / 3;
const targetPos = new THREE.Vector3(0, 0, 0);
const currentTargetPos = new THREE.Vector3(0, 0, 0);

let cameraMode = "default";
const DEFAULT_RADIUS = 180;
const DEFAULT_MIN_RADIUS = 60;
const DEFAULT_MAX_RADIUS = 3500;
let focusMinRadius = 14;
let focusMaxRadius = 120;
let uiPage = "solar";
let focusObject = null;
let solarPaused = false;
let isMobile = window.innerWidth < 768;
const MOON_SCALE = isMobile ? 33 : 40;
const LUNAR_OFFSET_DESKTOP = new THREE.Vector3(9, 0, 0);
const LUNAR_OFFSET_MOBILE = new THREE.Vector3(0, 0, 0);
const lunarFrameOffset = new THREE.Vector3();
const MOON_BASE_SCALE = 2.5;


const TIME_TRAVEL_THRESHOLD_DAYS = 7;
const TIME_TRAVEL_DURATION = 5.0; // Seconds the animation takes
let isTimeTraveling = false;
let travelStartTime = 0;
let travelStartAngles = {};
let travelTargetAngles = {};
let travelStartDate;
let travelEndDate;
let timeScale = 1; // required by animation loop
let isTimePaused = false;

/* =====================================================
LIGHTING
===================================================== */
const SOLAR_LIGHTING = {
    ambient: 0.35,
    sun: 18,
};

const LUNAR_LIGHTING = {
    ambient: 0.0001,
    sun: 0,
    lunar: 6,
};

const ambient = new THREE.AmbientLight(0xffffff, SOLAR_LIGHTING.ambient);
scene.add(ambient);

const hemi = new THREE.HemisphereLight(
    0xffffff,   // sky
    0x222233,   // ground
    0.6
);
scene.add(hemi);


const sunLight = new THREE.PointLight(0xffffff, SOLAR_LIGHTING.sun, 5000);
sunLight.decay = 2;
sunLight.distance = 2000;
sunLight.intensity = 25;
scene.add(sunLight);

const lunarSpotlight = new THREE.DirectionalLight(0xffffff, 6);
lunarSpotlight.castShadow = false;
lunarSpotlight.position.set(15, 5, 10);
scene.add(lunarSpotlight);
lunarSpotlight.visible = false;


const starGeo = new THREE.BufferGeometry();
const starPos = new Float32Array(6000 * 3);
for (let i = 0; i < starPos.length; i++) starPos[i] = (Math.random() - 0.5) * 10000;
starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 1, color: 0xffffff, sizeAttenuation: false }));
scene.add(stars);

/* =====================================================
SYSTEM SETUP
===================================================== */
const loader = new THREE.TextureLoader();

const tex = (f) => {
    const t = loader.load(`${ASSET_BASE}textures/${f}`);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
};

const PLANETS = {
    Mercury: { a: 0.387, e: 0.205, w: 77.46, i: 7.00, period: 0.241, rotationDays: 58.6 },
    Venus: { a: 0.723, e: 0.007, w: 131.57, i: 3.39, period: 0.615, rotationDays: -243 },
    Earth: { a: 1.000, e: 0.017, w: 102.94, i: 0.00, period: 1.0, rotationDays: 1 },
    Mars: { a: 1.524, e: 0.093, w: 336.04, i: 1.85, period: 1.881, rotationDays: 1.03 },
    Jupiter: { a: 5.203, e: 0.049, w: 14.75, i: 1.30, period: 11.86, rotationDays: 0.41 },
    Saturn: { a: 9.537, e: 0.054, w: 92.43, i: 2.48, period: 29.46, rotationDays: 0.44 },
    Uranus: { a: 19.19, e: 0.047, w: 170.96, i: 0.77, period: 84.01, rotationDays: -0.72 },
    Neptune: { a: 30.07, e: 0.009, w: 44.97, i: 1.77, period: 164.8, rotationDays: 0.67 }
};


// ================= MOON ORBIT PARAMS =================
const MOON_ORBIT = {
    radius: 2.2,
    periodDays: 27.3217,
};

let moonAngle = Math.random() * Math.PI * 2;

const planetMeshes = {};
const planetAngles = {};
const orbitLines = [];
let asteroidBelt = null;
let kuiperBelt = null;

const sun = new THREE.Mesh(
    new THREE.SphereGeometry(22, 64, 64),
    new THREE.MeshStandardMaterial({
        map: tex("sun.jpg"),
        roughness: 1,
        metalness: 0
    })
);

sun.userData.id = "sun";
scene.add(sun);
planetMeshes.sun = sun;
console.log("Sun position:", sun.position);

for (const name in PLANETS) {
    const p = PLANETS[name];
    const mat = name === "Earth"
        ? new THREE.MeshStandardMaterial({ map: tex("earth-day.jpg"), emissiveMap: tex("earth-night.jpg"), emissiveIntensity: 0.7 })
        : new THREE.MeshStandardMaterial({ map: tex(`${name.toLowerCase()}.jpg`) });

    // const mesh = new THREE.Mesh(new THREE.SphereGeometry(p.r, 48, 48), mat);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(p.r || 1, 48, 48), mat);
    mesh.userData.id = name.toLowerCase();
    scene.add(mesh);

    const PLANET_SIZE_SCALE = 4;
    mesh.userData.baseScale = PLANET_SIZE_SCALE;
    mesh.scale.setScalar(PLANET_SIZE_SCALE);
    // mesh.scale.multiplyScalar(2.5);
    planetMeshes[name] = mesh;
    // ================= SATURN RINGS =================
    if (name === "Saturn") {

        const ringTexture = tex("saturn-ring.png");

        const ringGeometry = new THREE.RingGeometry(2, 3, 128);

        const ringMaterial = new THREE.MeshStandardMaterial({
            map: ringTexture,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.9,
            depthWrite: false
        });

        const ring = new THREE.Mesh(ringGeometry, ringMaterial);

        // Rotate to lie flat in planet equator plane
        ring.rotation.x = Math.PI / 2;

        // Slight tilt (Saturn axial tilt ~26.7°)
        ring.rotation.z = THREE.MathUtils.degToRad(26.7);

        mesh.add(ring);
        ringGeometry.attributes.uv.needsUpdate = true;
    }
    planetAngles[name] = Math.random() * Math.PI * 2;
    if (name === "Earth") {
        const moon = new THREE.Mesh(
            new THREE.SphereGeometry(0.27, 48, 48),
            new THREE.MeshStandardMaterial({
                map: tex("moon.jpg"),
                roughness: 1,
                metalness: 0
            })
        );

        moon.userData.id = "moon";
        moon.position.set(2.2, 0, 0);
        moon.scale.setScalar(MOON_BASE_SCALE / PLANET_SIZE_SCALE);

        mesh.add(moon);
        planetMeshes.moon = moon;
    }
    const { a, e } = PLANETS[name];
    // const orbit = createCircularOrbit(p.a);
    const orbit = createEllipticalOrbit(p);
    scene.add(orbit);
    orbitLines.push(orbit);
}
asteroidBelt = createAsteroidBelt();
kuiperBelt = createKuiperBelt();

// ================= NEW UI LOGIC =================

// 1. Open Picker
document.getElementById("btn-date-trigger")?.addEventListener("click", () => {
    const picker = document.getElementById("solar-date-picker");
    const input = document.getElementById("solar-date-input");
    picker.classList.remove("hidden");
    input.value = simDate.toISOString().slice(0, 10);
});

// 2. Cancel
document.getElementById("solar-cancel-date")?.addEventListener("click", () => {
    document.getElementById("solar-date-picker").classList.add("hidden");
});

// 3. Apply (Warp)
document.getElementById("solar-apply-date")?.addEventListener("click", async () => {
    const input = document.getElementById("solar-date-input");
    if (!input.value) return;

    // 🛑 Stop normal ticking
    isTimePaused = true;
    isTimeTraveling = false;

    const newDate = new Date(input.value);
    const diffMs = newDate - simDate;
    const diffDays = Math.abs(diffMs / (1000 * 60 * 60 * 24));

    document.getElementById("solar-date-picker").classList.add("hidden");

    if (diffDays > TIME_TRAVEL_THRESHOLD_DAYS) {

        // 🚀 Let time travel system control pause/resume
        startTimeTravelAnimation(diffMs);

        simDate = new Date(newDate);
        currentDate = new Date(newDate);
        updateDateDisplay();
    } else {

        // ⚡ Instant Snap
        simDate = new Date(newDate);
        currentDate = new Date(newDate);

        await loadMoonForDate(newDate);
        await loadSolarForDate(newDate);

        updateDateDisplay();

        // ▶️ Resume only for snap case
        isTimePaused = false;
    }
});

function updateDateDisplay() {
    const label = document.getElementById("solar-date-label");
    if (label) {
        label.textContent = simDate.toLocaleDateString("en-US", {
            month: "short", day: "numeric", year: "numeric"
        });
    }
}

const planetList = document.getElementById("planet-visibility-list");
const infoCard = document.getElementById("info-card");
if (infoCard) infoCard.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
Object.values(planetMeshes).forEach(m => m.visible = true);

const timeLabel = document.getElementById("time-label");
function realignMoonPhaseImmediately() {
    if (!planetMeshes.moon) return;

    // Force visual phase = target phase
    visualPhaseAngle = targetPhaseAngle;

    const rad = THREE.MathUtils.degToRad(visualPhaseAngle - 90);

    const lightDir = new THREE.Vector3(
        Math.cos(rad),
        0,
        Math.sin(rad)
    );

    lunarSpotlight.position.copy(lightDir.multiplyScalar(50));
    lunarSpotlight.target.position.set(0, 0, 0);
    lunarSpotlight.target.updateMatrixWorld();
}

async function resetSimulationToNow() {
    // 1. Reset clocks
    const now = new Date();
    realToday = new Date(now);
    simDate = new Date(now);
    currentDate = new Date(now);

    // 2. Reset Physics (Fixed: No more timeIndex)
    timeScale = 1;        // Default to Real Time
    isTimePaused = false;
    isTimeTraveling = false;

    // 3. Reset Backend Sync
    lastBackendSyncMs = 0;

    // 4. Reset Moon Visuals
    if (planetMeshes.moon) {
        planetMeshes.moon.rotation.set(0, 0, 0);
    }
    visualPhaseAngle = targetPhaseAngle;
    realignMoonPhaseImmediately();

    // 5. Force backend updates for everything
    await loadMoonForDate(simDate);
    await loadSolarForDate(simDate);
    await loadPlanetVisibilityForDate(simDate);

    // 6. Immediately realign phase lighting
    realignMoonPhaseImmediately();

    // 7. Update UI
    updateDateDisplay();

    console.log("✅ Reset to current date & time:", simDate.toString());
}
const solarDateBtn = document.getElementById("solar-date-btn");
const solarDatePicker = document.getElementById("solar-date-picker");
const solarDateInput = document.getElementById("solar-date-input");

solarDateBtn?.addEventListener("click", () => {
    solarDatePicker.classList.remove("hidden");
    solarDateInput.valueAsDate = simDate;
});

/* =====================================================
INPUT HANDLING (FIXED ROTATION & DOUBLE CLICK)
===================================================== */
let isMouseDown = false;
let touchStart = { x: 0, y: 0 };
let touchCurrent = { x: 0, y: 0 };
let lastTouchDist = 0; // For pinch zoom
let isPinching = false;
let isDragging = false;
let draggingMoon = false;
let lastX = 0, lastY = 0;
let lastTap = 0;
const pointer = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const canvas = renderer.domElement;
let singleTapTimeout = null;

canvas.style.touchAction = "none";

// 1. Mouse Down: PREPARE TO DRAG
canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    isMouseDown = true;
    isDragging = false; // Reset drag state
    lastX = e.clientX;
    lastY = e.clientY;

    // Check if we are clicking on Moon in Lunar mode
    if (cameraMode === "lunar" && planetMeshes.moon) {
        pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
        pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObjects([planetMeshes.moon], true);
        if (hits.length > 0) draggingMoon = true;
    }
});

window.addEventListener("blur", () => {
    isMouseDown = false;
    isDragging = false;
    draggingMoon = false;
});


// 2. Mouse Up: RESET STATE
canvas.addEventListener("mouseup", () => {
    isMouseDown = false;
    draggingMoon = false;
    // Note: We don't do focus here anymore, we use dblclick
});
canvas.addEventListener("mouseleave", () => {
    isMouseDown = false;
    draggingMoon = false;
    isDragging = false;
});

// 3. Mouse Move: HANDLE ROTATION
canvas.addEventListener("mousemove", (e) => {
    // Cursor Logic
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    if (!isMouseDown) {
        // Just hovering? Show pointer if over object
        const hits = raycaster.intersectObjects(Object.values(planetMeshes), true);
        let validHit = false;
        for (const h of hits) {
            if (h.object.visible) {
                let o = h.object;
                while (o.parent && !o.userData.id) o = o.parent;
                if (o.userData.id) { validHit = true; break; }
            }
        }
        document.body.style.cursor = validHit ? "pointer" : "default";
        return;
    }

    // If mouse is down and moving, we are dragging
    isDragging = true;

    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;

    if (cameraMode === "lunar" && draggingMoon) {
        planetMeshes.moon.rotation.y += dx * 0.007;
    } else if (cameraMode !== "lunar") {
        // Update TARGETS instead of actual values to allow smoothing
        targetTheta -= dx * 0.005;
        targetPhi -= dy * 0.005;

        // Clamp the target immediately so we don't flip over
        targetPhi = THREE.MathUtils.clamp(targetPhi, 0.1, Math.PI - 0.1);
    }
    lastX = e.clientX;
    lastY = e.clientY;
});

// 4. Double Click: FOCUS LOGIC
canvas.addEventListener("dblclick", (e) => {
    if (uiPage !== "solar") return;

    canvas.addEventListener("click", (e) => {
        if (uiPage !== "solar") return;

        // Ignore click if it was part of a drag
        if (isDragging) return;

        handleSingleTap(e.clientX, e.clientY);
    });

    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const hits = raycaster.intersectObjects(Object.values(planetMeshes), true);

    if (hits.length > 0) {
        let obj = hits[0].object;
        while (obj.parent && !obj.userData.id) obj = obj.parent;

        if (obj.userData.id) {
            focusOn(obj);
        }
    } else {
        exitFocus();
    }
});


window.addEventListener("wheel", (e) => {

    // STOP camera zoom if events panel is open
    if (eventsPanel && eventsPanel.classList.contains("show")) return;

    if (uiPage === "lunar") return;

    targetRadius *= 1 + e.deltaY * 0.001; // higher value higher zoom speed

    const min = cameraMode === "focus" ? focusMinRadius : DEFAULT_MIN_RADIUS;
    const max = cameraMode === "focus" ? focusMaxRadius : DEFAULT_MAX_RADIUS;

    targetRadius = THREE.MathUtils.clamp(targetRadius, min, max);
});

//  ====================== touch controls =====================
/* =====================================================
   MOBILE TOUCH HANDLING (Google Earth Style)
===================================================== */

canvas.addEventListener("touchstart", (e) => {
    // 1. Single Finger (Rotate or Tap)
    if (e.touches.length === 1) {
        touchStart.x = e.touches[0].clientX;
        touchStart.y = e.touches[0].clientY;

        const now = Date.now();
        const DOUBLE_TAP_DELAY = 300;

        if (now - lastTap < DOUBLE_TAP_DELAY) {
            // --- DOUBLE TAP DETECTED ---
            e.preventDefault();
            clearTimeout(singleTapTimeout);
            handleDoubleTap(e.touches[0].clientX, e.touches[0].clientY);
            lastTap = 0;
        } else {
            // --- SINGLE TAP START ---
            lastTap = now;
            isDragging = false;
            isPinching = false;

            // Stop any existing inertia when finger touches down
            targetTheta = theta;
            targetPhi = phi;

            const x = e.touches[0].clientX;
            const y = e.touches[0].clientY;

            singleTapTimeout = setTimeout(() => {
                // Only trigger single tap if we didn't drag or pinch
                if (!isDragging && !isPinching) {
                    handleSingleTap(x, y);
                }
            }, DOUBLE_TAP_DELAY);
        }
    }

    // 2. Two Fingers (Pinch Zoom)
    if (e.touches.length === 2) {
        isPinching = true;
        isDragging = false;
        lastTap = 0; // Cancel tap logic

        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastTouchDist = Math.sqrt(dx * dx + dy * dy);
    }
}, { passive: false });


canvas.addEventListener("touchmove", (e) => {
    e.preventDefault(); // Prevent scrolling

    // --- ROTATION (1 Finger) ---
    if (e.touches.length === 1 && !isPinching && !isTimeTraveling) {
        const dx = e.touches[0].clientX - touchStart.x;
        const dy = e.touches[0].clientY - touchStart.y;

        // Threshold to prevent jitter on tiny movements
        if (!isDragging && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;

        isDragging = true;

        // Sensitivity: 1 screen width = 360 degrees rotation (Natural feel)
        const ROTATE_SPEED = 0.5;
        const sensitivity = (Math.PI * 2 * ROTATE_SPEED) / window.innerWidth;

        if (cameraMode === "lunar") {
            // 🌕 ROTATE MOON DIRECTLY
            if (planetMeshes.moon) {
                planetMeshes.moon.rotation.y += dx * sensitivity;
            }
        } else {
            // ☀️ ROTATE CAMERA ORBIT
            targetTheta -= dx * sensitivity;
            targetPhi -= dy * sensitivity;
            targetPhi = THREE.MathUtils.clamp(targetPhi, 0.1, Math.PI - 0.1);
        }

        touchStart.x = e.touches[0].clientX;
        touchStart.y = e.touches[0].clientY;
    }

    // --- PINCH ZOOM (2 Fingers) ---
    if (e.touches.length === 2) {
        isPinching = true;
        isDragging = false;

        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const currentDist = Math.sqrt(dx * dx + dy * dy);

        if (lastTouchDist > 0 && currentDist > 0) {
            // Multiplicative Zoom (Google Maps style)
            // Ratio > 1 means zooming IN, < 1 means zooming OUT
            const zoomRatio = lastTouchDist / currentDist;

            targetRadius *= zoomRatio;

            // Clamp Zoom Limits
            const min = cameraMode === "focus" ? focusMinRadius : DEFAULT_MIN_RADIUS;
            const max = cameraMode === "focus" ? focusMaxRadius : DEFAULT_MAX_RADIUS;

            targetRadius = THREE.MathUtils.clamp(targetRadius, min, max);
        }

        lastTouchDist = currentDist;
    }
}, { passive: false });

canvas.addEventListener("touchend", () => {
    isDragging = false;
    isPinching = false;
});
function handleInputFocus(clientX, clientY) {
    if (uiPage !== "solar") return;

    pointer.x = (clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(Object.values(planetMeshes), true);

    if (hits.length > 0) {
        let obj = hits[0].object;
        while (obj.parent && !obj.userData.id) obj = obj.parent;

        if (obj.userData.id) {
            focusOn(obj);
        }
    } else {
        exitFocus();
    }
}

function handleSingleTap(clientX, clientY) {

    pointer.x = (clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const hits = raycaster.intersectObjects(Object.values(planetMeshes), true);

    if (hits.length > 0) {
        let obj = hits[0].object;
        while (obj.parent && !obj.userData.id) obj = obj.parent;

        if (obj.userData.id) {

            // NEW LOGIC: Only show card if we are ALREADY focused on this specific object
            if (cameraMode === "focus" && focusObject?.userData?.id === obj.userData.id) {
                loadInfoCard(obj.userData.id);
                infoCard.classList.remove("hidden");
            }
            // If not focused, Single Tap does nothing (waiting for Double Tap)
        }
    }
}

function handleDoubleTap(clientX, clientY) {
    if (uiPage !== "solar") return;

    pointer.x = (clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const hits = raycaster.intersectObjects(Object.values(planetMeshes), true);

    if (hits.length > 0) {
        let obj = hits[0].object;
        while (obj.parent && !obj.userData.id) obj = obj.parent;

        if (obj.userData.id) {
            focusOn(obj);
        }
    }
}

const modeDock = document.querySelector(".mode-switch-container");
const sheetModes = document.querySelector(".sheet-modes");
if (modeDock) {
    modeDock.classList.add("floating");
}
const lunarCards = document.querySelector(".lunar-cards");

if (lunarCards) {
    lunarCards.addEventListener("scroll", () => {
        // If user scrolls down just a tiny bit (5px), expand the sheet
        if (lunarCards.scrollTop > 5) {
            lunarCards.classList.add("scrolled");
        }
        // If user scrolls back to the very top, shrink the sheet back to peaking
        else if (lunarCards.scrollTop === 0) {
            lunarCards.classList.remove("scrolled");
        }
    });
}

// -----------------------------------------------------
// SCENE HELPERS
// -----------------------------------------------------
const moonSheet = document.getElementById("moon-sheet");
let sheetExpanded = false;
if (moonSheet) {
    moonSheet.addEventListener("scroll", () => {
        const visual = document.querySelector(".lunar-visual");
        if (visual) {
            if (moonSheet.scrollTop > 50) visual.style.filter = "blur(15px) brightness(0.5)";
            else visual.style.filter = "none";
        }
    });
}

function updateModeButtons(activeId) {
    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.toggle('active', btn.id === activeId));
}

const solarBtn = document.getElementById("solar-mode-btn");
if (solarBtn) {
    solarBtn.addEventListener("click", () => {
        exitLearnMode();
        resetToSolar();
        updateModeButtons("solar-mode-btn");
        uiPage = "solar";
    });
}

const resetBtn = document.getElementById("reset-view");
if (resetBtn) {
    resetBtn.addEventListener("click", async () => {

        // If in Learn mode → exit learn
        if (uiPage === "learn") {
            exitLearnMode();
            resetToSolar();
            updateModeButtons("solar-mode-btn");
            return;
        }

        // If in Lunar mode → exit lunar only
        if (uiPage === "lunar") {
            resetToSolar();
            updateModeButtons("solar-mode-btn");
            return;
        }

        // If focused → just exit focus
        if (cameraMode === "focus") {
            exitFocus();
            return;
        }

        // Otherwise → full reset
        isTimePaused = true;
        await resetSimulationToNow();
        smoothResetCamera();
        isTimePaused = false;
    });
}

const learningBtn = document.getElementById("learning-mode-btn");

if (learningBtn) {
    learningBtn.addEventListener("click", () => {

        if (uiPage === "learn") return;

        // If coming from Lunar → exit properly
        if (uiPage === "lunar") {
            resetToSolar();
        }

        uiPage = "learn";
        cameraMode = "learn";

        updateModeButtons("learning-mode-btn");

        document.getElementById("learn-mode")?.classList.remove("hidden");
        document.getElementById("moon-mode")?.classList.add("hidden");

        renderer.domElement.style.display = "none";

        document.body.classList.add("learn-active");

        updateResetButton("learn");
        initLearnMode();
    });
}
function exitLearnMode() {

    const learnMode = document.getElementById("learn-mode");
    if (learnMode) learnMode.classList.add("hidden");

    document.body.classList.remove("learn-active");

    renderer.domElement.style.display = "block";

    cameraMode = "default";
    uiPage = "solar";

    updateModeButtons("solar-mode-btn");
    updateResetButton("solar");
}
function resetToSolar() {
    console.log("RESET TO SOLAR");

    // 1. Reset State Flags
    uiPage = "solar";
    cameraMode = "default";
    solarPaused = false;
    lunarIntro = false; // FIX: Stop any running lunar intro animation

    // 2. CSS & UI Cleanup
    document.body.classList.remove("lunar-active");
    document.body.classList.remove("focused");
    document.getElementById("env-gradient").classList.remove("lunar");
    document.getElementById("focus-overlay")?.classList.remove("active");

    // 3. Hide Lunar UI immediately
    const moonMode = document.getElementById("moon-mode");
    if (moonMode) moonMode.classList.add("hidden");

    // 4. Reset Camera & 3D Scene
    updateResetButton("solar");
    exitLunarScene();  // Moves moon back to Earth
    exitFocus(); // Clears focus target
    smoothResetCamera(); // Resets camera angle

    // 5. Restore Solar UI Hints
    const hint = document.querySelector(".ui-hint");
    if (hint && uiPage === "solar") {
        hint.style.opacity = 1;
    }
}

const lunarBtn = document.getElementById("lunar-mode-btn");

if (lunarBtn) {
    lunarBtn.addEventListener("click", () => {

        if (uiPage === "lunar") return;

        // If coming from Learn → exit cleanly
        if (uiPage === "learn") {
            exitLearnMode();
        }

        uiPage = "lunar";
        cameraMode = "lunar";

        updateModeButtons("lunar-mode-btn");

        renderer.domElement.style.display = "block";

        enterLunarScene();

        document.getElementById("env-gradient")?.classList.add("lunar");

        updateResetButton("lunar");
    });
}


function setSystemVisibility(visible) {
    planetMeshes.sun.visible = visible;
    for (const name in PLANETS) planetMeshes[name].visible = visible;
    orbitLines.forEach(o => o.visible = visible);
    if (asteroidBelt) asteroidBelt.visible = visible;
    if (kuiperBelt) kuiperBelt.visible = visible;
}

function focusOn(obj) {
    if (cameraMode === "lunar") return;
    obj = planetMeshes[obj.userData.id.charAt(0).toUpperCase() + obj.userData.id.slice(1)] || obj;
    cameraMode = "focus";
    focusObject = obj;
    solarPaused = true;

    // REMOVED: loadInfoCard and classList removal

    const r = obj.geometry.boundingSphere.radius;

    // Desktop: 12x radius, Mobile: 18x radius
    const isMobileDevice = window.innerWidth < 768;
    const zoomMultiplier = isMobileDevice ? 18 : 12;

    focusMinRadius = Math.max(20, r * 4);
    focusMaxRadius = r * 40;
    targetRadius = r * zoomMultiplier;

    // 🔹 Pretty name
    document.getElementById("focus-name").textContent =
        obj.userData.id === "moon" ? "MOON" : obj.userData.id.toUpperCase();

    // Keep overlay active to show we are in focus mode (optional, but good UX)
    document.getElementById("focus-indicator").classList.remove("hidden");
    document.getElementById("focus-overlay").classList.add("active");
    document.body.classList.add("focused");
}

function exitFocus() {

    cameraMode = "default";
    focusObject = null;
    solarPaused = false;

    // 🔥 Reset camera targets properly
    targetPos.set(0, 0, 0);
    currentTargetPos.set(0, 0, 0);

    targetTheta = Math.PI / 4;
    targetPhi = Math.PI / 3;

    theta = targetTheta;
    phi = targetPhi;

    targetRadius = DEFAULT_RADIUS;
    currentRadius = DEFAULT_RADIUS;

    setSystemVisibility(true);

    document.getElementById("info-card")?.classList.add("hidden");
    document.getElementById("focus-indicator").classList.add("hidden");
    document.getElementById("focus-overlay").classList.remove("active");

    document.body.classList.remove("focused");
}


const toggleBtn = document.getElementById("toggle-details");
const closeBtn = document.getElementById("close-card");

toggleBtn?.addEventListener("click", () => {
    infoCard.classList.toggle("expanded");
    infoCard.classList.toggle("collapsed");

    toggleBtn.textContent =
        infoCard.classList.contains("expanded")
            ? "Hide Telemetry"
            : "View Telemetry";
});

closeBtn?.addEventListener("click", () => {
    // 1. If in Lunar mode, exit back to Solar System
    resetToSolar();
    if (uiPage === "lunar") {
        resetToSolar();
        return;
    }

    // 2. If focused on a specific planet, exit focus (this automatically hides the card)
    if (cameraMode === "focus") {
        exitFocus();
        return;
    }

    // 3. If just viewing the card in default mode, JUST hide the card, don't reset camera
    infoCard.classList.add("hidden");
    const toggleBtn = document.getElementById("toggle-details");
    if (toggleBtn) toggleBtn.textContent = "View Telemetry"; // Reset toggle text
});


// ============ Logic for transforming reset to exit ==============
function updateResetButton(mode) {
    const label = document.getElementById("reset-label");
    if (!label) return;

    if (mode === "solar") {
        label.textContent = "Reset View";
    } else if (mode === "lunar") {
        label.textContent = "Exit Observatory";
    } else if (mode === "learn") {
        label.textContent = "Back to Scene";
    }
}



function setCanvasInteraction(enabled) {
    renderer.domElement.style.pointerEvents = enabled ? "auto" : "none";
}
function smoothResetCamera() {
    cameraMode = "default";
    focusObject = null;
    solarPaused = false;

    // Reset target position
    targetPos.set(0, 0, 0);
    currentTargetPos.set(0, 0, 0);

    // Reset angles
    targetTheta = Math.PI / 4;
    targetPhi = Math.PI / 3;

    theta = targetTheta;
    phi = targetPhi;

    // 🚀 HARD RESET radius (no smoothing through sun)
    currentRadius = DEFAULT_RADIUS;
    targetRadius = DEFAULT_RADIUS;
}

// ================= Function to change the lighting ==============
function applySolarLighting() {
    ambient.intensity = SOLAR_LIGHTING.ambient;
    hemi.intensity = 0.6;
    sunLight.intensity = SOLAR_LIGHTING.sun;
    lunarSpotlight.visible = false;
}
function applyLunarLighting() {
    // FIX: Use the LUNAR_LIGHTING constants instead of hardcoded numbers
    ambient.intensity = LUNAR_LIGHTING.ambient;
    hemi.intensity = 0.2;

    sunLight.intensity = LUNAR_LIGHTING.sun;

    lunarSpotlight.intensity = LUNAR_LIGHTING.lunar;
    lunarSpotlight.color.set(0xffffff);
    lunarSpotlight.visible = true;
}


// LUNAR SCENE HELPERS
let lunarIntro = false;
let lunarIntroProgress = 0;

function enterLunarScene() {
    if (!planetMeshes.moon) return;
    scene.attach(planetMeshes.moon);
    planetMeshes.moon.scale.setScalar(MOON_SCALE);

    setSystemVisibility(false);
    sunLight.visible = false;
    lunarSpotlight.visible = true;
    lunarFrameOffset.copy(isMobile ? LUNAR_OFFSET_MOBILE : LUNAR_OFFSET_DESKTOP);
    planetMeshes.moon.position.set(0, 0, 0);
    targetPos.set(0, 0, 0);
    currentTargetPos.set(0, 0, 0);

    planetMeshes.moon.rotation.set(0, 0, 0);
    planetMeshes.moon.visible = true;
    planetMeshes.moon.material.transparent = true;
    planetMeshes.moon.material.opacity = 0;

    document.body.classList.add("lunar-active");
    document.getElementById("moon-mode")?.classList.remove("hidden");
    // Show the planet visibility section when entering Lunar mode
    document.getElementById("planet-visibility-section")?.classList.remove("hidden");
    lunarIntro = true;
    lunarIntroProgress = 0;
    cameraMode = "lunar";
    solarPaused = true;
    document.getElementById("info-card")?.classList.add("hidden");
    document.body.classList.remove("focused");
    updateResetButton("lunar");
    applyLunarLighting();
    loadPlanetVisibilityForDate(simDate);

    targetTheta = Math.PI / 2;
    targetPhi = Math.PI / 2;

    // --- FIX 1: TASTEFUL ZOOM ---
    // Increased from 35/45 to 90/110 to give the Moon breathing room
    if (isMobile) {
        targetRadius = 55;
        currentRadius = 70;
    } else {
        targetRadius = 40;
        currentRadius = 90;
    }

}

function exitLunarScene() {
    // FIX: Ensure we reset opacity even if we think we aren't in lunar mode
    if (planetMeshes.moon) {
        planetMeshes.moon.material.transparent = false;
        planetMeshes.moon.material.opacity = 1;
    }

    if (!planetMeshes.moon || !planetMeshes.Earth) return;

    document.body.classList.remove("lunar-active");
    // Hide it when going back to Solar
    document.getElementById("planet-visibility-section")?.classList.add("hidden");

    // Re-parent Moon to Earth
    planetMeshes.Earth.add(planetMeshes.moon);
    planetMeshes.moon.position.set(2.2, 0, 0);
    planetMeshes.moon.scale.setScalar(MOON_BASE_SCALE / 4);

    // Lighting & Visibility
    sunLight.visible = true;
    lunarSpotlight.visible = false;
    setSystemVisibility(true);

    cameraMode = "default";


    applySolarLighting();
}
/* =====================================================
ANIMATION LOOP
===================================================== */
// Variable to track frames for UI throttling
let frameCount = 0;

function animate() {
    requestAnimationFrame(animate);

    const now = clock.getElapsedTime();
    const deltaSeconds = clock.getDelta();

    // ---------------- CAMERA TARGET ----------------
    if (cameraMode === "focus" && focusObject) {
        focusObject.getWorldPosition(targetPos);
    } else if (cameraMode === "lunar") {
        targetPos.copy(lunarFrameOffset);
    } else {
        targetPos.set(0, 0, 0);
    }

    // ---------------- BACKGROUND EFFECTS ----------------
    if (planetMeshes.sun) {
        planetMeshes.sun.material.emissiveIntensity = 0.35 + Math.sin(now * 2) * 0.1;
        sunLight.position.copy(planetMeshes.sun.position);
    }

    // Moon Idle Spin (Visual only)
    if (cameraMode === "lunar" && !lunarIntro && !isDragging && (!isMobile || !sheetExpanded)) {
        planetMeshes.moon.rotation.y += 0.0004;
    }

    // =========================================================
    //  STEP 1: CALCULATE ANGLES (PHYSICS ENGINE)
    // =========================================================
    let deltaSimMs = 0;
    const MS_IN_YEAR = 3.15576e10;

    if (isTimeTraveling) {
        // --- MODE A: TIME TRAVEL (Whoosh Effect) ---
        const elapsed = now - travelStartTime;
        let progress = elapsed / TIME_TRAVEL_DURATION;

        if (progress >= 1) {
            progress = 1;
            isTimeTraveling = false;
            isTimePaused = false;

            loadSolarForDate(simDate);
            loadMoonForDate(simDate);

            if (cameraMode === "lunar") {
                loadPlanetVisibilityForDate(simDate);
            }
        }

        const ease = progress < 0.5
            ? 4 * progress * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 3) / 2;

        // Visual Date Update
        const interpolated = travelStartDate.getTime() +
            (travelEndDate.getTime() - travelStartDate.getTime()) * ease;
        simDate = new Date(interpolated);

        // Update UI immediately during travel for smooth visual
        updateDateDisplay();

        // Interpolate Angles
        for (const name in PLANETS) {
            const p = PLANETS[name];
            const mesh = planetMeshes[name];

            if (travelStartAngles[name] !== undefined && travelTargetAngles[name] !== undefined) {
                planetAngles[name] = THREE.MathUtils.lerp(
                    travelStartAngles[name],
                    travelTargetAngles[name],
                    ease
                );
            }
            // Visual spin blur
            if (mesh && p.rotationDays) mesh.rotation.y += 0.05 * (1 + ease * 2);
        }

    } else if (!isTimePaused) {
        // --- MODE B: REAL TIME CLOCK ---
        // 1 Real Second = 1 Simulation Second (1000ms)
        deltaSimMs = deltaSeconds * 1000;
        simDate = new Date(simDate.getTime() + deltaSimMs);

        for (const name in PLANETS) {
            const p = PLANETS[name];
            const mesh = planetMeshes[name];

            // 1. ADVANCE ORBIT (Revolution)
            if (planetAngles[name] !== undefined) {
                const angleChange = (deltaSimMs / MS_IN_YEAR) * (Math.PI * 2) / p.period;
                planetAngles[name] += angleChange;
            }

            // 2. ADVANCE SPIN (Rotation)
            const MS_IN_DAY = 24 * 60 * 60 * 1000;
            if (mesh && p.rotationDays) {
                const rotationSpeed = (deltaSimMs / (p.rotationDays * MS_IN_DAY)) * Math.PI * 2;
                mesh.rotation.y += rotationSpeed;
            }
        }
    }

    // =========================================================
    //  STEP 2: APPLY POSITIONS (RENDERING)
    // =========================================================

    // 1. PLANETS (Elliptical Orbits + Inclination)
    if (uiPage === "solar" && cameraMode !== "lunar") {
        for (const name in PLANETS) {
            const p = PLANETS[name];
            const mesh = planetMeshes[name];
            if (!mesh || planetAngles[name] === undefined) continue;

            const theta = planetAngles[name];
            const { a, e, w, i } = p;

            const r_au = (a * (1 - e * e)) / (1 + e * Math.cos(theta));
            const r_scene = mapDistanceAU(r_au);

            const x_orb = r_scene * Math.cos(theta);
            const z_orb = r_scene * Math.sin(theta);

            const omega = THREE.MathUtils.degToRad(w);
            const x_w = x_orb * Math.cos(omega) - z_orb * Math.sin(omega);
            const z_w = x_orb * Math.sin(omega) + z_orb * Math.cos(omega);

            const inc = THREE.MathUtils.degToRad(i || 0);
            const y_final = z_w * Math.sin(inc);
            const z_final = z_w * Math.cos(inc);

            mesh.position.set(x_w, y_final, z_final);
        }
    }

    // 2. MOON ORBIT (Realistic Inclination)
    if (planetMeshes.moon && planetMeshes.Earth && uiPage === "solar" && cameraMode !== "lunar") {

        // Advance Angle Logic (Only if running normally)
        if (!isTimeTraveling && !isTimePaused) {
            const MS_IN_DAY = 24 * 60 * 60 * 1000;
            const deltaDays = deltaSimMs / MS_IN_DAY;
            moonAngle += (2 * Math.PI / MOON_ORBIT.periodDays) * deltaDays;
        }

        const moonR = MOON_ORBIT.radius;
        const moonInc = THREE.MathUtils.degToRad(5.14);

        const mx = moonR * Math.cos(moonAngle);
        const mz = moonR * Math.sin(moonAngle);
        const my = mz * Math.sin(moonInc);
        const mz_final = mz * Math.cos(moonInc);

        planetMeshes.moon.position.set(mx, my, mz_final);
    }

    // ---------------- UI & SYNC ----------------
    // CRITICAL FIX: Throttle UI Updates (1x per 0.5s approx)
    frameCount++;
    if (frameCount % 30 === 0 && !isTimeTraveling) {
        updateDateDisplay();
    }

    // Backend Safety Sync
    if (!isTimeTraveling) {
        lastBackendSyncMs += deltaSimMs;
        if (lastBackendSyncMs >= BACKEND_SYNC_MS) {
            lastBackendSyncMs = 0;
            loadSolarForDate(simDate);
        }
    }

    // ---------------- LUNAR MODE SPECIFICS ----------------
    if (cameraMode === "lunar") {
        if (lunarIntro) {
            lunarIntroProgress += 0.02;
            const t = Math.min(lunarIntroProgress, 1);
            const ease = 1 - Math.pow(1 - t, 3);
            planetMeshes.moon.material.opacity = ease;
            planetMeshes.moon.scale.setScalar(MOON_SCALE);
            if (t >= 1) { planetMeshes.moon.material.opacity = 1; lunarIntro = false; }
        }

        visualPhaseAngle = THREE.MathUtils.lerp(visualPhaseAngle, targetPhaseAngle, PHASE_LERP_SPEED);
        const rad = THREE.MathUtils.degToRad(visualPhaseAngle - 90);
        lunarSpotlight.position.set(
            targetPos.x + Math.cos(rad) * 50,
            targetPos.y,
            targetPos.z + Math.sin(rad) * 50
        );
        lunarSpotlight.target.position.copy(targetPos);
        lunarSpotlight.target.updateMatrixWorld();
    }

    // ---------------- CAMERA SMOOTHING ----------------
    const lerpFactor = 0.1;

    currentTargetPos.lerp(targetPos, lerpFactor);
    currentRadius = THREE.MathUtils.lerp(currentRadius, targetRadius, lerpFactor);

    theta = THREE.MathUtils.lerp(theta, targetTheta, lerpFactor);
    phi = THREE.MathUtils.lerp(phi, targetPhi, lerpFactor);

    if (cameraMode !== "lunar") phi = THREE.MathUtils.clamp(phi, 0.1, Math.PI - 0.1);

    camera.position.set(
        currentTargetPos.x + currentRadius * Math.sin(phi) * Math.cos(theta),
        currentTargetPos.y + currentRadius * Math.cos(phi),
        currentTargetPos.z + currentRadius * Math.sin(phi) * Math.sin(theta)
    );
    camera.lookAt(currentTargetPos);
    // ================= SIZE BOOST SYSTEM =================
    if (uiPage === "solar" && cameraMode !== "lunar") {

        for (const name in PLANETS) {

            const mesh = planetMeshes[name];
            if (!mesh) continue;

            const baseScale = mesh.userData.baseScale || 4;

            const distanceToCamera = mesh.position.distanceTo(camera.position);

            // Tune these two numbers for feel
            const boostFactor = distanceToCamera / 500; // change this number to scale the planets when zooming out lower is larger radius
            const clampedBoost = THREE.MathUtils.clamp(boostFactor, 1, 3);

            const finalScale = baseScale * clampedBoost;

            mesh.scale.setScalar(finalScale);
        }
    }

    if (asteroidBelt) {
        asteroidBelt.rotation.y += 0.0002;
    }
    if (kuiperBelt) {
        kuiperBelt.rotation.y += 0.00005; // much slower
    }
    renderer.render(scene, camera);
}
animate();


window.addEventListener("resize", () => {
    // 1. Update Mobile State
    isMobile = window.innerWidth < 768;

    // 2. Update Camera & Renderer
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);

    // 3. Update Moon Scale based on new state
    if (planetMeshes.moon && cameraMode === "lunar") {
        planetMeshes.moon.scale.setScalar(MOON_SCALE);
        // Update offset if needed
        lunarFrameOffset.copy(isMobile ? LUNAR_OFFSET_MOBILE : LUNAR_OFFSET_DESKTOP);
    }
});


function mapDistanceAU(au) {
    // 1. Inner Solar System (Mercury to Mars)
    // Start at 30 units (Safety zone outside Sun), add 50 units per AU
    if (au < 2.5) {
        return 30 + (au * 50);
    }
    // 2. Outer Solar System (Jupiter+)
    // Continue from where Mars left off, but compress space slightly
    return 155 + (au - 2.5) * 30;
}

function createCircularOrbit(aAU) {
    const points = [];
    const segments = 256;
    const radius = mapDistanceAU(aAU);

    for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        points.push(
            new THREE.Vector3(
                radius * Math.cos(theta),
                0,
                radius * Math.sin(theta)
            )
        );
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
        color: 0xffffff,
        opacity: 0.2,
        transparent: true
    });

    return new THREE.LineLoop(geometry, material);
}

function createEllipticalOrbit(planet) {
    const points = [];
    const segments = 256;

    const { a, e, w } = planet;
    const omega = THREE.MathUtils.degToRad(w);

    for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;

        const r = (a * (1 - e * e)) / (1 + e * Math.cos(theta));
        const scaled = mapDistanceAU(r);

        const x = scaled * Math.cos(theta);
        const z = scaled * Math.sin(theta);

        const rotatedX = x * Math.cos(omega) - z * Math.sin(omega);
        const rotatedZ = x * Math.sin(omega) + z * Math.cos(omega);

        const inc = THREE.MathUtils.degToRad(planet.i || 0);
        const y = rotatedZ * Math.sin(inc);
        const finalZ = rotatedZ * Math.cos(inc);

        points.push(new THREE.Vector3(rotatedX, y, finalZ));

    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
        color: 0xffffff,
        opacity: 0.25,
        transparent: true
    });

    return new THREE.LineLoop(geometry, material);
}

// =====================================================
// ASTEROID BELT
// =====================================================
function createAsteroidBelt() {

    const asteroidCount = 2500;

    const innerAU = 2.2;
    const outerAU = 3.2;

    const innerRadius = mapDistanceAU(innerAU);
    const outerRadius = mapDistanceAU(outerAU);

    const thickness = 4; // vertical spread

    const geometry = new THREE.IcosahedronGeometry(0.4, 0);

    const material = new THREE.MeshStandardMaterial({
        color: 0x999999,
        roughness: 1,
        metalness: 0
    });

    const belt = new THREE.InstancedMesh(
        geometry,
        material,
        asteroidCount
    );

    const dummy = new THREE.Object3D();

    for (let i = 0; i < asteroidCount; i++) {

        const t = Math.random();
        const bias = Math.pow(t, 0.5); // denser toward middle
        const radius = THREE.MathUtils.lerp(innerRadius, outerRadius, bias);
        const angle = Math.random() * Math.PI * 2;

        const x = radius * Math.cos(angle);
        const z = radius * Math.sin(angle);

        const y = (Math.random() - 0.5) * thickness;

        dummy.position.set(x, y, z);

        const scale = Math.random() * 0.8 + 0.2;
        dummy.scale.set(scale, scale, scale);

        dummy.rotation.set(
            Math.random() * Math.PI,
            Math.random() * Math.PI,
            Math.random() * Math.PI
        );

        material.color.setHSL(0, 0, 0.4 + Math.random() * 0.2);
        dummy.updateMatrix();
        belt.setMatrixAt(i, dummy.matrix);
    }

    scene.add(belt);
    belt.rotation.x = THREE.MathUtils.degToRad(1.5);

    return belt;
}

// =====================================================
// KUIPER BELT
// =====================================================
function createKuiperBelt() {

    const objectCount = 4000;

    const innerAU = 35;
    const outerAU = 55;

    const innerRadius = mapDistanceAU(innerAU);
    const outerRadius = mapDistanceAU(outerAU);

    const thickness = 15; // much thicker vertically

    const geometry = new THREE.IcosahedronGeometry(1.2, 0);

    const material = new THREE.MeshStandardMaterial({
        color: 0xbfdfff,
        roughness: 1,
        metalness: 0,
        emissive: 0x223355,
        emissiveIntensity: 0.3
    });

    const belt = new THREE.InstancedMesh(
        geometry,
        material,
        objectCount
    );

    const dummy = new THREE.Object3D();

    for (let i = 0; i < objectCount; i++) {

        const t = Math.random();
        const bias = Math.pow(t, 0.8); // less dense than asteroid belt

        const radius = THREE.MathUtils.lerp(innerRadius, outerRadius, bias);
        const angle = Math.random() * Math.PI * 2;

        const x = radius * Math.cos(angle);
        const z = radius * Math.sin(angle);
        const y = (Math.random() - 0.5) * thickness;

        dummy.position.set(x, y, z);

        const scale = Math.random() * 2.5 + 0.8;
        dummy.scale.set(scale, scale, scale);

        dummy.rotation.set(
            Math.random() * Math.PI,
            Math.random() * Math.PI,
            Math.random() * Math.PI
        );

        dummy.updateMatrix();
        belt.setMatrixAt(i, dummy.matrix);
    }

    scene.add(belt);

    // slight tilt
    belt.rotation.x = THREE.MathUtils.degToRad(3);

    return belt;
}


async function loadSolarForDate(dateObj) {

    try {
        const iso = dateObj.toISOString().slice(0, 10);

        const positions = await fetchPlanetPositions(iso);

        if (!positions) return;

        if (planetMeshes.sun) planetMeshes.sun.position.set(0, 0, 0);

        for (const name in positions) {
            const meshKey = name.charAt(0).toUpperCase() + name.slice(1);
            const mesh = planetMeshes[meshKey];
            const p = PLANETS[meshKey];

            if (!mesh || !p) continue;

            const { r, theta } = positions[name];

            // Update local angle so animation continues smoothly
            if (isTimeTraveling) {
                travelTargetAngles[meshKey] = theta;
            } else {
                planetAngles[meshKey] = theta;
            }

        }

    } catch (e) {
        console.error("Solar backend unavailable:", e);
    }
}


/* =====================================================
   ASTRONOMY INTELLIGENCE LOG
===================================================== */

const notifBtn = document.getElementById("btn-notifications");
const eventsPanel = document.getElementById("events-panel");
const closeEventsBtn = document.getElementById("close-events");

// --- FIXED: Define missing variables here to prevent ReferenceError ---
const eventsContainer = document.getElementById("events-container");
const eventsYearLabel = document.getElementById("events-year-label");
let currentEventsYear = new Date().getFullYear();
let availableYears = [];
let cachedEvents = [];
// ---------------------------------------------------------------------

// View Toggle Buttons (Icons in the panel header)
const viewEventsBtn = document.getElementById("btn-view-events");
const viewSettingsBtn = document.getElementById("btn-view-settings");

// View Containers
const viewNotifications = document.getElementById("view-notifications");
const viewEventsLog = document.getElementById("view-events-log");
const viewSettings = document.getElementById("view-settings");

// --- FIXED: Add Safety Checks (if statements) to prevent crashes ---

document.getElementById("back-to-notifications-events")?.addEventListener("click", () => {
    viewNotifications?.classList.remove("hidden");
    viewEventsLog?.classList.add("hidden");
    viewSettings?.classList.add("hidden");
});

document.getElementById("back-to-notifications-settings")?.addEventListener("click", () => {
    viewNotifications?.classList.remove("hidden");
    viewEventsLog?.classList.add("hidden");
    viewSettings?.classList.add("hidden");
});

// 1. OPEN PANEL
if (notifBtn && eventsPanel) {
    notifBtn?.addEventListener("click", () => {
        hideNotificationDot();

        const hasNotifications =
            document.querySelector("#notifications-container .notification-item");

        if (hasNotifications) {
            viewNotifications?.classList.remove("hidden");
            viewEventsLog?.classList.add("hidden");
        } else {
            viewEventsLog?.classList.remove("hidden");
            viewNotifications?.classList.add("hidden");
        }

        viewSettings?.classList.add("hidden");

        eventsPanel.classList.add("show");
        document.body.classList.add("events-open");
    });
}

// 2. CLOSE PANEL
if (closeEventsBtn && eventsPanel) {
    closeEventsBtn?.addEventListener("click", () => {
        eventsPanel.classList.remove("show");
        document.body.classList.remove("events-open");
    });
}

// 3. SWITCH BETWEEN VIEWS
if (viewEventsBtn) {
    viewEventsBtn.addEventListener("click", () => {
        if (viewEventsLog) viewEventsLog.classList.remove("hidden");
        if (viewNotifications) viewNotifications.classList.add("hidden");
        if (viewSettings) viewSettings.classList.add("hidden");
    });
}

if (viewSettingsBtn) {
    viewSettingsBtn.addEventListener("click", () => {
        if (viewSettings) viewSettings.classList.remove("hidden");
        if (viewEventsLog) viewEventsLog.classList.add("hidden");
        if (viewNotifications) viewNotifications.classList.add("hidden");
    });
}


document.getElementById("mark-all-read")?.addEventListener("click", () => {

    let stored = JSON.parse(localStorage.getItem("appNotifications") || "[]");
    stored = stored.map(n => ({ ...n, read: true }));
    localStorage.setItem("appNotifications", JSON.stringify(stored));

    hideNotificationDot();

    document.querySelectorAll(".notification-item").forEach(item => {
        item.classList.remove("unread");
    });
});

/* -------------------------
   Load Year Events
-------------------------- */

async function loadPlanetVisibilityForDate(dateObj) {

    const iso = dateObj.toISOString().split("T")[0];

    try {

        planetList.innerHTML =
            '<div style="text-align:center; padding:20px; opacity:0.5; font-size:12px;">Calibrating sensors...</div>';

        const data = await fetchVisibility(iso);

        renderPlanetVisibility(data);

    } catch (e) {

        console.error("Visibility error:", e);

        planetList.innerHTML =
            '<div style="text-align:center; opacity:0.5;">Signal lost.</div>';
    }
}

async function loadEventsForYear(year) {

    try {

        const events = await fetchEventsForYear(year);

        cachedEvents = events;
        currentEventsYear = year;

        renderEvents(events);
        renderYearSelector(year);

    } catch (err) {

        console.error("Events load error:", err);
    }
}
/* -------------------------
   Render Events
-------------------------- */
function renderEvents(events) {
    eventsContainer.innerHTML = "";

    if (!events.length) {
        eventsContainer.innerHTML = `<div class="empty-state">No major events detected.</div>`;
        return;
    }

    events.forEach(ev => {
        const div = document.createElement("div");
        div.className = "event-item";

        const accent = getAccentColor(ev.type);
        const regions = ev.visibility_regions?.join(" • ") || "Global";

        div.innerHTML = `
            <div class="event-date" style="background: ${accent}; color: #fff;">${formatDate(ev.date)}</div>
            <div class="event-title">${ev.title}</div>
            <div class="event-meta">
                <span class="meta-india ${ev.visible_from_india ? "visible" : "hidden-vis"}">
                    ${ev.visible_from_india ? "✓ Visible in India" : "× Not visible in India"}
                </span>
                <div class="meta-global">${regions}</div>
            </div>
            <button class="notify-btn">🔔 Notify Me</button>
        `;

        eventsContainer.appendChild(div);

        div.querySelector(".notify-btn").onclick = async (e) => {

            await enablePushIfNeeded();

            if (!hasNotificationPermission()) {
                alert("Enable notifications first in Settings.");
                return;
            }

            e.target.classList.toggle("active");

            if (e.target.classList.contains("active")) {
                e.target.textContent = "✓ Reminder Set";

                // Optional: store event reminder
                let reminders = JSON.parse(localStorage.getItem("eventReminders") || "[]");
                reminders.push(ev.id);
                localStorage.setItem("eventReminders", JSON.stringify(reminders));

            } else {
                e.target.textContent = "🔔 Notify Me";

                let reminders = JSON.parse(localStorage.getItem("eventReminders") || "[]");
                reminders = reminders.filter(id => id !== ev.id);
                localStorage.setItem("eventReminders", JSON.stringify(reminders));
            }
        };
    });
}

function renderYearSelector(activeYear) {

    const now = new Date();
    const thisYear = now.getFullYear();

    // Rolling 3 year window
    availableYears = [
        thisYear,
        thisYear + 1,
        thisYear + 2
    ];

    eventsYearLabel.innerHTML = "";

    availableYears.forEach(year => {
        const btn = document.createElement("span");
        btn.className = "year-chip";
        btn.textContent = year;

        if (year === activeYear) {
            btn.classList.add("active");
        }

        btn.addEventListener("click", () => {
            currentEventsYear = year;
            loadEventsForYear(year);
        });

        eventsYearLabel.appendChild(btn);
    });
}

/* -------------------------
   Accent Color Logic
-------------------------- */

function getAccentColor(type) {
    switch (type) {
        case "lunar_eclipse": return "rgba(255,80,80,0.7)";
        case "solar_eclipse": return "rgba(255,215,120,0.8)";
        case "supermoon": return "rgba(120,180,255,0.7)";
        case "planetary_opposition": return "rgba(255,140,0,0.8)";
        default: return "rgba(255,255,255,0.3)";
    }
}

/* -------------------------
   Date Formatting
-------------------------- */

function formatDate(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric"
    }).toUpperCase();
}


/* -------------------------
   Initialize
-------------------------- */
loadEventsForYear(currentEventsYear);

// ================= PLANET VISIBILITY ================
const moonContent = document.getElementById("moon-content");

// 3. Render Improved Planet Table
function renderPlanetVisibility(data) {
    planetList.innerHTML = "";

    Object.entries(data).forEach(([name, info]) => {
        const row = document.createElement("div");
        row.className = `planet-row ${info.visibility_rating.toLowerCase()}`;

        // Create the clean "Card/Table" HTML structure
        row.innerHTML = `
            <div class="planet-row-header">
                <span class="planet-name">${capitalize(name)}</span>
                <span class="planet-rating">${info.visibility_rating}</span>
            </div>
            
            <div class="planet-row-window">
                <span class="window-label">Best View</span>
                <span class="window-time">${info.best_view_window || "N/A"}</span>
            </div>

            <div class="planet-details">
                <div class="detail-item">
                    <span class="detail-label">Rise</span>
                    <span class="detail-value">${info.rise}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Transit</span>
                    <span class="detail-value">${info.transit}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Set</span>
                    <span class="detail-value">${info.set}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Altitude</span>
                    <span class="detail-value">${info.max_altitude}°</span>
                </div>
                 <div class="detail-item">
                    <span class="detail-label">Azimuth</span>
                    <span class="detail-value">${info.azimuth}°</span>
                </div>
                 <div class="detail-item">
                    <span class="detail-label">Mag</span>
                    <span class="detail-value">${info.magnitude}</span>
                </div>
            </div>
        `;

        row.addEventListener("click", () => {
            // Close others if you want accordion style, or just toggle
            document.querySelectorAll('.planet-row.expanded').forEach(el => {
                if (el !== row) el.classList.remove('expanded');
            });
            row.classList.toggle("expanded");
        });

        planetList.appendChild(row);
    });
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}


// 4. NOTIFICATION LOGIC (Settings Buttons)


document.getElementById("enable-daily-brief")?.addEventListener("click", () => {
    localStorage.setItem("dailyBrief", "true");
    alert("🌅 Daily Morning Brief Enabled");
});

document.getElementById("enable-planet-brief")?.addEventListener("click", () => {
    localStorage.setItem("planetBrief", "true");
    alert("🪐 Daily Planet Visibility Enabled");
});

document.getElementById("disable-notifications")?.addEventListener("click", () => {
    // 1. Remove Data
    localStorage.removeItem("dailyBrief");
    localStorage.removeItem("planetBrief");
    localStorage.removeItem("eventReminders");
    localStorage.removeItem("fcm_token");
    localStorage.removeItem("pushRegistered");

    // 2. Visual Reset (Now this works because variables are defined above)
    if (dailyToggle) dailyToggle.checked = false;
    if (planetToggle) planetToggle.checked = false;

    // 3. Reset Bell Buttons
    document.querySelectorAll(".notify-btn").forEach(btn => {
        btn.classList.remove("active");
        btn.textContent = "🔔 Notify Me";
    });

    alert("Notifications Disabled");
});

// Init Data
(async () => {
    try {
        const iso = realToday.toISOString().slice(0, 10);

        const moonData = await fetchMoonData(iso);
        updateMoonCards(moonData);

        await loadSolarForDate(realToday);
    } catch (e) {
        console.error("Init error:", e);
    } finally {
        const loaderUI = document.getElementById("loader");
        if (loaderUI) {
            loaderUI.style.opacity = "0";
            setTimeout(() => loaderUI.remove(), 800);
        }
        await checkForNewYear();
    }
})();



// ======== Firebase Notification ==============
// ---------------- Firebase Push Setup ---------------
const firebaseConfig = {
    apiKey: "AIzaSyCcofnDYMVom82NSHwNsT_0oZzhsMiUEEA",
    authDomain: "lunar-observatory.firebaseapp.com",
    projectId: "lunar-observatory",
    storageBucket: "lunar-observatory.firebasestorage.app",
    messagingSenderId: "379098412161",
    appId: "1:379098412161:web:0e386d4c2744c058748980"
};

let firebaseApp = null;
let messaging = null;

if (!isNativeApp) {
    firebaseApp = initializeApp(firebaseConfig);
    messaging = getMessaging(firebaseApp);
}

// ... existing imports ...

async function setupPush() {

    if (isNativeApp) {
        console.log("Native app detected — skipping web push setup.");
        return;
    }

    try {

        // 1️⃣ Request permission properly
        if (typeof Notification === "undefined") {
            console.log("Notification API not supported.");
            return;
        }

        const permission = await Notification.requestPermission();

        if (permission !== "granted") {
            console.log("Notification permission denied.");
            return;
        }

        // 2️⃣ Determine correct SW path
        const swPath =
            location.hostname === "localhost" ||
                location.hostname === "127.0.0.1"
                ? "/firebase-messaging-sw.js"
                : "/lunar-observatory/firebase-messaging-sw.js";

        console.log(`Registering SW at: ${swPath}`);

        // 3️⃣ Register Service Worker
        let registration = await navigator.serviceWorker.getRegistration();

        if (!registration) {
            registration = await navigator.serviceWorker.register(swPath, {
                scope: "./"
            });
        }

        await navigator.serviceWorker.ready;

        // 4️⃣ Get token
        const token = await getToken(messaging, {
            vapidKey: "BFZ0767uqrN5u5Ey0HmcKJYrUgbDchsWXChR1PSezmLQToHkgAD4eImqTtFdi2oA1MKBJB9lJ31Pr2SPmbBu8cU",
            serviceWorkerRegistration: registration
        });

        if (!token) {
            console.log("No registration token available.");
            return;
        }

        // 5️⃣ Send to backend only if changed
        const savedToken = localStorage.getItem("fcm_token");

        if (token !== savedToken) {

            console.log("New token detected, updating backend...");

            await fetch(`${API_BASE}/api/push/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    token: token,
                    daily_brief: localStorage.getItem("dailyBrief") === "true",
                    planet_brief: localStorage.getItem("planetBrief") === "true"
                })
            });

            localStorage.setItem("fcm_token", token);
            localStorage.setItem("pushRegistered", "true");

            console.log("Token registered successfully.");
        } else {
            console.log("Token is up to date.");
        }

    } catch (err) {
        console.error("Push setup error:", err);
    }
}

let nativePushReady = false;

async function initNativePush() {

    if (!isNativeApp) return;

    const PushNotifications = window.Capacitor.Plugins.PushNotifications;

    if (!PushNotifications) {
        console.error("PushNotifications plugin not available");
        return;
    }

    const permission = await PushNotifications.requestPermissions();

    if (permission.receive !== 'granted') {
        console.log("Notification permission not granted");
        return;
    }

    await PushNotifications.register();

    PushNotifications.addListener('registration', async (token) => {

        console.log("Native FCM Token:", token.value);

        await fetch(`${API_BASE}/api/push/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                token: token.value,
                daily_brief: localStorage.getItem("dailyBrief") === "true",
                planet_brief: localStorage.getItem("planetBrief") === "true"
            })
        });

        localStorage.setItem("pushRegistered", "true");
        localStorage.setItem("fcm_token", token.value);
    });

    PushNotifications.addListener('registrationError', (err) => {
        console.error("Push registration error:", err);
    });
}

// ================= CLEAN NOTIFICATION TOGGLE SYSTEM =================

const dailyToggle = document.getElementById("toggle-daily-brief");
const planetToggle = document.getElementById("toggle-planet-brief");

// Sync toggle UI from localStorage on load
function syncNotificationUI() {
    if (dailyToggle) {
        dailyToggle.checked = localStorage.getItem("dailyBrief") === "true";
    }
    if (planetToggle) {
        planetToggle.checked = localStorage.getItem("planetBrief") === "true";
    }
    if (!hasNotificationPermission()) {
        localStorage.removeItem("dailyBrief");
        localStorage.removeItem("planetBrief");
    }
}

// Check permission status
async function hasNotificationPermission() {

    if (isNativeApp) {
        const PushNotifications = window.Capacitor?.Plugins?.PushNotifications;
        if (!PushNotifications) return false;

        const result = await PushNotifications.checkPermissions();
        return result.receive === "granted";
    }

    if (typeof Notification === "undefined") return false;

    return Notification.permission === "granted";
}
// Enable Push (only when needed)
let pushInitializing = false;
async function enablePushIfNeeded() {

    if (isNativeApp) {

        const allowed = await hasNotificationPermission();
        if (!allowed) {
            await initNativePush();
        }

        return;
    }

    if (!(await hasNotificationPermission())) {
        await setupPush();
    }
}

dailyToggle?.addEventListener("change", async (e) => {

    if (e.target.checked) {

        // ✅ Save state FIRST (before permission flow)
        localStorage.setItem("dailyBrief", "true");

        await enablePushIfNeeded();

        if (!hasNotificationPermission()) {
            localStorage.removeItem("dailyBrief");
            e.target.checked = false;
            return;
        }
        await fetch(`${API_BASE}/api/push/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                token: localStorage.getItem("fcm_token"),
                daily_brief: e.target.checked,
                planet_brief: localStorage.getItem("planetBrief") === "true"
            })
        });
        console.log("Daily Brief Enabled");

    } else {
        localStorage.removeItem("dailyBrief");
        console.log("Daily Brief Disabled");
    }
});

// PLANET BRIEF TOGGLE
planetToggle?.addEventListener("change", async (e) => {

    if (e.target.checked) {

        // ✅ Save first
        localStorage.setItem("planetBrief", "true");

        await enablePushIfNeeded();

        if (!hasNotificationPermission()) {
            localStorage.removeItem("planetBrief");
            e.target.checked = false;
            return;
        }
        await fetch(`${API_BASE}/api/push/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                token: localStorage.getItem("fcm_token"),
                daily_brief: localStorage.getItem("dailyBrief") === "true",
                planet_brief: e.target.checked
            })
        });

        console.log("Planet Brief Enabled");

    } else {
        localStorage.removeItem("planetBrief");
        console.log("Planet Brief Disabled");
    }
});

// Run once at startup
syncNotificationUI();

if (isNativeApp) {
    initNativePush();
}

const notifDot = document.getElementById("notif-dot");
const notificationsContainer = document.getElementById("notifications-container");

function showNotificationDot() {
    notifDot?.classList.remove("hidden");
}

function hideNotificationDot() {
    notifDot?.classList.add("hidden");
}

function addNotificationToPanel(notification) {

    const empty = notificationsContainer.querySelector(".empty-state");
    if (empty) empty.remove();
    const div = document.createElement("div");
    div.className = "notification-item";

    if (!notification.read) {
        div.classList.add("unread");
    }

    div.innerHTML = `
            <div class="notification-header">
                <div class="notification-title">${notification.title}</div>
                <div class="notification-actions">
                    <button class="notif-read-btn" title="Mark as read"></button>
                    <button class="notif-delete-btn" title="Delete">✕</button>
                </div>
            </div>

            <div class="notification-body">
                ${notification.body}
            </div>

            <div class="notification-time">
                ${new Date(notification.time).toLocaleString()}
            </div>
        `;

    div.addEventListener("click", () => {
        div.classList.remove("unread");

        let stored = JSON.parse(localStorage.getItem("appNotifications") || "[]");
        stored = stored.map(n =>
            n.id === notification.id ? { ...n, read: true } : n
        );
        localStorage.setItem("appNotifications", JSON.stringify(stored));

        const unreadExists = stored.some(n => !n.read);
        if (!unreadExists) hideNotificationDot();
    });

    const readBtn = div.querySelector(".notif-read-btn");
    const deleteBtn = div.querySelector(".notif-delete-btn");

    // MARK READ
    readBtn.addEventListener("click", (e) => {
        e.stopPropagation();

        div.classList.remove("unread");

        let stored = JSON.parse(localStorage.getItem("appNotifications") || "[]");
        stored = stored.map(n =>
            n.id === notification.id ? { ...n, read: true } : n
        );
        localStorage.setItem("appNotifications", JSON.stringify(stored));

        const unreadExists = stored.some(n => !n.read);
        if (!unreadExists) hideNotificationDot();
    });

    // DELETE
    deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();

        // 1. Remove from DOM
        div.remove();

        // 2. Remove from localStorage
        let stored = JSON.parse(localStorage.getItem("appNotifications") || "[]");
        stored = stored.filter(n => n.id !== notification.id);
        localStorage.setItem("appNotifications", JSON.stringify(stored));

        // 3. Update red dot
        const unreadExists = stored.some(n => !n.read);
        if (!unreadExists) hideNotificationDot();

        if (stored.length === 0) {
            notificationsContainer.innerHTML = `
            <div class="empty-state">
                <span style="font-size: 24px; display:block; margin-bottom:10px;">🔕</span>
                No new alerts
            </div>
        `;
        }
    });
    notificationsContainer.prepend(div);
}

function loadStoredNotifications() {
    const stored = JSON.parse(localStorage.getItem("appNotifications") || "[]");

    if (!stored.length) return;

    stored.forEach(n => addNotificationToPanel(n));

    const unreadExists = stored.some(n => !n.read);
    if (unreadExists) showNotificationDot();
}

loadStoredNotifications();

if (!isNativeApp && messaging) {
    onMessage(messaging, (payload) => {
        console.log("Foreground message received:", payload);

        const title = payload.notification?.title || "Notification";
        const body = payload.notification?.body || "";

        const newNotification = {
            id: Date.now(),
            title,
            body,
            time: new Date().toISOString(),
            read: false
        };

        let stored = JSON.parse(localStorage.getItem("appNotifications") || "[]");
        stored.unshift(newNotification);
        localStorage.setItem("appNotifications", JSON.stringify(stored));

        addNotificationToPanel(newNotification);
        showNotificationDot();
    });
}

// ================= YEAR UPDATE CHECK =================

async function checkForNewYear() {

    try {

        const res = await fetch(`${API_BASE}/api/meta/latest-year`);
        const data = await res.json();

        const latest = data.latest_year;

        const storedYears = JSON.parse(
            localStorage.getItem("availableYears") || "[2026]"
        );

        if (!storedYears.includes(latest)) {

            console.log("New year detected:", latest);

            const bundleRes = await fetch(
                `${API_BASE}/bundles/year_${latest}.json`
            );

            const bundle = await bundleRes.json();

            localStorage.setItem(
                `year_${latest}`,
                JSON.stringify(bundle)
            );

            storedYears.push(latest);
            localStorage.setItem(
                "availableYears",
                JSON.stringify(storedYears)
            );

            console.log("New year downloaded silently.");

        }

    } catch (e) {

        console.log("No internet or no new year available.");

    }
}