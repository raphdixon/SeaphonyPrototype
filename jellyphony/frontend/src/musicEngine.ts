/**
 * Music Engine — Ambient music generation driven by jellyfish positions
 * 
 * Design:
 * - Row 0 (top): Arpeggios, one octave higher (C6-G6), quieter, with stereo panning
 * - Row 1-2 (middle): Ambient chords
 * - Row 3 (bottom): Bass, one octave deeper (C3-G3)
 * 
 * Notes only trigger when a squid CROSSES from one cell to another.
 */
import * as Tone from 'tone';

// Grid config
export const GRID_COLS = 4;
export const GRID_ROWS = 4;
export const TOTAL_CELLS = GRID_COLS * GRID_ROWS;

// Note mapping per row
// Row 0 (top): arpeggio mode — C5 D5 E5 G5
// Row 1: mid-low — A2 C3 D3 E3
// Row 2: chords, octave lower — roots: G2 A2 C3 D3
// Row 3 (bottom): octave lower (bass) — C2 D2 E2 G2
const NOTE_GRID: string[][] = [
    ['C5', 'D5', 'E5', 'G5'],    // Row 0 (top) — arp, quieter, panned
    ['A2', 'C3', 'D3', 'E3'],    // Row 1
    ['G3', 'A3', 'C4', 'D4'],    // Row 2 — chords
    ['C3', 'D3', 'E3', 'G3'],    // Row 3 (bottom) — bass (octave up)
];

// Chord voicings for row 2 (root + intervals in semitones)
const CHORD_VOICINGS: number[][] = [
    [0, 4, 7],       // G major
    [0, 3, 7],       // A minor
    [0, 4, 7],       // C major
    [0, 3, 7],       // D minor
];

// Arpeggio patterns for top row — expressed as PENTATONIC scale degree offsets
// (not semitone intervals!) so they always stay in key.
// 0 = root, 1 = next pentatonic note up, 2 = two up, etc.
const ARP_PATTERNS = [
    [0, 1, 2, 5],       // Root + step + step + octave
    [0, 2, 3, 4],       // Wider leap pattern
    [0, 1, 3, 5],       // Root + step + third + octave
    [0, 2, 4, 5],       // Skipping pattern
];

// Full pentatonic note table (MIDI) for arp lookups
// Covers C3 (48) to C8 (108): C D E G A in every octave
const PENTATONIC_MIDI: number[] = [];
for (let octave = 3; octave <= 8; octave++) {
    for (const pc of [0, 2, 4, 7, 9]) {
        PENTATONIC_MIDI.push(octave * 12 + pc);
    }
}

// Panning spread for top row columns: L → R
const TOP_ROW_PAN = [-0.7, -0.3, 0.3, 0.7];

// Note durations per row
const NOTE_DURATIONS: Record<number, string> = {
    0: '16n',   // Top row — short arp notes
    1: '4n',    // Middle
    2: '2n.',   // Chord row — longer sustain
    3: '2n',    // Bottom — longer sustain for bass
};

export interface CellTrigger {
    row: number;
    col: number;
    note: string;
    x: number; // normalized 0-1 center of cell
    y: number;
}

export class MusicEngine {
    // Main synth for middle rows
    private mainSynth: Tone.PolySynth | null = null;
    // Arp synth for top row — quieter
    private arpSynth: Tone.PolySynth | null = null;
    // Bass synth for bottom row
    private bassSynth: Tone.PolySynth | null = null;

    // --- Cloud Mode Custom Synths ---
    private cloudPianoSynth: Tone.PolySynth | null = null;
    private cloudChoirSynth: Tone.PolySynth | null = null;
    private cloudChoirChorus: Tone.Chorus | null = null;
    private cloudHouseSynth: Tone.PolySynth | null = null;
    private isCloudMode = false;

    // Panner for arp
    private arpPanner: Tone.Panner | null = null;
    // Effects chain
    private reverb: Tone.Reverb | null = null;
    private delay: Tone.FeedbackDelay | null = null;
    private filter: Tone.Filter | null = null;
    private _ready = false;

    get ready(): boolean {
        return this._ready;
    }

    async init(): Promise<void> {
        // === Effects chain ===

        // Reverb → destination
        this.reverb = new Tone.Reverb({
            decay: 6,
            wet: 0.6,
            preDelay: 0.1,
        }).toDestination();
        await this.reverb.generate();

        // Delay → reverb
        this.delay = new Tone.FeedbackDelay({
            delayTime: '8n.',
            feedback: 0.3,
            wet: 0.25,
        }).connect(this.reverb);

        // Low-pass filter → delay
        this.filter = new Tone.Filter({
            frequency: 2800,
            type: 'lowpass',
            rolloff: -12,
        }).connect(this.delay);

        // === Synths ===

        // Main synth (rows 1-2) — fat triangle for warm presence
        this.mainSynth = new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: 'fattriangle', spread: 0 } as any,
            envelope: {
                attack: 0.15,
                decay: 0.8,
                sustain: 0.3,
                release: 2.5,
            },
            volume: -8,
        }).connect(this.filter);
        this.mainSynth.maxPolyphony = 8;

        // Arp synth (row 0) — soft sine, dedicated LPF to kill click transients
        const arpFilter = new Tone.Filter({
            frequency: 3000,
            type: 'lowpass',
            rolloff: -24,
        }).connect(this.filter);
        this.arpPanner = new Tone.Panner(0).connect(arpFilter);
        this.arpSynth = new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: 'sine' },
            envelope: {
                attack: 0.08,
                decay: 0.4,
                sustain: 0.1,
                release: 1.2,
            },
            volume: -20,
        }).connect(this.arpPanner);
        this.arpSynth.maxPolyphony = 6;

        // Bass synth (row 3) — deep, warm
        this.bassSynth = new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: 'sine' },
            envelope: {
                attack: 0.3,
                decay: 1.2,
                sustain: 0.5,
                release: 3.0,
            },
            volume: -10,
        }).connect(this.filter);
        this.bassSynth.maxPolyphony = 4;

        // === Cloud Mode Synths ===
        // Piano-like synth (FM Synth for glassy, plucked tone)
        this.cloudPianoSynth = new Tone.PolySynth(Tone.FMSynth, {
            harmonicity: 2.0,
            modulationIndex: 1.5,
            oscillator: { type: 'sine' },
            modulation: { type: 'sine' },
            envelope: {
                attack: 0.01,
                decay: 0.8,
                sustain: 0.2,
                release: 1.5,
            },
            modulationEnvelope: {
                attack: 0.02,
                decay: 0.4,
                sustain: 0,
                release: 0.5,
            },
            volume: -14,
        }).connect(this.delay); // Plucked sounds sound great through delay
        this.cloudPianoSynth.maxPolyphony = 6;

        // Classic Digital FM Choir Patch
        // Use a wide Chorus effect to emulate multiple singers
        this.cloudChoirChorus = new Tone.Chorus({
            frequency: 1.5,
            delayTime: 3.5,
            depth: 0.7,
            wet: 0.8,
        }).connect(this.reverb);
        this.cloudChoirChorus.start();

        this.cloudChoirSynth = new Tone.PolySynth(Tone.FMSynth, {
            harmonicity: 3.01, // Irregular harmonicity for breathy, vocal-like formants
            modulationIndex: 3.5,
            oscillator: { type: 'triangle' }, // Warm fundamental "Ooh"
            modulation: { type: 'square' },   // Adds the breathy "Ahh" fizz at the top
            envelope: {
                attack: 1.2,    // Slow, vocal swell
                decay: 2.0,
                sustain: 0.8,
                release: 5.0,   // Lingering breath
            },
            modulationEnvelope: {
                attack: 0.8,
                decay: 1.5,
                sustain: 0.4,
                release: 3.0,
            },
            volume: -14, // Brought up +6dB as requested
        }).connect(this.cloudChoirChorus);
        this.cloudChoirSynth.maxPolyphony = 6;

        // Classic Deep House chord synth (Top Left Quadrant)
        this.cloudHouseSynth = new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: 'fatsine', spread: 30 } as any, // Less bright, sine-based, wider spread
            envelope: {
                attack: 0.05,
                decay: 0.6,
                sustain: 0.3, // Punchy decay
                release: 1.5,
            },
            volume: -10, // Bring up slightly since sine stands out less than square
        }).connect(this.delay); // Dubby delay trails
        this.cloudHouseSynth.maxPolyphony = 12; // High polyphony for thick 4/5-note chords

        this._ready = true;
        console.log('[MusicEngine] Initialized');
    }

    // ── Evolving Synth Parameters ─────────────────────────────────
    private evolveLfo: Tone.LFO | null = null;
    private evolveLfo2: Tone.LFO | null = null;
    private evolveLfo3: Tone.LFO | null = null;

    enableEvolvingSynth(): void {
        if (!this.filter || !this.mainSynth || !this.delay) return;

        // Slow LFO 1: modulate filter cutoff 1500 ↔ 3500 Hz (~50s cycle)
        // Min at 1500 Hz ensures notes always remain audible
        this.evolveLfo = new Tone.LFO({
            frequency: 0.02,
            min: 1500,
            max: 3500,
            type: 'sine',
        }).start();
        this.evolveLfo.connect(this.filter.frequency);

        // Slow LFO 2: modulate delay feedback 0.15 ↔ 0.45 (~73s cycle, prime offset)
        this.evolveLfo2 = new Tone.LFO({
            frequency: 0.0137,
            min: 0.15,
            max: 0.45,
            type: 'sine',
        }).start();
        this.evolveLfo2.connect(this.delay.feedback);

        // Slow LFO 3: modulate fat oscillator spread 0 ↔ 20 cents (~90s cycle)
        // Creates gradual tonal evolution: pure sine → warm detuned unison → back
        this.evolveLfo3 = new Tone.LFO({
            frequency: 0.011,
            min: 0,
            max: 20,
            type: 'sine',
        }).start();
        // Apply spread modulation to all voices in the PolySynth
        const voices = (this.mainSynth as any)._voices;
        if (voices) {
            for (const voice of voices) {
                const osc = voice.oscillator;
                if (osc && osc.spread !== undefined) {
                    this.evolveLfo3.connect(osc.spread);
                }
            }
        }

        console.log('[MusicEngine] Evolving synth parameters enabled (filter + delay + oscillator drift)');
    }

    /**
     * Shorten releases and lower squid note volume for Cloud mode,
     * where Lyria's output is the primary audio.
     */
    setCloudMode(): void {
        // Shorten sustain & release on all synths
        this.mainSynth?.set({ envelope: { sustain: 0.15, release: 1.0 } });
        this.arpSynth?.set({ envelope: { sustain: 0.05, release: 0.5 } });
        this.bassSynth?.set({ envelope: { sustain: 0.25, release: 1.5 } });

        // Raise volume but still sit under Lyria
        this.mainSynth?.set({ volume: -12 });
        this.arpSynth?.set({ volume: -18 });
        this.bassSynth?.set({ volume: -10 });

        this.isCloudMode = true;

        console.log('[MusicEngine] Cloud mode: custom piano/choir enabled, shorter release');
    }

    async start(): Promise<void> {
        await Tone.start();
        Tone.getTransport().bpm.value = 70;
        Tone.getTransport().start();
        console.log('[MusicEngine] Audio context started');
    }

    /**
     * Trigger a note for a specific cell. Called only on cell transitions.
     * Returns trigger info if a note was played.
     */
    triggerCell(row: number, col: number): CellTrigger | null {
        if (!this._ready) return null;

        const note = NOTE_GRID[row][col];
        const humanize = Math.random() * 0.03;
        const now = Tone.now() + humanize;
        const duration = NOTE_DURATIONS[row] || '4n';

        if (this.isCloudMode && row <= 1 && col <= 1) {
            // === CLOUD MODE: Top-Left Quadrant -> Deep House Chords ===
            // Classic minor key house chord progressions (9ths and 11ths), strictly in A minor
            const houseProgressions = [
                ['A3', 'C4', 'E4', 'G4', 'B4'], // Amin9 (i)
                ['F3', 'A3', 'C4', 'E4', 'G4'], // Fmaj9 (VI)
                ['D3', 'F3', 'A3', 'C4', 'E4'], // Dmin9 (iv)
                ['E3', 'G3', 'B3', 'D4', 'F4'], // Emin7(b9) (v) - keeping F natural for A minor scale
                ['G3', 'B3', 'D4', 'F4', 'A4']  // Gdom9 (VII)
            ];

            // Randomly pick a chord voicing
            const chord = houseProgressions[Math.floor(Math.random() * houseProgressions.length)];
            const velocity = 0.35 + Math.random() * 0.15;
            this.cloudHouseSynth?.triggerAttackRelease(chord, duration, now, velocity);

        } else if (row === 0) {
            // === TOP ROW: Arpeggiated, panned, quiet ===
            this.playArpeggio(col, now);
        } else if (this.isCloudMode && row >= 2) {
            // === CLOUD MODE: Custom Bottom Quadrants ===
            if (col <= 1) {
                // Bottom-Left (Cols 0,1) -> Piano (+2 Octaves)
                const transposedNote = Tone.Frequency(note).transpose(24).toNote();
                const velocity = 0.4 + Math.random() * 0.2;
                this.cloudPianoSynth?.triggerAttackRelease(transposedNote, duration, now, velocity);
            } else {
                // Bottom-Right (Cols 2,3) -> Choral Choir (+1 Octave)
                const transposedNote = Tone.Frequency(note).transpose(12).toNote();
                const velocity = 0.3 + Math.random() * 0.1;
                // Use longer duration/swell for choir
                this.cloudChoirSynth?.triggerAttackRelease(transposedNote, NOTE_DURATIONS[2], now, velocity);
            }
        } else if (row === 2) {
            // === ROW 2: Chords, octave lower ===
            this.playChord(col, now, duration);
        } else if (row === 3) {
            // === BOTTOM ROW: Deep bass ===
            const velocity = 0.35 + Math.random() * 0.15;
            this.bassSynth?.triggerAttackRelease(note, duration, now, velocity);
        } else {
            // === ROW 1: Ambient single notes ===
            const velocity = 0.3 + (1 - (row / GRID_ROWS)) * 0.3;
            this.mainSynth?.triggerAttackRelease(note, duration, now, velocity);
        }

        return {
            row, col, note,
            x: (col + 0.5) / GRID_COLS,
            y: (row + 0.5) / GRID_ROWS,
        };
    }

    /**
     * Play an arpeggiated pattern for top row
     */
    private playArpeggio(col: number, startTime: number): void {
        if (!this.arpSynth || !this.arpPanner) return;

        // Set stereo panning based on column
        this.arpPanner.pan.rampTo(TOP_ROW_PAN[col], 0.05);

        const baseNote = NOTE_GRID[0][col];
        const baseMidi = Tone.Frequency(baseNote).toMidi();

        // Find this note's position in the pentatonic table
        let baseIdx = PENTATONIC_MIDI.indexOf(baseMidi);
        if (baseIdx === -1) {
            // Snap to nearest pentatonic note
            baseIdx = PENTATONIC_MIDI.reduce(
                (best, midi, i) => Math.abs(midi - baseMidi) < Math.abs(PENTATONIC_MIDI[best] - baseMidi) ? i : best,
                0
            );
        }

        // Pick an arp pattern (scale degree offsets)
        const pattern = ARP_PATTERNS[col % ARP_PATTERNS.length];
        const eighthDuration = Tone.Time('16n').toSeconds();

        // Play the arp notes — each offset indexes into the pentatonic table
        for (let i = 0; i < pattern.length; i++) {
            const noteIdx = Math.min(baseIdx + pattern[i], PENTATONIC_MIDI.length - 1);
            const arpNote = Tone.Frequency(PENTATONIC_MIDI[noteIdx], 'midi').toNote();
            const time = startTime + i * eighthDuration;
            const velocity = 0.2 + (i === 0 ? 0.1 : 0) - (i * 0.02);

            this.arpSynth.triggerAttackRelease(arpNote, '32n', time, Math.max(0.08, velocity));
        }
    }

    /**
     * Play a chord for row 2
     */
    private playChord(col: number, startTime: number, duration: string): void {
        if (!this.mainSynth) return;

        const rootNote = NOTE_GRID[2][col];
        const rootFreq = Tone.Frequency(rootNote).toFrequency();
        const voicing = CHORD_VOICINGS[col % CHORD_VOICINGS.length];
        const velocity = 0.25 + Math.random() * 0.1;

        // Play all chord notes simultaneously
        const chordNotes = voicing.map((interval) => {
            const freq = rootFreq * Math.pow(2, interval / 12);
            return Tone.Frequency(freq).toNote();
        });

        this.mainSynth.triggerAttackRelease(chordNotes, duration, startTime, velocity);
    }

    /**
     * Get the note name for a specific grid cell
     */
    getNoteForCell(row: number, col: number): string {
        return NOTE_GRID[row]?.[col] ?? '';
    }

    /**
     * Get which cell a position maps to
     */
    static positionToCell(x: number, y: number): { row: number; col: number } {
        return {
            col: Math.min(GRID_COLS - 1, Math.floor(x * GRID_COLS)),
            row: Math.min(GRID_ROWS - 1, Math.floor(y * GRID_ROWS)),
        };
    }

    dispose(): void {
        this.evolveLfo?.dispose();
        this.evolveLfo2?.dispose();
        this.evolveLfo3?.dispose();
        this.mainSynth?.dispose();
        this.arpSynth?.dispose();
        this.bassSynth?.dispose();
        this.cloudPianoSynth?.dispose();
        this.cloudChoirSynth?.dispose();
        this.cloudChoirChorus?.dispose();
        this.cloudHouseSynth?.dispose();
        this.arpPanner?.dispose();
        this.reverb?.dispose();
        this.delay?.dispose();
        this.filter?.dispose();
        this._ready = false;
    }
}
