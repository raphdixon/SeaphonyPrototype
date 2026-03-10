/**
 * Quadrant Tracker — maps squid positions to genre weights for Lyria
 *
 * Splits the detection frame into 4 quadrants, counts squids in each,
 * and outputs smoothly interpolated weights for the 4 genre prompts.
 *
 *   ┌──────────┬───────────┐
 *   │ TL       │ TR        │
 *   │ Chill-   │ Ambient   │
 *   │ wave     │           │
 *   ├──────────┼───────────┤
 *   │ BL       │ BR        │
 *   │ Beach    │ Piano     │
 *   │ House    │ Song      │
 *   └──────────┴───────────┘
 */

import { Detection } from './squidDetector';

// ── Genre Definitions ────────────────────────────────────────
export interface GenreWeight {
    text: string;
    weight: number;
}

const GENRES = [
    {
        name: 'Lofi Beats',
        prompt: 'Lofi beats with mellow jazzy chords, warm vinyl crackle, laid-back drums, and nostalgic melodies',
    },
    {
        name: 'Ambient',
        prompt: 'Atmospheric ambient with evolving pads, gentle textures, and spacious soundscapes',
    },
    {
        name: 'Piano',
        prompt: 'Gentle piano melody with soft chords, expressive dynamics, and warm acoustic resonance',
    },
    {
        name: 'Choral Choir',
        prompt: 'Ethereal choral choir with layered harmonies, soaring vocals, and cathedral-like reverb',
    },
] as const;

// Minimum weight so genres never fully disappear
const MIN_WEIGHT = 0.05;

// Interpolation speed: lower = smoother transitions (0 = frozen, 1 = instant)
const LERP_SPEED = 0.08;

export class QuadrantTracker {
    // Raw quadrant counts: [TL, TR, BL, BR]
    private counts = [0, 0, 0, 0];
    private totalSquids = 0;

    // Smoothed weights — these are what we actually output
    private smoothWeights = [0.25, 0.25, 0.25, 0.25];

    // ── Update with new detections ──────────────────────────────
    update(detections: Detection[]): void {
        this.counts = [0, 0, 0, 0];
        this.totalSquids = detections.length;

        for (const det of detections) {
            const cx = det.centroid.x;
            const cy = det.centroid.y;

            const col = cx < 0.5 ? 0 : 1;
            const row = cy < 0.5 ? 0 : 1;
            const quadrant = row * 2 + col;

            this.counts[quadrant]++;
        }

        // Compute target weights
        const targetWeights =
            this.totalSquids === 0
                ? [0.25, 0.25, 0.25, 0.25]
                : this.counts.map((c) => Math.max(MIN_WEIGHT, c / this.totalSquids));

        // Normalize targets to sum to 1
        const targetSum = targetWeights.reduce((a, b) => a + b, 0);
        for (let i = 0; i < 4; i++) {
            targetWeights[i] /= targetSum;
        }

        // Smoothly interpolate toward targets
        for (let i = 0; i < 4; i++) {
            this.smoothWeights[i] += (targetWeights[i] - this.smoothWeights[i]) * LERP_SPEED;
        }

        // Re-normalize smoothed weights
        const smoothSum = this.smoothWeights.reduce((a, b) => a + b, 0);
        for (let i = 0; i < 4; i++) {
            this.smoothWeights[i] /= smoothSum;
        }
    }

    // ── Get weighted prompts for Lyria ───────────────────────────
    getWeightedPrompts(): GenreWeight[] {
        return GENRES.map((g, i) => ({
            text: g.prompt,
            weight: this.smoothWeights[i],
        }));
    }

    // ── Get density based on total squid count ───────────────────
    getDensity(): number {
        return Math.min(0.9, 0.1 + this.totalSquids * 0.053);
    }

    // ── Get brightness based on dominant quadrant ────────────────
    getBrightness(): number {
        const topCount = this.counts[0] + this.counts[1];
        if (this.totalSquids === 0) return 0.5;
        return 0.3 + 0.4 * (topCount / this.totalSquids);
    }

    // ── Debug info ──────────────────────────────────────────────
    getQuadrantInfo(): { names: string[]; counts: number[]; total: number } {
        return {
            names: GENRES.map((g) => g.name),
            counts: [...this.counts],
            total: this.totalSquids,
        };
    }
}
