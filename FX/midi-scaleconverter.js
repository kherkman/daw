window.CustomAudioEffect = class ScaleConverterEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;

        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.input.connect(this.output);
        
        this.NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

        this.SCALES = {
            "Major": "2212221",
            "Minor": "2122122",
            "Dorian": "2122212",
            "Phrygian": "1222122",
            "Lydian": "2221221",
            "Mixolydian": "2212212",
            "Locrian": "1221222",
            "Harmonic Minor": "2122131",
            "Phrygian Dominant": "1312122",
            "Melodic Minor": "2122221",
            "Pentatonic Major": "22323",
            "Pentatonic Minor": "32232",
            "Chromatic": "111111111111"
        };

        this.mappings = [];
        for (let i = 0; i < 12; i++) {
            this.mappings.push({ pc: i, octOffset: 0 });
        }

        this.activeNotes = new Map(); 
        this.customScaleMode = false;
        this.customFormat = 'steps'; 

        this.uiElements = {};
    }

    getNodes() { return { input: this.input, output: this.output }; }

    getState() {
        return {
            mappings: JSON.parse(JSON.stringify(this.mappings)),
            customScaleMode: this.customScaleMode,
            customFormat: this.customFormat
        };
    }

    setState(state) {
        if (state) {
            if (state.mappings) this.mappings = state.mappings;
            if (state.customScaleMode !== undefined) this.customScaleMode = state.customScaleMode;
            if (state.customFormat !== undefined) this.customFormat = state.customFormat;
            this.updateUI();
        }
    }

    onMidi(msg) {
        const status = msg[0] & 0xF0;
        const data1 = msg[1];
        const data2 = msg[2];

        if (msg[0] === 0xFA || msg[0] === 0xFB || (status === 0xB0 && data1 === 123)) {
            this.clearActiveNotes();
            this.emitMidi(msg);
            return;
        }

        if (status === 0x90 && data2 > 0) { 
            this.handleNoteOn(data1, data2);
        } else if (status === 0x80 || (status === 0x90 && data2 === 0)) { 
            this.handleNoteOff(data1);
        } else {
            this.emitMidi(msg);
        }
    }

    emitMidi(msg) {
        if (typeof this.sendMidi === 'function') {
            this.sendMidi(msg);
        } else if (typeof this.onMidiOut === 'function') {
            this.onMidiOut(msg);
        }
    }

    handleNoteOn(note, velocity) {
        const pc = note % 12;
        const oct = Math.floor(note / 12);
        const map = this.mappings[pc];

        const outPitch = (oct + map.octOffset) * 12 + map.pc;

        // Estetään mahdolliset bugit, jos outPitch lipsahtaa NaN:iksi huonon asteikon takia
        if (!isNaN(outPitch) && outPitch >= 0 && outPitch <= 127) {
            this.activeNotes.set(note, outPitch);
            this.emitMidi([0x90, outPitch, velocity]);
            this.highlightUI(pc, true);
        }
    }

    handleNoteOff(note) {
        if (this.activeNotes.has(note)) {
            const outPitch = this.activeNotes.get(note);
            this.emitMidi([0x80, outPitch, 0]);
            this.activeNotes.delete(note);
            
            let pcStillActive = false;
            for (let key of this.activeNotes.keys()) {
                if (key % 12 === note % 12) pcStillActive = true;
            }
            if (!pcStillActive) {
                this.highlightUI(note % 12, false);
            }
        }
    }

    clearActiveNotes() {
        for (let outPitch of this.activeNotes.values()) {
            this.emitMidi([0x80, outPitch, 0]);
        }
        this.activeNotes.clear();
        for (let i = 0; i < 12; i++) {
            this.highlightUI(i, false);
        }
    }

    stepsToIntervalsStr(stepsStr) {
        if (!stepsStr) return [0];
        let cleanStr = stepsStr.toString().replace(/[^0-9A-Fa-f]/g, ''); 
        if (cleanStr.length === 0) return [0];
        let intervals = [0];
        let sum = 0;
        for(let i = 0; i < cleanStr.length - 1; i++) {
            sum += parseInt(cleanStr[i], 16); 
            if (sum < 12) intervals.push(sum);
        }
        return intervals;
    }

    intervalsToStepsStr(intervalsArr) {
        if (!intervalsArr || intervalsArr.length === 0) return "12";
        let steps = "";
        for (let i = 1; i < intervalsArr.length; i++) {
            steps += (intervalsArr[i] - intervalsArr[i-1]).toString(16);
        }
        steps += (12 - intervalsArr[intervalsArr.length-1]).toString(16);
        return steps;
    }

    parseIntervalsStr(intStr) {
        if (!intStr) return [0];
        const arr = intStr.split(/[\s,-]+/).map(Number).filter(n => !isNaN(n) && n >= 0 && n < 12);
        if (arr.length === 0) return [0];
        if (arr[0] !== 0) arr.unshift(0);
        return Array.from(new Set(arr)).sort((a,b) => a-b);
    }

    autoConvert() {
        if (!this.uiElements.inRoot) return;

        const inRoot = parseInt(this.uiElements.inRoot.value);
        const outRoot = parseInt(this.uiElements.outRoot.value);
        
        let inScale, outScale;

        if (this.customScaleMode) {
            if (this.customFormat === 'steps') {
                inScale = this.stepsToIntervalsStr(this.uiElements.inScaleCustom.value);
                outScale = this.stepsToIntervalsStr(this.uiElements.outScaleCustom.value);
            } else {
                inScale = this.parseIntervalsStr(this.uiElements.inScaleCustom.value);
                outScale = this.parseIntervalsStr(this.uiElements.outScaleCustom.value);
            }
        } else {
            const inScaleName = this.uiElements.inScale.value;
            const outScaleName = this.uiElements.outScale.value;
            inScale = this.stepsToIntervalsStr(this.SCALES[inScaleName]);
            outScale = this.stepsToIntervalsStr(this.SCALES[outScaleName]);
        }

        if (!inScale || inScale.length === 0) inScale = [0];
        if (!outScale || outScale.length === 0) outScale = [0];

        let baseIn = 48 + inRoot;
        let rootShift = outRoot - inRoot;
        if (rootShift > 6) rootShift -= 12;
        if (rootShift < -6) rootShift += 12;
        let baseOut = baseIn + rootShift;

        let inNotes = inScale.map(i => baseIn + i);
        let outNotes = outScale.map(i => baseOut + i);

        inNotes.push(baseIn + 12);
        outNotes.push(baseOut + 12);

        for (let pc = 0; pc < 12; pc++) {
            let testNote = 48 + pc;
            while (testNote < baseIn) testNote += 12;
            while (testNote >= baseIn + 12) testNote -= 12;

            let mappedNote = testNote;
            
            for (let i = 0; i < inNotes.length - 1; i++) {
                let outIdx1 = Math.min(i, outNotes.length - 2); 
                let outIdx2 = Math.min(i + 1, outNotes.length - 1);

                if (testNote === inNotes[i]) {
                    mappedNote = outNotes[outIdx1];
                    break;
                } else if (testNote > inNotes[i] && testNote < inNotes[i+1]) {
                    let offset = testNote - inNotes[i];
                    let maxIntervalSpace = Math.max(0, outNotes[outIdx2] - outNotes[outIdx1] - 1);
                    mappedNote = outNotes[outIdx1] + Math.min(offset, maxIntervalSpace);
                    break;
                }
            }

            let origAbs = 48 + pc;
            let octShift = (testNote - origAbs) / 12; 
            let finalMappedAbs = mappedNote - (octShift * 12);

            let targetPC = ((finalMappedAbs % 12) + 12) % 12;
            let targetOctOffset = Math.floor(finalMappedAbs / 12) - Math.floor(origAbs / 12);

            this.mappings[pc] = { pc: targetPC, octOffset: targetOctOffset };
        }

        this.updateUI();
    }

    updateUI() {
        if (!this.uiElements.rows) return;
        for (let i = 0; i < 12; i++) {
            const map = this.mappings[i];
            this.uiElements.rows[i].targetPcSelect.value = map.pc;
            this.uiElements.rows[i].targetOctSelect.value = map.octOffset;
        }
    }

    highlightUI(pc, isPlaying) {
        if (!this.uiElements.rows || !this.uiElements.rows[pc]) return;
        const row = this.uiElements.rows[pc].container;
        if (isPlaying) {
            row.style.borderColor = '#00ffff';
            row.style.boxShadow = 'inset 0 0 10px rgba(0, 255, 255, 0.3)';
            row.style.backgroundColor = 'rgba(0, 255, 255, 0.1)';
        } else {
            row.style.borderColor = '#333';
            row.style.boxShadow = 'none';
            row.style.backgroundColor = 'transparent';
        }
    }

    renderUI(containerElement) {
        const styleId = 'fx-scaleconverter-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .sc-panel { background: #0a0a0a; padding: 15px; border-radius: 8px; border: 1px solid #333; display: flex; flex-direction: column; gap: 12px; box-shadow: inset 0 0 20px rgba(0,0,0,0.8); font-family: sans-serif;}
                .sc-top-bar { background: rgba(0,0,0,0.3); padding: 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); }
                .sc-header { color: #00ffff; font-weight: bold; letter-spacing: 2px; font-size: 14px; text-shadow: 0 0 10px rgba(0,255,255,0.5); margin-bottom: 10px; text-align: center; }
                
                .sc-controls { display: flex; justify-content: center; gap: 10px; margin-bottom: 15px; }
                
                .sc-auto-grid { display: grid; grid-template-columns: 1fr auto 1fr auto; gap: 10px; align-items: center; margin-bottom: 10px;}
                .sc-select { background: #1a1a24; border: 1px solid #444; color: #fff; padding: 6px; border-radius: 4px; font-size: 12px; outline: none; width: 100%; box-sizing: border-box; cursor: pointer;}
                .sc-select:hover { border-color: #00ffff; }
                .sc-select option { background: #111; color: #fff; }
                
                .sc-input { background: #1a1a24; border: 1px solid #444; color: #fff; padding: 6px; border-radius: 4px; font-size: 12px; outline: none; width: 100%; box-sizing: border-box; font-family: monospace;}
                .sc-input:focus { border-color: #00ffff; }

                .sc-btn { background: #1a1a24; border: 1px solid #00ffff; color: #00ffff; padding: 6px 15px; border-radius: 4px; font-size: 12px; cursor: pointer; text-transform: uppercase; font-weight: bold; transition: all 0.2s; box-shadow: 0 0 5px rgba(0,255,255,0.2); }
                .sc-btn:hover { background: rgba(0, 255, 255, 0.2); box-shadow: 0 0 15px rgba(0,255,255,0.5); }
                
                .sc-arrow { color: #555; font-weight: bold; font-size: 16px; text-align: center;}
                
                .sc-mappings-list { display: flex; flex-direction: column; gap: 4px; max-height: 350px; overflow-y: auto; padding-right: 5px;}
                .sc-mappings-list::-webkit-scrollbar { width: 6px; }
                .sc-mappings-list::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }

                .sc-row { display: grid; grid-template-columns: 40px auto 1fr 1fr; gap: 10px; align-items: center; padding: 6px 10px; background: #0f0f14; border: 1px solid #333; border-radius: 4px; transition: all 0.1s;}
                .sc-in-note { font-weight: bold; color: #fff; font-size: 14px; text-align: center; }
            `;
            document.head.appendChild(style);
        }

        const rootOptions = this.NOTE_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('');
        const scaleOptions = Object.keys(this.SCALES).map(s => `<option value="${s}">${s}</option>`).join('');
        const octOptions = [-3, -2, -1, 0, 1, 2, 3].map(o => `<option value="${o}">${o > 0 ? '+'+o : o} Oct</option>`).join('');

        containerElement.innerHTML = `
            <div class="sc-panel">
                <div class="sc-top-bar">
                    <div class="sc-header">MIDI SCALE CONVERTER</div>
                    
                    <div class="sc-controls">
                        <button id="btn-toggle-custom" class="sc-btn" style="width:auto; padding: 6px 10px;">Mode: Dropdown</button>
                        <button id="btn-toggle-format" class="sc-btn" style="width:auto; padding: 6px 10px; display:none;">Format: Steps</button>
                    </div>

                    <div class="sc-auto-grid">
                        <div style="display:flex; gap: 5px;">
                            <select id="in-root" class="sc-select" style="width: 50px;">${rootOptions}</select>
                            <div style="flex:1;">
                                <select id="in-scale" class="sc-select">${scaleOptions}</select>
                                <input type="text" id="in-scale-custom" class="sc-input" style="display:none;" />
                            </div>
                        </div>
                        <div class="sc-arrow">➝</div>
                        <div style="display:flex; gap: 5px;">
                            <select id="out-root" class="sc-select" style="width: 50px;">${rootOptions}</select>
                            <div style="flex:1;">
                                <select id="out-scale" class="sc-select">${scaleOptions}</select>
                                <input type="text" id="out-scale-custom" class="sc-input" style="display:none;" />
                            </div>
                        </div>
                        <button id="btn-convert" class="sc-btn" style="width: 100%;">Convert</button>
                    </div>
                </div>

                <div class="sc-mappings-list" id="mappings-list"></div>
            </div>
        `;

        this.uiElements.inRoot = containerElement.querySelector('#in-root');
        this.uiElements.inScale = containerElement.querySelector('#in-scale');
        this.uiElements.inScaleCustom = containerElement.querySelector('#in-scale-custom');
        
        this.uiElements.outRoot = containerElement.querySelector('#out-root');
        this.uiElements.outScale = containerElement.querySelector('#out-scale');
        this.uiElements.outScaleCustom = containerElement.querySelector('#out-scale-custom');
        
        const btnToggleCustom = containerElement.querySelector('#btn-toggle-custom');
        const btnToggleFormat = containerElement.querySelector('#btn-toggle-format');
        
        containerElement.querySelector('#btn-convert').onclick = () => this.autoConvert();

        // UI Tilan asettaja logiikka korjattu erilliseksi funktioksi virheiden välttämiseksi
        const syncCustomModeUI = () => {
            if (this.customScaleMode) {
                btnToggleCustom.innerText = 'Mode: Custom Input';
                btnToggleFormat.style.display = 'inline-block';
                
                this.uiElements.inScale.style.display = 'none';
                this.uiElements.outScale.style.display = 'none';
                this.uiElements.inScaleCustom.style.display = 'inline-block';
                this.uiElements.outScaleCustom.style.display = 'inline-block';
            } else {
                btnToggleCustom.innerText = 'Mode: Dropdown';
                btnToggleFormat.style.display = 'none';
                
                this.uiElements.inScale.style.display = 'inline-block';
                this.uiElements.outScale.style.display = 'inline-block';
                this.uiElements.inScaleCustom.style.display = 'none';
                this.uiElements.outScaleCustom.style.display = 'none';
            }
            
            if (this.customFormat === 'steps') btnToggleFormat.innerText = 'Format: Steps';
            else btnToggleFormat.innerText = 'Format: Intervals';
        };

        btnToggleCustom.onclick = () => {
            this.customScaleMode = !this.customScaleMode;
            if (this.customScaleMode) {
                let inSteps = this.SCALES[this.uiElements.inScale.value];
                let outSteps = this.SCALES[this.uiElements.outScale.value];
                
                if (this.customFormat === 'steps') {
                    this.uiElements.inScaleCustom.value = inSteps;
                    this.uiElements.outScaleCustom.value = outSteps;
                } else {
                    this.uiElements.inScaleCustom.value = this.stepsToIntervalsStr(inSteps).join(', ');
                    this.uiElements.outScaleCustom.value = this.stepsToIntervalsStr(outSteps).join(', ');
                }
            }
            syncCustomModeUI();
        };

        btnToggleFormat.onclick = () => {
            if (this.customFormat === 'steps') {
                this.customFormat = 'intervals';
                let inInt = this.stepsToIntervalsStr(this.uiElements.inScaleCustom.value);
                let outInt = this.stepsToIntervalsStr(this.uiElements.outScaleCustom.value);
                this.uiElements.inScaleCustom.value = inInt.join(', ');
                this.uiElements.outScaleCustom.value = outInt.join(', ');
            } else {
                this.customFormat = 'steps';
                let inSteps = this.intervalsToStepsStr(this.parseIntervalsStr(this.uiElements.inScaleCustom.value));
                let outSteps = this.intervalsToStepsStr(this.parseIntervalsStr(this.uiElements.outScaleCustom.value));
                this.uiElements.inScaleCustom.value = inSteps;
                this.uiElements.outScaleCustom.value = outSteps;
            }
            syncCustomModeUI();
        };

        const listContainer = containerElement.querySelector('#mappings-list');
        this.uiElements.rows = [];

        for (let i = 0; i < 12; i++) {
            const row = document.createElement('div');
            row.className = 'sc-row';

            row.innerHTML = `
                <div class="sc-in-note">${this.NOTE_NAMES[i]}</div>
                <div class="sc-arrow" style="font-size: 12px; color: #444;">►</div>
                <select class="sc-select row-pc">${rootOptions}</select>
                <select class="sc-select row-oct">${octOptions}</select>
            `;

            const pcSelect = row.querySelector('.row-pc');
            const octSelect = row.querySelector('.row-oct');

            pcSelect.value = i;
            octSelect.value = 0;

            pcSelect.onchange = () => {
                this.mappings[i].pc = parseInt(pcSelect.value);
            };
            octSelect.onchange = () => {
                this.mappings[i].octOffset = parseInt(octSelect.value);
            };

            listContainer.appendChild(row);
            this.uiElements.rows.push({
                container: row,
                targetPcSelect: pcSelect,
                targetOctSelect: octSelect
            });
        }

        this.uiElements.inScale.value = "Major";
        this.uiElements.outScale.value = "Minor";
        
        syncCustomModeUI();
        this.updateUI();
    }
};