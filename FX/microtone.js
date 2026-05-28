// microtone.js
// Mikrotunaalinen Ääniohjattu Koskettimisto
// Tukee mukautettuja vireitä (EDO, Just Intonation, Pythagorian, Meantone), 
// graafista kromaattista ympyrää, intervalli-mäppäyksiä sekä heksagonaalista koskettimistoa.

window.CustomAudioEffect = class AudioMicrotoneEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.dry = audioCtx.createGain();
        this.wet = audioCtx.createGain();

        this.input.connect(this.dry);
        this.dry.connect(this.output);
        this.wet.connect(this.output);
        this.wet.connect(this.ctx.destination); // Reititys kaiuttimiin suoraan

        this.mix = 1.0; 
        this.sensitivity = 0.5;
        
        this.sampleBuffer = null;
        this.baseMidi = 60; // C4
        this.sampleBaseHz = 261.625565; // C4 standardi Hz, johon samplea verrataan
        this.activeVoices = new Map();
        
        // Tuning state: Map<midi, {hz, label, interval}>
        this.tuning = new Map(); 
        
        // Hex grid state: Map<"r-c", {midi}>
        this.hexGrid = {};
        this.rows = 4;
        this.cols = 11;
        this.xStep = 2; // Vaakasuunta: M2 (oletus)
        this.yStep = 5; // Viistosuunta: P4 (oletus)
        this.virtualBase = 48; // C3
        this.editKeysMode = false;
        
        // Key bindings
        this.qwertyRows = [
            ['<','z','x','c','v','b','n','m',',','.','/'],
            ['a','s','d','f','g','h','j','k','l',';',"'"],
            ['q','w','e','r','t','y','u','i','o','p','['],
            ['2','3','4','5','6','7','8','9','0','-','=']
        ];
        this.currentKeyMap = {};
        this.pressedKeys = {};

        this.knobs = {};
        this.uiElements = {};
        this.hexElements = {};
        this.container = null; // Tallennetaan renderUI:n säiliö

        this.initDefaultTuning();
        this.generateHexGrid();
        
        this.updateMix();
        this._initWorklet();
        this.initKeyboardListeners();
        
        // Visualizer loop
        this.animationFrame = null;
    }

    // --- MIDI IN / PITCH-TO-MIDI ---
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

    // --- TUNING LOGIC ---
    calcDefaultHz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }
    
    midiToNoteName(midi) {
        const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
        return `${notes[midi % 12]}${Math.floor(midi / 12) - 1}`;
    }

    initDefaultTuning() {
        for (let i = 0; i <= 127; i++) {
            this.tuning.set(i, {
                hz: this.calcDefaultHz(i),
                label: this.midiToNoteName(i),
                interval: ""
            });
        }
    }

    applyPreset(presetName) {
        const baseHz = this.sampleBaseHz; // C4 = 261.625565
        const baseMidi = 60;

        let ratios = [];
        if (presetName === 'just') {
            ratios = [1, 16/15, 9/8, 6/5, 5/4, 4/3, 45/32, 3/2, 8/5, 5/3, 9/5, 15/8];
        } else if (presetName === 'pythagorean') {
            ratios = [1, 256/243, 9/8, 32/27, 81/64, 4/3, 729/512, 3/2, 128/81, 27/16, 16/9, 243/128];
        } else if (presetName === 'meantone') {
            // 1/4 comma meantone
            ratios = [1.0, 1.0449, 1.1180, 1.1963, 1.25, 1.3375, 1.3975, 1.4953, 1.5625, 1.6719, 1.7889, 1.8692];
        }

        if (presetName === 'edo12') {
            this.initDefaultTuning();
        } else if (ratios.length === 12) {
            for (let i = 0; i <= 127; i++) {
                let degree = (i - baseMidi) % 12;
                if (degree < 0) degree += 12;
                let octave = Math.floor((i - baseMidi) / 12);
                
                const hz = baseHz * ratios[degree] * Math.pow(2, octave);
                this.tuning.set(i, {
                    hz: hz,
                    label: this.midiToNoteName(i),
                    interval: ""
                });
            }
        }
        if(this.uiElements.tuningModalOpen) this.openTuningModal(); // Refresh modal
        this.updateHexGridMapping(); // Päivitä näppäimien tekstit
    }

    applyEDO(n) {
        const baseHz = this.sampleBaseHz;
        const baseMidi = 60;
        for (let i = 0; i <= 127; i++) {
            const steps = i - baseMidi;
            const hz = baseHz * Math.pow(2, steps / n);
            this.tuning.set(i, {
                hz: hz,
                label: `${n}EDO ${i - baseMidi > 0 ? '+' : ''}${i - baseMidi}`,
                interval: ""
            });
        }
        if(this.uiElements.tuningModalOpen) this.openTuningModal();
        this.updateHexGridMapping();
    }

    parseInterval(str, currentMidi) {
        if (!str || str.trim() === "") return null;
        // Regex hakee tyyliin "3/2 * MIDI60" tai "5/4"
        const match = str.trim().match(/^([\d\.]+)\s*\/\s*([\d\.]+)(?:\s*\*\s*MIDI(\d+))?$/i);
        if (match) {
            const num = parseFloat(match[1]);
            const den = parseFloat(match[2]);
            let refMidi = match[3] ? parseInt(match[3]) : 60; // Oletuksena root on 60
            
            const refData = this.tuning.get(refMidi);
            if (refData && den !== 0) {
                return (num / den) * refData.hz;
            }
        }
        return null;
    }

    // --- AUDIO & WORKLET ---
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
            this.updateHexKeyUI(note, false);
            const outFunc = this.sendMidi || this.onMidiOut;
            if (typeof outFunc === 'function') outFunc.call(this, [0x80, note, 0]);
        });
        this.activeVoices.clear();
        this.pressedKeys = {};
        if (this.worklet) this.worklet.port.postMessage({ type: 'panic' });
    }

    async _initWorklet() {
        const workletCode = `
            class MicrotoneProcessor extends AudioWorkletProcessor {
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
                        
                        if (targetMidi !== this.currentNote && targetMidi >= 0 && targetMidi <= 127) {
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
            registerProcessor('microtone-processor', MicrotoneProcessor);
        `;

        const dataUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(workletCode);
        try {
            await this.ctx.audioWorklet.addModule(dataUrl);
            this.worklet = new AudioWorkletNode(this.ctx, 'microtone-processor');
            this.worklet.port.onmessage = (e) => {
                if (e.data.type === 'midi') {
                    if (e.data.action === 'noteOn') this.noteOn(e.data.note, e.data.velocity);
                    else if (e.data.action === 'noteOff') this.noteOff(e.data.note);
                }
            };
            this.worklet.port.postMessage({ type: 'sensitivity', value: this.sensitivity });
            this.input.connect(this.worklet);
        } catch (e) { console.error("Microtone Worklet load failed:", e); }
    }

    noteOn(note, velocity, isExternalMidi = false) {
        const outFunc = this.sendMidi || this.onMidiOut;
        if (!isExternalMidi && typeof outFunc === 'function') {
            outFunc.call(this, [0x90, note, velocity]);
        }
        
        this.updateHexKeyUI(note, true);

        if (!this.sampleBuffer) return; 
        if (this.activeVoices.has(note)) this.noteOff(note, true); 

        const now = this.ctx.currentTime;
        
        const noteData = this.tuning.get(note);
        const targetHz = noteData ? noteData.hz : this.calcDefaultHz(note);
        
        const source = this.ctx.createBufferSource();
        source.buffer = this.sampleBuffer;
        
        source.playbackRate.value = targetHz / this.sampleBaseHz;

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

        this.updateHexKeyUI(note, false);

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
    generateHexGrid() {
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const rowObjIndex = this.rows - 1 - r; 
                const midi = this.virtualBase + (rowObjIndex * this.yStep) + (c * this.xStep);
                this.hexGrid[`${r}-${c}`] = { midi: midi };
            }
        }
        this.updateHexGridMapping();
    }

    updateHexGridMapping() {
        if (!this.container) return; // Jos DOM:ia ei ole vielä rakennettu
        
        this.currentKeyMap = {};
        this.hexElements = {};

        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const hexId = `${r}-${c}`;
                const data = this.hexGrid[hexId];
                if (!data) continue;
                
                const hexEl = this.container.querySelector(`#micro-hex-${hexId}`);
                if (hexEl) {
                    hexEl.dataset.midi = data.midi;
                    
                    // Hae nimi automaattisesti mapping-taulusta (NAME)
                    const noteData = this.tuning.get(data.midi);
                    const label = noteData && noteData.label ? noteData.label : this.midiToNoteName(data.midi);
                    hexEl.querySelector('.hex-note').innerText = label;
                    
                    const rowObjIndex = this.rows - 1 - r;
                    const keyChar = this.qwertyRows[rowObjIndex] ? this.qwertyRows[rowObjIndex][c] : null;
                    if (keyChar) {
                        this.currentKeyMap[keyChar] = data.midi;
                        hexEl.querySelector('.hex-hint').innerText = keyChar.toUpperCase();
                    }
                    
                    if (!this.hexElements[data.midi]) this.hexElements[data.midi] = [];
                    this.hexElements[data.midi].push(hexEl);
                }
            }
        }
    }

    updateHexKeyUI(note, isActive) {
        if (this.hexElements[note]) {
            this.hexElements[note].forEach(el => {
                if (isActive) el.classList.add('active');
                else el.classList.remove('active');
            });
        }
    }

    initKeyboardListeners() {
        window.addEventListener('keydown', async (e) => {
            if (e.target.tagName === 'INPUT' || e.repeat) return;
            if (this.ctx.state === 'suspended') await this.ctx.resume();

            const key = e.key.toLowerCase();
            if (this.currentKeyMap[key] !== undefined && !this.pressedKeys[key] && !this.editKeysMode) {
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

    // --- SAVE / LOAD STATE ---
    getState() {
        return {
            mix: this.mix,
            sensitivity: this.sensitivity,
            tuning: Array.from(this.tuning.entries()),
            hexGrid: this.hexGrid,
            xStep: this.xStep,
            yStep: this.yStep
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
            if (this.worklet) this.worklet.port.postMessage({ type: 'sensitivity', value: this.sensitivity });
            if (this.knobs['sens']) this.knobs['sens'].setValue(this.sensitivity);
        }
        if (state.tuning !== undefined) this.tuning = new Map(state.tuning);
        if (state.xStep !== undefined) this.xStep = state.xStep;
        if (state.yStep !== undefined) this.yStep = state.yStep;
        
        if (state.hexGrid !== undefined) {
            this.hexGrid = state.hexGrid;
        } else {
            this.generateHexGrid();
        }
        
        // Päivitetään input-kentät jos ne ovat näkyvissä
        if (this.container) {
            const xInp = this.container.querySelector('#micro-x-step');
            const yInp = this.container.querySelector('#micro-y-step');
            if (xInp) xInp.value = this.xStep;
            if (yInp) yInp.value = this.yStep;
            this.updateHexGridMapping();
        }
    }

    saveSettings() {
        const state = this.getState();
        const dataStr = "window.microtonePreset = " + JSON.stringify(state, null, 2) + ";";
        const blob = new Blob([dataStr], { type: "application/javascript" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "microtone_preset.js";
        link.click();
    }

    loadSettings(file) {
        const reader = new FileReader();
        reader.onload = e => {
            let text = e.target.result;
            text = text.replace("window.microtonePreset = ", "");
            const lastSemi = text.lastIndexOf(";");
            if (lastSemi !== -1) text = text.substring(0, lastSemi);
            try {
                const state = JSON.parse(text);
                this.setState(state);
            } catch(err) {
                alert("Virhe ladattaessa asetuksia: " + err);
            }
        };
        reader.readAsText(file);
    }

    // --- VISUALIZER ---
    getDotCoords(midi) {
        const noteData = this.tuning.get(midi);
        if (!noteData || !this.uiElements.canvas) return null;
        const cx = this.uiElements.canvas.width / 2;
        const cy = this.uiElements.canvas.height / 2;
        
        const cents = 1200 * Math.log2(noteData.hz / this.sampleBaseHz);
        const normalizedCents = ((cents % 1200) + 1200) % 1200; // Varmistaa positiivisen luvun
        const angle = (normalizedCents / 1200) * 2 * Math.PI - Math.PI/2;
        
        // Spiraali jotta oktaavit eivät mene täysin päällekkäin
        const r = 25 + (midi - 21) * 0.9; 
        
        return {
            x: cx + Math.cos(angle) * r,
            y: cy + Math.sin(angle) * r,
            r: r,
            midi: midi
        };
    }

    startVisualizer() {
        const canvas = this.uiElements.canvas;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const cx = w / 2;
        const cy = h / 2;

        const draw = () => {
            ctx.clearRect(0, 0, w, h);
            
            // Draw background reference circles
            ctx.strokeStyle = '#222';
            ctx.lineWidth = 1;
            [35, 65, 95].forEach(radius => {
                ctx.beginPath();
                ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
                ctx.stroke();
            });

            // Draw notes
            ctx.font = "9px monospace";
            for (let i = 21; i <= 108; i++) {
                const coords = this.getDotCoords(i);
                if (!coords) continue;
                
                const isActive = this.activeVoices.has(i);
                const dotSize = isActive ? 5 : 2.5;
                
                ctx.beginPath();
                ctx.arc(coords.x, coords.y, dotSize, 0, 2 * Math.PI);
                ctx.fillStyle = isActive ? '#00ffaa' : '#555';
                ctx.fill();

                if (isActive) {
                    const freq = this.tuning.get(i).hz;
                    ctx.fillStyle = '#fff';
                    ctx.fillText(freq.toFixed(1) + ' Hz', coords.x + 8, coords.y + 4);
                }
            }

            this.animationFrame = requestAnimationFrame(draw);
        };
        draw();
    }

    // --- MODALS & UI ---
    openTuningModal() {
        this.uiElements.tuningModalOpen = true;
        if (document.getElementById('micro-tuning-overlay')) {
            document.body.removeChild(document.getElementById('micro-tuning-overlay'));
        }

        const overlay = document.createElement('div');
        overlay.id = 'micro-tuning-overlay';
        overlay.className = 'micro-modal-overlay';
        
        const modal = document.createElement('div');
        modal.className = 'micro-modal';
        
        let html = `
            <div class="micro-modal-header">
                <span>MAPPING & INTERVALS</span>
                <button class="btn-micro" id="btn-close-modal" style="padding: 4px 8px;">X</button>
            </div>
            <div class="micro-modal-body">
                <div class="micro-tuning-row" style="font-weight:bold; color:var(--micro-color); border-bottom:1px solid #333; padding-bottom:5px;">
                    <div>NAME</div>
                    <div>MIDI</div>
                    <div>FREQ (Hz)</div>
                    <div>INTERVAL (e.g. 3/2 * MIDI60)</div>
                </div>
        `;

        for (let i = 21; i <= 108; i++) {
            const data = this.tuning.get(i);
            html += `
                <div class="micro-tuning-row">
                    <div><input type="text" class="micro-input label-input" data-midi="${i}" value="${data.label}"></div>
                    <div>${i}</div>
                    <div><input type="number" step="0.001" class="micro-input hz-input" data-midi="${i}" value="${data.hz.toFixed(3)}"></div>
                    <div><input type="text" class="micro-input int-input" data-midi="${i}" value="${data.interval || ''}" placeholder="e.g. 5/4 * MIDI60"></div>
                </div>
            `;
        }

        html += `</div>`;
        modal.innerHTML = html;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        modal.querySelector('#btn-close-modal').addEventListener('click', () => {
            this.uiElements.tuningModalOpen = false;
            document.body.removeChild(overlay);
        });

        // Event listeners for inputs
        modal.querySelectorAll('.label-input').forEach(inp => {
            inp.addEventListener('change', (e) => {
                const midi = parseInt(e.target.dataset.midi);
                this.tuning.get(midi).label = e.target.value;
                this.updateHexGridMapping(); // Päivittää nimet reaaliajassa koskettimiin
            });
        });

        modal.querySelectorAll('.hz-input').forEach(inp => {
            inp.addEventListener('change', (e) => {
                const midi = parseInt(e.target.dataset.midi);
                const hz = parseFloat(e.target.value);
                if (!isNaN(hz) && hz > 0) {
                    this.tuning.get(midi).hz = hz;
                    this.tuning.get(midi).interval = ""; 
                    modal.querySelector(`.int-input[data-midi="${midi}"]`).value = "";
                }
            });
        });

        modal.querySelectorAll('.int-input').forEach(inp => {
            inp.addEventListener('change', (e) => {
                const midi = parseInt(e.target.dataset.midi);
                const intStr = e.target.value;
                this.tuning.get(midi).interval = intStr;
                
                const newHz = this.parseInterval(intStr, midi);
                if (newHz) {
                    this.tuning.get(midi).hz = newHz;
                    modal.querySelector(`.hz-input[data-midi="${midi}"]`).value = newHz.toFixed(3);
                }
            });
        });
    }

    renderUI(containerElement) {
        this.container = containerElement; // Tallenna DOM referenssi
        const color = '#00ffaa'; 
        this.container.style.setProperty('--micro-color', color);

        const styleId = 'fx-microtone-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .micro-panel { background: #111; padding: 15px; border-radius: 8px; border: 1px solid #333; display: flex; flex-direction: column; gap: 15px; box-shadow: inset 0 0 20px rgba(0,0,0,0.5); font-family: monospace;}
                .micro-row { display: flex; justify-content: space-between; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
                
                .btn-micro { 
                    background: #0a0a0a; border: 1px solid var(--micro-color); color: var(--micro-color); 
                    cursor: pointer; padding: 6px 10px; border-radius: 4px; font-family: monospace; 
                    font-weight: bold; font-size: 10px; letter-spacing: 1px; transition: all 0.2s; 
                    box-shadow: inset 0 0 5px rgba(0, 255, 170, 0.1); text-align: center; display: inline-block;
                }
                .btn-micro:hover { background: rgba(0, 255, 170, 0.1); box-shadow: inset 0 0 10px rgba(0, 255, 170, 0.3), 0 0 5px rgba(0, 255, 170, 0.4); }
                .btn-micro.active { background: var(--micro-color); color: #000; box-shadow: 0 0 15px var(--micro-color), inset 0 0 5px rgba(255,255,255,0.5); }
                
                .micro-select, .micro-input-sm {
                    background: #000; color: var(--micro-color); border: 1px solid var(--micro-color);
                    padding: 4px; font-family: monospace; border-radius: 4px; font-size: 10px; outline: none;
                }

                .hex-grid-container {
                    width: 100%; background: #000; border: 2px solid #333; border-radius: 6px;
                    padding: 15px 5px; display: flex; flex-direction: column; align-items: center; 
                    box-sizing: border-box; box-shadow: 0 5px 15px rgba(0,0,0,0.8); overflow-x: auto;
                }
                .micro-hex-row { display: flex; justify-content: center; margin-bottom: -10px; }
                .micro-hex-row.offset { transform: translateX(20px); }
                
                .micro-hex {
                    width: 38px; height: 44px; margin: 0 1px;
                    clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
                    position: relative; cursor: pointer;
                    display: flex; flex-direction: column; justify-content: center; align-items: center;
                    background: #222; transition: transform 0.05s; user-select: none;
                }
                .micro-hex:active { transform: scale(0.92); }
                
                .micro-hex::before {
                    content: ""; position: absolute; top: 1px; left: 1px; right: 1px; bottom: 1px;
                    clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
                    background: #1a1a1a; z-index: 0; pointer-events: none;
                }
                
                .micro-hex.active { background: var(--micro-color) !important; box-shadow: none; }
                .micro-hex.active::before { background: var(--micro-color) !important; }
                .micro-hex.editing::before { background: #5500aa !important; }
                
                .hex-note { font-size: 9px; font-weight: bold; color: #ccc; pointer-events: none; z-index: 1; text-align:center;}
                .micro-hex.active .hex-note { color: #000; }
                
                .hex-hint { position: absolute; bottom: 4px; font-size: 8px; color: #777; pointer-events: none; z-index: 1; font-weight: bold;}
                .micro-hex.active .hex-hint { color: rgba(0,0,0,0.6); }

                .knob-container { display: flex; flex-direction: column; align-items: center; user-select: none; width: 45px; }
                .knob-wrapper { position: relative; width: 35px; height: 35px; cursor: ns-resize; margin-bottom: 5px; touch-action: none; }
                .knob-svg { width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 3px rgba(0,255,170,0.2));}
                .knob-track { fill: none; stroke: #222; stroke-width: 6; stroke-linecap: round; }
                .knob-value-path { fill: none; stroke: var(--micro-color); stroke-width: 6; stroke-linecap: round; transition: stroke 0.2s; }
                .knob-center { fill: #111; stroke: #333; stroke-width: 1.5; }
                .knob-indicator { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
                .knob-dot { position: absolute; width: 4px; height: 4px; background: var(--micro-color); border-radius: 50%; top: 4px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 5px var(--micro-color);}
                .knob-label { font-size: 9px; color: #8b8b9f; margin-bottom: 3px; text-align: center;}
                .knob-value-display { font-size: 9px; color: #ccc; background: #000; padding: 2px 5px; border-radius: 3px; border: 1px solid #333; }

                /* Modal */
                .micro-modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 9999; display: flex; justify-content: center; align-items: center; backdrop-filter: blur(4px); }
                .micro-modal { background: #111; border: 1px solid var(--micro-color); border-radius: 8px; padding: 20px; width: 550px; max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 0 30px rgba(0,255,170,0.2); font-family: monospace; }
                .micro-modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; color: var(--micro-color); font-size: 16px; font-weight: bold;}
                .micro-modal-body { overflow-y: auto; flex: 1; padding-right: 10px; }
                .micro-modal-body::-webkit-scrollbar { width: 8px; }
                .micro-modal-body::-webkit-scrollbar-track { background: #000; border-radius: 4px; }
                .micro-modal-body::-webkit-scrollbar-thumb { background: var(--micro-color); border-radius: 4px; }
                .micro-tuning-row { display: grid; grid-template-columns: 1fr 0.5fr 1fr 1.5fr; gap: 10px; margin-bottom: 8px; align-items: center; color: #ccc; font-size: 11px; }
                .micro-input { background: #000; border: 1px solid #333; color: var(--micro-color); padding: 5px; width: 100%; border-radius: 3px; font-family: monospace; box-sizing: border-box; }
                .micro-input:focus { outline: none; border-color: var(--micro-color); box-shadow: 0 0 5px rgba(0,255,170,0.3); }
            `;
            document.head.appendChild(style);
        }

        this.container.innerHTML = `
            <div style="margin-bottom: 15px; color: var(--micro-color); font-weight: bold; text-align: center; letter-spacing: 4px; font-size: 14px; text-shadow: 0 0 10px rgba(0,255,170,0.5); font-family: monospace;">MICROTONAL CONTROLLER</div>
            
            <div class="micro-panel">
                <div class="micro-row" style="border-bottom: 1px solid #333; padding-bottom: 10px;">
                    <div style="display:flex; gap:8px;">
                        <input type="file" id="micro-wav-upload" accept="audio/wav,audio/mp3" style="display:none;">
                        <button class="btn-micro" id="btn-load-micro">LOAD WAV</button>
                        <button class="btn-micro" id="btn-save-js">SAVE .JS</button>
                        <input type="file" id="micro-js-upload" accept=".js,.json" style="display:none;">
                        <button class="btn-micro" id="btn-load-js">LOAD .JS</button>
                    </div>
                    <div style="display:flex; gap:10px;">
                        <div id="sens-knob-area"></div>
                        <div id="mix-knob-area"></div>
                    </div>
                </div>

                <div class="micro-row" style="align-items: center;">
                    <div style="display:flex; flex-direction:column; gap:5px;">
                        <span style="font-size:9px; color:#aaa;">PRESETS:</span>
                        <select id="micro-preset-select" class="micro-select">
                            <option value="edo12">12-EDO (Standard)</option>
                            <option value="just">5-Limit Just Intonation</option>
                            <option value="pythagorean">Pythagorean</option>
                            <option value="meantone">1/4 Comma Meantone</option>
                        </select>
                    </div>
                    <div style="display:flex; flex-direction:column; gap:5px;">
                        <span style="font-size:9px; color:#aaa;">CUSTOM EDO:</span>
                        <div style="display:flex; gap:5px;">
                            <input type="number" id="micro-edo-input" class="micro-input-sm" value="31" style="width:50px;">
                            <button class="btn-micro" id="btn-gen-edo">GENERATE</button>
                        </div>
                    </div>
                    <div>
                        <button class="btn-micro" id="btn-mapping" style="border-color:#ff00aa; color:#ff00aa;">MAPPING</button>
                    </div>
                </div>

                <div style="display:flex; justify-content: center; padding: 10px 0;">
                    <canvas id="chromatic-circle" width="240" height="240" style="background:#0a0a0a; border-radius:50%; border:2px solid #222; box-shadow: 0 0 20px rgba(0,0,0,0.8); cursor: pointer;"></canvas>
                </div>
                
                <div style="display:flex; justify-content: space-between; align-items:center; margin-bottom: -5px;">
                    <span style="font-size:10px; color:var(--micro-color);">HEX KEYBOARD</span>
                    <div style="display:flex; gap:10px; align-items:center;">
                        <div style="display:flex; gap:5px; align-items:center;">
                            <span style="font-size:9px; color:#aaa;">X Step:</span>
                            <input type="number" id="micro-x-step" class="micro-input-sm" value="${this.xStep}" style="width:40px;">
                        </div>
                        <div style="display:flex; gap:5px; align-items:center;">
                            <span style="font-size:9px; color:#aaa;">Y Step:</span>
                            <input type="number" id="micro-y-step" class="micro-input-sm" value="${this.yStep}" style="width:40px;">
                        </div>
                        <button class="btn-micro" id="btn-edit-keys" style="border-color:#ffff00; color:#ffff00;">EDIT KEYS</button>
                    </div>
                </div>
                <div class="hex-grid-container" id="micro-grid"></div>
            </div>
        `;

        this.uiElements.loadBtn = this.container.querySelector('#btn-load-micro');
        const fileInputWav = this.container.querySelector('#micro-wav-upload');
        this.uiElements.loadBtn.addEventListener('click', () => fileInputWav.click());
        fileInputWav.addEventListener('change', (e) => { if (e.target.files.length > 0) this.loadSample(e.target.files[0]); });

        const saveBtn = this.container.querySelector('#btn-save-js');
        const loadJsBtn = this.container.querySelector('#btn-load-js');
        const fileInputJs = this.container.querySelector('#micro-js-upload');
        saveBtn.addEventListener('click', () => this.saveSettings());
        loadJsBtn.addEventListener('click', () => fileInputJs.click());
        fileInputJs.addEventListener('change', (e) => { if (e.target.files.length > 0) this.loadSettings(e.target.files[0]); });

        this.container.querySelector('#micro-preset-select').addEventListener('change', (e) => {
            this.applyPreset(e.target.value);
        });

        this.container.querySelector('#btn-gen-edo').addEventListener('click', () => {
            const val = parseInt(this.container.querySelector('#micro-edo-input').value);
            if (!isNaN(val) && val > 0) this.applyEDO(val);
        });

        this.container.querySelector('#btn-mapping').addEventListener('click', () => this.openTuningModal());

        // Hex Keyboard Settings Inputs
        const xStepInput = this.container.querySelector('#micro-x-step');
        const yStepInput = this.container.querySelector('#micro-y-step');
        
        const applySteps = () => {
            const newX = parseInt(xStepInput.value);
            const newY = parseInt(yStepInput.value);
            if (!isNaN(newX) && !isNaN(newY)) {
                this.xStep = newX;
                this.yStep = newY;
                this.generateHexGrid();
            }
        };
        xStepInput.addEventListener('change', applySteps);
        yStepInput.addEventListener('change', applySteps);

        // Visualizer Canvas & Events
        this.uiElements.canvas = this.container.querySelector('#chromatic-circle');
        this.startVisualizer();

        let isCanvasDrawing = false;
        let currentCanvasMidi = null;

        const handleCanvasPointer = (e) => {
            if (!this.uiElements.canvas) return;
            const rect = this.uiElements.canvas.getBoundingClientRect();
            const clientX = e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches && e.touches.length > 0 ? e.touches[0].clientY : e.clientY;
            const x = clientX - rect.left;
            const y = clientY - rect.top;

            let closestMidi = null;
            let minDist = Infinity;

            for (let i = 21; i <= 108; i++) {
                const coords = this.getDotCoords(i);
                if (!coords) continue;
                const dist = Math.hypot(coords.x - x, coords.y - y);
                if (dist < 12 && dist < minDist) { // 12px osumasäde
                    minDist = dist;
                    closestMidi = i;
                }
            }

            if (closestMidi !== currentCanvasMidi) {
                if (currentCanvasMidi !== null) this.noteOff(currentCanvasMidi);
                if (closestMidi !== null && isCanvasDrawing) {
                    if (this.ctx.state === 'suspended') this.ctx.resume();
                    this.noteOn(closestMidi, 100);
                }
                currentCanvasMidi = closestMidi;
            }
        };

        const canvas = this.uiElements.canvas;
        canvas.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isCanvasDrawing = true;
            handleCanvasPointer(e);
        });
        canvas.addEventListener('mousemove', (e) => {
            if (isCanvasDrawing) handleCanvasPointer(e);
        });
        window.addEventListener('mouseup', () => {
            if (isCanvasDrawing && currentCanvasMidi !== null) {
                this.noteOff(currentCanvasMidi);
                currentCanvasMidi = null;
            }
            isCanvasDrawing = false;
        });
        canvas.addEventListener('mouseleave', () => {
            if (isCanvasDrawing && currentCanvasMidi !== null) {
                this.noteOff(currentCanvasMidi);
                currentCanvasMidi = null;
            }
            isCanvasDrawing = false;
        });
        
        // Kosketusnäyttötuki ympyrälle
        canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            isCanvasDrawing = true;
            handleCanvasPointer(e);
        }, { passive: false });
        canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (isCanvasDrawing) handleCanvasPointer(e);
        }, { passive: false });
        window.addEventListener('touchend', () => {
            if (isCanvasDrawing && currentCanvasMidi !== null) {
                this.noteOff(currentCanvasMidi);
                currentCanvasMidi = null;
            }
            isCanvasDrawing = false;
        });

        // Build Hex Grid DOM
        const gridContainer = this.container.querySelector('#micro-grid');
        for (let r = 0; r < this.rows; r++) {
            const rowDiv = document.createElement('div');
            rowDiv.className = 'micro-hex-row';
            if (r % 2 === 0) rowDiv.classList.add('offset');

            for (let c = 0; c < this.cols; c++) {
                const hexId = `${r}-${c}`;
                const hex = document.createElement('div');
                hex.className = 'micro-hex';
                hex.id = `micro-hex-${hexId}`;
                hex.innerHTML = `<span class="hex-note"></span><span class="hex-hint"></span>`;
                
                const triggerOn = (e) => {
                    e.preventDefault();
                    if (this.editKeysMode) {
                        const current = this.hexGrid[hexId];
                        if(!current) return;
                        const res = prompt(`Set MIDI Note for this key:`, `${current.midi}`);
                        if (res !== null) {
                            const newMidi = parseInt(res.trim());
                            if(!isNaN(newMidi)) {
                                this.hexGrid[hexId].midi = newMidi;
                                this.updateHexGridMapping(); // Päivittää labelin heti uudelle MIDIlle
                            }
                        }
                        return;
                    }
                    if (this.ctx.state === 'suspended') this.ctx.resume();
                    const midi = parseInt(hex.dataset.midi);
                    if(!isNaN(midi)) this.noteOn(midi, 100);
                };
                
                const triggerOff = (e) => {
                    e.preventDefault();
                    if(this.editKeysMode) return;
                    const midi = parseInt(hex.dataset.midi);
                    if(!isNaN(midi)) this.noteOff(midi);
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

        const editKeysBtn = this.container.querySelector('#btn-edit-keys');
        editKeysBtn.addEventListener('click', () => {
            this.editKeysMode = !this.editKeysMode;
            if (this.editKeysMode) {
                editKeysBtn.classList.add('active');
                gridContainer.querySelectorAll('.micro-hex').forEach(el => el.classList.add('editing'));
            } else {
                editKeysBtn.classList.remove('active');
                gridContainer.querySelectorAll('.micro-hex').forEach(el => el.classList.remove('editing'));
            }
        });

        // Knobs
        const createKnob = (container, label, min, max, defaultValue, formatValue, onChange) => {
            const div = document.createElement('div');
            div.className = 'knob-container';
            const radius = 15, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            
            div.innerHTML = `
                <div class="knob-label">${label}</div>
                <div class="knob-wrapper">
                    <svg class="knob-svg" viewBox="0 0 35 35"><circle class="knob-track" cx="17.5" cy="17.5" r="${radius}" stroke-dasharray="${maxDash} ${circumference}" /><circle class="knob-value-path" cx="17.5" cy="17.5" r="${radius}" stroke-dasharray="0 ${circumference}" /><circle class="knob-center" cx="17.5" cy="17.5" r="8" /></svg>
                    <div class="knob-indicator"><div class="knob-dot" style="top:2px;"></div></div>
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

        this.knobs['sens'] = createKnob(this.container.querySelector('#sens-knob-area'), 'SENS', 0.0, 1.0, this.sensitivity, v => Math.round(v*100), v => { 
            this.sensitivity = v; 
            if (this.worklet) this.worklet.port.postMessage({ type: 'sensitivity', value: v });
        });
        this.knobs['mix'] = createKnob(this.container.querySelector('#mix-knob-area'), 'MIX', 0, 1.0, this.mix, v => Math.round(v*100)+'%', v => { this.mix = v; this.updateMix(); });

        // Pakotetaan lopuksi ensimmäinen päivitys, kun DOM on täysin generoitu säiliössä
        this.updateHexGridMapping();
    }

    getNodes() { return { input: this.input, output: this.output }; }
}