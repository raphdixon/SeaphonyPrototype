/**
 * Visualizer — Canvas overlay + CSS bloom animations
 * 
 * Canvas: grid lines, detection boxes (drawn at detection fps, fine at low rate)
 * CSS blooms: note-triggered effects (run on compositor thread at 60fps always)
 */
import { GRID_COLS, GRID_ROWS, type CellTrigger } from './musicEngine';
import type { Detection } from './types';

export class Visualizer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private bloomLayer: HTMLElement;
    private width = 0;
    private height = 0;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d')!;
        this.bloomLayer = document.getElementById('bloom-layer')!;
    }

    resize(w: number, h: number): void {
        this.width = w;
        this.height = h;
        this.canvas.width = w;
        this.canvas.height = h;
    }

    /**
     * Trigger a note bloom — creates DOM elements with CSS animations.
     * These run on the compositor thread at 60fps, unaffected by ONNX blocking.
     */
    onNoteTrigger(trigger: CellTrigger): void {
        const x = trigger.x * this.width;
        const y = trigger.y * this.height;
        const hue = this.cellHue(trigger.row, trigger.col);

        // 1. Main bloom burst
        this.spawnBloom(x, y, hue);

        // 2. Expanding ring
        this.spawnRing(x, y, hue);

        // 3. Floating note label
        this.spawnNoteLabel(trigger.note, x, y);

        // 4. Scatter particles
        const count = trigger.row === 0 ? 8 : 5;
        for (let i = 0; i < count; i++) {
            this.spawnParticle(x, y, hue);
        }
    }

    /** Main render — just canvas items (grid + detection boxes). Fine at any fps. */
    render(detections: Detection[]): void {
        const { ctx, width, height } = this;
        ctx.clearRect(0, 0, width, height);
        this.drawGrid();
        this.drawDetections(detections);
    }

    // ── CSS Bloom Elements (compositor thread) ──

    private spawnBloom(x: number, y: number, hue: number): void {
        const el = document.createElement('div');
        el.className = 'bloom';
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.background = `radial-gradient(circle, hsla(${hue}, 90%, 70%, 0.6) 0%, hsla(${hue}, 90%, 70%, 0.15) 40%, transparent 70%)`;
        this.bloomLayer.appendChild(el);
        el.addEventListener('animationend', () => el.remove());
    }

    private spawnRing(x: number, y: number, hue: number): void {
        const el = document.createElement('div');
        el.className = 'bloom-ring';
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.borderColor = `hsla(${hue}, 90%, 70%, 0.5)`;
        this.bloomLayer.appendChild(el);
        el.addEventListener('animationend', () => el.remove());
    }

    private spawnNoteLabel(note: string, x: number, y: number): void {
        const el = document.createElement('div');
        el.className = 'note-float';
        el.textContent = note;
        el.style.left = `${x}px`;
        el.style.top = `${y - 20}px`;
        this.bloomLayer.appendChild(el);
        el.addEventListener('animationend', () => el.remove());
    }

    private spawnParticle(cx: number, cy: number, hue: number): void {
        const el = document.createElement('div');
        el.className = 'bloom-particle';
        el.style.left = `${cx}px`;
        el.style.top = `${cy}px`;
        el.style.background = `hsla(${hue}, 90%, 70%, 0.8)`;

        // Random direction via CSS custom end position
        const angle = Math.random() * Math.PI * 2;
        const dist = 40 + Math.random() * 60;
        const tx = Math.cos(angle) * dist;
        const ty = Math.sin(angle) * dist;
        el.style.setProperty('--tx', `${tx}px`);
        el.style.setProperty('--ty', `${ty}px`);

        this.bloomLayer.appendChild(el);
        el.addEventListener('animationend', () => el.remove());
    }

    // ── Canvas-only rendering ──

    private drawGrid(): void {
        const { ctx, width, height } = this;
        const cellW = width / GRID_COLS;
        const cellH = height / GRID_ROWS;

        ctx.strokeStyle = 'rgba(0, 229, 255, 0.12)';
        ctx.lineWidth = 1;
        for (let c = 1; c < GRID_COLS; c++) {
            ctx.beginPath();
            ctx.moveTo(c * cellW, 0);
            ctx.lineTo(c * cellW, height);
            ctx.stroke();
        }
        for (let r = 1; r < GRID_ROWS; r++) {
            ctx.beginPath();
            ctx.moveTo(0, r * cellH);
            ctx.lineTo(width, r * cellH);
            ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.06)';
        ctx.lineWidth = 2;
        ctx.strokeRect(0, 0, width, height);
    }

    private drawDetections(detections: Detection[]): void {
        const { ctx, width, height } = this;
        for (const det of detections) {
            const x1 = det.bbox.x1 * width;
            const y1 = det.bbox.y1 * height;
            const x2 = det.bbox.x2 * width;
            const y2 = det.bbox.y2 * height;

            // Bounding box
            ctx.strokeStyle = 'rgba(0, 230, 255, 0.6)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 3]);
            ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
            ctx.setLineDash([]);

            // Confidence
            ctx.font = '10px monospace';
            ctx.fillStyle = 'rgba(0, 230, 255, 0.7)';
            ctx.fillText(`${(det.confidence * 100).toFixed(0)}%`, x1 + 4, y1 - 4);
        }
    }

    private cellHue(row: number, col: number): number {
        return (180 + (row * GRID_COLS + col) * 22.5) % 360;
    }
}
