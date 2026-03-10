/**
 * AudioWorklet Processor for PCM Playback
 * Handles STEREO 16-bit PCM from Lyria RealTime
 * 
 * Lyria outputs: 48kHz, 16-bit PCM, STEREO (2 channels)
 * Data format: [L, R, L, R, L, R, ...] interleaved
 */

class PCMPlayerProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        // Ring buffer for STEREO audio
        // Lyria sends ~192,000 stereo samples per chunk = ~2 seconds per channel
        this.bufferSize = 48000 * 20; // 20 seconds buffer (10 seconds stereo)
        this.bufferL = new Float32Array(this.bufferSize);
        this.bufferR = new Float32Array(this.bufferSize);
        this.writeIndex = 0;
        this.readIndex = 0;
        this.samplesAvailable = 0;

        // Buffer thresholds for smooth playback
        this.initialBufferThreshold = 48000 * 3; // 3 seconds before first playback
        this.resumeBufferThreshold = 48000 * 2;  // 2 seconds to resume after underrun
        this.minBufferThreshold = this.initialBufferThreshold;
        this.isBuffering = true;
        this.hasStartedOnce = false;

        // Listen for audio data from main thread
        this.port.onmessage = (event) => {
            if (event.data.audioData) {
                this.addStereoSamples(event.data.audioData);
            }
        };
    }

    addStereoSamples(interleavedSamples) {
        // Input is interleaved stereo: [L, R, L, R, ...]
        const numNewFrames = interleavedSamples.length / 2;

        // precise 30ms crossfade
        const CROSSFADE_FRAMES = Math.floor(48000 * 0.03);

        // Only crossfade if we have enough data and it's not a fresh start
        let startFrame = 0;
        let framesToWrite = numNewFrames;

        if (this.samplesAvailable >= CROSSFADE_FRAMES && !this.isBuffering) {
            // Rewind write index to overlap
            let rewindIndex = (this.writeIndex - CROSSFADE_FRAMES + this.bufferSize) % this.bufferSize;

            // Perform crossfade on the overlapping region
            for (let i = 0; i < CROSSFADE_FRAMES; i++) {
                const t = i / CROSSFADE_FRAMES; // 0.0 to 1.0
                const fadeOut = 1.0 - t;
                const fadeIn = t;

                // Read existing "tail"
                const oldL = this.bufferL[rewindIndex];
                const oldR = this.bufferR[rewindIndex];

                // Read new "head"
                const newL = interleavedSamples[i * 2];
                const newR = interleavedSamples[i * 2 + 1];

                // Mix
                this.bufferL[rewindIndex] = (oldL * fadeOut) + (newL * fadeIn);
                this.bufferR[rewindIndex] = (oldR * fadeOut) + (newR * fadeIn);

                rewindIndex = (rewindIndex + 1) % this.bufferSize;
            }

            // We have consumed the first CROSSFADE_FRAMES of the new data by mixing
            // So we continue writing from there, effectively strictly appending the REST
            // The "writeIndex" is technically already at the end of the crossfaded section 
            // (because we just rewound and walked forward again).

            startFrame = CROSSFADE_FRAMES;
            framesToWrite = numNewFrames - CROSSFADE_FRAMES;

            // We don't increment samplesAvailable for the crossfaded part 
            // because we essentially replaced existing silence/data with mixed data.
            // Actually simplest mental model: we just merged 30ms. 
            // The total duration added is (New - 30ms).
            // The standard loop below will add the rest.
        }

        // Write the rest of the new frames (or all if no crossfade)
        for (let i = startFrame; i < numNewFrames; i++) {
            this.bufferL[this.writeIndex] = interleavedSamples[i * 2];
            this.bufferR[this.writeIndex] = interleavedSamples[i * 2 + 1];
            this.writeIndex = (this.writeIndex + 1) % this.bufferSize;

            if (this.samplesAvailable < this.bufferSize) {
                this.samplesAvailable++;
            } else {
                this.readIndex = (this.readIndex + 1) % this.bufferSize;
            }
        }

        // Start playing once we have enough data
        if (this.isBuffering && this.samplesAvailable >= this.minBufferThreshold) {
            this.isBuffering = false;
            if (!this.hasStartedOnce) {
                this.hasStartedOnce = true;
                // After first start, use smaller resume threshold
                this.minBufferThreshold = this.resumeBufferThreshold;
            }
        }
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0];
        const channelL = output[0];
        const channelR = output[1] || output[0]; // Fallback to mono if no R channel

        if (!channelL) return true;

        for (let i = 0; i < channelL.length; i++) {
            if (!this.isBuffering && this.samplesAvailable > 0) {
                channelL[i] = this.bufferL[this.readIndex];
                channelR[i] = this.bufferR[this.readIndex];
                this.readIndex = (this.readIndex + 1) % this.bufferSize;
                this.samplesAvailable--;
            } else {
                // No samples or buffering - output silence
                channelL[i] = 0;
                channelR[i] = 0;

                // If we ran out, go back to buffering (with hysteresis)
                if (this.samplesAvailable === 0 && !this.isBuffering) {
                    this.isBuffering = true;
                    console.log('Audio underrun - rebuffering...');
                }
            }
        }

        return true; // Keep processor alive
    }
}

registerProcessor('pcm-player-processor', PCMPlayerProcessor);
