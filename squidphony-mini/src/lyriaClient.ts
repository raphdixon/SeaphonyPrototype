/**
 * Lyria Realtime Client — music generation via Google's Lyria model
 *
 * Uses @google/genai SDK's live.music.connect() for WebSocket session management.
 * Receives audio chunks as base64 PCM16 stereo @ 48kHz.
 * Decodes and schedules gapless playback through Web Audio API.
 */
import { GoogleGenAI } from '@google/genai';

// ── Configuration ──────────────────────────────────────────────
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY;
const MODEL = 'models/lyria-realtime-exp';
const SAMPLE_RATE = 48000;
const CHANNELS = 2;

// Audio buffer: accumulate chunks before playback to absorb jitter
const PRE_BUFFER_CHUNKS = 2; // wait for 2 chunks before first playback

export interface LyriaConfig {
    bpm?: number;
    density?: number;
    brightness?: number;
    scale?: string;
    temperature?: number;
}

export interface WeightedPrompt {
    text: string;
    weight: number;
}

type ConnectionState = 'disconnected' | 'connecting' | 'setup' | 'ready' | 'playing' | 'error';

export class LyriaClient {
    private client: GoogleGenAI;
    private session: any = null;
    private audioCtx: AudioContext | null = null;
    private gainNode: GainNode | null = null;
    private state: ConnectionState = 'disconnected';
    private chunkQueue: Float32Array[] = [];
    private chunksReceived = 0;
    private nextPlayTime = 0;
    private setupResolve: (() => void) | null = null;
    private sessionStartTime = 0;

    // Last-used config/prompts for session renewal
    private _lastConfig: LyriaConfig = {};
    private _lastPrompts: WeightedPrompt[] = [];

    // Status callback for UI updates
    onStatusChange: ((state: ConnectionState, msg: string) => void) | null = null;

    constructor() {
        this.client = new GoogleGenAI({
            apiKey: API_KEY,
            apiVersion: 'v1alpha',
        } as any);
    }

    get connected(): boolean {
        return this.state === 'ready' || this.state === 'playing';
    }

    get connectionState(): ConnectionState {
        return this.state;
    }

    /** Seconds since this session started playing */
    getSessionAge(): number {
        if (!this.sessionStartTime) return 0;
        return (Date.now() - this.sessionStartTime) / 1000;
    }

    /** Last-used config for session renewal */
    get lastConfig(): LyriaConfig { return this._lastConfig; }

    /** Last-used prompts for session renewal */
    get lastPrompts(): WeightedPrompt[] { return this._lastPrompts; }

    private setStatus(state: ConnectionState, msg: string): void {
        this.state = state;
        console.log(`[Lyria] ${state}: ${msg}`);
        this.onStatusChange?.(state, msg);
    }

    // ── Connect to Lyria Realtime ────────────────────────────────
    async connect(): Promise<void> {
        this.setStatus('connecting', 'Opening WebSocket…');

        // Ensure AudioContext is running
        this.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
        this.gainNode = this.audioCtx.createGain();
        this.gainNode.gain.value = 0; // Start silent — fade in after play
        this.gainNode.connect(this.audioCtx.destination);

        // Create a promise that resolves when we get the setupComplete message
        const setupCompletePromise = new Promise<void>((resolve) => {
            this.setupResolve = resolve;
        });

        try {
            this.session = await (this.client as any).live.music.connect({
                model: MODEL,
                callbacks: {
                    onmessage: (message: any) => {
                        this.handleMessage(message);
                    },
                    onerror: (error: any) => {
                        console.error('[Lyria] Session error:', error);
                        this.setStatus('error', `WebSocket error: ${error}`);
                    },
                    onclose: () => {
                        console.log('[Lyria] Session closed');
                        this.setStatus('disconnected', 'Connection closed');
                    },
                },
            });

            this.setStatus('setup', 'WebSocket open, waiting for setup acknowledgement…');

            // Wait for the server to send setupComplete before proceeding
            await Promise.race([
                setupCompletePromise,
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error('Setup timeout after 10s')), 10000)
                ),
            ]);

            this.setStatus('ready', 'Connected and ready');
        } catch (err) {
            this.setStatus('error', `Connection failed: ${err}`);
            throw err;
        }
    }

    // ── Handle incoming server messages ──────────────────────────
    private handleMessage(message: any): void {
        // Check for setupComplete (first server message)
        if (message.setupComplete !== undefined) {
            console.log('[Lyria] Setup complete received');
            this.setupResolve?.();
            this.setupResolve = null;
            return;
        }

        // Audio data
        if (message.serverContent?.audioChunks) {
            for (const chunk of message.serverContent.audioChunks) {
                if (chunk.data) {
                    this.handleAudioChunk(chunk.data);
                }
            }
        }

        // Also check the convenience accessor
        const singleChunk = message.audioChunk;
        if (singleChunk?.data && !message.serverContent?.audioChunks) {
            this.handleAudioChunk(singleChunk.data);
        }
    }

    // ── Set initial config and start playing ─────────────────────
    async startPlaying(config: LyriaConfig, prompts: WeightedPrompt[]): Promise<void> {
        if (!this.session) throw new Error('Not connected');
        if (this.state !== 'ready' && this.state !== 'playing') {
            throw new Error(`Cannot start playing in state: ${this.state}`);
        }

        // Store for renewal
        this._lastConfig = { ...config };
        this._lastPrompts = [...prompts];

        try {
            this.setStatus('playing', 'Setting prompts…');

            await this.session.setWeightedPrompts({
                weightedPrompts: prompts,
            });

            await this.session.setMusicGenerationConfig({
                musicGenerationConfig: {
                    bpm: config.bpm ?? 70,
                    temperature: config.temperature ?? 1.0,
                    scale: config.scale ?? 'C_MAJOR_A_MINOR',
                    density: config.density,
                    brightness: config.brightness,
                },
            });

            this.session.play();
            this.sessionStartTime = Date.now();

            // Fade in: silent for ~6s, then ramp to full volume by ~15s
            if (this.audioCtx && this.gainNode) {
                const t = this.audioCtx.currentTime;
                this.gainNode.gain.setValueAtTime(0, t);
                this.gainNode.gain.setValueAtTime(0, t + 6);
                this.gainNode.gain.linearRampToValueAtTime(0.7, t + 15);
            }

            this.setStatus('playing', 'Music generation started');
        } catch (err) {
            this.setStatus('error', `Failed to start: ${err}`);
            throw err;
        }
    }

    // ── Update genre weights in real-time ────────────────────────
    async updatePrompts(prompts: WeightedPrompt[]): Promise<void> {
        if (!this.session || this.state !== 'playing') return;
        this._lastPrompts = [...prompts];

        try {
            await this.session.setWeightedPrompts({
                weightedPrompts: prompts,
            });
        } catch (err) {
            console.warn('[Lyria] Failed to update prompts:', err);
        }
    }

    // ── Update config (density, brightness) ──────────────────────
    async updateConfig(config: Partial<LyriaConfig>): Promise<void> {
        if (!this.session || this.state !== 'playing') return;
        Object.assign(this._lastConfig, config);

        try {
            await this.session.setMusicGenerationConfig({
                musicGenerationConfig: {
                    bpm: config.bpm ?? 70,
                    density: config.density,
                    brightness: config.brightness,
                    scale: config.scale ?? 'C_MAJOR_A_MINOR',
                },
            });
        } catch (err) {
            console.warn('[Lyria] Failed to update config:', err);
        }
    }

    // ── Handle incoming PCM16 audio chunk ─────────────────────────
    private handleAudioChunk(base64Data: string): void {
        if (!this.audioCtx || !this.gainNode) return;

        // Decode base64 → Int16 PCM → Float32
        const binaryStr = atob(base64Data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
        }
        const int16 = new Int16Array(bytes.buffer);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 32768;
        }

        this.chunksReceived++;

        // Buffer chunks for smooth playback
        this.chunkQueue.push(float32);

        // Start scheduling once we have enough buffered
        if (this.chunksReceived >= PRE_BUFFER_CHUNKS) {
            this.scheduleBufferedChunks();
        }
    }

    // ── Schedule buffered audio for gapless playback ─────────────
    private scheduleBufferedChunks(): void {
        if (!this.audioCtx || !this.gainNode) return;

        while (this.chunkQueue.length > 0) {
            const samples = this.chunkQueue.shift()!;
            const numFrames = samples.length / CHANNELS;

            // Create an AudioBuffer (stereo, 48kHz)
            const buffer = this.audioCtx.createBuffer(CHANNELS, numFrames, SAMPLE_RATE);
            const left = buffer.getChannelData(0);
            const right = buffer.getChannelData(1);

            // Deinterleave stereo PCM
            for (let i = 0; i < numFrames; i++) {
                left[i] = samples[i * 2];
                right[i] = samples[i * 2 + 1];
            }

            // Schedule for gapless playback
            const source = this.audioCtx.createBufferSource();
            source.buffer = buffer;
            source.connect(this.gainNode);

            const now = this.audioCtx.currentTime;
            const startTime = Math.max(now + 0.01, this.nextPlayTime);
            source.start(startTime);

            this.nextPlayTime = startTime + buffer.duration;
        }
    }

    // ── Volume control ──────────────────────────────────────────
    setVolume(value: number): void {
        if (this.gainNode) {
            this.gainNode.gain.setTargetAtTime(value, this.audioCtx!.currentTime, 0.1);
        }
    }

    // ── Cleanup ──────────────────────────────────────────────────
    async stop(): Promise<void> {
        if (this.session && this.state === 'playing') {
            try {
                this.session.stop();
            } catch { /* ignore */ }
        }
        this.state = 'disconnected';
        if (this.session) {
            try { this.session.close(); } catch { /* ignore */ }
        }
        if (this.audioCtx) {
            await this.audioCtx.close();
            this.audioCtx = null;
        }
    }
}
