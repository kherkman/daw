// midi-isomorphichex.js
// Ääniohjattu Heksagonaalinen Isomorfinen Koskettimisto - MIDI-ohjaus tuki DAW/Host laitteista.
// Toimii myös MIDI-ohjaimena (Pitch-to-MIDI) ilman ladattua WAV-samplea.

window.CustomAudioEffect = class AudioIsomorphicHexEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.dry = audioCtx.createGain();
        this.wet = audioCtx.createGain();

        this.input.connect(this.dry);
        this.dry.connect(this.output);
        this.wet.connect(this.output);
        this.wet.connect(this.ctx.destination); // Reititys kaiuttimiin hostista riippumatta

        this.mix = 1.0; 
        this.sensitivity = 0.5;
        
        this.sampleBuffer = null;
        this.baseMidi = 60; // C4 (Samplen pohjanuotti)
        this.activeVoices = new Map();
        
        this.tuning = new Map();
        this.initDefaultTuning();

        this.knobs = {};
        this.uiElements = {};
        this.hexElements = {}; // Map: midi-nuotti -> array DOM elementtejä

        // Hexagonal Grid State
        this.gridVisible = false;
        this.rows = 4;
        this.cols = 11;
        
        // Oletus: Wicki-Hayden layout (X = M2, Y = P4)
        this.xInterval = 2; // Vaakasuunta: Kokosävelaskel
        this.yInterval = 5; // Viisto ylä-oikea: Kvartti
        
        this.virtualBaseMidi = 48; // Vasemman alakulman nuotti (C3)
        
        this.currentKeyMap = {};
        this.pressedKeys = {};

        // QWERTY-näppäinrivit alhaalta ylös (porrastus sopii hex-ruudukkoon)
        this.qwertyRows = [
            ['<','z','x','c','v','b','n','m',',','.','/'], // Neljäs rivi (alin)
            ['a','s','d','f','g','h','j','k','l',';',"'"], // Kolmas rivi
            ['q','w','e','r','t','y','u','i','o','p','['], // Toinen rivi
            ['2','3','4','5','6','7','8','9','0','-','=']  // Ylin rivi
        ];

        this.updateMix();
        this._initWorklet();
        this.initKeyboardListeners();
        this.loadDefaultSample();
    }

    async loadDefaultSample() {
        try {
            const response = await fetch('PianoC4.wav');
            if (!response.ok) {
                console.warn('PianoC4.wav not found, loading from root failed');
                return;
            }
            const arrayBuffer = await response.arrayBuffer();
            this.pianoBuffer = await this.ctx.decodeAudioData(arrayBuffer);
            console.log('PianoC4.wav loaded successfully!');
            if (this.uiElements.loadBtn) {
                this.uiElements.loadBtn.classList.add('active');
                this.uiElements.loadBtn.innerText = "WAV LOADED";
            }
        } catch (e) {
            console.error("Failed to load default PianoC4.wav:", e);
        }
    }

    // --- MIDI-OHJAUS (DAW / HOST SISÄÄN) ---
    onMidi(msg) {
        if (typeof this.onMidiOut === 'function') this.onMidiOut(msg);

        const status = msg[0] & 0xF0;
        const note = msg[1];
        const velocity = msg[2];

        if (status === 0x90 && velocity > 0) {
            this.noteOn(note, velocity, true);
        } else if (status === 0x80 || (status === 0x90 && velocity === 0)) {
            this.noteOff(note, true);
        }
    }

    initDefaultTuning() {
        for (let i = 21; i <= 108; i++) this.tuning.set(i, this.calcDefaultHz(i));
    }

    calcDefaultHz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

    midiToNoteName(midi) {
        const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
        return `${notes[midi % 12]}${Math.floor(midi / 12) - 1}`;
    }

    noteNameToMidi(name) {
        const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
        const match = name.match(/([A-G]#?)(-?\d+)/);
        if (!match) return -1;
        const note = match[1];
        const octave = parseInt(match[2]);
        const noteIndex = notes.indexOf(note);
        if (noteIndex === -1) return -1;
        return (octave + 1) * 12 + noteIndex;
    }

    updateMix() {
        this.dry.gain.setTargetAtTime(Math.cos(this.mix * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
        this.wet.gain.setTargetAtTime(Math.sin(this.mix * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
    }

    killAllNotes() {
        this.activeVoices.forEach((voice, note) => {
            try {
                voice.vca.gain.cancelScheduledValues(this.ctx.currentTime);
                voice.vca.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
                voice.source.stop(this.ctx.currentTime + 0.1);
            } catch (e) { }
            this.updateHexUI(note, false);
            const outFunc = this.sendMidi || this.onMidiOut;
            if (typeof outFunc === 'function') outFunc.call(this, [0x80, note, 0]);
        });
        this.activeVoices.clear();
        this.pressedKeys = {};
        
        if (this.worklet) this.worklet.port.postMessage({ type: 'panic' });
    }

    async _initWorklet() {
        const workletCode = `
            class AudioPianoProcessor extends AudioWorkletProcessor {
                constructor() {
                    super();
                    this.bufferSize = 8192;
                    this.buffer = new Float32Array(this.bufferSize);
                    this.writePos = 0;
                    this.currentNote = -1;
                    this.stableFrames = 0;
                    this.silenceFrames = 0;
                    this.confidenceThreshold = 0.5;
                    this.rmsThreshold = 0.01;
                    this.requiredStableFrames = 4;

                    this.port.onmessage = (e) => {
                        if (e.data.type === 'panic') {
                            this.currentNote = -1;
                            this.stableFrames = 0;
                            this.silenceFrames = 0;
                            this.buffer.fill(0);
                        } else if (e.data.type === 'sensitivity') {
                            const sens = e.data.value; 
                            this.rmsThreshold = 0.001 + (1.0 - sens) * 0.02;
                            this.requiredStableFrames = Math.max(1, Math.floor(5 - (sens * 4)));
                            this.confidenceThreshold = 0.6 - (sens * 0.3);
                        }
                    };
                }

                detectPitch() {
                    let sumSq = 0;
                    for(let i = 0; i < 1024; i++) {
                        let idx = (this.writePos - 1 - i + this.bufferSize) % this.bufferSize;
                        sumSq += this.buffer[idx] * this.buffer[idx];
                    }
                    const rms = Math.sqrt(sumSq / 1024);
                    if (rms < this.rmsThreshold) return { hz: 0, rms }; 

                    let minDiff = Infinity;
                    let bestPeriod = 0;
                    const minPeriod = Math.floor(sampleRate / 4186); 
                    const maxPeriod = Math.floor(sampleRate / 27);   

                    for (let period = minPeriod; period < maxPeriod; period++) {
                        let diff = 0;
                        for (let i = 0; i < 512; i++) {
                            let idx1 = (this.writePos - 1 - i + this.bufferSize) % this.bufferSize;
                            let idx2 = (this.writePos - 1 - i - period + this.bufferSize) % this.bufferSize;
                            diff += Math.abs(this.buffer[idx1] - this.buffer[idx2]);
                        }
                        if (diff < minDiff) { minDiff = diff; bestPeriod = period; }
                    }
                    
                    const avgDiff = minDiff / 512;
                    const confidence = 1.0 - (avgDiff / (rms * 2.0));

                    if (confidence > this.confidenceThreshold) return { hz: sampleRate / bestPeriod, rms };
                    return { hz: 0, rms };
                }

                hzToMidi(hz) { return 69 + 12 * Math.log2(hz / 440); }

                process(inputs, outputs) {
                    const input = inputs[0];
                    if (!input || !input.length || !input[0]) {
                        if (this.currentNote !== -1) {
                            this.port.postMessage({ type: 'midi', action: 'noteOff', note: this.currentNote });
                            this.currentNote = -1;
                        }
                        return true;
                    }

                    const inChannel = input[0];
                    for (let i = 0; i < inChannel.length; i++) {
                        this.buffer[this.writePos] = inChannel[i];
                        this.writePos = (this.writePos + 1) % this.bufferSize;
                    }

                    const { hz, rms } = this.detectPitch();

                    if (hz > 0) {
                        this.silenceFrames = 0;
                        const targetMidi = Math.round(this.hzToMidi(hz));
                        
                        if (targetMidi !== this.currentNote && targetMidi >= 21 && targetMidi <= 108) {
                            this.stableFrames++;
                            if (this.stableFrames >= this.requiredStableFrames) { 
                                if (this.currentNote !== -1) {
                                    this.port.postMessage({ type: 'midi', action: 'noteOff', note: this.currentNote });
                                }
                                const rawVel = Math.pow(rms * 15, 0.7) * 127;
                                const velocity = Math.min(127, Math.max(10, Math.floor(rawVel)));
                                
                                this.port.postMessage({ type: 'midi', action: 'noteOn', note: targetMidi, velocity: velocity });
                                this.currentNote = targetMidi;
                                this.stableFrames = 0;
                            }
                        } else {
                            this.stableFrames = 0;
                        }
                    } else {
                        this.silenceFrames++;
                        this.stableFrames = 0;
                        if (this.silenceFrames >= 3 && this.currentNote !== -1) {
                            this.port.postMessage({ type: 'midi', action: 'noteOff', note: this.currentNote });
                            this.currentNote = -1;
                        }
                    }
                    return true;
                }
            }
            registerProcessor('isomorphic-hex-processor', AudioPianoProcessor);
        `;

        const dataUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(workletCode);
        try {
            await this.ctx.audioWorklet.addModule(dataUrl);
            this.worklet = new AudioWorkletNode(this.ctx, 'isomorphic-hex-processor');
            this.worklet.port.onmessage = (e) => {
                if (e.data.type === 'midi') {
                    if (e.data.action === 'noteOn') this.noteOn(e.data.note, e.data.velocity);
                    else if (e.data.action === 'noteOff') this.noteOff(e.data.note);
                }
            };
            this.worklet.port.postMessage({ type: 'sensitivity', value: this.sensitivity });
            this.input.connect(this.worklet);
        } catch (e) {
            console.error("Isomorphic Hex Worklet load failed:", e);
        }
    }

    async loadSample(file) {
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        try {
            const arrayBuffer = await file.arrayBuffer();
            this.sampleBuffer = await this.ctx.decodeAudioData(arrayBuffer);
            if (this.uiElements.loadBtn) {
                this.uiElements.loadBtn.classList.add('active');
                this.uiElements.loadBtn.innerText = "WAV LOADED";
            }
        } catch (e) { console.error("Virhe ladattaessa wav:", e); }
    }
    
    noteOn(note, velocity, isExternalMidi = false) {
        const outFunc = this.sendMidi || this.onMidiOut;
        if (!isExternalMidi && typeof outFunc === 'function') {
            outFunc.call(this, [0x90, note, velocity]);
        }
        
        this.updateHexUI(note, true);

        if (!this.sampleBuffer) return; 

        if (this.activeVoices.has(note)) this.noteOff(note, true); 

        const now = this.ctx.currentTime;
        const targetHz = this.tuning.get(note) || this.calcDefaultHz(note);
        const baseHz = this.tuning.get(this.baseMidi) || this.calcDefaultHz(this.baseMidi);
        
        const source = this.ctx.createBufferSource();
        source.buffer = this.sampleBuffer;
        source.playbackRate.value = targetHz / baseHz;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        const cutoffFreq = 1000 + Math.pow(velocity / 127, 2) * 19000;
        filter.frequency.setValueAtTime(cutoffFreq, now);

        const vca = this.ctx.createGain();
        const peakGain = Math.pow(velocity / 127, 2); 
        vca.gain.setValueAtTime(0, now);
        vca.gain.linearRampToValueAtTime(peakGain, now + 0.02); 

        source.connect(filter);
        filter.connect(vca);
        vca.connect(this.wet);
        
        source.start();
        this.activeVoices.set(note, { source, filter, vca });
    }

    noteOff(note, isExternalMidi = false) {
        const outFunc = this.sendMidi || this.onMidiOut;
        if (!isExternalMidi && typeof outFunc === 'function') {
            outFunc.call(this, [0x80, note, 0]);
        }

        this.updateHexUI(note, false);

        if (!this.activeVoices.has(note)) return;

        const voice = this.activeVoices.get(note);
        const now = this.ctx.currentTime;
        
        voice.vca.gain.cancelScheduledValues(now);
        voice.vca.gain.setValueAtTime(voice.vca.gain.value, now);
        voice.vca.gain.setTargetAtTime(0, now, 0.4); 
        
        voice.source.stop(now + 2.5);
        this.activeVoices.delete(note);
    }

    // --- HEX GRID LOGIC ---
    updateGridMapping() {
        this.currentKeyMap = {};
        
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const rowObjIndex = this.rows - 1 - r; // r=0 on DOMin ylin rivi, rowObjIndex=0 on alin rivi ruudukon koordinaatistossa
                
                // Heksagonaalinen matematiikka:
                // Jokainen askel oikealle (+c) lisää xInterval.
                // Jokainen askel ylös (+rowObjIndex) lisää yInterval ja siirtää visuaalisesti puoli askelta oikealle.
                const midi = this.virtualBaseMidi + (rowObjIndex * this.yInterval) + (c * this.xInterval);
                
                const hexId = `hex-${r}-${c}`;
                const hexEl = document.getElementById(hexId);
                
                if (hexEl) {
                    hexEl.dataset.midi = midi;
                    const noteName = this.midiToNoteName(midi);
                    hexEl.querySelector('.hex-note').innerText = noteName;
                    
                    // Värikoodaus
                    hexEl.className = 'iso-hex'; 
                    const isC = noteName.startsWith("C") && !noteName.includes("#");
                    const isWhite = !noteName.includes("#");
                    
                    if (isC) hexEl.classList.add('root');
                    else if (isWhite) hexEl.classList.add('white');
                    else hexEl.classList.add('black');

                    // Mappaus näppäimistöön
                    const keyChar = this.qwertyRows[rowObjIndex] ? this.qwertyRows[rowObjIndex][c] : null;
                    if (keyChar) {
                        this.currentKeyMap[keyChar] = midi;
                        hexEl.querySelector('.hex-hint').innerText = keyChar.toUpperCase();
                    } else {
                        hexEl.querySelector('.hex-hint').innerText = '';
                    }
                }
            }
        }

        // DOM elementtien tallennus mappiin nuotin perusteella nopeita päivityksiä varten
        this.hexElements = {};
        document.querySelectorAll('.iso-hex').forEach(el => {
            const m = parseInt(el.dataset.midi);
            if (!this.hexElements[m]) this.hexElements[m] = [];
            this.hexElements[m].push(el);
        });

        if (this.uiElements.keyInfo) {
            this.uiElements.keyInfo.innerText = `Base Note: ${this.midiToNoteName(this.virtualBaseMidi)}`;
        }
    }

    shiftGrid(semitones) {
        this.killAllNotes();
        this.virtualBaseMidi += semitones;
        // Pidetään nuotti järkevissä rajoissa
        this.virtualBaseMidi = Math.max(12, Math.min(this.virtualBaseMidi, 96));
        this.updateGridMapping();
    }

    initKeyboardListeners() {
        window.addEventListener('keydown', async (e) => {
            if (e.target.tagName === 'INPUT' || e.repeat || !this.gridVisible) return;
            if (this.ctx.state === 'suspended') await this.ctx.resume();

            const key = e.key.toLowerCase();

            // Navigointi nuolinäppäimillä
            if (e.key === 'ArrowUp') { e.preventDefault(); this.shiftGrid(12); return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); this.shiftGrid(-12); return; }
            if (e.key === 'ArrowRight') { e.preventDefault(); this.shiftGrid(1); return; }
            if (e.key === 'ArrowLeft') { e.preventDefault(); this.shiftGrid(-1); return; }

            if (this.currentKeyMap[key] !== undefined && !this.pressedKeys[key]) {
                e.preventDefault();
                this.pressedKeys[key] = true;
                this.noteOn(this.currentKeyMap[key], 100);
            }
        });

        window.addEventListener('keyup', (e) => {
            const key = e.key.toLowerCase();
            if (this.currentKeyMap[key] !== undefined && this.pressedKeys[key]) {
                this.pressedKeys[key] = false;
                this.noteOff(this.currentKeyMap[key]);
            }
        });
    }

    updateHexUI(note, isActive) {
        if (this.hexElements[note]) {
            this.hexElements[note].forEach(el => {
                if (isActive) el.classList.add('active');
                else el.classList.remove('active');
            });
        }
    }

    getNodes() { return { input: this.input, output: this.output }; }

    getState() {
        return { mix: this.mix, sensitivity: this.sensitivity, tuning: Array.from(this.tuning.entries()) };
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
            if (this.worklet) this.worklet.port.postMessage({ type: 'sensitivity', value: this.sensitivity });
            if (this.knobs['sens']) this.knobs['sens'].setValue(this.sensitivity);
        }
        if (state.tuning !== undefined && Array.isArray(state.tuning)) this.tuning = new Map(state.tuning);
    }

    renderUI(containerElement) {
        const color = '#ffea00'; // Keltainen neon-teema Heksagoneille
        containerElement.style.setProperty('--fx-color', color);

        const styleId = 'fx-isomorphic-hex-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .iso-panel { background: #111; padding: 15px; border-radius: 8px; border: 1px solid #333; display: flex; flex-direction: column; gap: 15px; box-shadow: inset 0 0 20px rgba(0,0,0,0.5); font-family: monospace;}
                .iso-row { display: flex; justify-content: space-between; align-items: flex-end; gap: 15px; flex-wrap: wrap; }
                
                .btn-neon { 
                    background: #0a0a0a; border: 1px solid var(--fx-color); color: var(--fx-color); 
                    cursor: pointer; padding: 8px 12px; border-radius: 4px; font-family: monospace; 
                    font-weight: bold; font-size: 11px; letter-spacing: 1px; transition: all 0.2s; 
                    box-shadow: inset 0 0 5px rgba(255, 234, 0, 0.1); text-align: center; display: inline-block;
                }
                .btn-neon:hover { background: rgba(255, 234, 0, 0.1); box-shadow: inset 0 0 10px rgba(255, 234, 0, 0.3), 0 0 5px rgba(255, 234, 0, 0.4); }
                .btn-neon.active { background: var(--fx-color); color: #000; box-shadow: 0 0 15px var(--fx-color), inset 0 0 5px rgba(255,255,255,0.5); }
                
                .hex-grid-container {
                    width: 100%; background: #000; border: 2px solid #333; border-radius: 6px;
                    padding: 25px 10px; display: none; flex-direction: column; align-items: center; 
                    box-sizing: border-box; box-shadow: 0 5px 15px rgba(0,0,0,0.8); overflow-x: auto;
                }
                .hex-grid-container.show-grid { display: flex; }
                
                .iso-hex-row {
                    display: flex; justify-content: center;
                    margin-bottom: -13px; /* Hunajakennon pystysuuntainen lomittuminen */
                }
                .iso-hex-row.offset {
                    transform: translateX(23px); /* Siirtää joka toista riviä puolen heksagonin verran */
                }
                
                .iso-hex {
                    width: 44px; height: 50px; margin: 0 1px; /* 44px leveys, 50px korkeus on lähellä aitoa heksagonia */
                    clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
                    position: relative; cursor: pointer;
                    display: flex; flex-direction: column; justify-content: center; align-items: center;
                    background: #222; transition: transform 0.05s;
                    user-select: none;
                }
                .iso-hex:active { transform: scale(0.92); }
                
                /* Hex Colors */
                .iso-hex.white { background: #3a3a3a; }
                .iso-hex.black { background: #1a1a1a; }
                .iso-hex.root { background: #5c4d00; }
                
                /* Border simulation via inner div (since clip-path cuts real borders) */
                .iso-hex::before {
                    content: ""; position: absolute; top: 1px; left: 1px; right: 1px; bottom: 1px;
                    clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
                    background: transparent; z-index: 0; pointer-events: none;
                }
                .iso-hex.white::before { background: #444; }
                .iso-hex.black::before { background: #222; }
                .iso-hex.root::before { background: #7a6600; }

                /* Active Hex states */
                .iso-hex.active { background: var(--fx-color) !important; box-shadow: none; }
                .iso-hex.active::before { background: var(--fx-color) !important; }
                
                .hex-note { font-size: 11px; font-weight: bold; color: #ccc; pointer-events: none; z-index: 1; }
                .iso-hex.root .hex-note { color: #ffe600; }
                .iso-hex.active .hex-note { color: #000; }
                
                .hex-hint { position: absolute; bottom: 6px; font-size: 8px; color: #777; pointer-events: none; z-index: 1; font-weight: bold;}
                .iso-hex.active .hex-hint { color: rgba(0,0,0,0.6); }

                /* Knobs */
                .knob-container { display: flex; flex-direction: column; align-items: center; user-select: none; width: 50px; }
                .knob-wrapper { position: relative; width: 40px; height: 40px; cursor: ns-resize; margin-bottom: 5px; touch-action: none; }
                .knob-svg { width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 3px rgba(255,234,0,0.2));}
                .knob-track { fill: none; stroke: #222; stroke-width: 6; stroke-linecap: round; }
                .knob-value-path { fill: none; stroke: var(--fx-color); stroke-width: 6; stroke-linecap: round; transition: stroke 0.2s; }
                .knob-center { fill: #111; stroke: #333; stroke-width: 1.5; }
                .knob-indicator { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
                .knob-dot { position: absolute; width: 4px; height: 4px; background: var(--fx-color); border-radius: 50%; top: 4px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 5px var(--fx-color);}
                .knob-label { font-size: 9px; color: #8b8b9f; margin-bottom: 3px; text-align: center;}
                .knob-value-display { font-size: 9px; color: #ccc; background: #000; padding: 2px 5px; border-radius: 3px; border: 1px solid #333; }
                
                select.iso-select {
                    background: #000; color: var(--fx-color); border: 1px solid var(--fx-color);
                    padding: 3px 5px; font-family: monospace; border-radius: 4px; font-size: 10px; outline: none; width: 100%;
                }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div style="margin-bottom: 15px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 4px; font-size: 14px; text-shadow: 0 0 10px rgba(255,234,0,0.5); font-family: monospace;">HEXAGONAL CONTROLLER</div>
            
            <div class="iso-panel">
                <div class="iso-row">
                    <div style="display:flex; flex-direction:column; gap:8px;">
                        <input type="file" id="iso-wav-upload" accept="audio/wav,audio/mp3" style="display:none;">
                        <button class="btn-neon" id="btn-load-iso">LOAD WAV</button>
                        <button class="btn-neon" id="btn-toggle-grid" style="border-color:#ff9100; color:#ff9100;">SHOW HEX GRID</button>
                    </div>

                    <div style="display:flex; flex-direction:column; gap:8px; align-items:center;">
                        <div style="font-size: 10px; color: #ccc; font-family: monospace;">LAYOUT SETUP</div>
                        <div style="display:flex; gap: 5px; align-items: center;">
                            <button class="btn-neon" id="btn-oct-down" title="Arrow Down">OCT -</button>
                            <button class="btn-neon" id="btn-oct-up" title="Arrow Up">OCT +</button>
                            <div style="display:flex; flex-direction:column; gap:3px; min-width: 160px;">
                                <select id="iso-x-select" class="iso-select" title="Horizontal Interval (Right)">
                                    <option value="1">X: m2 (Semitone)</option>
                                    <option value="2" selected>X: M2 (Wicki-Hayden)</option>
                                    <option value="3">X: m3 (Harmonic)</option>
                                    <option value="4">X: M3</option>
                                    <option value="5">X: P4</option>
                                    <option value="7">X: P5 (Mahlmann)</option>
                                </select>
                                <select id="iso-y-select" class="iso-select" title="Diagonal Interval (Up-Right)">
                                    <option value="1">Y: m2 (Harmonic/Janko)</option>
                                    <option value="2">Y: M2</option>
                                    <option value="3">Y: m3 (Mahlmann)</option>
                                    <option value="4">Y: M3</option>
                                    <option value="5" selected>Y: P4 (Wicki-Hayden)</option>
                                    <option value="7">Y: P5</option>
                                </select>
                            </div>
                        </div>
                        <div id="iso-base-info" style="font-size: 11px; color: var(--fx-color); text-align: center; font-weight: bold;">Base Note: C3</div>
                    </div>

                    <div style="display:flex; gap:15px;">
                        <div id="sens-knob-area"></div>
                        <div id="mix-knob-area"></div>
                    </div>
                </div>
                
                <div class="hex-grid-container" id="iso-grid"></div>
            </div>
        `;

        this.uiElements.loadBtn = containerElement.querySelector('#btn-load-iso');
        const fileInput = containerElement.querySelector('#iso-wav-upload');
        this.uiElements.keyInfo = containerElement.querySelector('#iso-base-info');

        this.uiElements.loadBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => { if (e.target.files.length > 0) this.loadSample(e.target.files[0]); });
        
        // Settings Listeners
        containerElement.querySelector('#btn-oct-down').addEventListener('click', () => this.shiftGrid(-12));
        containerElement.querySelector('#btn-oct-up').addEventListener('click', () => this.shiftGrid(12));
        
        containerElement.querySelector('#iso-x-select').addEventListener('change', (e) => {
            this.xInterval = parseInt(e.target.value);
            this.updateGridMapping();
        });
        
        containerElement.querySelector('#iso-y-select').addEventListener('change', (e) => {
            this.yInterval = parseInt(e.target.value);
            this.updateGridMapping();
        });

        const toggleGridBtn = containerElement.querySelector('#btn-toggle-grid');
        const gridContainer = containerElement.querySelector('#iso-grid');

        // Rakennetaan heksagonaalinen ruudukko (DOM)
        for (let r = 0; r < this.rows; r++) {
            const rowDiv = document.createElement('div');
            rowDiv.className = 'iso-hex-row';
            
            // Joka toinen rivi porrastetaan oikealle (koska r=0 on ylin rivi DOMissa, tarkistetaan pariteetti)
            if (r % 2 === 0) rowDiv.classList.add('offset');

            for (let c = 0; c < this.cols; c++) {
                const hex = document.createElement('div');
                hex.className = 'iso-hex';
                hex.id = `hex-${r}-${c}`;
                hex.innerHTML = `<span class="hex-note"></span><span class="hex-hint"></span>`;
                
                // Hiiri/Kosketus-tapahtumat
                const triggerOn = (e) => {
                    e.preventDefault();
                    if (this.ctx.state === 'suspended') this.ctx.resume();
                    const midi = parseInt(hex.dataset.midi);
                    this.noteOn(midi, 100);
                };
                const triggerOff = (e) => {
                    e.preventDefault();
                    const midi = parseInt(hex.dataset.midi);
                    this.noteOff(midi);
                };

                hex.addEventListener('mousedown', triggerOn);
                hex.addEventListener('mouseup', triggerOff);
                hex.addEventListener('mouseleave', triggerOff);
                
                hex.addEventListener('touchstart', triggerOn, { passive: false });
                hex.addEventListener('touchend', triggerOff, { passive: false });
                hex.addEventListener('touchcancel', triggerOff, { passive: false });

                rowDiv.appendChild(hex);
            }
            gridContainer.appendChild(rowDiv);
        }

        toggleGridBtn.addEventListener('click', () => {
            this.gridVisible = !this.gridVisible;
            if (this.gridVisible) {
                gridContainer.classList.add('show-grid');
                toggleGridBtn.classList.add('active');
                this.updateGridMapping();
            } else {
                gridContainer.classList.remove('show-grid');
                toggleGridBtn.classList.remove('active');
                this.killAllNotes();
            }
        });

        const createKnob = (container, label, min, max, defaultValue, formatValue, onChange) => {
            const div = document.createElement('div');
            div.className = 'knob-container';
            const radius = 17, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            
            div.innerHTML = `
                <div class="knob-label">${label}</div>
                <div class="knob-wrapper">
                    <svg class="knob-svg" viewBox="0 0 40 40"><circle class="knob-track" cx="20" cy="20" r="${radius}" stroke-dasharray="${maxDash} ${circumference}" /><circle class="knob-value-path" cx="20" cy="20" r="${radius}" stroke-dasharray="0 ${circumference}" /><circle class="knob-center" cx="20" cy="20" r="10" /></svg>
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
                if (newVal !== currentValue) { currentValue = newVal; updateUI(currentValue); onChange(currentValue); }
            };
            const endDrag = () => { if (isDragging) { isDragging = false; document.body.style.cursor = 'default'; } };

            wrapper.addEventListener('mousedown', (e) => startDrag(e.clientY)); window.addEventListener('mousemove', (e) => doDrag(e.clientY)); window.addEventListener('mouseup', endDrag);
            wrapper.addEventListener('touchstart', (e) => startDrag(e.touches[0].clientY), { passive: false }); window.addEventListener('touchmove', (e) => { if (isDragging) { e.preventDefault(); doDrag(e.touches[0].clientY); } }, { passive: false }); window.addEventListener('touchend', endDrag);
            
            return { setValue: (v) => { currentValue = v; updateUI(v); } };
        };

        this.knobs['sens'] = createKnob(containerElement.querySelector('#sens-knob-area'), 'SENS', 0.0, 1.0, this.sensitivity, v => Math.round(v*100), v => { 
            this.sensitivity = v; 
            if (this.worklet) this.worklet.port.postMessage({ type: 'sensitivity', value: v });
        });
        this.knobs['mix'] = createKnob(containerElement.querySelector('#mix-knob-area'), 'MIX', 0, 1.0, this.mix, v => Math.round(v*100)+'%', v => { this.mix = v; this.updateMix(); });

        // Alustetaan grid taustalla (vaikka on piilossa)
        this.updateGridMapping();
    }
}
