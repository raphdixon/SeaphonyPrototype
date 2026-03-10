/**
 * Squidphony Mini — Main Application
 *
 * Orchestrates: Video → YOLO Detection → Grid Mapping → Music Triggering → Visualization
 * 
 * Supports two modes:
 * - LOCAL: Offline AI jammer (Magenta MusicVAE) plays along
 * - CLOUD: Lyria Realtime generates music based on squid quadrant distribution
 * 
 * Notes only trigger when a squid CROSSES from one grid cell to another.
 * Uses a simple nearest-centroid tracker to maintain squid identity across frames.
 */
import { SquidDetector, Detection } from './squidDetector';
import { MusicEngine } from './musicEngine';
import { Visualizer } from './visualizer';
import { MagentaJammer } from './magentaJammer';
import { AIPianoRoll } from './aiPianoRoll';
import { LyriaClient } from './lyriaClient';
import { QuadrantTracker } from './quadrantTracker';

// ============================================================
// Config
// ============================================================
// Video is bundled locally in public/
const VIDEO_URL = import.meta.env.DEV
    ? '/SquidCam.mp4'
    : 'https://squid-assets.quiet-king-8097.workers.dev/SquidCam.mp4';
const DETECT_INTERVAL_MS = 200; // ~5 FPS for detection
const TRACK_MAX_DIST = 0.15;   // Max distance to match a squid across frames (normalized)
const LYRIA_UPDATE_INTERVAL = 3000; // Update Lyria prompts every 3s (avoid spamming)

// Lyria session renewal — sessions timeout after ~10 minutes
const LYRIA_RENEWAL_AGE_S = 9.5 * 60;  // Start renewal at 9.5 minutes
const LYRIA_CROSSFADE_S = 10;          // Crossfade duration in seconds

// ============================================================
// Types
// ============================================================
type AppMode = 'local' | 'cloud';

// ============================================================
// DOM Elements
// ============================================================
const loadingScreen = document.getElementById('loading-screen')!;
const progressFill = document.getElementById('progress-fill')!;
const loadingStatus = document.getElementById('loading-status')!;
const modeSelector = document.getElementById('mode-selector')!;
const modeLocalBtn = document.getElementById('mode-local')! as HTMLButtonElement;
const modeCloudBtn = document.getElementById('mode-cloud')! as HTMLButtonElement;
const experience = document.getElementById('experience')!;
const video = document.getElementById('video')! as HTMLVideoElement;
const overlay = document.getElementById('overlay')! as HTMLCanvasElement;
const hudFps = document.getElementById('hud-fps')!;
const hudMusicStatus = document.getElementById('hud-music-status')!;
const hudSquidCount = document.getElementById('hud-squid-count')!;

// Genre quadrant overlay elements (Cloud mode)
const genreOverlay = document.getElementById('genre-overlay')!;
const genreQuadrants = [
    genreOverlay.querySelector('.genre-tl')!,
    genreOverlay.querySelector('.genre-tr')!,
    genreOverlay.querySelector('.genre-bl')!,
    genreOverlay.querySelector('.genre-br')!,
] as HTMLElement[];
const genrePcts = Array.from(document.querySelectorAll('[data-quadrant-pct]')) as HTMLElement[];
const genreSliderFills = Array.from(document.querySelectorAll('.genre-slider-fill')) as HTMLElement[];

// ============================================================
// Core modules (always used)
// ============================================================
const detector = new SquidDetector();
const music = new MusicEngine();
const visualizer = new Visualizer(overlay);

// Mode-specific modules (lazily initialized)
let jammer: MagentaJammer | null = null;
let lyriaClient: LyriaClient | null = null;
let quadrantTracker: QuadrantTracker | null = null;
let selectedMode: AppMode = 'local';

// ============================================================
// Squid Tracker — simple nearest-centroid matching
// ============================================================
interface TrackedSquid {
    id: number;
    x: number;       // last known centroid
    y: number;
    cellRow: number;  // current grid cell
    cellCol: number;
    age: number;      // frames since last matched
}

let nextSquidId = 0;
let trackedSquids: TrackedSquid[] = [];

function trackSquids(detections: Detection[]): void {
    const unmatched = [...detections];
    const updated: TrackedSquid[] = [];

    // Match existing squids to nearest detection
    for (const squid of trackedSquids) {
        let bestIdx = -1;
        let bestDist = TRACK_MAX_DIST;

        for (let i = 0; i < unmatched.length; i++) {
            const dx = unmatched[i].centroid.x - squid.x;
            const dy = unmatched[i].centroid.y - squid.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        }

        if (bestIdx >= 0) {
            const det = unmatched.splice(bestIdx, 1)[0];
            const newCell = MusicEngine.positionToCell(det.centroid.x, det.centroid.y);

            // Check if squid crossed into a new cell
            if (newCell.row !== squid.cellRow || newCell.col !== squid.cellCol) {
                const trigger = music.triggerCell(newCell.row, newCell.col);
                if (trigger) {
                    visualizer.onNoteTrigger(trigger);
                    if (jammer) jammer.feedNote(trigger.note);
                }
            }

            updated.push({
                id: squid.id,
                x: det.centroid.x,
                y: det.centroid.y,
                cellRow: newCell.row,
                cellCol: newCell.col,
                age: 0,
            });
        } else {
            // Squid not matched — keep for a few frames in case it reappears
            squid.age++;
            if (squid.age < 5) {
                updated.push(squid);
            }
        }
    }

    // Create new tracked squids from unmatched detections
    for (const det of unmatched) {
        const cell = MusicEngine.positionToCell(det.centroid.x, det.centroid.y);
        // New squid entering the scene — trigger its initial cell
        const trigger = music.triggerCell(cell.row, cell.col);
        if (trigger) {
            visualizer.onNoteTrigger(trigger);
            if (jammer) jammer.feedNote(trigger.note);
        }

        updated.push({
            id: nextSquidId++,
            x: det.centroid.x,
            y: det.centroid.y,
            cellRow: cell.row,
            cellCol: cell.col,
            age: 0,
        });
    }

    trackedSquids = updated;
}

// ============================================================
// State
// ============================================================
let lastDetections: Detection[] = [];
let lastDetectTime = 0;
let detectFrameCount = 0;
let detectFps = 0;
let fpsUpdateTime = 0;
let running = false;
let lastLyriaUpdate = 0;

// Lyria renewal state
let nextLyriaClient: LyriaClient | null = null;
let renewalCrossfadeStart = 0;
let isRenewing = false;
const changeoverIndicator = document.getElementById('changeover-indicator');

// ============================================================
// Initialization
// ============================================================
async function init(): Promise<void> {
    updateProgress(5, 'Initializing…');

    // 1. Load YOLO model
    await detector.load((pct) => {
        updateProgress(5 + pct * 0.4, `Loading squid model… ${pct.toFixed(0)}%`);
    });
    updateProgress(45, 'Squid model loaded ✓');

    // 2. Initialize music engine
    updateProgress(50, 'Initializing audio engine…');
    await music.init();
    updateProgress(60, 'Audio engine ready ✓');

    // 3. Set up video
    updateProgress(70, 'Loading aquarium video…');
    await loadVideo();
    updateProgress(90, 'Video loaded ✓');

    // 4. Ready — show mode selector
    updateProgress(100, 'Ready to begin');
    modeSelector.style.display = '';
    modeSelector.classList.add('ready');
}

function updateProgress(pct: number, status: string): void {
    progressFill.style.width = `${pct}%`;
    loadingStatus.textContent = status;
}

function loadVideo(): Promise<void> {
    return new Promise((resolve, reject) => {
        video.src = VIDEO_URL;
        video.crossOrigin = 'anonymous';
        video.addEventListener('loadeddata', () => resolve(), { once: true });
        video.addEventListener('error', () => reject(new Error('Failed to load aquarium video')), { once: true });
        video.load();
    });
}

// ============================================================
// Start Experience (mode-aware)
// ============================================================
async function startExperience(mode: AppMode): Promise<void> {
    selectedMode = mode;

    // Start audio context (requires user gesture)
    await music.start();

    if (mode === 'local') {
        // ── LOCAL MODE: Load Magenta + start jammer ──
        updateProgress(95, 'Loading AI jammer…');
        jammer = new MagentaJammer();
        await jammer.init((msg) => updateProgress(97, msg));
        jammer.start();

        // Start the AI note visualization
        const pianoRoll = new AIPianoRoll(experience);
        jammer.onNote = (note, velocity, duration) => {
            pianoRoll.addNote(note, velocity, duration);
        };
        pianoRoll.start();

    } else {
        // ── CLOUD MODE: Connect Lyria + start quadrant tracking ──
        updateProgress(95, 'Connecting to Lyria Realtime…');
        lyriaClient = new LyriaClient();
        quadrantTracker = new QuadrantTracker();

        // Show connection status updates
        lyriaClient.onStatusChange = (_state, msg) => {
            updateProgress(96, msg);
        };

        await lyriaClient.connect();

        // Start with equal genre weights
        const initialPrompts = quadrantTracker.getWeightedPrompts();
        await lyriaClient.startPlaying(
            { bpm: 120, scale: 'C_MAJOR_A_MINOR', density: 0.3, brightness: 0.5 },
            initialPrompts,
        );

        // Show genre quadrant overlay
        genreOverlay.classList.remove('hidden');

        // Quieter, shorter squid notes in cloud mode (Lyria is primary audio)
        music.setCloudMode();
    }

    // Enable evolving synth parameters in both modes
    music.enableEvolvingSynth();

    hudMusicStatus.textContent = mode === 'local' ? 'Local AI' : 'Lyria Cloud';

    // Show experience
    loadingScreen.classList.add('fade-out');
    experience.classList.remove('hidden');

    // Set up canvas size
    handleResize();
    window.addEventListener('resize', handleResize);

    // Start video
    await video.play();

    // Start loops
    running = true;
    requestAnimationFrame(mainLoop);
}

function handleResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    visualizer.resize(w, h);
}

// ============================================================
// Main Loop
// ============================================================
function mainLoop(timestamp: number): void {
    if (!running) return;

    // Run detection at ~5 FPS
    if (timestamp - lastDetectTime >= DETECT_INTERVAL_MS) {
        lastDetectTime = timestamp;
        runDetection(timestamp);
    }

    // Lyria session renewal check (cloud mode only)
    if (selectedMode === 'cloud' && lyriaClient) {
        checkLyriaRenewal();
    }

    // Render at full frame rate
    visualizer.render(lastDetections);

    // Update FPS counter
    detectFrameCount++;
    if (timestamp - fpsUpdateTime >= 1000) {
        detectFps = detectFrameCount;
        detectFrameCount = 0;
        fpsUpdateTime = timestamp;
        hudFps.textContent = String(detectFps);
    }

    requestAnimationFrame(mainLoop);
}

// ============================================================
// Lyria Session Renewal — crossfade before timeout
// ============================================================
function checkLyriaRenewal(): void {
    if (!lyriaClient || isRenewing) return;

    const age = lyriaClient.getSessionAge();
    if (age >= LYRIA_RENEWAL_AGE_S) {
        renewLyriaSession();
    }
}

async function renewLyriaSession(): Promise<void> {
    if (!lyriaClient || !quadrantTracker) return;
    isRenewing = true;

    console.log('[Lyria] Renewal: spinning up new session');

    // Show changeover indicator
    changeoverIndicator?.classList.add('active');

    try {
        // Create new session with current prompts/config
        nextLyriaClient = new LyriaClient();
        nextLyriaClient.onStatusChange = (_state, msg) => {
            console.log(`[Lyria Next] ${msg}`);
        };

        await nextLyriaClient.connect();

        // Start playing at volume 0 (will crossfade in)
        const prompts = lyriaClient.lastPrompts.length > 0
            ? lyriaClient.lastPrompts
            : quadrantTracker.getWeightedPrompts();
        const config = {
            bpm: lyriaClient.lastConfig.bpm ?? 120,
            scale: lyriaClient.lastConfig.scale ?? 'C_MAJOR_A_MINOR',
            density: lyriaClient.lastConfig.density ?? 0.3,
            brightness: lyriaClient.lastConfig.brightness ?? 0.5,
        };

        await nextLyriaClient.startPlaying(config, prompts);
        // Override the default fade-in: start silent
        nextLyriaClient.setVolume(0);

        // Crossfade: old → 0, new → 0.7 over LYRIA_CROSSFADE_S seconds
        renewalCrossfadeStart = Date.now();
        const crossfadeMs = LYRIA_CROSSFADE_S * 1000;

        const crossfadeInterval = setInterval(() => {
            const elapsed = Date.now() - renewalCrossfadeStart;
            const progress = Math.min(1, elapsed / crossfadeMs);

            // Smooth ease-in/out
            const eased = progress * progress * (3 - 2 * progress);
            lyriaClient?.setVolume(0.7 * (1 - eased));
            nextLyriaClient?.setVolume(0.7 * eased);

            if (progress >= 1) {
                clearInterval(crossfadeInterval);
                finishRenewal();
            }
        }, 100);
    } catch (err) {
        console.error('[Lyria] Renewal failed:', err);
        isRenewing = false;
        changeoverIndicator?.classList.remove('active');
        // If renewal fails, let the old session continue
    }
}

async function finishRenewal(): Promise<void> {
    // Tear down old session
    const oldClient = lyriaClient;
    lyriaClient = nextLyriaClient;
    nextLyriaClient = null;

    try {
        await oldClient?.stop();
    } catch { /* ignore */ }

    // Wire up status callback on the new active client
    if (lyriaClient) {
        lyriaClient.onStatusChange = (_state, msg) => {
            console.log(`[Lyria] ${msg}`);
        };
    }

    isRenewing = false;
    changeoverIndicator?.classList.remove('active');
    console.log('[Lyria] Renewal complete — new session active');
}

function runDetection(timestamp: number): void {
    if (video.readyState < 2) return;

    try {
        const detections = detector.detect(video);
        lastDetections = detections;
        hudSquidCount.textContent = String(detections.length);

        // Track squids across frames — only trigger notes on cell transitions
        trackSquids(detections);

        if (selectedMode === 'local' && jammer) {
            // Feed squid count to the AI jammer for density-aware behavior
            jammer.feedActivity(detections.length);
        } else if (selectedMode === 'cloud' && quadrantTracker && lyriaClient) {
            // Update quadrant weights for Lyria
            quadrantTracker.update(detections);

            // Update genre overlay highlighting + percentages
            const info = quadrantTracker.getQuadrantInfo();
            const weights = quadrantTracker.getWeightedPrompts();
            for (let i = 0; i < 4; i++) {
                const el = genreQuadrants[i];
                if (info.counts[i] > 0) {
                    el.classList.add('active');
                } else {
                    el.classList.remove('active');
                }
                // Update percentage text and slider fill
                const pct = Math.round(weights[i].weight * 100);
                genrePcts[i].textContent = `${pct}%`;
                genreSliderFills[i].style.width = `${pct}%`;
            }

            // Throttle Lyria updates to avoid spamming the WebSocket
            if (timestamp - lastLyriaUpdate >= LYRIA_UPDATE_INTERVAL) {
                lastLyriaUpdate = timestamp;
                const prompts = quadrantTracker.getWeightedPrompts();
                const density = quadrantTracker.getDensity();
                const brightness = quadrantTracker.getBrightness();

                lyriaClient.updatePrompts(prompts);
                lyriaClient.updateConfig({ density, brightness });

                console.log('[Cloud] Quadrant update:', info);
            }
        }
    } catch (err) {
        console.error('[Detection Error]', err);
    }
}

// ============================================================
// Event Handlers — Mode Selection
// ============================================================
function handleModeClick(mode: AppMode): void {
    // Disable both buttons
    modeLocalBtn.disabled = true;
    modeCloudBtn.disabled = true;
    const activeBtn = mode === 'local' ? modeLocalBtn : modeCloudBtn;
    activeBtn.style.borderColor = 'var(--color-primary)';
    activeBtn.style.opacity = '1';
    const inactiveBtn = mode === 'local' ? modeCloudBtn : modeLocalBtn;
    inactiveBtn.style.opacity = '0.3';

    loadingStatus.textContent = mode === 'local' ? 'Starting local mode…' : 'Connecting to cloud…';
    startExperience(mode).catch(console.error);
}

modeLocalBtn.addEventListener('click', () => handleModeClick('local'));
modeCloudBtn.addEventListener('click', () => handleModeClick('cloud'));

// ============================================================
// Boot
// ============================================================
init().catch((err) => {
    console.error('[Init Error]', err);
    loadingStatus.textContent = `Error: ${err.message}`;
});
