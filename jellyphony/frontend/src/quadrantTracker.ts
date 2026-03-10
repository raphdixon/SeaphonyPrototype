/**
 * Quadrant Tracker — maps jellyfish area to genre weights for Lyria.
 * Uses bounding box area per quadrant.
 */
import { Detection } from './types';

export interface GenreWeight { text: string; weight: number; }

const GENRES = [
    { name: 'Deep Lofi Beats', prompt: 'Lofi beats with mellow jazzy chords, warm vinyl crackle, laid-back drums, and nostalgic melodies' },
    { name: 'Ambient', prompt: 'Atmospheric ambient with evolving pads, gentle textures, and spacious soundscapes' },
    { name: 'Piano', prompt: 'Gentle piano melody with soft chords, expressive dynamics, and warm acoustic resonance' },
    { name: 'Choral Choir', prompt: 'Ethereal choral choir with layered harmonies, soaring vocals, and cathedral-like reverb' },
] as const;

const MIN_WEIGHT = 0.05;
const LERP_SPEED = 0.08;

export class QuadrantTracker {
    private areaCoverage = [0, 0, 0, 0];
    private totalCoverage = 0;
    private counts = [0, 0, 0, 0];
    private totalJellyfish = 0;
    private smoothWeights = [0.25, 0.25, 0.25, 0.25];

    update(detections: Detection[]): void {
        const areaPerQ = [0, 0, 0, 0];
        this.counts = [0, 0, 0, 0];
        this.totalJellyfish = detections.length;

        for (const det of detections) {
            const col = det.centroid.x < 0.5 ? 0 : 1;
            const row = det.centroid.y < 0.5 ? 0 : 1;
            const q = row * 2 + col;
            this.counts[q]++;
            areaPerQ[q] += (det.bbox.x2 - det.bbox.x1) * (det.bbox.y2 - det.bbox.y1);
        }

        for (let i = 0; i < 4; i++) this.areaCoverage[i] = areaPerQ[i];
        this.totalCoverage = areaPerQ.reduce((a, b) => a + b, 0);

        const total = this.totalCoverage;
        const tw = total === 0
            ? [0.25, 0.25, 0.25, 0.25]
            : areaPerQ.map((a) => Math.max(MIN_WEIGHT, a / total));

        const ts = tw.reduce((a, b) => a + b, 0);
        for (let i = 0; i < 4; i++) tw[i] /= ts;
        for (let i = 0; i < 4; i++) this.smoothWeights[i] += (tw[i] - this.smoothWeights[i]) * LERP_SPEED;
        const ss = this.smoothWeights.reduce((a, b) => a + b, 0);
        for (let i = 0; i < 4; i++) this.smoothWeights[i] /= ss;
    }

    getWeightedPrompts(): GenreWeight[] {
        return GENRES.map((g, i) => ({ text: g.prompt, weight: this.smoothWeights[i] }));
    }

    getDensity(): number { return Math.min(0.9, 0.1 + this.totalCoverage * 3); }

    getBrightness(): number {
        const top = this.areaCoverage[0] + this.areaCoverage[1];
        const total = this.areaCoverage.reduce((a, b) => a + b, 0);
        return total === 0 ? 0.5 : 0.3 + 0.4 * (top / total);
    }

    getQuadrantInfo(): { names: string[]; counts: number[]; total: number } {
        return { names: GENRES.map((g) => g.name), counts: [...this.counts], total: this.totalJellyfish };
    }
}
