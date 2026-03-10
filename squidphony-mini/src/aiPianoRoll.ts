/**
 * AI Piano Roll — A subtle bottom-bar visualization showing AI-generated notes
 *
 * Renders a semi-transparent piano-roll strip along the bottom of the screen.
 * Each note appears as a glowing bar at the correct pitch position, fading out
 * over time. This makes the AI's musical contribution visible without being
 * distracting.
 */

// MIDI range the jammer uses: C4 (60) to C7 (96) = 36 semitones
const MIDI_MIN = 60;
const MIDI_MAX = 96;
const MIDI_RANGE = MIDI_MAX - MIDI_MIN;

interface ActiveNote {
    x: number;        // normalized position (0–1) across the bar
    velocity: number; // 0–1, controls brightness
    duration: number; // seconds
    birth: number;    // performance.now()
    fadeTime: number; // total display time in ms
}

export class AIPianoRoll {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private notes: ActiveNote[] = [];
    private animFrame: number = 0;

    constructor(container: HTMLElement) {
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'ai-piano-roll';
        this.canvas.style.cssText = `
            position: absolute;
            bottom: 0;
            left: 0;
            width: 100%;
            height: 64px;
            z-index: 15;
            pointer-events: none;
            opacity: 0.85;
        `;
        container.appendChild(this.canvas);

        this.ctx = this.canvas.getContext('2d')!;

        // Defer initial resize so the canvas has layout dimensions
        requestAnimationFrame(() => {
            this.resize();
            // Safety: re-check after a beat in case layout wasn't ready
            setTimeout(() => this.resize(), 200);
        });
        window.addEventListener('resize', () => this.resize());
    }

    private resize(): void {
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return; // not laid out yet
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        // Reset transform then scale for DPR
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /** Called by the jammer's onNote callback */
    addNote(noteName: string, velocity: number, durationSec: number): void {
        // Parse MIDI from note name
        let midi: number;
        try {
            // Simple note name → MIDI conversion
            midi = noteNameToMidi(noteName);
        } catch {
            return;
        }

        const x = Math.max(0, Math.min(1, (midi - MIDI_MIN) / MIDI_RANGE));
        const fadeTime = Math.max(600, durationSec * 1000 + 400); // note duration + tail

        this.notes.push({
            x,
            velocity,
            duration: durationSec,
            birth: performance.now(),
            fadeTime,
        });
    }

    /** Start the render loop */
    start(): void {
        const draw = () => {
            this.render();
            this.animFrame = requestAnimationFrame(draw);
        };
        draw();
    }

    stop(): void {
        cancelAnimationFrame(this.animFrame);
    }

    private render(): void {
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.width / dpr;
        const h = this.canvas.height / dpr;

        // If canvas is still 0-sized, try resizing
        if (w === 0 || h === 0) {
            this.resize();
            return;
        }
        const now = performance.now();

        this.ctx.clearRect(0, 0, w, h);

        // Background strip — very subtle dark glass
        this.ctx.fillStyle = 'rgba(2, 8, 24, 0.5)';
        this.ctx.fillRect(0, 0, w, h);

        // Top edge line
        this.ctx.strokeStyle = 'rgba(0, 229, 255, 0.15)';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(0, 0.5);
        this.ctx.lineTo(w, 0.5);
        this.ctx.stroke();

        // "AI" label
        this.ctx.font = '9px Inter, sans-serif';
        this.ctx.fillStyle = 'rgba(0, 229, 255, 0.4)';
        this.ctx.textAlign = 'left';
        this.ctx.fillText('AI ♪', 8, 12);

        // Draw active notes
        const alive: ActiveNote[] = [];

        for (const note of this.notes) {
            const age = now - note.birth;
            if (age > note.fadeTime) continue; // expired

            alive.push(note);

            const progress = age / note.fadeTime; // 0 → 1
            const alpha = (1 - progress) * note.velocity;

            // Note bar position
            const barX = note.x * (w - 8) + 4; // 4px padding each side
            const barWidth = 3;
            const barHeight = h * 0.65;
            const barY = (h - barHeight) / 2;

            // Glow effect
            const glowAlpha = alpha * 0.6;
            this.ctx.shadowColor = `rgba(0, 229, 255, ${glowAlpha})`;
            this.ctx.shadowBlur = 8;

            // Primary color (cyan → purple gradient based on pitch position)
            const r = Math.round(0 + note.x * 124);   // 0 → 124
            const g = Math.round(229 - note.x * 152);  // 229 → 77
            const b = 255;
            this.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha * 0.9})`;

            // Draw rounded bar
            this.ctx.beginPath();
            this.ctx.roundRect(barX - barWidth / 2, barY, barWidth, barHeight, 2);
            this.ctx.fill();

            // Bright peak at attack
            if (progress < 0.15) {
                const peakAlpha = (1 - progress / 0.15) * note.velocity;
                this.ctx.fillStyle = `rgba(255, 255, 255, ${peakAlpha * 0.7})`;
                this.ctx.beginPath();
                this.ctx.roundRect(barX - barWidth / 2, barY, barWidth, barHeight, 2);
                this.ctx.fill();
            }

            this.ctx.shadowBlur = 0;
        }

        this.notes = alive;
    }

    dispose(): void {
        this.stop();
        this.canvas.remove();
    }
}

// ── Simple note name to MIDI ──────────────────────────────────
const NOTE_MAP: Record<string, number> = {
    'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3,
    'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8,
    'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11,
};

function noteNameToMidi(name: string): number {
    const match = name.match(/^([A-G][#b]?)(\d+)$/);
    if (!match) throw new Error(`Invalid note: ${name}`);
    const pc = NOTE_MAP[match[1]];
    const octave = parseInt(match[2]);
    return (octave + 1) * 12 + pc;
}
