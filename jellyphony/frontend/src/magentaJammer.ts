/**
 * Magenta Jammer — AI-generated melodic phrases that evolve alongside jellyfish activity
 *
 * Architecture:
 *   1. Jellyfish notes are collected into a rolling buffer
 *   2. Each cycle, a "jellyfish phrase" is built from recent notes
 *   3. MusicVAE.interpolate() morphs between the LAST AI phrase and the new
 *      jellyfish phrase — creating smooth musical evolution where the AI sounds
 *      like it's *listening and responding*
 *   4. Jellyfish density controls behavior:
 *      - Few jellyfish → similar() with high similarity (subtle, sparse)
 *      - Medium → interpolate() (responsive morphing)
 *      - Many jellyfish → higher temperature, more adventurous
 *   5. Output is snapped to pentatonic and played on a bright detuned saw synth
 */
import * as Tone from 'tone';
import * as tf from '@tensorflow/tfjs';

// ── Constants ──────────────────────────────────────────────────
const CHECKPOINT = '/magenta-checkpoint';
const TOTAL_STEPS = 32;          // 2 bars of 16th notes
const STEPS_PER_QUARTER = 4;
const PENTATONIC = [0, 2, 4, 7, 9]; // C D E G A pitch classes
const MIN_NOTES_TO_JAM = 2;
const NOTE_HISTORY_MS = 30_000;

// ── Types ──────────────────────────────────────────────────────
interface BufferedNote {
    pitch: number; // MIDI
    time: number;  // performance.now()
}

export class MagentaJammer {
    private mvae: any = null;
    // Bright saw synth
    private synth: Tone.PolySynth | null = null;
    private jamFilter: Tone.Filter | null = null;
    private jamLfo: Tone.LFO | null = null;
    private jamReverb: Tone.Reverb | null = null;
    private jamDelay: Tone.FeedbackDelay | null = null;
    // Note buffer
    private noteHistory: BufferedNote[] = [];
    // Last generated phrase (for interpolation continuity)
    private lastPhrase: any = null;
    // Callback for UI visualization — called with (noteName, velocity, durationSec)
    public onNote: ((note: string, velocity: number, duration: number) => void) | null = null;
    // Generation state
    private isGenerating = false;
    private jamTimer: ReturnType<typeof setInterval> | null = null;
    private _ready = false;
    private jellyfishCount = 0; // current jellyfish density

    get ready(): boolean {
        return this._ready;
    }

    // ── Initialization ─────────────────────────────────────────
    async init(onProgress?: (msg: string) => void): Promise<void> {
        onProgress?.('Loading Magenta MusicVAE…');

        await tf.ready();
        const originalBackend = tf.getBackend() || 'webgl';
        console.log(`[MagentaJammer] Current TF backend: ${originalBackend}`);

        await tf.setBackend('cpu');
        console.log('[MagentaJammer] Switched to CPU backend for MusicVAE');

        const mm = await import('@magenta/music');
        this.mvae = new mm.MusicVAE(CHECKPOINT);
        await this.mvae.initialize();
        console.log('[MagentaJammer] MusicVAE model loaded (on CPU)');

        await tf.setBackend(originalBackend);
        console.log(`[MagentaJammer] Restored TF backend to: ${originalBackend}`);

        onProgress?.('Setting up AI synth…');

        // ── Effects chain: synth → filter → delay → reverb → destination ──
        // Spring reverb — short decay, higher wetness for springy character
        this.jamReverb = new Tone.Reverb({
            decay: 2.0,
            wet: 0.4,
        }).toDestination();
        await this.jamReverb.generate();

        this.jamDelay = new Tone.FeedbackDelay({
            delayTime: '8n.',
            feedback: 0.25,
            wet: 0.2,
        }).connect(this.jamReverb);

        // LPF with LFO modulation for movement
        this.jamFilter = new Tone.Filter({
            frequency: 3500,
            type: 'lowpass',
            rolloff: -12,
        }).connect(this.jamDelay);

        this.jamLfo = new Tone.LFO({
            frequency: 0.15,    // slow sweep
            min: 2000,
            max: 5000,
            type: 'sine',
        });
        this.jamLfo.connect(this.jamFilter.frequency);

        // ── FM-synthesized Piano (fully offline, no samples needed) ──
        this.synth = new Tone.PolySynth(Tone.FMSynth, {
            harmonicity: 3,
            modulationIndex: 1.5,
            oscillator: { type: 'sine' },
            modulation: { type: 'sine' },
            envelope: {
                attack: 0.005,
                decay: 0.6,
                sustain: 0.15,
                release: 1.2,
            },
            modulationEnvelope: {
                attack: 0.002,
                decay: 0.2,
                sustain: 0.0,
                release: 0.4,
            },
            volume: -18,
        }).connect(this.jamFilter!);
        this.synth.maxPolyphony = 8;

        console.log('[MagentaJammer] 🎹 FM Piano synth ready');

        this._ready = true;
        console.log('[MagentaJammer] Initialized');
    }

    // ── Feed jellyfish notes ───────────────────────────────────
    feedNote(noteName: string): void {
        try {
            const midi = Tone.Frequency(noteName).toMidi();
            this.noteHistory.push({ pitch: midi, time: performance.now() });
            const cutoff = performance.now() - NOTE_HISTORY_MS;
            this.noteHistory = this.noteHistory.filter((n) => n.time > cutoff);
        } catch {
            // Ignore invalid note names
        }
    }

    // ── Feed jellyfish count for density-aware behavior ────────
    feedActivity(count: number): void {
        this.jellyfishCount = count;
    }

    // ── Start / Stop ───────────────────────────────────────────
    start(): void {
        if (!this._ready) return;
        this.jamLfo?.start();
        const cycleMs = this.getPhraseDurationMs();
        this.jamTimer = setInterval(() => this.maybeGenerate(), cycleMs);
        // First phrase after a short delay
        setTimeout(() => this.maybeGenerate(), 2000);
        console.log(`[MagentaJammer] Jam loop started (cycle: ${Math.round(cycleMs)}ms)`);
    }

    stop(): void {
        if (this.jamTimer) {
            clearInterval(this.jamTimer);
            this.jamTimer = null;
        }
        this.jamLfo?.stop();
    }

    private getPhraseDurationMs(): number {
        const bpm = Tone.getTransport().bpm.value || 120;
        const beatsPerPhrase = 8; // 2 bars × 4 beats
        return (beatsPerPhrase / bpm) * 60 * 1000;
    }

    // ── Generation loop ────────────────────────────────────────
    private async maybeGenerate(): Promise<void> {
        if (this.isGenerating || !this._ready || !this.mvae) return;
        if (this.noteHistory.length < MIN_NOTES_TO_JAM) return;

        this.isGenerating = true;
        const currentBackend = tf.getBackend();

        try {
            await tf.setBackend('cpu');

            const jellyfishPhrase = this.buildJellyfishPhrase();
            let result: any;

            if (this.jellyfishCount <= 3) {
                // ── FEW JELLYFISH: subtle variations ──
                // Use similar() with high similarity — sparse, gentle
                const variations = await this.mvae.similar(jellyfishPhrase, 1, 0.85, 0.8);
                result = variations[0];
                console.log(`[MagentaJammer] Mode: SUBTLE (${this.jellyfishCount} jellyfish, similarity=0.85)`);

            } else if (this.jellyfishCount <= 7 && this.lastPhrase) {
                // ── MEDIUM JELLYFISH: interpolate between last AI phrase and jellyfish phrase ──
                // This creates smooth evolution — AI sounds like it's listening
                const interps = await this.mvae.interpolate(
                    [this.lastPhrase, jellyfishPhrase], 4, 0.9
                );
                // Pick a point partway through the interpolation (not the endpoints)
                result = interps[2]; // 3rd of 4 = ~75% toward jellyfish phrase
                console.log(`[MagentaJammer] Mode: INTERPOLATE (${this.jellyfishCount} jellyfish)`);

            } else {
                // ── MANY JELLYFISH: adventurous ──
                // Use similar() with lower similarity + higher temperature
                const variations = await this.mvae.similar(jellyfishPhrase, 1, 0.5, 1.4);
                result = variations[0];
                console.log(`[MagentaJammer] Mode: ADVENTUROUS (${this.jellyfishCount} jellyfish, similarity=0.5)`);
            }

            if (result?.notes?.length) {
                this.lastPhrase = result; // Save for next interpolation
                this.playSequence(result);
            }
        } catch (err) {
            console.error('[MagentaJammer] Generation error:', err);
            // Fallback: try a simple sample
            try {
                const samples = await this.mvae.sample(1, 0.8);
                if (samples[0]?.notes?.length) {
                    this.lastPhrase = samples[0];
                    this.playSequence(samples[0]);
                }
            } catch { /* give up */ }
        }

        await tf.setBackend(currentBackend);
        this.isGenerating = false;
    }

    // ── Build a phrase from recent jellyfish notes (with rhythmic variety) ──
    private buildJellyfishPhrase(): any {
        const recent = this.noteHistory.slice(-10);
        const notes: any[] = [];

        // Create a syncopated, rhythmically varied sequence
        let step = 0;
        for (let i = 0; i < recent.length && step < TOTAL_STEPS - 1; i++) {
            const pitch = clampPitch(recent[i].pitch);

            // Vary note lengths: mix of short and long
            const rand = Math.random();
            let duration: number;
            if (rand < 0.3) {
                duration = 1;       // 16th note (staccato)
            } else if (rand < 0.6) {
                duration = 2;       // 8th note
            } else if (rand < 0.85) {
                duration = 4;       // quarter note (held)
            } else {
                duration = 6;       // dotted quarter (long)
            }
            duration = Math.min(duration, TOTAL_STEPS - step);

            notes.push({
                pitch,
                quantizedStartStep: step,
                quantizedEndStep: step + duration,
            });

            // Advance with syncopated spacing (not uniform)
            const spacing = Math.random() < 0.3 ? 3 : // odd spacing for syncopation
                Math.random() < 0.5 ? 2 : 4;
            step += spacing;

            // Occasionally add a rest (skip a beat)
            if (Math.random() < 0.2) {
                step += 2;
            }
        }

        return {
            notes,
            totalQuantizedSteps: TOTAL_STEPS,
            quantizationInfo: { stepsPerQuarter: STEPS_PER_QUARTER },
        };
    }

    // ── Play a sequence on the saw synth ───────────────────────
    private playSequence(seq: any): void {
        if (!this.synth || !seq.notes) return;

        const bpm = Tone.getTransport().bpm.value || 120;
        const stepSec = 60 / bpm / STEPS_PER_QUARTER;
        const now = Tone.now() + 0.1;

        // Swing amount for groove
        const swingAmount = 0.25 * stepSec;

        let noteCount = 0;

        for (const note of seq.notes) {
            const step = note.quantizedStartStep ?? 0;
            const end = note.quantizedEndStep ?? step + 2;
            const pitch = snapToPentatonic(note.pitch);

            let startTime = now + step * stepSec;

            // Swing on odd 16th notes
            if (step % 2 === 1) {
                startTime += swingAmount;
            }

            // Humanize: ±25ms
            startTime += (Math.random() - 0.5) * 0.05;

            // Duration varies — short staccato to long held notes
            const rawDuration = (end - step) * stepSec;
            const duration = Math.max(0.08, rawDuration);
            const noteName = Tone.Frequency(pitch, 'midi').toNote();

            // Velocity with beat-position dynamics
            const isDownbeat = step % 4 === 0;
            const isUpbeat = step % 4 === 2;
            const baseVelocity = isDownbeat ? 0.75 : isUpbeat ? 0.6 : 0.45;
            // More jellyfish = louder AI
            const densityBoost = Math.min(0.15, this.jellyfishCount * 0.015);
            const velocity = baseVelocity + densityBoost + (Math.random() - 0.5) * 0.12;

            this.synth.triggerAttackRelease(
                noteName,
                duration,
                Math.max(now, startTime),
                Math.max(0.15, Math.min(1.0, velocity))
            );

            // Fire visualization callback at the moment the note plays
            if (this.onNote) {
                const delayMs = Math.max(0, (startTime - Tone.now())) * 1000;
                const cb = this.onNote;
                const n = noteName;
                const v = Math.max(0.15, Math.min(1.0, velocity));
                const d = duration;
                setTimeout(() => cb(n, v, d), delayMs);
            }

            noteCount++;
        }

        console.log(`[MagentaJammer] 🎵 Playing phrase: ${noteCount} notes (jellyfish: ${this.jellyfishCount})`);
    }

    // ── Cleanup ────────────────────────────────────────────────
    dispose(): void {
        this.stop();
        this.synth?.dispose();
        this.jamFilter?.dispose();
        this.jamLfo?.dispose();
        this.jamDelay?.dispose();
        this.jamReverb?.dispose();
        this.mvae?.dispose();
        this._ready = false;
    }
}

// ── Utility: snap MIDI pitch to nearest pentatonic note ──────
function snapToPentatonic(midi: number): number {
    const octave = Math.floor(midi / 12);
    const pc = midi % 12;
    let closest = PENTATONIC[0];
    let minDist = 12;

    for (const p of PENTATONIC) {
        const dist = Math.min(Math.abs(pc - p), 12 - Math.abs(pc - p));
        if (dist < minDist) {
            minDist = dist;
            closest = p;
        }
    }

    // Keep in a bright mid-high range (C4–C7) so it cuts through
    let result = octave * 12 + closest;
    while (result < 60) result += 12;  // C4 minimum
    while (result > 96) result -= 12;  // C7 maximum
    return result;
}

// ── Utility: clamp pitch to MusicVAE-friendly range ──────────
function clampPitch(midi: number): number {
    return Math.max(36, Math.min(84, midi));
}
