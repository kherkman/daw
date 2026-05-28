// midi-bassline.js
window.CustomAudioEffect = class MidiBassline {
    constructor(audioCtx) {
        this.ctx = audioCtx;

        // Reititys (Audio menee läpi muuttumattomana, plugari tuottaa MIDIä)
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.input.connect(this.output);
        
        // Sidechain input äänenkorkeuden tunnistusta varten (kuten chordifier.js)
        this.sidechainInput = audioCtx.createGain();

        // Tila- ja seurantamuuttujat
        this.enabled = true;
        this.pattern = "011101110111032h";
        this.stepIndex = 0;
        this.arpTimer = null;
        
        this.heldNotes = new Map(); // Seuranta aktiivisista nuoteista: midiNote -> boolean
        this.currentChord = []; // Aktiiviset nuotit lajiteltuna (alin ensin)
        
        this.activeBassNotes = new Set(); // Parhaillaan soivat bassonuotit

        // Aika-asetukset ja nupit
        this.rhythmIndex = 0; // Oletus: 1/16
        this.rhythmDivs = [
            { label: '1/16', mult: 0.25 },
            { label: '1/8',  mult: 0.5 },
            { label: '1/4',  mult: 1.0 },
            { label: '1/2',  mult: 2.0 },
            { label: '1/1',  mult: 4.0 }
        ];

        // Oktaaviasetus (-4 ... +1)
        this.octaveOffset = -2;

        this.uiElements = {};

        // Alustetaan AudioWorklet Pitch-tunnistukseen
        this._initWorklet();
    }

    getNodes() {
        return { input: this.input, output: this.output, sidechain: this.sidechainInput };
    }

    getState() {
        return {
            enabled: this.enabled,
            pattern: this.pattern,
            rhythmIndex: this.rhythmIndex,
            octaveOffset: this.octaveOffset
        };
    }

    setState(state) {
        if (!state) return;
        if (state.enabled !== undefined) this.enabled = state.enabled;
        if (state.pattern !== undefined) this.pattern = state.pattern;
        if (state.rhythmIndex !== undefined) this.rhythmIndex = state.rhythmIndex;
        if (state.octaveOffset !== undefined) this.octaveOffset = state.octaveOffset;
        
        if (this.uiElements.patternInput) {
            this.uiElements.patternInput.value = this.pattern;
            this.updateKnobsUI();
            this.updateEnableBtn();
            this.renderStepLights();
        }
    }

    // --- MIDI I/O ---

    onMidi(msg) {
        // Lähetetään alkuperäinen MIDI läpi (pass-through)
        if (typeof this.onMidiOut === 'function') {
            this.onMidiOut(msg);
        }

        // Resetoi soittimen tila kun DAW:n Play/Stop -nappia painetaan
        if (msg[0] === 0xFA || msg[0] === 0xFC) {
            this.stopAllBassNotes();
            this.stepIndex = 0;
            if (msg[0] === 0xFC) { // Stop
                this.heldNotes.clear();
                this.updateCurrentChord();
            }
        }

        const status = msg[0] & 0xF0;
        const note = msg[1];
        const velocity = msg[2];

        if (status === 0x90 && velocity > 0) { 
            this.handleNoteOn(note);
        } else if (status === 0x80 || (status === 0x90 && velocity === 0)) { 
            this.handleNoteOff(note);
        }
    }

    emitMidi(msg) {
        if (typeof this.sendMidi === 'function') {
            this.sendMidi(msg);
        } else if (typeof this.onMidiOut === 'function') {
            this.onMidiOut(msg);
        }
    }

    // --- AUDIO WORKLET PITCH DETECTION ---

    async _initWorklet() {
        const workletCode = `
            class BasslinePitchProcessor extends AudioWorkletProcessor {
                constructor() {
                    super();
                    this.bufferSize = 4096;
                    this.buffer = new Float32Array(this.bufferSize);
                    this.writePos = 0;
                    this.currentNote = -1;
                    this.stableFrames = 0;
                    this.silenceFrames = 0;
                    this.rmsThreshold = 0.01;
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
                    const minPeriod = Math.floor(sampleRate / 1200); 
                    const maxPeriod = Math.floor(sampleRate / 60);   

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
                    if (confidence > 0.4) {
                        return { hz: sampleRate / bestPeriod, rms };
                    }
                    return { hz: 0, rms };
                }

                hzToMidi(hz) { return 69 + 12 * Math.log2(hz / 440); }

                process(inputs, outputs) {
                    let hasData = false;
                    if (inputs[0] && inputs[0].length > 0 && inputs[0][0].length > 0) hasData = true;
                    if (inputs[1] && inputs[1].length > 0 && inputs[1][0].length > 0) hasData = true;

                    if (!hasData) return true;

                    const channelData = (inputs[0] && inputs[0].length > 0) ? inputs[0][0] : inputs[1][0];
                    if (channelData) {
                        for (let i = 0; i < channelData.length; i++) {
                            let val = channelData[i] || 0;
                            if (inputs[1] && inputs[1].length > 0 && inputs[1][0]) {
                                val += inputs[1][0][i] || 0;
                            }
                            this.buffer[this.writePos] = val;
                            this.writePos = (this.writePos + 1) % this.bufferSize;
                        }
                    }

                    const { hz, rms } = this.detectPitch();

                    if (hz > 0) {
                        this.silenceFrames = 0;
                        const targetMidi = Math.round(this.hzToMidi(hz));
                        
                        if (targetMidi !== this.currentNote) {
                            this.stableFrames++;
                            if (this.stableFrames >= 3) { 
                                if (this.currentNote !== -1) {
                                    this.port.postMessage({ action: 'noteOff', note: this.currentNote });
                                }
                                this.port.postMessage({ action: 'noteOn', note: targetMidi });
                                this.currentNote = targetMidi;
                                this.stableFrames = 0;
                            }
                        } else {
                            this.stableFrames = 0;
                        }
                    } else {
                        this.silenceFrames++;
                        this.stableFrames = 0;
                        if (this.silenceFrames >= 5 && this.currentNote !== -1) {
                            this.port.postMessage({ action: 'noteOff', note: this.currentNote });
                            this.currentNote = -1;
                        }
                    }
                    return true;
                }
            }
            registerProcessor('bassline-pitch-processor', BasslinePitchProcessor);
        `;

        const dataUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(workletCode);
        try {
            await this.ctx.audioWorklet.addModule(dataUrl);
            this.worklet = new AudioWorkletNode(this.ctx, 'bassline-pitch-processor', { numberOfInputs: 2 });
            this.worklet.port.onmessage = (e) => {
                if (e.data.action === 'noteOn') this.handleNoteOn(e.data.note);
                else if (e.data.action === 'noteOff') this.handleNoteOff(e.data.note);
            };
            
            this.input.connect(this.worklet, 0, 0);
            this.sidechainInput.connect(this.worklet, 0, 1);
        } catch (e) {
            console.error("Bassline Worklet load failed:", e);
        }
    }

    // --- BASSLINE LOGIC ---

    handleNoteOn(note) {
        if (!this.enabled) return;
        const wasEmpty = this.heldNotes.size === 0;
        this.heldNotes.set(note, true);
        this.updateCurrentChord();

        // Aloita sekvensseri, jos se ei ollut käynnissä
        if (wasEmpty && this.pattern.length > 0) {
            this.stepIndex = 0;
            this.runStep();
        }
    }

    handleNoteOff(note) {
        this.heldNotes.delete(note);
        this.updateCurrentChord();

        // Pysäytä sekvensseri, jos ei ole enää nuotteja
        if (this.heldNotes.size === 0) {
            clearTimeout(this.arpTimer);
            this.arpTimer = null;
            this.stopAllBassNotes();
            this.highlightStep(-1);
        }
    }

    updateCurrentChord() {
        // Päivitetään aktiivinen sointu ja lajitellaan alhaalta ylös
        this.currentChord = Array.from(this.heldNotes.keys()).sort((a, b) => a - b);
    }

    getStepDelay() {
        const currentBpm = window.bpm || window.globalTempo || 120;
        const quarterNoteMs = 60000 / currentBpm;
        const div = this.rhythmDivs[this.rhythmIndex];
        return quarterNoteMs * div.mult;
    }

    runStep() {
        if (this.heldNotes.size === 0 || !this.enabled || this.pattern.length === 0) {
            this.stopAllBassNotes();
            this.arpTimer = null;
            return;
        }

        const patternLen = this.pattern.length;
        const char = this.pattern[this.stepIndex % patternLen].toLowerCase();
        
        this.highlightStep(this.stepIndex % patternLen);

        if (char === '0') {
            // Tauko: lopeta kaikki bassonuotit
            this.stopAllBassNotes();
        } else if (char === 'h') {
            // Hold: pidä edellinen nuotti soimassa (älä lähetä note-off)
        } else {
            // Nuotti 1-9
            const num = parseInt(char);
            if (!isNaN(num) && num > 0) {
                // Katkaise aiemmat ennen uuden soittoa
                this.stopAllBassNotes();
                
                const noteIndex = num - 1;
                // Modulo kierto jos patternissa suurempi luku kuin soinnun koko
                const wrappedIndex = noteIndex % this.currentChord.length;
                const baseMidi = this.currentChord[wrappedIndex];
                
                // Lisää oktaavisiirtymä
                const outMidi = baseMidi + (this.octaveOffset * 12);
                
                if (outMidi >= 0 && outMidi <= 127) {
                    this.playBassNote(outMidi, 100);
                }
            } else {
                // Tuntematon merkki, kohdellaan taukona
                this.stopAllBassNotes();
            }
        }

        this.stepIndex++;
        this.arpTimer = setTimeout(() => this.runStep(), this.getStepDelay());
    }

    playBassNote(midiNote, velocity) {
        if (!this.activeBassNotes.has(midiNote)) {
            this.activeBassNotes.add(midiNote);
            this.emitMidi([0x90, midiNote, Math.floor(velocity)]);
        }
    }

    stopAllBassNotes() {
        this.activeBassNotes.forEach(note => {
            this.emitMidi([0x80, note, 0]);
        });
        this.activeBassNotes.clear();
    }

    generateRandomPattern() {
        // Generoi kuvio suosien nuotteja 1,2,3, satunnaisia taukoja 0 ja hold-merkkejä 'h'
        const chars = ['0', '1', '2', '3', 'h', '1', '1', '2', '1']; 
        let res = '';
        let len = this.pattern.length > 0 ? this.pattern.length : 16;
        for (let i = 0; i < len; i++) {
            res += chars[Math.floor(Math.random() * chars.length)];
        }
        // Varmista ettei kuvio ala holdilla 'h'
        if (res[0] === 'h') res = '1' + res.substring(1);
        
        this.pattern = res;
        if (this.uiElements.patternInput) {
            this.uiElements.patternInput.value = res;
            this.renderStepLights();
        }
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(container) {
        this.uiContainer = container;
        const color = '#00ffcc'; 
        container.style.setProperty('--bl-color', color);

        if (!document.getElementById('bl-styles')) {
            const style = document.createElement('style');
            style.id = 'bl-styles';
            style.textContent = `
                .bl-panel { background: #111; padding: 15px; border-radius: 8px; border: 1px solid #333; font-family: monospace; color: #eee; }
                .bl-header { text-align: center; color: var(--bl-color); font-weight: bold; letter-spacing: 2px; text-shadow: 0 0 10px rgba(0, 255, 204, 0.5); margin-bottom: 15px; font-size: 14px; }
                
                .bl-section { background: #1a1a1a; border: 1px solid #333; padding: 10px; border-radius: 6px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 10px; }
                .bl-controls { display: flex; gap: 15px; align-items: center; flex-wrap: wrap; justify-content: space-between; }
                
                .bl-btn { background: #222; border: 1px solid #555; color: #ddd; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-family: monospace; font-size: 11px; transition: 0.2s; }
                .bl-btn:hover { background: #333; border-color: var(--bl-color); }
                .bl-btn.active { background: var(--bl-color); color: #000; border-color: #fff; box-shadow: 0 0 10px var(--bl-color); font-weight: bold; }
                
                .bl-input { background: #000; border: 1px solid #444; color: var(--bl-color); padding: 5px; font-family: monospace; border-radius: 3px; font-size: 14px; letter-spacing: 2px; }
                
                .bl-knob-container { display: flex; gap: 20px; align-items: center; }
                .bl-knob { display: flex; flex-direction: column; align-items: center; min-width: 50px; }
                .bl-knob-svg { width: 35px; height: 35px; transform: rotate(135deg); cursor: ns-resize; }
                .bl-knob-track { fill: none; stroke: #333; stroke-width: 5; stroke-linecap: round; }
                .bl-knob-val { fill: none; stroke: var(--bl-color); stroke-width: 5; stroke-linecap: round; }

                .bl-step-lights { display: flex; gap: 2px; overflow-x: auto; padding: 5px 0; min-height: 10px; }
                .bl-step-light { flex-grow: 1; min-width: 10px; height: 4px; background: #333; border-radius: 2px; transition: 0.1s; }
                .bl-step-light.active { background: var(--bl-color); box-shadow: 0 0 8px var(--bl-color); }
            `;
            document.head.appendChild(style);
        }

        container.innerHTML = `
            <div class="bl-panel">
                <div class="bl-header">MIDI BASSLINE</div>
                
                <div class="bl-section">
                    <div class="bl-controls">
                        <button class="bl-btn ${this.enabled ? 'active' : ''}" id="bl-enable-btn">BASS ON</button>
                        
                        <div style="flex-grow: 1; display: flex; flex-direction: column; align-items: center;">
                            <div style="font-size: 9px; color: #888; margin-bottom: 3px;">PATTERN (0=rest, 1-9=note, h=hold)</div>
                            <div style="display: flex; gap: 5px; width: 100%; max-width: 250px;">
                                <input type="text" id="bl-pattern-input" class="bl-input" value="${this.pattern}" style="flex-grow: 1; text-align: center;">
                                <button class="bl-btn" id="bl-rnd-btn" title="Random Pattern" style="border-color:#00ffcc; padding: 0 8px;">RND</button>
                            </div>
                            <div class="bl-step-lights" id="bl-steps-container" style="width: 100%; max-width: 250px;"></div>
                        </div>

                        <div class="bl-knob-container">
                            <div class="bl-knob" id="bl-rhythm-knob"></div>
                            <div class="bl-knob" id="bl-octave-knob"></div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        this.uiElements.patternInput = container.querySelector('#bl-pattern-input');
        this.uiElements.enableBtn = container.querySelector('#bl-enable-btn');
        this.uiElements.stepsContainer = container.querySelector('#bl-steps-container');
        
        this.bindEvents();
        this.updateKnobsUI();
        this.renderStepLights();
    }

    bindEvents() {
        this.uiElements.enableBtn.addEventListener('click', () => {
            this.enabled = !this.enabled;
            this.updateEnableBtn();
            if (!this.enabled) {
                this.stopAllBassNotes();
                clearTimeout(this.arpTimer);
                this.arpTimer = null;
                this.highlightStep(-1);
            } else if (this.heldNotes.size > 0) {
                this.stepIndex = 0;
                this.runStep();
            }
        });

        this.uiElements.patternInput.addEventListener('input', (e) => {
            // Suodata pois virheelliset merkit (salli 0-9, h, H)
            let val = e.target.value.replace(/[^0-9hH]/g, '');
            e.target.value = val;
            this.pattern = val;
            this.renderStepLights();
        });

        this.uiContainer.querySelector('#bl-rnd-btn').addEventListener('click', () => {
            this.generateRandomPattern();
        });
    }

    updateEnableBtn() {
        if (!this.uiElements.enableBtn) return;
        if (this.enabled) {
            this.uiElements.enableBtn.classList.add('active');
            this.uiElements.enableBtn.innerText = "BASS ON";
        } else {
            this.uiElements.enableBtn.classList.remove('active');
            this.uiElements.enableBtn.innerText = "BASS OFF";
        }
    }

    renderStepLights() {
        if (!this.uiElements.stepsContainer) return;
        const container = this.uiElements.stepsContainer;
        container.innerHTML = '';
        
        const len = this.pattern.length;
        for (let i = 0; i < len; i++) {
            const dot = document.createElement('div');
            dot.className = 'bl-step-light';
            container.appendChild(dot);
        }
    }

    highlightStep(index) {
        if (!this.uiElements.stepsContainer) return;
        const dots = this.uiElements.stepsContainer.children;
        for (let i = 0; i < dots.length; i++) {
            if (i === index) {
                dots[i].classList.add('active');
            } else {
                dots[i].classList.remove('active');
            }
        }
    }

    updateKnobsUI() {
        if (!this.uiContainer) return;

        const rhythmContainer = this.uiContainer.querySelector('#bl-rhythm-knob');
        const octaveContainer = this.uiContainer.querySelector('#bl-octave-knob');

        rhythmContainer.innerHTML = '';
        octaveContainer.innerHTML = '';

        // Rytmi/pituus -nuppi
        this.createKnob(rhythmContainer, "LENGTH", 0, this.rhythmDivs.length - 1, this.rhythmIndex, 
            (v) => this.rhythmDivs[Math.round(v)].label, 
            (v) => { this.rhythmIndex = Math.round(v); }
        );

        // Oktaavisiirtymä -nuppi (-4 ... +1)
        this.createKnob(octaveContainer, "OCTAVE", -4, 1, this.octaveOffset, 
            (v) => {
                let val = Math.round(v);
                return val > 0 ? '+' + val : val.toString();
            }, 
            (v) => { this.octaveOffset = Math.round(v); }
        );
    }

    createKnob(container, label, min, max, defaultValue, formatValue, onChange) {
        const radius = 14, circ = 2 * Math.PI * radius, maxDash = circ * 0.75;
        container.innerHTML = `
            <div style="font-size: 8px; color: #888; text-align: center; margin-bottom: 2px; font-weight: bold;">${label}</div>
            <div style="position: relative; width: 35px; height: 35px; margin: 0 auto;">
                <svg class="bl-knob-svg" viewBox="0 0 35 35">
                    <circle class="bl-knob-track" cx="17.5" cy="17.5" r="${radius}" stroke-dasharray="${maxDash} ${circ}"></circle>
                    <circle class="bl-knob-val" cx="17.5" cy="17.5" r="${radius}" stroke-dasharray="0 ${circ}"></circle>
                </svg>
            </div>
            <div style="font-size: 9px; margin-top: 2px; color: #aaa; text-align: center; font-family: monospace;" class="knob-display">${formatValue(defaultValue)}</div>
        `;

        const valCircle = container.querySelector('.bl-knob-val');
        const display = container.querySelector('.knob-display');
        const svg = container.querySelector('svg');
        let currentVal = defaultValue;

        const updateVis = (val) => {
            const norm = (val - min) / (max - min);
            valCircle.setAttribute('stroke-dasharray', `${norm * maxDash} ${circ}`);
            display.innerText = formatValue(val);
        };
        updateVis(currentVal);

        let isDragging = false, startY = 0, startVal = 0;
        const start = (y) => { 
            isDragging = true; startY = y; startVal = currentVal; document.body.style.cursor = 'ns-resize'; 
        };
        const move = (y) => {
            if (!isDragging) return;
            const delta = (startY - y) / 100; 
            const currentNorm = (startVal - min) / (max - min);
            let newNorm = Math.max(0, Math.min(1, currentNorm + delta));
            
            let newVal = min + newNorm * (max - min);
            newVal = Math.round(newVal); 
            
            if (newVal !== currentVal) { 
                currentVal = newVal; 
                updateVis(newVal); 
                onChange(newVal); 
            }
        };
        const end = () => { if(isDragging) { isDragging = false; document.body.style.cursor = 'default'; } };

        svg.addEventListener('mousedown', e => start(e.clientY));
        window.addEventListener('mousemove', e => move(e.clientY));
        window.addEventListener('mouseup', end);
        svg.addEventListener('touchstart', e => start(e.touches[0].clientY), {passive: false});
        window.addEventListener('touchmove', e => { if(isDragging){e.preventDefault(); move(e.touches[0].clientY);} }, {passive: false});
        window.addEventListener('touchend', end);
    }
}