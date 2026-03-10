/**
 * Seaphony — Main Application
 *
 * Cloud mode: ONE detector shared between lead video (+6s) and display video.
 * Detection alternates: even ticks → lead video → Lyria, odd ticks → display video → visuals/midi.
 */
import { JellyfishDetector, Detection } from './jellyfishDetector';
import { MusicEngine } from './musicEngine';
import { Visualizer } from './visualizer';
import { MagentaJammer } from './magentaJammer';
import { AIPianoRoll } from './aiPianoRoll';
import { LyriaClient } from './lyriaClient';
import { QuadrantTracker } from './quadrantTracker';

// ── Config ──
const VIDEO_URL = import.meta.env.DEV
    ? '/JellyHD.mp4'
    : 'https://squid-assets.quiet-king-8097.workers.dev/JellyHD.mp4';
const DETECT_INTERVAL_MS = 200;
const TRACK_MAX_DIST = 0.15;
const LYRIA_UPDATE_INTERVAL = 3000;
const LYRIA_LEAD_SECONDS = 6;
const LYRIA_RENEWAL_AGE_S = 9.5 * 60;
const LYRIA_CROSSFADE_S = 10;

type AppMode = 'local' | 'cloud';

// ── DOM ──
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
const hudJellyfishCount = document.getElementById('hud-jellyfish-count')!;
const genreOverlay = document.getElementById('genre-overlay')!;
const genreQuadrants = [
    genreOverlay.querySelector('.genre-tl')!,
    genreOverlay.querySelector('.genre-tr')!,
    genreOverlay.querySelector('.genre-bl')!,
    genreOverlay.querySelector('.genre-br')!,
] as HTMLElement[];
const genrePcts = Array.from(document.querySelectorAll('[data-quadrant-pct]')) as HTMLElement[];
const genreSliderFills = Array.from(document.querySelectorAll('.genre-slider-fill')) as HTMLElement[];

// ── Core modules ──
const detector = new JellyfishDetector(); // ONE detector, shared
const music = new MusicEngine();
const visualizer = new Visualizer(overlay);

let jammer: MagentaJammer | null = null;
let lyriaClient: LyriaClient | null = null;
let quadrantTracker: QuadrantTracker | null = null;
let leadQuadrantTracker: QuadrantTracker | null = null;
let selectedMode: AppMode = 'local';

// Cloud mode: hidden lead video (+6s ahead)
let leadVideo: HTMLVideoElement | null = null;

// ── Jellyfish Tracker ──
interface TrackedJellyfish {
    id: number; x: number; y: number;
    cellRow: number; cellCol: number; age: number;
}
let nextJfId = 0;
let trackedJf: TrackedJellyfish[] = [];

function trackJellyfish(detections: Detection[]): void {
    const unmatched = [...detections];
    const updated: TrackedJellyfish[] = [];

    for (const jf of trackedJf) {
        let bestIdx = -1, bestDist = TRACK_MAX_DIST;
        for (let i = 0; i < unmatched.length; i++) {
            const dx = unmatched[i].centroid.x - jf.x;
            const dy = unmatched[i].centroid.y - jf.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < bestDist) { bestDist = dist; bestIdx = i; }
        }
        if (bestIdx >= 0) {
            const det = unmatched.splice(bestIdx, 1)[0];
            const cell = MusicEngine.positionToCell(det.centroid.x, det.centroid.y);
            if (cell.row !== jf.cellRow || cell.col !== jf.cellCol) {
                const trigger = music.triggerCell(cell.row, cell.col);
                if (trigger) {
                    visualizer.onNoteTrigger(trigger);
                    if (jammer) jammer.feedNote(trigger.note);
                }
            }
            updated.push({ id: jf.id, x: det.centroid.x, y: det.centroid.y, cellRow: cell.row, cellCol: cell.col, age: 0 });
        } else {
            jf.age++;
            if (jf.age < 5) updated.push(jf);
        }
    }

    for (const det of unmatched) {
        const cell = MusicEngine.positionToCell(det.centroid.x, det.centroid.y);
        const trigger = music.triggerCell(cell.row, cell.col);
        if (trigger) {
            visualizer.onNoteTrigger(trigger);
            if (jammer) jammer.feedNote(trigger.note);
        }
        updated.push({ id: nextJfId++, x: det.centroid.x, y: det.centroid.y, cellRow: cell.row, cellCol: cell.col, age: 0 });
    }
    trackedJf = updated;
}

// ── State ──
let lastDetections: Detection[] = [];
let lastDetectTime = 0;
let detectTick = 0;  // alternates between lead and display in cloud mode
let detectFrameCount = 0;
let detectFps = 0;
let fpsUpdateTime = 0;
let running = false;
let lastLyriaUpdate = 0;
let nextLyriaClient: LyriaClient | null = null;
let renewalCrossfadeStart = 0;
let isRenewing = false;
const changeoverIndicator = document.getElementById('changeover-indicator');

// ── Init ──
async function init(): Promise<void> {
    updateProgress(5, 'Initializing…');
    await detector.load((pct) => updateProgress(5 + pct * 0.4, `Loading model… ${pct.toFixed(0)}%`));
    updateProgress(45, 'Model loaded ✓');
    updateProgress(50, 'Initializing audio…');
    await music.init();
    updateProgress(60, 'Audio ready ✓');
    updateProgress(70, 'Loading video…');
    await loadVideo();
    updateProgress(90, 'Video loaded ✓');
    updateProgress(100, 'Ready');
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
        video.addEventListener('error', () => reject(new Error('Video load failed')), { once: true });
        video.load();
    });
}

function createLeadVideo(): Promise<void> {
    return new Promise((resolve, reject) => {
        leadVideo = document.createElement('video');
        leadVideo.src = VIDEO_URL;
        leadVideo.crossOrigin = 'anonymous';
        leadVideo.muted = true;
        leadVideo.loop = true;
        leadVideo.playsInline = true;
        leadVideo.style.display = 'none';
        document.body.appendChild(leadVideo);
        leadVideo.addEventListener('loadeddata', () => resolve(), { once: true });
        leadVideo.addEventListener('error', () => reject(new Error('Lead video failed')), { once: true });
        leadVideo.load();
    });
}

// ── Start ──
async function startExperience(mode: AppMode): Promise<void> {
    selectedMode = mode;
    await music.start();

    if (mode === 'local') {
        updateProgress(95, 'Loading AI jammer…');
        jammer = new MagentaJammer();
        await jammer.init((msg) => updateProgress(97, msg));
        jammer.start();
        const pianoRoll = new AIPianoRoll(experience);
        jammer.onNote = (note, velocity, duration) => pianoRoll.addNote(note, velocity, duration);
        pianoRoll.start();
    } else {
        // Cloud mode: set up lead video + Lyria
        updateProgress(92, 'Setting up delay pipeline…');
        await createLeadVideo();
        leadQuadrantTracker = new QuadrantTracker();
        quadrantTracker = new QuadrantTracker();

        updateProgress(95, 'Connecting to Lyria…');
        lyriaClient = new LyriaClient();
        lyriaClient.onStatusChange = (_s, msg) => updateProgress(96, msg);
        await lyriaClient.connect();

        const initialPrompts = leadQuadrantTracker.getWeightedPrompts();
        await lyriaClient.startPlaying(
            { scale: 'C_MAJOR_A_MINOR', density: 0.3, brightness: 0.5 },
            initialPrompts,
        );
        genreOverlay.classList.remove('hidden');
        music.setCloudMode();
    }

    music.enableEvolvingSynth();
    hudMusicStatus.textContent = mode === 'local' ? 'Local AI' : 'Lyria Cloud';
    loadingScreen.classList.add('fade-out');
    experience.classList.remove('hidden');
    handleResize();
    window.addEventListener('resize', handleResize);

    // Start display video
    await video.play();

    if (mode === 'cloud' && leadVideo) {
        const dur = video.duration || 600;
        leadVideo.currentTime = (video.currentTime + LYRIA_LEAD_SECONDS) % dur;
        await leadVideo.play();
        console.log(`[Pipeline] Lead: ${leadVideo.currentTime.toFixed(1)}s, Display: ${video.currentTime.toFixed(1)}s`);
    }

    running = true;
    requestAnimationFrame(mainLoop);
}

function handleResize(): void { visualizer.resize(window.innerWidth, window.innerHeight); }

// ── Main Loop ──
function mainLoop(timestamp: number): void {
    if (!running) return;

    if (timestamp - lastDetectTime >= DETECT_INTERVAL_MS) {
        lastDetectTime = timestamp;

        if (selectedMode === 'cloud') {
            // Alternate between lead and display detection using ONE detector
            if (detectTick % 2 === 0) {
                runLeadDetection(timestamp);
            } else {
                runDisplayDetection();
            }
            detectTick++;
            checkLyriaRenewal();
        } else {
            runDisplayDetection();
        }
    }

    visualizer.render(lastDetections);

    detectFrameCount++;
    if (timestamp - fpsUpdateTime >= 1000) {
        detectFps = detectFrameCount;
        detectFrameCount = 0;
        fpsUpdateTime = timestamp;
        hudFps.textContent = String(detectFps);
    }
    requestAnimationFrame(mainLoop);
}

// ── Display detection (visualization + MIDI + synth) ──
async function runDisplayDetection(): Promise<void> {
    if (video.readyState < 2) return;
    try {
        const dets = await detector.detect(video);
        lastDetections = dets;
        hudJellyfishCount.textContent = String(dets.length);
        trackJellyfish(dets);
        if (selectedMode === 'local' && jammer) jammer.feedActivity(dets.length);

        // Update display quadrant UI in cloud mode
        if (selectedMode === 'cloud' && quadrantTracker) {
            quadrantTracker.update(dets);
            const info = quadrantTracker.getQuadrantInfo();
            const weights = quadrantTracker.getWeightedPrompts();
            for (let i = 0; i < 4; i++) {
                genreQuadrants[i].classList.toggle('active', info.counts[i] > 0);
                const pct = Math.round(weights[i].weight * 100);
                genrePcts[i].textContent = `${pct}%`;
                genreSliderFills[i].style.width = `${pct}%`;
            }
        }
    } catch (err) {
        console.error('[Display Det]', err);
    }
}

// ── Lead detection (feeds Lyria, +6s ahead) ──
async function runLeadDetection(timestamp: number): Promise<void> {
    if (!leadVideo || leadVideo.readyState < 2) return;
    try {
        const dets = await detector.detect(leadVideo);
        if (leadQuadrantTracker && lyriaClient) {
            leadQuadrantTracker.update(dets);
            if (timestamp - lastLyriaUpdate >= LYRIA_UPDATE_INTERVAL) {
                lastLyriaUpdate = timestamp;
                const prompts = leadQuadrantTracker.getWeightedPrompts();
                lyriaClient.updatePrompts(prompts);
                lyriaClient.updateConfig({
                    density: leadQuadrantTracker.getDensity(),
                    brightness: leadQuadrantTracker.getBrightness(),
                });
            }
        }
    } catch (err) {
        console.error('[Lead Det]', err);
    }
}

// ── Lyria Renewal ──
function checkLyriaRenewal(): void {
    if (!lyriaClient || isRenewing) return;
    if (lyriaClient.getSessionAge() >= LYRIA_RENEWAL_AGE_S) renewLyriaSession();
}

async function renewLyriaSession(): Promise<void> {
    if (!lyriaClient || !leadQuadrantTracker) return;
    isRenewing = true;
    changeoverIndicator?.classList.add('active');
    try {
        nextLyriaClient = new LyriaClient();
        nextLyriaClient.onStatusChange = (_s, msg) => console.log(`[Lyria Next] ${msg}`);
        await nextLyriaClient.connect();
        const prompts = lyriaClient.lastPrompts.length > 0 ? lyriaClient.lastPrompts : leadQuadrantTracker.getWeightedPrompts();
        const config = {
            scale: lyriaClient.lastConfig.scale ?? 'C_MAJOR_A_MINOR',
            density: lyriaClient.lastConfig.density ?? 0.3,
            brightness: lyriaClient.lastConfig.brightness ?? 0.5,
        };
        await nextLyriaClient.startPlaying(config, prompts);
        nextLyriaClient.setVolume(0);

        renewalCrossfadeStart = Date.now();
        const crossfadeMs = LYRIA_CROSSFADE_S * 1000;
        const interval = setInterval(() => {
            const progress = Math.min(1, (Date.now() - renewalCrossfadeStart) / crossfadeMs);
            const eased = progress * progress * (3 - 2 * progress);
            lyriaClient?.setVolume(0.7 * (1 - eased));
            nextLyriaClient?.setVolume(0.7 * eased);
            if (progress >= 1) { clearInterval(interval); finishRenewal(); }
        }, 100);
    } catch (err) {
        console.error('[Lyria] Renewal failed:', err);
        isRenewing = false;
        changeoverIndicator?.classList.remove('active');
    }
}

async function finishRenewal(): Promise<void> {
    const old = lyriaClient;
    lyriaClient = nextLyriaClient;
    nextLyriaClient = null;
    try { await old?.stop(); } catch { /* ok */ }
    if (lyriaClient) lyriaClient.onStatusChange = (_s, msg) => console.log(`[Lyria] ${msg}`);
    isRenewing = false;
    changeoverIndicator?.classList.remove('active');
}

// ── Mode Selection ──
function handleModeClick(mode: AppMode): void {
    modeLocalBtn.disabled = true;
    modeCloudBtn.disabled = true;
    (mode === 'local' ? modeLocalBtn : modeCloudBtn).style.borderColor = 'var(--color-primary)';
    (mode === 'local' ? modeLocalBtn : modeCloudBtn).style.opacity = '1';
    (mode === 'local' ? modeCloudBtn : modeLocalBtn).style.opacity = '0.3';
    loadingStatus.textContent = mode === 'local' ? 'Starting local…' : 'Connecting to cloud…';
    startExperience(mode).catch(console.error);
}

modeLocalBtn.addEventListener('click', () => handleModeClick('local'));
modeCloudBtn.addEventListener('click', () => handleModeClick('cloud'));

init().catch((err) => {
    console.error('[Init]', err);
    loadingStatus.textContent = `Error: ${err.message}`;
});
