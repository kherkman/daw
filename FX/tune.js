// tune.js
// Pitch Shifter ja Auto-Tune -efekti pianokoskettimistolla, visuaalisella vireen näytöllä ja MIDI Sidechainilla

window.CustomAudioEffect = class TuneEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.dry = audioCtx.createGain();
        this.wet = audioCtx.createGain();

        // Asetukset ja tilamuuttujat
        this.mix = 1.0;
        this.manualTune = 0; // Semitones (-12 to +12)
        this.autoTuneEnabled = false;
        
        // Sidechain MIDI asetukset
        this.scMidiEnabled = false;
        this.scMidiAmount = 1.0; // 0.0 - 1.0
        this.scMidiAttack = 20;  // ms
        this.scMidiLegato = 50;  // ms
        this.heldNotes = new Set();
        
        // Aktiiviset nuotit (Skaala). C, C#, D, D#, E, F, F#, G, G#, A, A#, B
        this.activeNotes = [true, false, true, false, true, true, false, true, false, true, false, true];

        this.detectedFreq = 0;
        this.targetFreq = 0;

        // UI-referenssit
        this.knobs = {};
        this.uiElements = {};

        // Routing
        this.input.connect(this.dry);
        this.dry.connect(this.output);
        this.updateMix();

        this._initWorklet();
    }

    updateMix() {
        this.dry.gain.setTargetAtTime(Math.cos(this.mix * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
        this.wet.gain.setTargetAtTime(Math.sin(this.mix * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
    }

    async _initWorklet() {
        const workletCode = `
            class TuneProcessor extends AudioWorkletProcessor {
                constructor() {
                    super();
                    this.bufferSize = 8192;
                    this.buffer = new Float32Array(this.bufferSize);
                    this.writePos = 0;
                    
                    this.detectedPitch = 0;
                    this.pitchSmoothing = 0.5;
                    this.confidenceThreshold = 0.3; 
                    this.currentShift = 0; 

                    this.activeNotes = [true, false, true, false, true, true, false, true, false, true, false, true];
                    this.manualTune = 0;
                    this.autoTuneEnabled = false;
                    
                    // Sidechain MIDI State
                    this.scMidiEnabled = false;
                    this.scMidiAmount = 1.0;
                    this.scMidiAttack = 20;
                    this.scMidiLegato = 50;

                    this.currentScMidiNote = -1;
                    this.smoothedTargetMidi = -1;
                    this.isMidiActive = false;
                    this.useAttack = false;

                    this.windowSize = 4096;
                    this.phase = 0;
                    this.frameCounter = 0;

                    this.port.onmessage = (e) => {
                        if (e.data.type === 'state') {
                            this.activeNotes = e.data.activeNotes;
                            this.manualTune = e.data.manualTune;
                            this.autoTuneEnabled = e.data.autoTuneEnabled;
                            
                            this.scMidiEnabled = e.data.scMidiEnabled;
                            this.scMidiAmount = e.data.scMidiAmount;
                            this.scMidiAttack = e.data.scMidiAttack;
                            this.scMidiLegato = e.data.scMidiLegato;
                        } else if (e.data.type === 'midi') {
                            const newNote = e.data.note;
                            if (newNote !== this.currentScMidiNote) {
                                if (this.currentScMidiNote === -1 && newNote !== -1) {
                                    // Uuden nuotin attack, asetetaan lähtökohdaksi laulajan sen hetkinen vire
                                    this.smoothedTargetMidi = this.hzToMidi(this.detectedPitch > 0 ? this.detectedPitch : 440);
                                    this.isMidiActive = true;
                                    this.useAttack = true;
                                } else if (newNote === -1) {
                                    // Nuotti vapautettu
                                    this.isMidiActive = false;
                                    this.useAttack = false;
                                } else {
                                    // Legato siirtymä nuotista toiseen
                                    this.useAttack = false;
                                }
                                this.currentScMidiNote = newNote;
                            }
                        }
                    };
                }

                detectPitch() {
                    let sumSq = 0;
                    for(let i = 0; i < 512; i++) {
                        let idx = (this.writePos - 1 - i + this.bufferSize) % this.bufferSize;
                        sumSq += this.buffer[idx] * this.buffer[idx];
                    }
                    const rms = Math.sqrt(sumSq / 512);

                    if (rms < 0.002) return 0; 

                    let minDiff = Infinity;
                    let bestPeriod = 0;
                    const minPeriod = Math.floor(sampleRate / 1000); 
                    const maxPeriod = Math.floor(sampleRate / 80);   

                    for (let period = minPeriod; period < maxPeriod; period++) {
                        let diff = 0;
                        for (let i = 0; i < 512; i++) {
                            let idx1 = (this.writePos - 1 - i + this.bufferSize) % this.bufferSize;
                            let idx2 = (this.writePos - 1 - i - period + this.bufferSize) % this.bufferSize;
                            diff += Math.abs(this.buffer[idx1] - this.buffer[idx2]);
                        }
                        if (diff < minDiff) {
                            minDiff = diff;
                            bestPeriod = period;
                        }
                    }
                    
                    const avgDiff = minDiff / 512;
                    const confidence = 1.0 - (avgDiff / (rms * 2.0));

                    if (confidence > this.confidenceThreshold) {
                        const hz = sampleRate / bestPeriod;
                        this.detectedPitch = this.detectedPitch * this.pitchSmoothing + hz * (1 - this.pitchSmoothing);
                        return this.detectedPitch;
                    }
                    return 0; 
                }

                hzToMidi(hz) { return 69 + 12 * Math.log2(hz / 440); }
                midiToHz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

                process(inputs, outputs, parameters) {
                    const input = inputs[0];
                    const output = outputs[0];
                    if (!input || !input[0] || !output || !output[0]) return true;

                    const inChannel = input[0];
                    const outChannelL = output[0];
                    const outChannelR = output[1];
                    
                    const hz = this.detectPitch();
                    let targetShift = this.manualTune; 
                    let targetFreqHz = 0;

                    if (hz > 0) {
                        const currentMidi = this.hzToMidi(hz);
                        
                        // Perusvireen pohjalaskenta (Auto-Tune / Manual)
                        let baseTargetMidi = currentMidi + this.manualTune;
                        
                        if (this.autoTuneEnabled) {
                            const transposedMidi = currentMidi + this.manualTune;
                            let midiInt = Math.round(transposedMidi);
                            let noteInOctave = midiInt % 12;
                            if (noteInOctave < 0) noteInOctave += 12;

                            let targetMidi = midiInt;

                            if (!this.activeNotes[noteInOctave]) {
                                let searchUp = noteInOctave;
                                let searchDown = noteInOctave;
                                for (let i = 1; i <= 6; i++) {
                                    searchUp = (searchUp + 1) % 12;
                                    searchDown = (searchDown - 1 + 12) % 12;
                                    if (this.activeNotes[searchUp]) { targetMidi = midiInt + i; break; }
                                    if (this.activeNotes[searchDown]) { targetMidi = midiInt - i; break; }
                                }
                            }
                            baseTargetMidi = targetMidi;
                        }
                        
                        let finalTargetMidi = baseTargetMidi;

                        // MIDI Sidechain pitch korjaus ja liu'utus
                        if (this.scMidiEnabled && this.isMidiActive && this.currentScMidiNote !== -1) {
                            let msTime = this.useAttack ? this.scMidiAttack : this.scMidiLegato;
                            if (msTime < 1) msTime = 1;
                            const frames = (msTime / 1000) * sampleRate;
                            const smoothAlpha = Math.pow(0.01, 1.0 / frames);

                            this.smoothedTargetMidi = this.smoothedTargetMidi * smoothAlpha + this.currentScMidiNote * (1 - smoothAlpha);
                            
                            // Blendataan MIDI targetin ja normaalin targetin välillä Amountin mukaan
                            finalTargetMidi = baseTargetMidi * (1 - this.scMidiAmount) + this.smoothedTargetMidi * this.scMidiAmount;
                            
                            if (Math.abs(this.smoothedTargetMidi - this.currentScMidiNote) < 0.1) {
                                this.useAttack = false; // Vaihdetaan legatolle kun lähellä maalia
                            }
                        }

                        targetFreqHz = this.midiToHz(finalTargetMidi);
                        targetShift = finalTargetMidi - currentMidi; 
                        
                        // Rajoitukset
                        if (targetShift > 36) targetShift = 36;
                        if (targetShift < -36) targetShift = -36;
                    }

                    this.currentShift = this.currentShift * 0.95 + targetShift * 0.05;
                    const ratio = Math.pow(2, this.currentShift / 12);

                    // Pitch Shiftaus (Time-domain)
                    for (let i = 0; i < inChannel.length; i++) {
                        this.buffer[this.writePos] = inChannel[i];

                        this.phase += (1 - ratio);
                        if (this.phase >= this.windowSize) this.phase -= this.windowSize;
                        if (this.phase < 0) this.phase += this.windowSize;

                        const delay1 = this.phase;
                        const delay2 = (this.phase + this.windowSize / 2) % this.windowSize;

                        const window1 = 0.5 - 0.5 * Math.cos(2 * Math.PI * delay1 / this.windowSize);
                        const window2 = 0.5 - 0.5 * Math.cos(2 * Math.PI * delay2 / this.windowSize);

                        let readPos1 = this.writePos - Math.floor(delay1);
                        if (readPos1 < 0) readPos1 += this.bufferSize;
                        
                        let readPos2 = this.writePos - Math.floor(delay2);
                        if (readPos2 < 0) readPos2 += this.bufferSize;

                        const frac1 = delay1 - Math.floor(delay1);
                        const s1_a = this.buffer[readPos1];
                        const s1_b = this.buffer[(readPos1 - 1 + this.bufferSize) % this.bufferSize];
                        const sample1 = s1_a + frac1 * (s1_b - s1_a);

                        const frac2 = delay2 - Math.floor(delay2);
                        const s2_a = this.buffer[readPos2];
                        const s2_b = this.buffer[(readPos2 - 1 + this.bufferSize) % this.bufferSize];
                        const sample2 = s2_a + frac2 * (s2_b - s2_a);

                        const mixedSample = (sample1 * window1 + sample2 * window2);
                        
                        outChannelL[i] = mixedSample;
                        if (outChannelR) outChannelR[i] = mixedSample; 

                        this.writePos = (this.writePos + 1) % this.bufferSize;
                    }

                    // Visuaalien päivitys
                    this.frameCounter += inChannel.length;
                    if (this.frameCounter >= 4096) {
                        this.frameCounter = 0;
                        this.port.postMessage({ type: 'visuals', hz: hz, targetHz: targetFreqHz });
                    }

                    return true;
                }
            }
            registerProcessor('tune-processor', TuneProcessor);
        `;

        const dataUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(workletCode);

        try {
            await this.ctx.audioWorklet.addModule(dataUrl);
            this.worklet = new AudioWorkletNode(this.ctx, 'tune-processor', {
                outputChannelCount: [2]
            });
            
            this.worklet.port.onmessage = (e) => {
                if (e.data.type === 'visuals') {
                    this.detectedFreq = e.data.hz;
                    this.targetFreq = e.data.targetHz;
                }
            };

            this.input.connect(this.worklet);
            this.worklet.connect(this.wet);
            this.wet.connect(this.output);
            
            this._updateWorkletState();
        } catch (e) {
            console.error("Tune Worklet load failed:", e);
        }
    }

    _updateWorkletState() {
        if (!this.worklet) return;
        this.worklet.port.postMessage({
            type: 'state',
            activeNotes: this.activeNotes,
            manualTune: this.manualTune,
            autoTuneEnabled: this.autoTuneEnabled,
            scMidiEnabled: this.scMidiEnabled,
            scMidiAmount: this.scMidiAmount,
            scMidiAttack: this.scMidiAttack,
            scMidiLegato: this.scMidiLegato
        });
    }

    _sendMidiToWorklet() {
        if (!this.worklet) return;
        let activeNote = -1;
        if (this.heldNotes.size > 0) {
            const notes = Array.from(this.heldNotes);
            activeNote = notes[notes.length - 1]; // Uusin painettu nuotti
        }
        this.worklet.port.postMessage({ type: 'midi', note: activeNote });
    }

    // Ulkoinen reititys MIDI-tapahtumille
    onMidiMessage(msg) {
        if (!msg || msg.length < 3) return;
        const status = msg[0] & 0xf0;
        const note = msg[1];
        const velocity = msg[2];

        if (status === 144 && velocity > 0) { // Note On
            this.heldNotes.add(note);
            this._sendMidiToWorklet();
        } else if (status === 128 || (status === 144 && velocity === 0)) { // Note Off
            this.heldNotes.delete(note);
            this._sendMidiToWorklet();
        }
    }

    getNodes() { return { input: this.input, output: this.output }; }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            mix: this.mix,
            manualTune: this.manualTune,
            autoTuneEnabled: this.autoTuneEnabled,
            activeNotes: [...this.activeNotes],
            scMidiEnabled: this.scMidiEnabled,
            scMidiAmount: this.scMidiAmount,
            scMidiAttack: this.scMidiAttack,
            scMidiLegato: this.scMidiLegato
        };
    }

    setState(state) {
        if (!state) return;

        if (state.autoTuneEnabled !== undefined) {
            this.autoTuneEnabled = state.autoTuneEnabled;
            if (this.uiElements.btnAutoTune) {
                this.uiElements.btnAutoTune.classList.toggle('active', this.autoTuneEnabled);
                this.uiElements.btnAutoTune.innerText = this.autoTuneEnabled ? "Auto-Tune: ON" : "Auto-Tune: OFF";
            }
        }
        
        if (state.scMidiEnabled !== undefined) {
            this.scMidiEnabled = state.scMidiEnabled;
            if (this.uiElements.btnScMidi) {
                this.uiElements.btnScMidi.classList.toggle('active', this.scMidiEnabled);
                this.uiElements.btnScMidi.innerText = this.scMidiEnabled ? "Sidechain Midi: ON" : "Sidechain Midi: OFF";
            }
        }

        if (state.activeNotes !== undefined) {
            this.activeNotes = [...state.activeNotes];
            if (this.uiElements.keys) {
                this.uiElements.keys.forEach(key => {
                    if (key) {
                        const note = parseInt(key.getAttribute('data-note'));
                        if (this.activeNotes[note]) key.classList.remove('disabled');
                        else key.classList.add('disabled');
                    }
                });
            }
        }

        if (state.manualTune !== undefined) {
            this.manualTune = state.manualTune;
            if (this.knobs['tune']) this.knobs['tune'].setValue(this.manualTune);
        }

        if (state.mix !== undefined) {
            this.mix = state.mix;
            this.updateMix();
            if (this.knobs['mix']) this.knobs['mix'].setValue(this.mix);
        }
        
        if (state.scMidiAmount !== undefined) {
            this.scMidiAmount = state.scMidiAmount;
            if (this.knobs['scAmount']) this.knobs['scAmount'].setValue(this.scMidiAmount);
        }
        
        if (state.scMidiAttack !== undefined) {
            this.scMidiAttack = state.scMidiAttack;
            if (this.knobs['scAttack']) this.knobs['scAttack'].setValue(this.scMidiAttack);
        }
        
        if (state.scMidiLegato !== undefined) {
            this.scMidiLegato = state.scMidiLegato;
            if (this.knobs['scLegato']) this.knobs['scLegato'].setValue(this.scMidiLegato);
        }

        this._updateWorkletState();
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#cc00ff';
        containerElement.style.setProperty('--fx-color', color);

        const styleId = 'fx-tune-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .tune-dashboard { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; padding: 15px 0; gap: 20px; }
                .btn-tune { background: rgba(0,0,0,0.5); border: 1px solid var(--fx-color); color: var(--fx-color); cursor: pointer; padding: 8px 15px; border-radius: 4px; font-weight: bold; font-size: 12px; text-transform: uppercase; transition: all 0.2s; }
                .btn-tune.active { background: var(--fx-color); color: #000; box-shadow: 0 0 15px var(--fx-color); }
                .piano-container { display: flex; position: relative; width: 100%; max-width: 400px; height: 100px; margin: 0 auto 15px auto; border-radius: 4px; overflow: hidden; background: #222; border: 1px solid rgba(204, 0, 255, 0.3); }
                .key-white { flex: 1; background: #eee; border: 1px solid #ccc; border-bottom-left-radius: 4px; border-bottom-right-radius: 4px; position: relative; cursor: pointer; z-index: 1; transition: background 0.1s;}
                .key-white.disabled { background: #555; border-color: #444; }
                .key-black { position: absolute; width: calc(100% / 14); height: 60%; background: #222; border: 1px solid #000; border-bottom-left-radius: 4px; border-bottom-right-radius: 4px; cursor: pointer; z-index: 2; top: 0; transition: background 0.1s;}
                .key-black.disabled { background: #111; border-color: #000;}
                .key-black:nth-child(2) { left: calc(100% / 7 * 1 - (100% / 14) / 2); }
                .key-black:nth-child(4) { left: calc(100% / 7 * 2 - (100% / 14) / 2); }
                .key-black:nth-child(7) { left: calc(100% / 7 * 4 - (100% / 14) / 2); }
                .key-black:nth-child(9) { left: calc(100% / 7 * 5 - (100% / 14) / 2); }
                .key-black:nth-child(11) { left: calc(100% / 7 * 6 - (100% / 14) / 2); }
                .knob-container { display: flex; flex-direction: column; align-items: center; user-select: none; width: 70px; }
                .knob-wrapper { position: relative; width: 60px; height: 60px; cursor: ns-resize; margin-bottom: 8px; touch-action: none; }
                .knob-svg { width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 5px rgba(204, 0, 255, 0.3)); }
                .knob-track { fill: none; stroke: #2a2a3b; stroke-width: 8; stroke-linecap: round; }
                .knob-value-path { fill: none; stroke: var(--fx-color); stroke-width: 8; stroke-linecap: round; transition: stroke 0.2s; }
                .knob-center { fill: #1a1a24; stroke: #333; stroke-width: 2; }
                .knob-indicator { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
                .knob-dot { position: absolute; width: 6px; height: 6px; background: var(--fx-color); border-radius: 50%; top: 6px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 8px var(--fx-color); }
                .knob-label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #8b8b9f; margin-bottom: 5px; text-align: center; }
                .knob-value-display { font-size: 11px; font-family: monospace; color: #fff; background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); text-align: center; min-width: 40px; }
                .btn-group { display: flex; justify-content: center; gap: 15px; margin-bottom: 15px; }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div style="margin-bottom: 15px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">VOCAL & PITCH ENGINE</div>
            
            <div class="btn-group">
                <button id="btn-autotune" class="btn-tune">${this.autoTuneEnabled ? 'Auto-Tune: ON' : 'Auto-Tune: OFF'}</button>
                <button id="btn-sc-midi" class="btn-tune">${this.scMidiEnabled ? 'Sidechain Midi: ON' : 'Sidechain Midi: OFF'}</button>
            </div>
            <div style="text-align: center; font-size: 10px; color: #8b8b9f; margin-bottom: 8px;">Scale Setup (Click keys to enable/disable notes)</div>

            <div class="piano-container" id="piano-keys">
                <div class="key-white" data-note="0"></div>
                <div class="key-black" data-note="1"></div>
                <div class="key-white" data-note="2"></div>
                <div class="key-black" data-note="3"></div>
                <div class="key-white" data-note="4"></div>
                <div class="key-white" data-note="5"></div>
                <div class="key-black" data-note="6"></div>
                <div class="key-white" data-note="7"></div>
                <div class="key-black" data-note="8"></div>
                <div class="key-white" data-note="9"></div>
                <div class="key-black" data-note="10"></div>
                <div class="key-white" data-note="11"></div>
                <canvas id="tune-canvas" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 10;"></canvas>
            </div>
            <div class="tune-dashboard" id="tune-dashboard"></div>
        `;

        const btnAutoTune = containerElement.querySelector('#btn-autotune');
        this.uiElements.btnAutoTune = btnAutoTune;
        if (this.autoTuneEnabled) btnAutoTune.classList.add('active');

        btnAutoTune.addEventListener('click', () => {
            this.autoTuneEnabled = !this.autoTuneEnabled;
            btnAutoTune.classList.toggle('active', this.autoTuneEnabled);
            btnAutoTune.innerText = this.autoTuneEnabled ? "Auto-Tune: ON" : "Auto-Tune: OFF";
            this._updateWorkletState();
        });
        
        const btnScMidi = containerElement.querySelector('#btn-sc-midi');
        this.uiElements.btnScMidi = btnScMidi;
        if (this.scMidiEnabled) btnScMidi.classList.add('active');

        btnScMidi.addEventListener('click', () => {
            this.scMidiEnabled = !this.scMidiEnabled;
            btnScMidi.classList.toggle('active', this.scMidiEnabled);
            btnScMidi.innerText = this.scMidiEnabled ? "Sidechain Midi: ON" : "Sidechain Midi: OFF";
            this._updateWorkletState();
        });

        const pianoKeys = containerElement.querySelectorAll('.key-white, .key-black');
        this.uiElements.keys = Array(12).fill(null);

        const updatePianoVisuals = () => {
            pianoKeys.forEach(key => {
                const note = parseInt(key.getAttribute('data-note'));
                if (this.activeNotes[note]) key.classList.remove('disabled');
                else key.classList.add('disabled');
            });
        };

        pianoKeys.forEach(key => {
            const noteIndex = parseInt(key.getAttribute('data-note'));
            this.uiElements.keys[noteIndex] = key;
            key.addEventListener('click', () => {
                this.activeNotes[noteIndex] = !this.activeNotes[noteIndex];
                updatePianoVisuals();
                this._updateWorkletState();
            });
        });
        updatePianoVisuals();

        const dashboard = containerElement.querySelector('#tune-dashboard');
        const canvas = containerElement.querySelector('#tune-canvas');
        const ctx2d = canvas.getContext('2d');

        const createKnob = (container, label, min, max, defaultValue, formatValue, onChange) => {
            const div = document.createElement('div');
            div.className = 'knob-container';
            const radius = 25, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            div.innerHTML = `
                <div class="knob-label">${label}</div>
                <div class="knob-wrapper">
                    <svg class="knob-svg" viewBox="0 0 60 60"><circle class="knob-track" cx="30" cy="30" r="${radius}" stroke-dasharray="${maxDash} ${circumference}" /><circle class="knob-value-path" cx="30" cy="30" r="${radius}" stroke-dasharray="0 ${circumference}" /><circle class="knob-center" cx="30" cy="30" r="16" /></svg>
                    <div class="knob-indicator"><div class="knob-dot"></div></div>
                </div>
                <div class="knob-value-display">${formatValue(defaultValue)}</div>
            `;
            const wrapper = div.querySelector('.knob-wrapper'), valuePath = div.querySelector('.knob-value-path'), indicator = div.querySelector('.knob-indicator'), display = div.querySelector('.knob-value-display');
            let currentValue = defaultValue;

            const updateUI = (value) => {
                const normalized = (value - min) / (max - min);
                valuePath.setAttribute('stroke-dasharray', `${normalized * maxDash} ${circumference}`);
                indicator.style.transform = `rotate(${-135 + (normalized * 270)}deg)`;
                display.innerText = formatValue(value);
            };
            updateUI(currentValue); container.appendChild(div);

            let isDragging = false, startY = 0, startValue = 0;
            const startDrag = (y) => { isDragging = true; startY = y; startValue = currentValue; document.body.style.cursor = 'ns-resize'; };
            const doDrag = (y) => {
                if (!isDragging) return;
                let newVal = startValue + (((startY - y) / 100) * (max - min));
                newVal = Math.max(min, Math.min(max, newVal));
                if (newVal !== currentValue) { 
                    currentValue = newVal; 
                    updateUI(currentValue); 
                    onChange(currentValue); 
                }
            };
            const endDrag = () => { if (isDragging) { isDragging = false; document.body.style.cursor = 'default'; } };

            wrapper.addEventListener('mousedown', (e) => startDrag(e.clientY)); window.addEventListener('mousemove', (e) => doDrag(e.clientY)); window.addEventListener('mouseup', endDrag);
            wrapper.addEventListener('touchstart', (e) => startDrag(e.touches[0].clientY), { passive: false }); window.addEventListener('touchmove', (e) => { if (isDragging) { e.preventDefault(); doDrag(e.touches[0].clientY); } }, { passive: false }); window.addEventListener('touchend', endDrag);

            return {
                setValue: (v) => {
                    currentValue = v;
                    updateUI(v);
                }
            };
        };

        this.knobs['tune'] = createKnob(dashboard, 'Tune', -12, 12, this.manualTune, v => (v>0?'+':'')+Math.round(v)+' st', v => {
            this.manualTune = Math.round(v);
            this._updateWorkletState();
        });
        
        this.knobs['mix'] = createKnob(dashboard, 'Mix', 0, 1.0, this.mix, v => Math.round(v*100)+'%', v => {
            this.mix = v;
            this.updateMix();
        });
        
        this.knobs['scAmount'] = createKnob(dashboard, 'Midi Amt', 0, 1.0, this.scMidiAmount, v => Math.round(v*100)+'%', v => {
            this.scMidiAmount = v;
            this._updateWorkletState();
        });
        
        this.knobs['scAttack'] = createKnob(dashboard, 'Attack', 0, 1000, this.scMidiAttack, v => Math.round(v)+' ms', v => {
            this.scMidiAttack = v;
            this._updateWorkletState();
        });
        
        this.knobs['scLegato'] = createKnob(dashboard, 'Legato', 0, 1000, this.scMidiLegato, v => Math.round(v)+' ms', v => {
            this.scMidiLegato = v;
            this._updateWorkletState();
        });

        const keyCenters = [
            0.5/7,   // 0: C
            1.0/7,   // 1: C#
            1.5/7,   // 2: D
            2.0/7,   // 3: D#
            2.5/7,   // 4: E
            3.5/7,   // 5: F  
            4.0/7,   // 6: F#
            4.5/7,   // 7: G
            5.0/7,   // 8: G#
            5.5/7,   // 9: A
            6.0/7,   // 10: A#
            6.5/7,   // 11: B
            7.5/7    // 12: C (Interpolaatio)
        ];

        let mountCheckCount = 0;
        const drawCanvas = () => {
            mountCheckCount++;
            if (!document.body.contains(canvas)) {
                if (mountCheckCount > 10) return;
                return requestAnimationFrame(drawCanvas);
            }

            const parent = canvas.parentElement;
            if (parent) {
                if (canvas.width !== parent.clientWidth) canvas.width = parent.clientWidth || 400;
                if (canvas.height !== parent.clientHeight) canvas.height = parent.clientHeight || 100;
            }

            const w = canvas.width, h = canvas.height;
            if (w === 0 || h === 0) {
                requestAnimationFrame(drawCanvas);
                return;
            }

            ctx2d.clearRect(0, 0, w, h);

            const mapFreqToX = (freq) => {
                if (freq <= 0) return -1;
                const midi = 69 + 12 * Math.log2(freq / 440);
                
                let noteFloat = midi % 12;
                if (noteFloat < 0) noteFloat += 12;

                const baseIndex = Math.floor(noteFloat);
                const fraction = noteFloat - baseIndex;

                const xMultiplier = keyCenters[baseIndex] + fraction * (keyCenters[baseIndex + 1] - keyCenters[baseIndex]);
                return xMultiplier * w;
            };

            let orgX = mapFreqToX(this.detectedFreq);
            if (orgX >= 0) {
                ctx2d.fillStyle = 'rgba(255, 0, 60, 0.4)';
                ctx2d.fillRect(orgX - 8, 0, 16, h); 
                ctx2d.fillStyle = '#ff003c';
                ctx2d.fillRect(orgX - 2, 0, 4, h);  
            }

            if (this.targetFreq > 0 && this.detectedFreq > 0) {
                let tgtX = mapFreqToX(this.targetFreq);
                if (tgtX >= 0) {
                    ctx2d.fillStyle = 'rgba(0, 255, 136, 0.8)';
                    ctx2d.fillRect(tgtX - 3, 0, 6, h); 
                }
            }

            requestAnimationFrame(drawCanvas);
        };
        drawCanvas();
    }
}