/**
 * Visualizer — Canvas overlay rendering for grid, detections, and particles
 */
import { GRID_COLS, GRID_ROWS, type CellTrigger } from './musicEngine';
import type { Detection } from './squidDetector';

// Particle system
interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    maxLife: number;
    size: number;
    hue: number;
    alpha: number;
}

// Cell glow state
interface CellGlow {
    row: number;
    col: number;
    intensity: number;
    hue: number;
    note: string;
}

// Scheduled particle burst for staggered arp animations
interface PendingBurst {
    time: number;   // performance.now() timestamp to spawn at
    cx: number;
    cy: number;
    count: number;
    hue: number;
    arcAngle?: number;  // focused direction for arp ripple bursts
    isArp?: boolean;    // arp particles are larger/brighter
}

export class Visualizer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private particles: Particle[] = [];
    private cellGlows: CellGlow[] = [];
    private pendingBursts: PendingBurst[] = [];
    private width = 0;
    private height = 0;
    private noteDisplays: { text: string; x: number; y: number; alpha: number; vy: number }[] = [];

    // Safety caps to prevent runaway memory growth
    private static readonly MAX_PARTICLES = 500;
    private static readonly MAX_GLOWS = 50;
    private static readonly MAX_NOTE_DISPLAYS = 30;

    // Arp animation timing — matches the 16n note spacing in musicEngine
    private static readonly ARP_NOTE_COUNT = 4;
    private static readonly ARP_STEP_MS = 125; // ~16n at 120 BPM

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d')!;
    }

    resize(w: number, h: number): void {
        this.width = w;
        this.height = h;
        this.canvas.width = w;
        this.canvas.height = h;
    }

    /**
     * Register a note trigger — spawns particles and cell glow.
     * Top-row (arp) triggers stagger particles across 4 bursts
     * timed to the arp notes; other rows burst all at once.
     */
    onNoteTrigger(trigger: CellTrigger): void {
        // Safety: skip if arrays are saturated
        if (this.particles.length >= Visualizer.MAX_PARTICLES) return;

        const cx = trigger.x * this.width;
        const cy = trigger.y * this.height;
        const hue = this.cellHue(trigger.row, trigger.col);

        if (trigger.row === 0) {
            // === TOP ROW: sequential directional ripple matching 4 arp notes ===
            // Each burst shoots particles in a focused arc direction: → ↗ ↑ ↖
            const now = performance.now();
            const particlesPerBurst = 4;
            for (let beat = 0; beat < Visualizer.ARP_NOTE_COUNT; beat++) {
                this.pendingBursts.push({
                    time: now + beat * Visualizer.ARP_STEP_MS,
                    cx, cy,
                    count: particlesPerBurst,
                    hue,
                    arcAngle: (beat * Math.PI) / 3 - Math.PI / 6,  // sweep from right to upper-left
                    isArp: true,
                });
            }
        } else {
            // === OTHER ROWS: instant burst ===
            this.spawnParticles(cx, cy, 12, hue);
        }

        // Add cell glow
        this.cellGlows.push({
            row: trigger.row,
            col: trigger.col,
            intensity: 1,
            hue,
            note: trigger.note,
        });

        // Floating note label
        this.noteDisplays.push({
            text: trigger.note,
            x: cx,
            y: cy - 10,
            alpha: 1.2,
            vy: -0.8,
        });
    }

    /** Spawn N particles at a position */
    private spawnParticles(cx: number, cy: number, count: number, hue: number): void {
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 0.5 + Math.random() * 2;
            this.particles.push({
                x: cx, y: cy,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1,
                maxLife: 60 + Math.random() * 40,
                size: 2 + Math.random() * 4,
                hue,
                alpha: 0.8 + Math.random() * 0.2,
            });
        }
    }

    /** Flush any pending arp bursts whose time has arrived */
    private processPendingBursts(): void {
        const now = performance.now();
        for (let i = this.pendingBursts.length - 1; i >= 0; i--) {
            const burst = this.pendingBursts[i];
            if (now >= burst.time) {
                if (burst.isArp && burst.arcAngle !== undefined) {
                    // Directional arp burst — focused arc with bigger, brighter particles
                    this.spawnArpParticles(burst.cx, burst.cy, burst.count, burst.hue, burst.arcAngle);
                } else {
                    this.spawnParticles(burst.cx, burst.cy, burst.count, burst.hue);
                }
                this.pendingBursts.splice(i, 1);
            }
        }
    }

    /** Spawn directional arp particles in a focused arc */
    private spawnArpParticles(cx: number, cy: number, count: number, hue: number, direction: number): void {
        const arcSpread = Math.PI / 4; // 45° cone
        for (let i = 0; i < count; i++) {
            const angle = direction + (Math.random() - 0.5) * arcSpread;
            const speed = 1.5 + Math.random() * 2.5;
            this.particles.push({
                x: cx, y: cy,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1,
                maxLife: 45 + Math.random() * 25,
                size: 3 + Math.random() * 5,
                hue,
                alpha: 0.9 + Math.random() * 0.1,
            });
        }
    }

    /**
     * Main render loop
     */
    render(detections: Detection[]): void {
        const { ctx, width, height } = this;
        ctx.clearRect(0, 0, width, height);

        // 0. Flush any scheduled arp particle bursts
        this.processPendingBursts();

        // 1. Draw grid
        this.drawGrid();

        // 2. Draw cell glows
        this.drawCellGlows();

        // 3. Draw detections (bounding boxes + centroids)
        this.drawDetections(detections);

        // 4. Draw particles
        this.drawParticles();

        // 5. Draw floating note labels
        this.drawNoteDisplays();
    }

    private drawGrid(): void {
        const { ctx, width, height } = this;
        const cellW = width / GRID_COLS;
        const cellH = height / GRID_ROWS;

        ctx.strokeStyle = 'rgba(0, 229, 255, 0.12)';
        ctx.lineWidth = 1;

        // Vertical lines
        for (let c = 1; c < GRID_COLS; c++) {
            const x = c * cellW;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }

        // Horizontal lines
        for (let r = 1; r < GRID_ROWS; r++) {
            const y = r * cellH;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }

        // Border
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.06)';
        ctx.lineWidth = 2;
        ctx.strokeRect(0, 0, width, height);
    }

    private drawCellGlows(): void {
        const { ctx, width, height } = this;
        const cellW = width / GRID_COLS;
        const cellH = height / GRID_ROWS;

        for (let i = this.cellGlows.length - 1; i >= 0; i--) {
            const glow = this.cellGlows[i];
            const x = glow.col * cellW;
            const y = glow.row * cellH;

            // Background glow
            ctx.fillStyle = `hsla(${glow.hue}, 80%, 60%, ${glow.intensity * 0.15})`;
            ctx.fillRect(x, y, cellW, cellH);

            // Border glow
            ctx.strokeStyle = `hsla(${glow.hue}, 90%, 70%, ${glow.intensity * 0.5})`;
            ctx.lineWidth = 2;
            ctx.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2);

            // Center glow
            const cx = x + cellW / 2;
            const cy = y + cellH / 2;
            const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, cellW * 0.4);
            gradient.addColorStop(0, `hsla(${glow.hue}, 90%, 70%, ${glow.intensity * 0.3})`);
            gradient.addColorStop(1, `hsla(${glow.hue}, 90%, 70%, 0)`);
            ctx.fillStyle = gradient;
            ctx.fillRect(x, y, cellW, cellH);

            // Decay
            glow.intensity *= 0.96;
            if (glow.intensity < 0.01) {
                this.cellGlows.splice(i, 1);
            }
        }
    }

    private drawDetections(detections: Detection[]): void {
        const { ctx, width, height } = this;

        for (const det of detections) {
            const x1 = det.bbox.x1 * width;
            const y1 = det.bbox.y1 * height;
            const x2 = det.bbox.x2 * width;
            const y2 = det.bbox.y2 * height;
            const cx = det.centroid.x * width;
            const cy = det.centroid.y * height;

            // Bounding box
            ctx.strokeStyle = 'rgba(255, 0, 255, 0.6)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 3]);
            ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
            ctx.setLineDash([]);

            // Centroid dot with glow
            ctx.shadowColor = 'rgba(255, 0, 255, 0.8)';
            ctx.shadowBlur = 10;
            ctx.fillStyle = '#ff00ff';
            ctx.beginPath();
            ctx.arc(cx, cy, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;

            // Confidence label
            ctx.font = '10px "JetBrains Mono", monospace';
            ctx.fillStyle = 'rgba(255, 0, 255, 0.8)';
            ctx.fillText(`${(det.confidence * 100).toFixed(0)}%`, x1 + 4, y1 - 4);
        }
    }

    private drawParticles(): void {
        const { ctx } = this;

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];

            // Update
            p.x += p.vx;
            p.y += p.vy;
            p.vy -= 0.01; // slight float upwards
            p.vx *= 0.98;
            p.vy *= 0.98;
            p.life++;

            const lifeRatio = 1 - p.life / p.maxLife;

            if (lifeRatio <= 0) {
                this.particles.splice(i, 1);
                continue;
            }

            const alpha = lifeRatio * p.alpha;
            const size = p.size * (0.5 + lifeRatio * 0.5);

            // Draw with glow
            ctx.shadowColor = `hsla(${p.hue}, 90%, 70%, ${alpha})`;
            ctx.shadowBlur = 8;
            ctx.fillStyle = `hsla(${p.hue}, 90%, 75%, ${alpha})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.shadowBlur = 0;
    }

    private drawNoteDisplays(): void {
        const { ctx } = this;

        for (let i = this.noteDisplays.length - 1; i >= 0; i--) {
            const nd = this.noteDisplays[i];
            nd.y += nd.vy;
            nd.alpha -= 0.015;

            if (nd.alpha <= 0) {
                this.noteDisplays.splice(i, 1);
                continue;
            }

            ctx.font = 'bold 14px "Inter", sans-serif';
            ctx.textAlign = 'center';
            ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, nd.alpha)})`;
            ctx.shadowColor = `rgba(0, 229, 255, ${Math.min(0.5, nd.alpha)})`;
            ctx.shadowBlur = 6;
            ctx.fillText(nd.text, nd.x, nd.y);
        }

        ctx.shadowBlur = 0;
        ctx.textAlign = 'start';
    }

    /**
     * Map grid cell to a hue for visual variety
     */
    private cellHue(row: number, col: number): number {
        // Spread hues across the grid for visual variety
        const index = row * GRID_COLS + col;
        return (180 + index * 22.5) % 360; // Start from cyan, spread
    }
}
