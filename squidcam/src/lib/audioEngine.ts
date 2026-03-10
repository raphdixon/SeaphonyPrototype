/**
 * Audio Engine using Web Audio API
 * Handles PCM audio playback from Lyria via AudioWorklet
 */

export class AudioEngine {
    private audioContext: AudioContext | null = null;
    private workletNode: AudioWorkletNode | null = null;
    private isInitialized = false;

    async init(): Promise<void> {
        if (this.isInitialized) return;

        try {
            this.audioContext = new AudioContext({
                sampleRate: 48000,
                latencyHint: 'playback' // Critical for quality: prevents "voice" processing
            });

            console.log(`AudioEngine created. LatencyHint: playback, SampleRate: ${this.audioContext.sampleRate}`);
            console.log(`Output Channels: ${this.audioContext.destination.channelCount}, Max: ${this.audioContext.destination.maxChannelCount}`);

            // Register the audio worklet processor with cache busting
            await this.audioContext.audioWorklet.addModule(`/audio-worklet.js?t=${Date.now()}`);

            // Create worklet node with explicit stereo output
            this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-player-processor', {
                outputChannelCount: [2]
            });
            this.workletNode.connect(this.audioContext.destination);

            this.isInitialized = true;
            console.log(`AudioEngine initialized. Requested: 48000Hz, Actual: ${this.audioContext.sampleRate}Hz`);
        } catch (error) {
            console.error('Failed to initialize AudioEngine:', error);
            throw error;
        }
    }

    async start(): Promise<void> {
        if (!this.audioContext) return;

        // Resume context (required for user gesture)
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        console.log('AudioEngine started');
    }

    getSampleRate(): number {
        return this.audioContext?.sampleRate || 48000;
    }

    feedAudio(pcmData: Float32Array): void {
        if (!this.workletNode) return;

        // Send audio data to worklet processor via message port
        this.workletNode.port.postMessage({ audioData: pcmData });
    }

    close(): void {
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.isInitialized = false;
    }
}
