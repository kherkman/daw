// harmonizer.js
window.CustomAudioEffect = class HarmonizerEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.dry = audioCtx.createGain();
        this.wet = audioCtx.createGain();
        
        // Parametrit ja tilamuuttujat
        this.mix = 0.8;
        this.rootNote = 0; // 0 = C
        this.scaleSteps = [2, 2, 1, 2, 2, 2, 1];
        this.activeHarmonies = new Set();
        this.sensitivity = 0.5;

        // Arpeggiaattorin parametrit
        this.arpEnabled = false;
        this.arpRate = 200; // Millisekuntia per sävel
        this.arpPattern = 0; // 0=Up, 1=Down, 2=Up/Down, 3=Random

        // UI-referenssit
        this.knobs = {};
        this.uiElements = {};

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
            class HarmonizerProcessor extends AudioWorkletProcessor {
                constructor() {
                    super();
                    this.bufferSize = 8192; 
                    this.buffer = new Float32Array(this.bufferSize);
                    this.writePos = 0;
                    
                    this.detectedPitch = 0;
                    this.pitchSmoothing = 0.5;
                    this.confidenceThreshold = 0.5;
                    this.lastValidMidi = 60; 

                    this.voices = [];
                    this.windowSize = 4096;
                    
                    // Arpeggiaattorin tilamuuttujat
                    this.arpEnabled = false;
                    this.arpRateMs = 200;
                    this.arpPattern = 0;
                    this.arpStep = 0;
                    this.arpSamplesCounter = 0;
                    this.arpDirection = 1;

                    this.port.onmessage = (e) => {
                        if (e.data.type === 'updateVoices') {
                            const newVoices = e.data.voices;
                            for (let i = 0; i < newVoices.length; i++) {
                                if (this.voices[i]) {
                                    newVoices[i].phase1 = this.voices[i].phase1;
                                    newVoices[i].currentShift = this.voices[i].currentShift;
                                }
                            }
                            this.voices = newVoices;
                        }
                        if (e.data.type === 'sensitivity') {
                            this.pitchSmoothing = e.data.smoothing;
                            this.confidenceThreshold = e.data.threshold;
                        }
                        if (e.data.type === 'arp') {
                            this.arpEnabled = e.data.enabled;
                            this.arpRateMs = e.data.rate;
                            this.arpPattern = e.data.pattern;
                        }
                    };
                }

                detectPitch(inputChannel) {
                    let minDiff = Infinity;
                    let bestPeriod = 0;
                    const minPeriod = Math.floor(sampleRate / 1000); 
                    const maxPeriod = Math.floor(sampleRate / 80);   

                    for (let period = minPeriod; period < maxPeriod; period++) {
                        let diff = 0;
                        for (let i = 0; i < 512; i++) {
                            diff += Math.abs(inputChannel[i] - inputChannel[i + period]);
                        }
                        if (diff < minDiff) {
                            minDiff = diff;
                            bestPeriod = period;
                        }
                    }
                    
                    let sumSq = 0;
                    for(let i=0; i<512; i++) sumSq += inputChannel[i] * inputChannel[i];
                    const rms = Math.sqrt(sumSq / 512);
                    const confidence = rms > 0.01 ? 1.0 - (minDiff / (512 * 2)) : 0;

                    if (confidence > this.confidenceThreshold) {
                        const hz = sampleRate / bestPeriod;
                        this.detectedPitch = this.detectedPitch * this.pitchSmoothing + hz * (1 - this.pitchSmoothing);
                        return this.detectedPitch;
                    }
                    return 0; 
                }

                hzToMidi(hz) { return 69 + 12 * Math.log2(hz / 440); }

                process(inputs, outputs, parameters) {
                    const input = inputs[0];
                    const output = outputs[0];
                    if (!input || !input[0] || !output || !output[0]) return true;

                    const inChannel = input[0];
                    const outChannelL = output[0];
                    const outChannelR = output[1];
                    
                    const hz = this.detectPitch(inChannel);
                    if (hz > 0) {
                        this.lastValidMidi = Math.max(0, Math.min(127, Math.round(this.hzToMidi(hz))));
                    }

                    for (let i = 0; i < inChannel.length; i++) {
                        this.buffer[this.writePos] = inChannel[i];

                        let mixedSample = 0;
                        const voicesToProcess = [];

                        // ARPEGGIAATTORIN AJOITUS
                        if (this.arpEnabled && this.voices.length > 0) {
                            this.arpSamplesCounter++;
                            const samplesPerStep = sampleRate * (this.arpRateMs / 1000);
                            
                            if (this.arpSamplesCounter >= samplesPerStep) {
                                this.arpSamplesCounter = 0;
                                
                                // Vaihda askel järjestyksen mukaan
                                if (this.arpPattern === 0) { // Up
                                    this.arpStep = (this.arpStep + 1) % this.voices.length;
                                } else if (this.arpPattern === 1) { // Down
                                    this.arpStep = (this.arpStep - 1 + this.voices.length) % this.voices.length;
                                } else if (this.arpPattern === 2) { // Up/Down
                                    if (this.voices.length > 1) {
                                        this.arpStep += this.arpDirection;
                                        if (this.arpStep >= this.voices.length - 1) {
                                            this.arpStep = this.voices.length - 1;
                                            this.arpDirection = -1;
                                        } else if (this.arpStep <= 0) {
                                            this.arpStep = 0;
                                            this.arpDirection = 1;
                                        }
                                    } else {
                                        this.arpStep = 0;
                                    }
                                } else if (this.arpPattern === 3) { // Random
                                    this.arpStep = Math.floor(Math.random() * this.voices.length);
                                }
                            }
                            
                            // Turvaudu, jos ääniä poistetaan lennosta
                            if (this.arpStep >= this.voices.length) this.arpStep = 0;

                            // Kun Arp on päällä, käsitellään vain yhtä moottoria (ensimmäistä), 
                            // mutta lainataan sille kohdetaajuus nykyisestä arp-askeleesta.
                            const v = this.voices[0];
                            v.targetLookup = this.voices[this.arpStep].lookupTable;
                            voicesToProcess.push(v);
                        } else {
                            // Normaali moniääninen (Chord) tila
                            for (let v = 0; v < this.voices.length; v++) {
                                this.voices[v].targetLookup = this.voices[v].lookupTable;
                                voicesToProcess.push(this.voices[v]);
                            }
                        }

                        const activeCount = voicesToProcess.length;

                        for (let v = 0; v < activeCount; v++) {
                            const voice = voicesToProcess[v];

                            // Kohdesävel haetaan tilapäisestä arp-mappauksesta (tai omasta)
                            const targetShift = voice.targetLookup[this.lastValidMidi] || 0;
                            if (voice.currentShift === undefined) voice.currentShift = targetShift;
                            voice.currentShift = voice.currentShift * 0.995 + targetShift * 0.005; 

                            const ratio = Math.pow(2, voice.currentShift / 12);

                            voice.phase1 += (1 - ratio);
                            if (voice.phase1 >= this.windowSize) voice.phase1 -= this.windowSize;
                            if (voice.phase1 < 0) voice.phase1 += this.windowSize;

                            const delay1 = voice.phase1;
                            const delay2 = (voice.phase1 + this.windowSize / 2) % this.windowSize;

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

                            mixedSample += (sample1 * window1 + sample2 * window2);
                        }
                        
                        const finalOut = activeCount > 0 ? mixedSample / Math.sqrt(activeCount) : 0;
                        outChannelL[i] = finalOut;
                        if (outChannelR) outChannelR[i] = finalOut; 

                        this.writePos = (this.writePos + 1) % this.bufferSize;
                    }

                    return true;
                }
            }
            registerProcessor('harmonizer-processor', HarmonizerProcessor);
        `;

        const dataUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(workletCode);

        try {
            await this.ctx.audioWorklet.addModule(dataUrl);
            this.worklet = new AudioWorkletNode(this.ctx, 'harmonizer-processor', {
                outputChannelCount: [2]
            });
            this.input.connect(this.worklet);
            this.worklet.connect(this.wet);
            this.wet.connect(this.output);
            
            this._updateWorkletVoices();
            this._updateSensitivity();
            this._updateArp();
        } catch (e) {
            console.error("Harmonizer Worklet load failed:", e);
        }
    }

    getNodes() { return { input: this.input, output: this.output }; }
    
    _getScalePitches() {
        const pitches = [];
        let currentNote = this.rootNote; 
        let stepIndex = 0;
        
        while (currentNote < 128) {
            pitches.push(currentNote);
            currentNote += this.scaleSteps[stepIndex % this.scaleSteps.length];
            stepIndex++;
        }
        return pitches;
    }

    _updateWorkletVoices() {
        if (!this.worklet) return;
        const scalePitches = this._getScalePitches();
        const voicesData = [];

        for (const intervalStr of this.activeHarmonies) {
            const lookup = new Float32Array(128);
            
            let stepsToMove = 0;
            if (intervalStr === '0') {
                stepsToMove = 0; // Root note
            } else {
                let isOctave = intervalStr.includes('8');
                let isNegative = intervalStr.startsWith('-');
                stepsToMove = isOctave ? 7 : (parseInt(intervalStr.replace('-', '')) - 1);
                if (isNegative) stepsToMove *= -1;
            }

            for (let midi = 0; midi < 128; midi++) {
                let closestIdx = 0;
                let minDiff = Infinity;
                
                for (let i = 0; i < scalePitches.length; i++) {
                    const diff = Math.abs(scalePitches[i] - midi);
                    if (diff < minDiff) { minDiff = diff; closestIdx = i; }
                }

                let targetIdx = closestIdx + stepsToMove;
                targetIdx = Math.max(0, Math.min(scalePitches.length - 1, targetIdx));
                lookup[midi] = scalePitches[targetIdx] - midi; 
            }

            voicesData.push({
                interval: intervalStr,
                steps: stepsToMove, // Tallennetaan lajittelua varten
                lookupTable: lookup,
                phase1: 0,
                currentShift: 0
            });
        }

        // Lajitellaan äänet matalimmasta korkeimpaan, jotta arp up/down toimii loogisesti
        voicesData.sort((a, b) => a.steps - b.steps);

        this.worklet.port.postMessage({ type: 'updateVoices', voices: voicesData });
    }

    _updateSensitivity() {
        if (!this.worklet) return;
        const smoothing = 0.95 - (this.sensitivity * 0.9); 
        const threshold = 0.8 - (this.sensitivity * 0.6); 
        this.worklet.port.postMessage({ type: 'sensitivity', smoothing, threshold });
    }

    _updateArp() {
        if (!this.worklet) return;
        this.worklet.port.postMessage({ 
            type: 'arp', 
            enabled: this.arpEnabled, 
            rate: this.arpRate, 
            pattern: parseInt(this.arpPattern) 
        });
    }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            rootNote: this.rootNote,
            scaleSteps: [...this.scaleSteps],
            activeHarmonies: Array.from(this.activeHarmonies),
            sensitivity: this.sensitivity,
            mix: this.mix,
            arpEnabled: this.arpEnabled,
            arpRate: this.arpRate,
            arpPattern: this.arpPattern
        };
    }

    setState(state) {
        if (!state) return;

        if (state.mix !== undefined) {
            this.mix = state.mix;
            this.updateMix();
            if (this.knobs['mix']) this.knobs['mix'].setValue(this.mix);
        }

        if (state.sensitivity !== undefined) {
            this.sensitivity = state.sensitivity;
            this._updateSensitivity();
            if (this.knobs['sens']) this.knobs['sens'].setValue(this.sensitivity);
        }

        if (state.rootNote !== undefined) {
            this.rootNote = state.rootNote;
            if (this.uiElements.rootSelect) this.uiElements.rootSelect.value = this.rootNote;
        }

        if (state.scaleSteps !== undefined) {
            this.scaleSteps = [...state.scaleSteps];
            if (this.uiElements.scaleInput) this.uiElements.scaleInput.value = this.scaleSteps.join('');
        }

        if (state.activeHarmonies !== undefined) {
            this.activeHarmonies = new Set(state.activeHarmonies);
            if (this.uiElements.harmButtons) {
                this.uiElements.harmButtons.forEach(btn => {
                    const val = btn.getAttribute('data-val');
                    if (this.activeHarmonies.has(val)) btn.classList.add('active');
                    else btn.classList.remove('active');
                });
            }
            this._updateWorkletVoices();
        }

        if (state.arpEnabled !== undefined) {
            this.arpEnabled = state.arpEnabled;
            if (this.uiElements.arpToggle) {
                if (this.arpEnabled) {
                    this.uiElements.arpToggle.classList.add('active');
                    this.uiElements.arpToggle.innerText = 'ARP ON';
                } else {
                    this.uiElements.arpToggle.classList.remove('active');
                    this.uiElements.arpToggle.innerText = 'ARP OFF';
                }
            }
        }

        if (state.arpPattern !== undefined) {
            this.arpPattern = state.arpPattern;
            if (this.uiElements.arpPatternSelect) this.uiElements.arpPatternSelect.value = this.arpPattern;
        }

        if (state.arpRate !== undefined) {
            this.arpRate = state.arpRate;
            if (this.knobs['arpRate']) this.knobs['arpRate'].setValue(this.arpRate);
        }

        this._updateArp();
    }
    
    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const styleId = 'fx-harmonizer-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .fx-dashboard { display: flex; flex-wrap: wrap; justify-content: center; align-items: flex-start; padding: 15px 0; gap: 20px; }
                .fx-section { display: flex; flex-direction: column; align-items: center; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); }
                .knob-container { display: flex; flex-direction: column; align-items: center; user-select: none; width: 70px; }
                .knob-wrapper { position: relative; width: 50px; height: 50px; cursor: ns-resize; margin-bottom: 8px; touch-action: none; }
                .knob-svg { width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 5px rgba(255,255,255,0.1)); }
                .knob-track { fill: none; stroke: #2a2a3b; stroke-width: 8; stroke-linecap: round; }
                .knob-value-path { fill: none; stroke: var(--fx-color); stroke-width: 8; stroke-linecap: round; transition: stroke 0.2s; }
                .knob-wrapper:active .knob-value-path, .knob-wrapper:hover .knob-value-path { stroke: #fff; filter: drop-shadow(0 0 8px var(--fx-color)); }
                .knob-center { fill: #1a1a24; stroke: #333; stroke-width: 2; }
                .knob-indicator { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
                .knob-dot { position: absolute; width: 5px; height: 5px; background: var(--fx-color); border-radius: 50%; top: 5px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 8px var(--fx-color); }
                .knob-label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted, #aaa); margin-bottom: 5px; text-align: center; }
                .knob-value-display { font-size: 11px; font-family: monospace; color: #fff; background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); text-align: center; min-width: 40px; }
                .harm-input-group { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; justify-content: center; width: 100%; }
                .harm-text-input { background: #111; color: var(--fx-color); border: 1px solid #333; padding: 4px 8px; border-radius: 4px; font-family: monospace; font-size: 12px; width: 70px; text-align: center; outline: none; }
                .harm-select { background: #111; color: #fff; border: 1px solid #333; padding: 4px; border-radius: 4px; font-size: 12px; outline: none; }
                .harm-buttons-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; margin-top: 5px;}
                .harm-btn { background: #222; color: #888; border: 1px solid #333; border-radius: 4px; padding: 6px 0; font-size: 11px; font-weight: bold; cursor: pointer; transition: all 0.2s; user-select: none; width: 35px; text-align: center;}
                .harm-btn.wide { grid-column: span 2; width: auto; }
                .harm-btn.active { background: var(--fx-color); color: #000; box-shadow: 0 0 10px var(--fx-color); border-color: transparent; }
            `;
            document.head.appendChild(style);
        }

        containerElement.style.setProperty('--fx-color', '#ff3366');
        containerElement.innerHTML = `
            <div style="margin-bottom: 5px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">DIATONIC HARMONIZER</div>
            <div class="fx-dashboard" id="harm-dashboard">
                
                <div class="fx-section">
                    <div class="knob-label" style="margin-bottom: 8px;">Scale Setup</div>
                    <div class="harm-input-group">
                        <select class="harm-select" id="harm-root">
                            <option value="0">C</option><option value="1">C#</option><option value="2">D</option>
                            <option value="3">D#</option><option value="4">E</option><option value="5">F</option>
                            <option value="6">F#</option><option value="7">G</option><option value="8">G#</option>
                            <option value="9">A</option><option value="10">A#</option><option value="11">B</option>
                        </select>
                    </div>
                    <div class="harm-input-group" style="margin-bottom: 0;">
                        <input type="text" class="harm-text-input" id="harm-scale" value="2212221" maxlength="12" title="Scale Steps">
                    </div>
                </div>

                <div class="fx-section">
                    <div class="knob-label">Active Harmonies</div>
                    <div class="harm-buttons-grid" id="harm-buttons">
                        <div class="harm-btn wide" data-val="0">Root</div>
                        <div class="harm-btn" data-val="3">+3</div><div class="harm-btn" data-val="4">+4</div>
                        <div class="harm-btn" data-val="5">+5</div><div class="harm-btn" data-val="6">+6</div>
                        <div class="harm-btn" data-val="7">+7</div><div class="harm-btn" data-val="8">+8</div>
                        <div class="harm-btn" data-val="-3">-3</div><div class="harm-btn" data-val="-4">-4</div>
                        <div class="harm-btn" data-val="-5">-5</div><div class="harm-btn" data-val="-6">-6</div>
                        <div class="harm-btn" data-val="-7">-7</div><div class="harm-btn" data-val="-8">-8</div>
                    </div>
                </div>

                <div class="fx-section">
                    <div class="knob-label" style="margin-bottom: 8px;">Arpeggiator</div>
                    <div class="harm-input-group">
                        <div class="harm-btn wide" id="arp-toggle" style="padding: 6px 12px; width: 100%;">ARP OFF</div>
                    </div>
                    <div class="harm-input-group" style="margin-bottom: 0;">
                        <select class="harm-select" id="arp-pattern" style="width: 100%; text-align: center;">
                            <option value="0">Up</option>
                            <option value="1">Down</option>
                            <option value="2">Up / Down</option>
                            <option value="3">Random</option>
                        </select>
                    </div>
                </div>

                <div class="fx-section" style="flex-direction: row; gap: 10px;" id="harm-knobs">
                </div>
            </div>
        `;
        
        // Setup Bindings
        this.uiElements.rootSelect = containerElement.querySelector('#harm-root');
        this.uiElements.rootSelect.value = this.rootNote;
        this.uiElements.rootSelect.addEventListener('change', (e) => {
            this.rootNote = parseInt(e.target.value);
            this._updateWorkletVoices();
        });

        this.uiElements.scaleInput = containerElement.querySelector('#harm-scale');
        this.uiElements.scaleInput.value = this.scaleSteps.join('');
        this.uiElements.scaleInput.addEventListener('input', (e) => {
            const val = e.target.value.replace(/[^1-9]/g, '');
            if(val.length > 0) {
                this.scaleSteps = val.split('').map(Number);
                this._updateWorkletVoices();
            }
        });

        // Harmony Buttons
        this.uiElements.harmButtons = containerElement.querySelectorAll('#harm-buttons .harm-btn');
        this.uiElements.harmButtons.forEach(btn => {
            const val = btn.getAttribute('data-val');
            if (this.activeHarmonies.has(val)) btn.classList.add('active');

            btn.addEventListener('click', () => {
                if (this.activeHarmonies.has(val)) {
                    this.activeHarmonies.delete(val);
                    btn.classList.remove('active');
                } else {
                    this.activeHarmonies.add(val);
                    btn.classList.add('active');
                }
                this._updateWorkletVoices();
            });
        });

        // Arp Controls
        this.uiElements.arpToggle = containerElement.querySelector('#arp-toggle');
        if (this.arpEnabled) {
            this.uiElements.arpToggle.classList.add('active');
            this.uiElements.arpToggle.innerText = 'ARP ON';
        }
        this.uiElements.arpToggle.addEventListener('click', () => {
            this.arpEnabled = !this.arpEnabled;
            if (this.arpEnabled) {
                this.uiElements.arpToggle.classList.add('active');
                this.uiElements.arpToggle.innerText = 'ARP ON';
            } else {
                this.uiElements.arpToggle.classList.remove('active');
                this.uiElements.arpToggle.innerText = 'ARP OFF';
            }
            this._updateArp();
        });

        this.uiElements.arpPatternSelect = containerElement.querySelector('#arp-pattern');
        this.uiElements.arpPatternSelect.value = this.arpPattern;
        this.uiElements.arpPatternSelect.addEventListener('change', (e) => {
            this.arpPattern = parseInt(e.target.value);
            this._updateArp();
        });

        // Knobs
        const knobsContainer = containerElement.querySelector('#harm-knobs');

        const createKnob = (label, min, max, defaultValue, formatValue, onChange) => {
            const container = document.createElement('div');
            container.className = 'knob-container';
            const radius = 20, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            container.innerHTML = `
                <div class="knob-label">${label}</div>
                <div class="knob-wrapper">
                    <svg class="knob-svg" viewBox="0 0 50 50">
                        <circle class="knob-track" cx="25" cy="25" r="${radius}" stroke-dasharray="${maxDash} ${circumference}" />
                        <circle class="knob-value-path" cx="25" cy="25" r="${radius}" stroke-dasharray="0 ${circumference}" />
                        <circle class="knob-center" cx="25" cy="25" r="12" />
                    </svg>
                    <div class="knob-indicator"><div class="knob-dot"></div></div>
                </div>
                <div class="knob-value-display">${formatValue(defaultValue)}</div>
            `;
            
            const wrapper = container.querySelector('.knob-wrapper');
            const valuePath = container.querySelector('.knob-value-path');
            const indicator = container.querySelector('.knob-indicator');
            const display = container.querySelector('.knob-value-display');
            let currentValue = defaultValue;

            const updateUI = (value) => {
                const normalized = (value - min) / (max - min);
                valuePath.setAttribute('stroke-dasharray', `${normalized * maxDash} ${circumference}`);
                indicator.style.transform = `rotate(${-135 + (normalized * 270)}deg)`;
                display.innerText = formatValue(value);
            };
            updateUI(currentValue);
            knobsContainer.appendChild(container);

            let isDragging = false, startY = 0, startValue = 0;
            const startDrag = (y) => { isDragging = true; startY = y; startValue = currentValue; document.body.style.cursor = 'ns-resize'; };
            const doDrag = (y) => {
                if (!isDragging) return;
                let newVal = startValue + (((startY - y) / 150) * (max - min));
                newVal = Math.max(min, Math.min(max, newVal));
                if (newVal !== currentValue) { 
                    currentValue = newVal; 
                    updateUI(currentValue);
                    onChange(currentValue); 
                }
            };
            const endDrag = () => { if (isDragging) { isDragging = false; document.body.style.cursor = 'default'; } };

            wrapper.addEventListener('mousedown', (e) => startDrag(e.clientY));
            window.addEventListener('mousemove', (e) => doDrag(e.clientY));
            window.addEventListener('mouseup', endDrag);
            wrapper.addEventListener('touchstart', (e) => startDrag(e.touches[0].clientY), { passive: false });
            window.addEventListener('touchmove', (e) => { if (isDragging) { e.preventDefault(); doDrag(e.touches[0].clientY); } }, { passive: false });
            window.addEventListener('touchend', endDrag);

            return {
                setValue: (v) => {
                    currentValue = v;
                    updateUI(v);
                }
            };
        };

        this.knobs['mix'] = createKnob('Mix', 0.0, 1.0, this.mix, (v) => Math.round(v * 100) + ' %', (v) => {
            this.mix = v;
            this.updateMix();
        });
        
        this.knobs['sens'] = createKnob('Sens', 0.0, 1.0, this.sensitivity, (v) => Math.round(v * 100) + ' %', (v) => {
            this.sensitivity = v;
            this._updateSensitivity();
        });

        this.knobs['arpRate'] = createKnob('Rate', 50, 1000, this.arpRate, (v) => Math.round(v) + ' ms', (v) => {
            this.arpRate = v;
            this._updateArp();
        });
    }
}