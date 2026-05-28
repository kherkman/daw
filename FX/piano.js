// piano.js
// Ääniohjattu Pianokoskettimisto - Lisätty MIDI-ohjaus tuki DAW/Host laitteista.
// Toimii myös MIDI-ohjaimena (Pitch-to-MIDI) ilman ladattua WAV-samplea.

window.CustomAudioEffect = class AudioPianoEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.dry = audioCtx.createGain();
        this.wet = audioCtx.createGain();

        this.input.connect(this.dry);
        this.dry.connect(this.output);
        this.wet.connect(this.output);
        
        // KORJAUS: Reititetään tuotettu pianoääni suoraan kaiuttimiin (kuten midi-bass.js tekee)
        // Näin koskettimiston ääni kuuluu vaikka DAW (index.html) ei olisi Play-tilassa.
        this.wet.connect(this.ctx.destination); 

        this.mix = 1.0; 
        this.sensitivity = 0.5;
        
        this.pianoBuffer = null;
        this.baseMidi = 60; // C4
        this.activeVoices = new Map();
        
        this.tuning = new Map();
        this.initDefaultTuning();

        this.knobs = {};
        this.uiElements = {};
        this.keyElements = {};

        // Virtual Keyboard State
        this.keysVisible = false;
        this.virtualOctave = 4;
        this.virtualKeyOffset = 0;
        this.currentKeyMap = {};
        this.pressedKeys = {};

        this.updateMix();
        this._initWorklet();
        this.initKeyboardListeners();
    }

    // --- MIDI-OHJAUS (DAW / HOST SISÄÄN) ---
    onMidi(msg) {
        if (typeof this.onMidiOut === 'function') this.onMidiOut(msg); // Passthrough tuki ketjutukselle

        const status = msg[0] & 0xF0;
        const note = msg[1];
        const velocity = msg[2];

        if (status === 0x90 && velocity > 0) { // Note ON
            this.noteOn(note, velocity, true);
        } else if (status === 0x80 || (status === 0x90 && velocity === 0)) { // Note OFF
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
            this.updateKeyUI(note, false);
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
            registerProcessor('piano-processor', AudioPianoProcessor);
        `;

        const dataUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(workletCode);
        try {
            await this.ctx.audioWorklet.addModule(dataUrl);
            this.worklet = new AudioWorkletNode(this.ctx, 'piano-processor');
            this.worklet.port.onmessage = (e) => {
                if (e.data.type === 'midi') {
                    if (e.data.action === 'noteOn') this.noteOn(e.data.note, e.data.velocity);
                    else if (e.data.action === 'noteOff') this.noteOff(e.data.note);
                }
            };
            this.worklet.port.postMessage({ type: 'sensitivity', value: this.sensitivity });
            this.input.connect(this.worklet);
        } catch (e) {
            console.error("AudioPiano Worklet load failed:", e);
        }
    }

    async loadPianoSample(file) {
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        try {
            const arrayBuffer = await file.arrayBuffer();
            this.pianoBuffer = await this.ctx.decodeAudioData(arrayBuffer);
            if (this.uiElements.loadBtn) {
                this.uiElements.loadBtn.classList.add('active');
                this.uiElements.loadBtn.innerText = "WAV LOADED";
            }
        } catch (e) { console.error("Virhe ladattaessa wav:", e); }
    }
    
    noteOn(note, velocity, isExternalMidi = false) {
        // LÄHETETÄÄN MIDI ULOS DAW/HOSTIIN (Varmistettu toimivuus sendMidi ja onMidiOut kautta)
        const outFunc = this.sendMidi || this.onMidiOut;
        if (!isExternalMidi && typeof outFunc === 'function') {
            outFunc.call(this, [0x90, note, velocity]);
        }
        
        this.updateKeyUI(note, true);

        // JOS EI OLE WAV LADATTU, LOPETETAAN TÄHÄN (toimii pelkkänä MIDI ohjaimena)
        if (!this.pianoBuffer) return; 

        if (this.activeVoices.has(note)) this.noteOff(note, true); // true, jotta ei lähetä turhaa MIDI OFFia

        const now = this.ctx.currentTime;
        const targetHz = this.tuning.get(note) || this.calcDefaultHz(note);
        const baseHz = this.tuning.get(this.baseMidi) || this.calcDefaultHz(this.baseMidi);
        
        const source = this.ctx.createBufferSource();
        source.buffer = this.pianoBuffer;
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
        // LÄHETETÄÄN MIDI ULOS DAW/HOSTIIN
        const outFunc = this.sendMidi || this.onMidiOut;
        if (!isExternalMidi && typeof outFunc === 'function') {
            outFunc.call(this, [0x80, note, 0]);
        }

        this.updateKeyUI(note, false);

        if (!this.activeVoices.has(note)) return;

        const voice = this.activeVoices.get(note);
        const now = this.ctx.currentTime;
        
        voice.vca.gain.cancelScheduledValues(now);
        voice.vca.gain.setValueAtTime(voice.vca.gain.value, now);
        voice.vca.gain.setTargetAtTime(0, now, 0.4); 
        
        voice.source.stop(now + 2.5);
        this.activeVoices.delete(note);
    }

    // --- VIRTUAL KEYBOARD LOGIC ---
    updateKeyMapping() {
        this.currentKeyMap = {};
        const whiteChars = ['a','s','d','f','g','h','j','k','l'];
        
        // Uusi logiikka: Mustan koskettimen pikanäppäin määräytyy fyysisesti vasemmalla 
        // puolella olevan valkoisen koskettimen mukaan
        const blackKeyMap = {
            'a': 'w',
            's': 'e',
            'd': 'r',
            'f': 't',
            'g': 'y',
            'h': 'u',
            'j': 'i',
            'k': 'o',
            'l': 'p'
        };

        const isBlack = (p) => [1,3,6,8,10].includes(p % 12);
        let targetWhiteKeys = (this.virtualOctave) * 7 + this.virtualKeyOffset;
        if (targetWhiteKeys < 0) targetWhiteKeys = 0;

        let startPitch = 12;
        let whiteKeysSeen = 0;
        for(let p = 12; p < 128; p++) {
            if(!isBlack(p)) {
                if(whiteKeysSeen === targetWhiteKeys) {
                    startPitch = p;
                    break;
                }
                whiteKeysSeen++;
            }
        }

        // Tyhjennetään ensin vanhat etiketit
        Object.values(this.keyElements).forEach(el => {
            const hint = el.querySelector('.key-hint');
            if (hint) hint.innerText = '';
        });

        let wIdx = 0;
        let currentPitch = startPitch;
        let lastWhiteChar = null;

        while(wIdx < whiteChars.length && currentPitch <= 108) {
            const black = isBlack(currentPitch);
            let char = '';

            if (black) {
                // Etsi edellisen valkoisen koskettimen ylemmällä rivillä oikealla oleva nappi
                if (lastWhiteChar && blackKeyMap[lastWhiteChar]) {
                    char = blackKeyMap[lastWhiteChar];
                } else {
                    currentPitch++;
                    continue;
                }
            } else {
                char = whiteChars[wIdx++];
                lastWhiteChar = char; // Päivitetään viimeisin valkoinen
            }

            this.currentKeyMap[char] = currentPitch;

            // Päivitetään UI
            if (this.keyElements[currentPitch]) {
                const hint = this.keyElements[currentPitch].querySelector('.key-hint');
                if (hint) hint.innerText = char.toUpperCase();
            }
            currentPitch++;
        }

        if (this.uiElements.keyInfo) {
            const shiftStr = this.virtualKeyOffset > 0 ? '+' + this.virtualKeyOffset : this.virtualKeyOffset;
            this.uiElements.keyInfo.innerHTML = `Oct: ${this.virtualOctave} | Shift: ${shiftStr}<br>(1/2 Oct, 3/4 Shift)`;
        }
    }

    initKeyboardListeners() {
        window.addEventListener('keydown', async (e) => {
            if (e.target.tagName === 'INPUT' || e.repeat || !this.keysVisible) return;
            if (this.ctx.state === 'suspended') await this.ctx.resume();

            const key = e.key.toLowerCase();

            if (key === '1') { this.virtualOctave = Math.max(0, this.virtualOctave - 1); this.updateKeyMapping(); return; }
            if (key === '2') { this.virtualOctave = Math.min(8, this.virtualOctave + 1); this.updateKeyMapping(); return; }
            if (key === '3') { this.virtualKeyOffset--; this.updateKeyMapping(); return; }
            if (key === '4') { this.virtualKeyOffset++; this.updateKeyMapping(); return; }

            if (this.currentKeyMap[key] !== undefined && !this.pressedKeys[key]) {
                e.preventDefault();
                this.pressedKeys[key] = true;
                this.noteOn(this.currentKeyMap[key], 100);
            }
        });

        window.addEventListener('keyup', (e) => {
            // Huom! Ei tarkisteta tässä this.keysVisible, jotta napit voivat vapautua vaikka UI olisi piilotettu
            const key = e.key.toLowerCase();
            if (this.currentKeyMap[key] !== undefined && this.pressedKeys[key]) {
                this.pressedKeys[key] = false;
                this.noteOff(this.currentKeyMap[key]);
            }
        });
    }

    getNodes() { return { input: this.input, output: this.output }; }

    importCSV(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const lines = e.target.result.split(/\r?\n/);
            let importedCount = 0;
            
            lines.forEach(line => {
                if (!line.trim()) return;
                const parts = line.split(/[;,]/);
                if (parts.length >= 2) {
                    const midi = this.noteNameToMidi(parts[0].trim());
                    if (midi >= 21 && midi <= 108) {
                        const hz = parseFloat(parts[1].replace(',', '.').trim());
                        if (!isNaN(hz) && hz > 0) {
                            this.tuning.set(midi, hz);
                            importedCount++;
                        }
                    }
                }
            });
            alert(`Tuotiin ${importedCount} viritysasetusta.`);
        };
        reader.readAsText(file);
    }

    exportCSV() {
        let csvContent = "";
        for (let i = 21; i <= 108; i++) {
            csvContent += `${this.midiToNoteName(i)};${this.tuning.get(i).toFixed(2).replace('.', ',')}\n`;
        }
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        link.setAttribute("href", URL.createObjectURL(blob));
        link.setAttribute("download", "piano_tuning.csv");
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

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

    updateKeyUI(note, isActive) {
        if (this.keyElements[note]) {
            if (isActive) this.keyElements[note].classList.add('active');
            else this.keyElements[note].classList.remove('active');
        }
    }

    // --- TUNING EDITOR UI ---
    openTuningModal() {
        if (document.getElementById('piano-tuning-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'piano-tuning-overlay';
        overlay.className = 'piano-modal-overlay';
        
        const modal = document.createElement('div');
        modal.className = 'piano-modal';
        
        let html = `
            <div class="piano-modal-header">
                <span>PIANO TUNING EDITOR</span>
                <button class="btn-neon" id="btn-close-modal" style="padding: 4px 8px;">X</button>
            </div>
            <div style="display:flex; justify-content:space-between; margin-bottom: 10px;">
                <button class="btn-neon" id="btn-reset-tuning" style="font-size:10px;">RESET EQUAL TEMP.</button>
            </div>
            <div class="piano-modal-body">
                <div class="piano-tuning-row" style="font-weight:bold; color:var(--fx-color); border-bottom:1px solid #333; padding-bottom:5px;">
                    <div>NOTE</div>
                    <div>MIDI</div>
                    <div>FREQ (Hz)</div>
                    <div>CENTS</div>
                </div>
        `;

        for (let i = 21; i <= 108; i++) {
            const currentHz = this.tuning.get(i) || this.calcDefaultHz(i);
            const standardHz = this.calcDefaultHz(i);
            const cents = 1200 * Math.log2(currentHz / standardHz);

            html += `
                <div class="piano-tuning-row">
                    <div>${this.midiToNoteName(i)}</div>
                    <div>${i}</div>
                    <div><input type="number" step="0.01" class="piano-tuning-input hz-input" data-midi="${i}" value="${currentHz.toFixed(2)}"></div>
                    <div><input type="number" step="0.1" class="piano-tuning-input cent-input" data-midi="${i}" value="${cents.toFixed(2)}"></div>
                </div>
            `;
        }

        html += `</div>`;
        modal.innerHTML = html;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Event Listeners
        modal.querySelector('#btn-close-modal').addEventListener('click', () => {
            document.body.removeChild(overlay);
        });

        modal.querySelector('#btn-reset-tuning').addEventListener('click', () => {
            this.initDefaultTuning();
            document.body.removeChild(overlay);
            this.openTuningModal(); // Reopen to refresh values
        });

        const hzInputs = modal.querySelectorAll('.hz-input');
        const centInputs = modal.querySelectorAll('.cent-input');

        hzInputs.forEach((input, index) => {
            input.addEventListener('change', (e) => {
                const midi = parseInt(e.target.dataset.midi);
                const hz = parseFloat(e.target.value);
                if (!isNaN(hz) && hz > 0) {
                    this.tuning.set(midi, hz);
                    const standardHz = this.calcDefaultHz(midi);
                    const cents = 1200 * Math.log2(hz / standardHz);
                    centInputs[index].value = cents.toFixed(2);
                }
            });
        });

        centInputs.forEach((input, index) => {
            input.addEventListener('change', (e) => {
                const midi = parseInt(e.target.dataset.midi);
                const cents = parseFloat(e.target.value);
                if (!isNaN(cents)) {
                    const standardHz = this.calcDefaultHz(midi);
                    const hz = standardHz * Math.pow(2, cents / 1200);
                    this.tuning.set(midi, hz);
                    hzInputs[index].value = hz.toFixed(2);
                }
            });
        });
    }

    renderUI(containerElement) {
        const color = '#ff0055'; 
        containerElement.style.setProperty('--fx-color', color);

        const styleId = 'fx-piano-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .piano-panel { background: #111; padding: 15px; border-radius: 8px; border: 1px solid #333; display: flex; flex-direction: column; gap: 15px; box-shadow: inset 0 0 20px rgba(0,0,0,0.5); font-family: monospace;}
                .piano-row { display: flex; justify-content: space-between; align-items: flex-end; gap: 15px; flex-wrap: wrap; }
                
                .btn-neon { 
                    background: #0a0a0a; border: 1px solid var(--fx-color); color: var(--fx-color); 
                    cursor: pointer; padding: 8px 12px; border-radius: 4px; font-family: monospace; 
                    font-weight: bold; font-size: 11px; letter-spacing: 1px; transition: all 0.2s; 
                    box-shadow: inset 0 0 5px rgba(255, 0, 85, 0.1); text-align: center; display: inline-block;
                }
                .btn-neon:hover { background: rgba(255, 0, 85, 0.1); box-shadow: inset 0 0 10px rgba(255, 0, 85, 0.3), 0 0 5px rgba(255, 0, 85, 0.4); }
                .btn-neon.active { background: var(--fx-color); color: #000; box-shadow: 0 0 15px var(--fx-color), inset 0 0 5px rgba(255,255,255,0.5); }
                
                .btn-csv { border-color: #00ffff; color: #00ffff; box-shadow: inset 0 0 5px rgba(0, 255, 255, 0.1); }
                .btn-csv:hover { background: rgba(0, 255, 255, 0.1); box-shadow: inset 0 0 10px rgba(0, 255, 255, 0.3), 0 0 5px rgba(0, 255, 255, 0.4); }

                .piano-keyboard-container {
                    width: 100%; height: 100px; background: #000; border: 2px solid #333; border-radius: 4px;
                    display: flex; position: relative; overflow: hidden; box-shadow: 0 5px 15px rgba(0,0,0,0.8);
                }
                .piano-key { position: relative; cursor: default; }
                .piano-key.white { 
                    flex: 1; background: #eee; border-right: 1px solid #ccc; border-bottom: 2px solid #bbb; border-radius: 0 0 3px 3px; z-index: 1;
                }
                .piano-key.white.active { background: #ffb3c6; box-shadow: inset 0 0 15px #ff0055; }
                .piano-key.black {
                    position: absolute; background: #111; width: calc(100% / 52 * 0.6); height: 60%;
                    border-radius: 0 0 2px 2px; border: 1px solid #000; border-top: none; z-index: 2;
                    transform: translateX(-50%);
                    background: linear-gradient(to bottom, #333, #000);
                }
                .piano-key.black.active { background: var(--fx-color); box-shadow: 0 0 15px var(--fx-color); }
                
                /* Hotkey hints */
                .key-hint { position: absolute; bottom: 5px; width: 100%; text-align: center; font-size: 10px; color: #555; pointer-events: none; display: none; font-weight: bold; font-family: monospace;}
                .piano-key.black .key-hint { color: #aaa; bottom: 10px; }
                .show-keys .key-hint { display: block; }

                .knob-container { display: flex; flex-direction: column; align-items: center; user-select: none; width: 50px; }
                .knob-wrapper { position: relative; width: 40px; height: 40px; cursor: ns-resize; margin-bottom: 5px; touch-action: none; }
                .knob-svg { width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 3px rgba(255,0,85,0.2));}
                .knob-track { fill: none; stroke: #222; stroke-width: 6; stroke-linecap: round; }
                .knob-value-path { fill: none; stroke: var(--fx-color); stroke-width: 6; stroke-linecap: round; transition: stroke 0.2s; }
                .knob-center { fill: #111; stroke: #333; stroke-width: 1.5; }
                .knob-indicator { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
                .knob-dot { position: absolute; width: 4px; height: 4px; background: var(--fx-color); border-radius: 50%; top: 4px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 5px var(--fx-color);}
                .knob-label { font-size: 9px; color: #8b8b9f; margin-bottom: 3px; text-align: center;}
                .knob-value-display { font-size: 9px; color: #ccc; background: #000; padding: 2px 5px; border-radius: 3px; border: 1px solid #333; }

                /* Modal Styles */
                .piano-modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 9999; display: flex; justify-content: center; align-items: center; backdrop-filter: blur(4px); }
                .piano-modal { background: #111; border: 1px solid var(--fx-color); border-radius: 8px; padding: 20px; width: 450px; max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 0 30px rgba(255,0,85,0.2); font-family: monospace; }
                .piano-modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; color: var(--fx-color); font-size: 16px; font-weight: bold; letter-spacing: 2px;}
                .piano-modal-body { overflow-y: auto; flex: 1; padding-right: 10px; }
                .piano-modal-body::-webkit-scrollbar { width: 8px; }
                .piano-modal-body::-webkit-scrollbar-track { background: #000; border-radius: 4px; }
                .piano-modal-body::-webkit-scrollbar-thumb { background: var(--fx-color); border-radius: 4px; }
                .piano-tuning-row { display: grid; grid-template-columns: 1fr 1fr 1.5fr 1.5fr; gap: 10px; margin-bottom: 8px; align-items: center; color: #ccc; font-size: 12px; }
                .piano-tuning-input { background: #000; border: 1px solid #333; color: #00ffff; padding: 6px; width: 100%; border-radius: 3px; text-align: center; font-family: monospace; box-sizing: border-box; }
                .piano-tuning-input:focus { outline: none; border-color: #00ffff; box-shadow: 0 0 5px rgba(0,255,255,0.3); }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div style="margin-bottom: 15px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 4px; font-size: 14px; text-shadow: 0 0 10px rgba(255,0,85,0.5); font-family: monospace;">AUDIO/MIDI TO PIANO</div>
            
            <div class="piano-panel">
                <div class="piano-row">
                    <div style="display:flex; flex-direction:column; gap:8px;">
                        <input type="file" id="piano-wav-upload" accept="audio/wav,audio/mp3" style="display:none;">
                        <button class="btn-neon" id="btn-load-piano">LOAD WAV</button>
                        <button class="btn-neon" id="btn-toggle-keys" style="border-color:#8e24aa; color:#8e24aa;">SHOW KEYS</button>
                        <div id="piano-key-info" style="font-size: 9px; color: #8e24aa; text-align: center; display: none;">Oct: 4 | Shift: 0<br>(1/2 Oct, 3/4 Shift)</div>
                    </div>

                    <div style="display:flex; flex-direction:column; gap:8px; align-items:center;">
                        <div style="font-size: 10px; color: #00ffff; font-weight: bold; letter-spacing: 1px; font-family: monospace;">CUSTOM TUNING</div>
                        <div style="display:flex; gap: 5px;">
                            <input type="file" id="csv-upload" accept=".csv" style="display:none;">
                            <button class="btn-neon btn-csv" id="btn-edit-tuning">EDIT TUNING</button>
                            <button class="btn-neon btn-csv" id="btn-import-csv">IMPORT CSV</button>
                            <button class="btn-neon btn-csv" id="btn-export-csv">EXPORT CSV</button>
                        </div>
                    </div>

                    <div style="display:flex; gap:15px;">
                        <div id="sens-knob-area"></div>
                        <div id="mix-knob-area"></div>
                    </div>
                </div>
                <div class="piano-keyboard-container" id="piano-keyboard"></div>
            </div>
        `;

        this.uiElements.loadBtn = containerElement.querySelector('#btn-load-piano');
        const fileInput = containerElement.querySelector('#piano-wav-upload');

        this.uiElements.loadBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => { if (e.target.files.length > 0) this.loadPianoSample(e.target.files[0]); });
        
        // Keys Toggle Logic
        const toggleKeysBtn = containerElement.querySelector('#btn-toggle-keys');
        const keyboardContainer = containerElement.querySelector('#piano-keyboard');
        this.uiElements.keyInfo = containerElement.querySelector('#piano-key-info');

        toggleKeysBtn.addEventListener('click', () => {
            this.keysVisible = !this.keysVisible;
            if (this.keysVisible) {
                keyboardContainer.classList.add('show-keys');
                toggleKeysBtn.classList.add('active');
                this.uiElements.keyInfo.style.display = 'block';
                this.updateKeyMapping();
            } else {
                keyboardContainer.classList.remove('show-keys');
                toggleKeysBtn.classList.remove('active');
                this.uiElements.keyInfo.style.display = 'none';
                this.killAllNotes(); // Sammutetaan päälle jääneet äänet kun piilotetaan
            }
        });

        const importCsvBtn = containerElement.querySelector('#btn-import-csv');
        const exportCsvBtn = containerElement.querySelector('#btn-export-csv');
        const editTuningBtn = containerElement.querySelector('#btn-edit-tuning');
        const csvInput = containerElement.querySelector('#csv-upload');

        editTuningBtn.addEventListener('click', () => this.openTuningModal());
        importCsvBtn.addEventListener('click', () => csvInput.click());
        csvInput.addEventListener('change', (e) => { if (e.target.files.length > 0) this.importCSV(e.target.files[0]); });
        exportCsvBtn.addEventListener('click', () => this.exportCSV());

        const keyboard = containerElement.querySelector('#piano-keyboard');
        this.keyElements = {};
        
        let whiteKeyCount = 0;
        const isBlackKey = (midi) => [1, 3, 6, 8, 10].includes(midi % 12);

        const getClickVelocity = (e, element) => {
            const rect = element.getBoundingClientRect();
            const clientY = e.touches && e.touches.length > 0 ? e.touches[0].clientY : e.clientY;
            const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
            const ratio = y / rect.height; 
            return Math.floor(20 + ratio * 107); // 20 - 127
        };

        for (let i = 21; i <= 108; i++) {
            const keyDiv = document.createElement('div');
            keyDiv.className = 'piano-key';
            keyDiv.title = `${this.midiToNoteName(i)} (Midi ${i})`;
            
            if (isBlackKey(i)) {
                keyDiv.classList.add('black');
                keyDiv.style.left = `calc((100% / 52) * ${whiteKeyCount})`;
            } else {
                keyDiv.classList.add('white');
                whiteKeyCount++;
            }

            keyDiv.innerHTML = `<div class="key-hint"></div>`;
            
            // Mouse events
            keyDiv.addEventListener('mousedown', (e) => {
                e.preventDefault(); 
                if (this.ctx.state === 'suspended') this.ctx.resume();
                this.noteOn(i, getClickVelocity(e, keyDiv));
            });
            keyDiv.addEventListener('mouseup', () => this.noteOff(i));
            keyDiv.addEventListener('mouseleave', () => this.noteOff(i));

            // Touch events
            keyDiv.addEventListener('touchstart', (e) => {
                e.preventDefault();
                if (this.ctx.state === 'suspended') this.ctx.resume();
                this.noteOn(i, getClickVelocity(e, keyDiv));
            }, { passive: false });
            keyDiv.addEventListener('touchend', (e) => {
                e.preventDefault();
                this.noteOff(i);
            }, { passive: false });
            keyDiv.addEventListener('touchcancel', (e) => {
                e.preventDefault();
                this.noteOff(i);
            }, { passive: false });

            this.keyElements[i] = keyDiv;
            keyboard.appendChild(keyDiv);
        }

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
    }
}