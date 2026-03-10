/**
 * Lyria Realtime Client — music generation via Google's Lyria model
 *
 * Connects to a Cloudflare Worker WebSocket proxy that relays to Google's
 * Lyria API. The API key is injected server-side by the proxy, never exposed
 * to the client.
 *
 * Receives audio chunks as base64 PCM16 stereo @ 48kHz.
 * Decodes and schedules gapless playback through Web Audio API.
 */

// ── Configuration ──────────────────────────────────────────────
const PROXY_URL = import.meta.env.VITE_LYRIA_PROXY_URL || 'http://localhost:8787';
const MODEL = 'models/lyria-realtime-exp';
const SAMPLE_RATE = 48000;
const CHANNELS = 2;

// Audio buffer: accumulate chunks before playback to absorb jitter
const PRE_BUFFER_CHUNKS = 8; // buffer more chunks to absorb proxy jitter

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
    private ws: WebSocket | null = null;
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

    // ── Connect to Lyria via proxy ──────────────────────────────
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
            // Build the proxy WebSocket URL
            const proxyBase = PROXY_URL.replace(/^http/, 'ws');
            const wsUrl = `${proxyBase}/ws`;

            this.ws = new WebSocket(wsUrl);

            // Wait for the WebSocket to open
            await new Promise<void>((resolve, reject) => {
                this.ws!.addEventListener('open', () => resolve(), { once: true });
                this.ws!.addEventListener('error', () => reject(new Error('WebSocket open failed')), { once: true });
            });

            // Set up message handler
            this.ws.addEventListener('message', (event) => {
                this.handleMessage(event);
            });

            this.ws.addEventListener('error', (event) => {
                console.error('[Lyria] Session error:', event);
                this.setStatus('error', 'WebSocket error');
            });

            this.ws.addEventListener('close', () => {
                console.log('[Lyria] Session closed');
                this.setStatus('disconnected', 'Connection closed');
            });

            // Send the setup message (same format as the SDK)
            const setup = { model: MODEL };
            this.ws.send(JSON.stringify({ setup }));

            this.setStatus('setup', 'WebSocket open, waiting for setup acknowledgement…');

            // Wait for server setupComplete
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
    private async handleMessage(event: MessageEvent): Promise<void> {
        let data: any;
        try {
            if (event.data instanceof Blob) {
                data = JSON.parse(await event.data.text());
            } else if (event.data instanceof ArrayBuffer) {
                data = JSON.parse(new TextDecoder().decode(event.data));
            } else if (typeof event.data === 'string') {
                data = JSON.parse(event.data);
            } else {
                console.warn('[Lyria] Unknown message type:', typeof event.data);
                return;
            }
        } catch (e) {
            console.warn('[Lyria] Failed to parse message:', e);
            return;
        }

        // Check for setupComplete (first server message)
        if (data.setupComplete !== undefined) {
            console.log('[Lyria] Setup complete received');
            this.setupResolve?.();
            this.setupResolve = null;
            return;
        }

        // Audio data
        if (data.serverContent?.audioChunks) {
            for (const chunk of data.serverContent.audioChunks) {
                if (chunk.data) {
                    this.handleAudioChunk(chunk.data);
                }
            }
        }

        // Also check the convenience accessor pattern
        const singleChunk = data.audioChunk;
        if (singleChunk?.data && !data.serverContent?.audioChunks) {
            this.handleAudioChunk(singleChunk.data);
        }
    }

    // ── Set initial config and start playing ─────────────────────
    async startPlaying(config: LyriaConfig, prompts: WeightedPrompt[]): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Not connected');
        if (this.state !== 'ready' && this.state !== 'playing') {
            throw new Error(`Cannot start playing in state: ${this.state}`);
        }

        // Store for renewal
        this._lastConfig = { ...config };
        this._lastPrompts = [...prompts];

        try {
            this.setStatus('playing', 'Setting prompts…');

            // Send weighted prompts
            this.ws.send(JSON.stringify({
                clientContent: {
                    weightedPrompts: prompts,
                },
            }));

            // Send music generation config
            this.ws.send(JSON.stringify({
                musicGenerationConfig: {
                    temperature: config.temperature ?? 1.0,
                    scale: config.scale ?? 'C_MAJOR_A_MINOR',
                    density: config.density,
                    brightness: config.brightness,
                },
            }));

            // Send play command
            this.ws.send(JSON.stringify({ playbackControl: 'PLAY' }));
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
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.state !== 'playing') return;
        this._lastPrompts = [...prompts];

        try {
            this.ws.send(JSON.stringify({
                clientContent: {
                    weightedPrompts: prompts,
                },
            }));
        } catch (err) {
            console.warn('[Lyria] Failed to update prompts:', err);
        }
    }

    // ── Update config (density, brightness) ──────────────────────
    async updateConfig(config: Partial<LyriaConfig>): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.state !== 'playing') return;
        Object.assign(this._lastConfig, config);

        try {
            this.ws.send(JSON.stringify({
                musicGenerationConfig: {
                    density: config.density,
                    brightness: config.brightness,
                    scale: config.scale ?? 'C_MAJOR_A_MINOR',
                },
            }));
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
        if (this.ws && this.ws.readyState === WebSocket.OPEN && this.state === 'playing') {
            try {
                this.ws.send(JSON.stringify({ playbackControl: 'STOP' }));
            } catch { /* ignore */ }
        }
        this.state = 'disconnected';
        if (this.ws) {
            try { this.ws.close(); } catch { /* ignore */ }
            this.ws = null;
        }
        if (this.audioCtx) {
            await this.audioCtx.close();
            this.audioCtx = null;
        }
    }
}
