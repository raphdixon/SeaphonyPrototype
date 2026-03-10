import { GoogleGenAI } from "@google/genai";

/**
 * Lyria RealTime Client using @google/genai SDK
 * Connects to Google's Lyria RealTime API for AI music generation
 */

export interface WeightedPrompt {
    text: string;
    weight: number;
}

export class LyriaClient {
    private client: GoogleGenAI;
    private session: any = null; // Type as any for now due to experimental nature
    private isConnected = false;
    private contextSampleRate = 48000;
    private lastChunkTime = 0;

    public onAudioData: ((data: Float32Array) => void) | null = null;
    public onConnectionChange: ((connected: boolean) => void) | null = null;

    constructor() {
        const apiKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY || '';
        // Use v1alpha as per documentation for experimental features
        this.client = new GoogleGenAI({
            apiKey,
            apiVersion: "v1alpha"
        });
    }

    async connect(initialWeightedPrompts: WeightedPrompt[], sampleRate: number = 48000): Promise<void> {
        if (this.isConnected) return;

        try {
            console.log("Attempting to connect to Lyria with config:", {
                model: "models/lyria-realtime-exp",
                sampleRate
            });

            this.contextSampleRate = sampleRate;

            this.session = await this.client.live.music.connect({
                model: "models/lyria-realtime-exp",
                callbacks: {
                    onmessage: (message: any) => {
                        // console.log("Received message:", message); // Too verbose for audio chunks
                        this.handleMessage(message);
                    },
                    onerror: (error: any) => {
                        console.error("Lyria WebSocket Error Details:", JSON.stringify(error, null, 2));
                        this.isConnected = false;
                        this.onConnectionChange?.(false);
                    },
                    onclose: (event: any) => {
                        console.warn("Lyria Session Closed. Event:", event);
                        this.isConnected = false;
                        this.onConnectionChange?.(false);
                    },
                },
            });

            console.log("Lyria session connected");
            this.isConnected = true;
            this.onConnectionChange?.(true);

            // Set initial prompts
            await this.updateWeightedPrompts(initialWeightedPrompts);

            // Start generation
            try {
                await this.session.setMusicGenerationConfig({
                    bpm: 105,
                    temperature: 1.5, // Higher = more creative/adventurous
                    audioFormat: "pcm16",
                    sampleRateHz: 48000,
                    scale: "C_MAJOR_A_MINOR"
                });
            } catch (err) {
                console.warn("Config set failed (trying fallback):", err);
            }

            await this.session.play();
            console.log("Lyria playback started with sample rate:", sampleRate);

        } catch (error) {
            console.error("Failed to connect to Lyria:", error);
            this.isConnected = false;
            this.onConnectionChange?.(false);
            throw error;
        }
    }

    async updateWeightedPrompts(prompts: WeightedPrompt[]): Promise<void> {
        if (!this.session || !this.isConnected) return;

        try {
            await this.session.setWeightedPrompts({
                weightedPrompts: prompts
            });
            // console.log("Updated weighted prompts:", prompts);
        } catch (error) {
            console.error("Failed to update prompts:", error);
        }
    }

    private handleMessage(message: any): void {
        if (message.serverContent?.audioChunks) {
            for (const chunk of message.serverContent.audioChunks) {
                if (!chunk.data) continue;

                // Decode Base64 audio data
                // Browser compatible way without Buffer polyfill
                const binaryString = atob(chunk.data);
                const len = binaryString.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }

                // Convert PCM16 (int16) to Float32 (-1.0 to 1.0)
                const int16Data = new Int16Array(bytes.buffer);
                const float32Data = new Float32Array(int16Data.length);

                for (let i = 0; i < int16Data.length; i++) {
                    float32Data[i] = int16Data[i] / 32768.0;
                }

                // Diagnostic: Log audio chunk info
                const durationMs = (float32Data.length / 2) / 48000 * 1000; // stereo samples, so /2
                const bitrateKbps = (float32Data.length * 2 * 8) / (durationMs / 1000) / 1000; // 16-bit = 2 bytes
                console.log(`🎵 Audio chunk: ${float32Data.length} samples (${durationMs.toFixed(0)}ms stereo) | ~${bitrateKbps.toFixed(0)} kbps`);

                this.onAudioData?.(float32Data);
            }
        }
    }

    async disconnect(): Promise<void> {
        if (this.session) {
            try {
                await this.session.stop();
            } catch (e) {
                // ignore
            }
            this.session = null;
        }
        this.isConnected = false;
    }
}
