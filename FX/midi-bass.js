// midi-bass.js
window.CustomAudioEffect = class MidiBassEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;

        // Audio Routing
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.wet = audioCtx.createGain(); 
        
        // Pass-through alkuperäiselle audiolle
        this.input.connect(this.output);

        // Piilotetut filtterit bassolle
        this.hpf = audioCtx.createBiquadFilter();
        this.hpf.type = 'highpass';
        this.hpf.frequency.value = 30; 

        this.lpf = audioCtx.createBiquadFilter();
        this.lpf.type = 'lowpass';
        this.lpf.frequency.value = 4500; 

        // EQ Noodit
        this.eqBass = audioCtx.createBiquadFilter();
        this.eqBass.type = 'lowshelf';
        this.eqBass.frequency.value = 100;
        
        this.eqMid = audioCtx.createBiquadFilter();
        this.eqMid.type = 'peaking';
        this.eqMid.frequency.value = 800;
        this.eqMid.Q.value = 1.0;

        this.eqTreble = audioCtx.createBiquadFilter();
        this.eqTreble.type = 'highshelf';
        this.eqTreble.frequency.value = 3000;

        this.vcaOut = audioCtx.createGain();

        // Kytkentä
        this.wet.connect(this.hpf);
        this.hpf.connect(this.lpf);
        this.lpf.connect(this.eqBass);
        this.eqBass.connect(this.eqMid);
        this.eqMid.connect(this.eqTreble);
        this.eqTreble.connect(this.vcaOut);
        
        this.vcaOut.connect(this.output);
        this.vcaOut.connect(this.ctx.destination);

        // Parametrien oletusarvot
        this.eqBass.gain.value = 0;
        this.eqMid.gain.value = 0;
        this.eqTreble.gain.value = 0;
        this.vcaOut.gain.value = 0.8;

        // Tila ja muuttujat
        this.baseMidi = 60; // C4
        this.buffers = [null, null, null];
        this.currentStyle = 0;
        
        // Basson 4 kieltä ja niiden tila (Monofoninen kielilogiikka)
        this.numStrings = 4;
        this.stringStates = Array.from({ length: this.numStrings }, () => ({
            heldNotes: [], 
            activeVoice: null,
            lastVelocity: 100
        }));
        
        this.styleTriggers = [72, 74, 76];
        this.defaultTunings = [28, 33, 38, 43]; // Standard E1, A1, D2, G2
        this.currentTunings = [...this.defaultTunings];

        this.uiElements = {};
        this.knobs = {};
        this.keysVisible = false;

        this.loadDefaultSamples();
        this.initKeyboardListeners();
    }

    async loadDefaultSamples() {
        const files = ['bass/bass1.wav', 'bass/bass2.wav', 'bass/bass3.wav'];
        for (let i = 0; i < files.length; i++) {
            try {
                const response = await fetch(files[i]);
                if (response.ok) {
                    const arrayBuffer = await response.arrayBuffer();
                    this.buffers[i] = await this.ctx.decodeAudioData(arrayBuffer);
                }
            } catch (e) {
                console.warn(`Midi-bass: Ei voitu ladata oletussamplea ${files[i]}`);
            }
        }
    }

    midiToNoteName(midi) {
        const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
        return `${notes[midi % 12]}${Math.floor(midi / 12) - 1}`;
    }

    onMidi(msg) {
        if (typeof this.onMidiOut === 'function') this.onMidiOut(msg);

        const status = msg[0] & 0xF0;
        const note = msg[1];
        const velocity = msg[2];

        if (status === 0x90 && velocity > 0) {
            const styleIdx = this.styleTriggers.indexOf(note);
            if (styleIdx !== -1) {
                this.setStyle(styleIdx);
                return;
            }
            this.noteOn(note, velocity, -1, true);
        } else if (status === 0x80 || (status === 0x90 && velocity === 0)) {
            this.noteOff(note, true);
        }
    }

    allocateString(midiNote) {
        let possibleStrings = [];
        for (let s = 0; s < this.numStrings; s++) {
            const fret = midiNote - this.currentTunings[s];
            if (fret >= 0 && fret <= 4) {
                possibleStrings.push(s);
            }
        }
        if (possibleStrings.length === 0) return -1;

        let emptyStrings = possibleStrings.filter(s => this.stringStates[s].heldNotes.length === 0);
        
        if (emptyStrings.length > 0) {
            return emptyStrings[emptyStrings.length - 1];
        } else {
            return possibleStrings[possibleStrings.length - 1];
        }
    }

    noteOn(midiNote, velocity, forceStringIdx = -1, isExternalMidi = false) {
        if (!this.buffers[this.currentStyle]) return;
        
        let stringIdx = forceStringIdx;
        if (stringIdx === -1) {
            stringIdx = this.allocateString(midiNote);
        }

        if (stringIdx === -1) return; 
        let fret = midiNote - this.currentTunings[stringIdx];
        if (fret < 0 || fret > 4) return;

        let state = this.stringStates[stringIdx];
        const oldHighest = state.heldNotes.length > 0 ? state.heldNotes[state.heldNotes.length - 1] : -1;
        
        if (!state.heldNotes.includes(midiNote)) {
            state.heldNotes.push(midiNote);
            state.heldNotes.sort((a, b) => a - b);
        }

        const newHighest = state.heldNotes[state.heldNotes.length - 1];
        state.lastVelocity = velocity; // Päivitetään muistiin
        const now = this.ctx.currentTime;
        const peakGain = Math.pow(velocity / 127, 2);

        if (!state.activeVoice) {
            // Normaali isku
            const source = this.ctx.createBufferSource();
            source.buffer = this.buffers[this.currentStyle];
            source.playbackRate.value = Math.pow(2, (newHighest - this.baseMidi) / 12);

            const vca = this.ctx.createGain();
            vca.gain.setValueAtTime(0, now);
            vca.gain.linearRampToValueAtTime(peakGain, now + 0.01);

            source.connect(vca);
            vca.connect(this.wet);
            source.start();

            state.activeVoice = { source, vca };
        } else if (newHighest !== oldHighest) {
            // HAMMER-ON (Sämpler legato -tekniikalla)
            const oldVoice = state.activeVoice;
            oldVoice.vca.gain.cancelScheduledValues(now);
            oldVoice.vca.gain.setValueAtTime(oldVoice.vca.gain.value, now);
            oldVoice.vca.gain.linearRampToValueAtTime(0, now + 0.02);
            oldVoice.source.stop(now + 0.05);

            const newSource = this.ctx.createBufferSource();
            newSource.buffer = this.buffers[this.currentStyle];
            newSource.playbackRate.value = Math.pow(2, (newHighest - this.baseMidi) / 12);

            const newVca = this.ctx.createGain();
            newVca.gain.setValueAtTime(0, now);
            newVca.gain.linearRampToValueAtTime(peakGain, now + 0.02);

            newSource.connect(newVca);
            newVca.connect(this.wet);
            
            // Hypätään iskun alun yli (legato)
            const skipAttack = Math.min(0.05, newSource.buffer.duration * 0.1);
            newSource.start(now, skipAttack);

            state.activeVoice = { source: newSource, vca: newVca };
        }

        this.updateVisuals(stringIdx);

        if (!isExternalMidi && typeof this.sendMidi === 'function') {
            this.sendMidi([0x90, midiNote, velocity]);
        }
    }

    noteOff(midiNote, isExternalMidi = false) {
        let stateChanged = false;
        const now = this.ctx.currentTime;

        for (let s = 0; s < this.numStrings; s++) {
            let state = this.stringStates[s];
            const idx = state.heldNotes.indexOf(midiNote);
            
            if (idx !== -1) {
                const wasHighest = (midiNote === state.heldNotes[state.heldNotes.length - 1]);
                state.heldNotes.splice(idx, 1);
                stateChanged = true;

                if (state.heldNotes.length === 0) {
                    if (state.activeVoice) {
                        const voice = state.activeVoice;
                        voice.vca.gain.cancelScheduledValues(now);
                        voice.vca.gain.setValueAtTime(voice.vca.gain.value, now);
                        voice.vca.gain.setTargetAtTime(0, now, 0.1); 
                        voice.source.stop(now + 0.5);
                        state.activeVoice = null;
                    }
                } else if (wasHighest && state.activeVoice) {
                    // PULL-OFF (Sämpler legato -tekniikalla)
                    const newHighest = state.heldNotes[state.heldNotes.length - 1];
                    const oldVoice = state.activeVoice;

                    oldVoice.vca.gain.cancelScheduledValues(now);
                    oldVoice.vca.gain.setValueAtTime(oldVoice.vca.gain.value, now);
                    oldVoice.vca.gain.linearRampToValueAtTime(0, now + 0.02);
                    oldVoice.source.stop(now + 0.05);

                    const newSource = this.ctx.createBufferSource();
                    newSource.buffer = this.buffers[this.currentStyle];
                    newSource.playbackRate.value = Math.pow(2, (newHighest - this.baseMidi) / 12);

                    const newVca = this.ctx.createGain();
                    newVca.gain.setValueAtTime(0, now);
                    
                    const peakGain = Math.pow(state.lastVelocity / 127, 2) * 0.85; 
                    newVca.gain.linearRampToValueAtTime(peakGain, now + 0.02);

                    newSource.connect(newVca);
                    newVca.connect(this.wet);
                    
                    const skipAttack = Math.min(0.05, newSource.buffer.duration * 0.1);
                    newSource.start(now, skipAttack);

                    state.activeVoice = { source: newSource, vca: newVca };
                }
                this.updateVisuals(s);
            }
        }

        if (stateChanged && !isExternalMidi && typeof this.sendMidi === 'function') {
            this.sendMidi([0x80, midiNote, 0]);
        }
    }

    updateVisuals(stringIdx) {
        if (!this.uiElements.strings) return;
        const stringRow = this.uiElements.strings[stringIdx];
        const frets = stringRow.querySelectorAll('.bass-fret');
        const staticStr = stringRow.querySelector('.string-static');
        const vibStr = stringRow.querySelector('.string-vibrating');
        
        const state = this.stringStates[stringIdx];
        const root = this.currentTunings[stringIdx];

        frets.forEach(f => f.classList.remove('active'));

        if (state.heldNotes.length === 0) {
            vibStr.classList.remove('is-vibrating');
            staticStr.style.width = '100%';
            vibStr.style.width = '0%';
        } else {
            let highestFret = -1;
            
            state.heldNotes.forEach(note => {
                let fret = note - root;
                if (fret >= 0 && fret <= 4) {
                    frets[fret].classList.add('active');
                    frets[fret].setAttribute('data-note', this.midiToNoteName(note));
                    if (fret > highestFret) highestFret = fret;
                }
            });

            if (highestFret !== -1) {
                const startPercent = highestFret * 20;
                staticStr.style.width = startPercent + '%';
                vibStr.style.left = startPercent + '%';
                vibStr.style.width = (100 - startPercent) + '%';
                vibStr.classList.add('is-vibrating');
            }
        }
    }

    setStyle(idx) {
        if (idx >= 0 && idx <= 2) {
            this.currentStyle = idx;
            if (this.uiElements.styleBtns) {
                this.uiElements.styleBtns.forEach((btn, i) => {
                    btn.classList.toggle('active', i === idx);
                });
            }
        }
    }

    initKeyboardListeners() {
        const keyMap = {
            'c': {s: 0, f: 0}, 'v': {s: 0, f: 1}, 'b': {s: 0, f: 2}, 'n': {s: 0, f: 3}, 'm': {s: 0, f: 4},
            'f': {s: 1, f: 0}, 'g': {s: 1, f: 1}, 'h': {s: 1, f: 2}, 'j': {s: 1, f: 3}, 'k': {s: 1, f: 4},
            't': {s: 2, f: 0}, 'y': {s: 2, f: 1}, 'u': {s: 2, f: 2}, 'i': {s: 2, f: 3}, 'o': {s: 2, f: 4},
            '6': {s: 3, f: 0}, '7': {s: 3, f: 1}, '8': {s: 3, f: 2}, '9': {s: 3, f: 3}, '0': {s: 3, f: 4}
        };

        this.keyStates = {};

        window.addEventListener('keydown', async (e) => {
            if (e.target.tagName === 'INPUT' || e.repeat) return;
            if (!this.keysVisible) return;
            if (this.ctx.state === 'suspended') await this.ctx.resume();

            const key = e.key.toLowerCase();
            if (['1', '2', '3'].includes(key)) {
                this.setStyle(parseInt(key) - 1);
                return;
            }

            const map = keyMap[key];
            if (map) {
                this.keyStates[key] = true;
                const note = this.currentTunings[map.s] + map.f;
                this.noteOn(note, 100, map.s);
            }
        });

        window.addEventListener('keyup', (e) => {
            const key = e.key.toLowerCase();
            const map = keyMap[key];
            if (map && this.keyStates[key]) {
                this.keyStates[key] = false;
                const note = this.currentTunings[map.s] + map.f;
                this.noteOff(note);
            }
        });
    }

    changeTuning(stringIdx, delta) {
        const newTuning = this.currentTunings[stringIdx] + delta;
        const min = this.defaultTunings[stringIdx] - 6; 
        const max = this.defaultTunings[stringIdx] + 6; 
        if (newTuning >= min && newTuning <= max) {
            this.currentTunings[stringIdx] = newTuning;
            this.renderFretboardLabels();
        }
    }

    renderFretboardLabels() {
        if (!this.uiElements.strings) return;
        const keyMapGrid = [
            ['c', 'v', 'b', 'n', 'm'],
            ['f', 'g', 'h', 'j', 'k'],
            ['t', 'y', 'u', 'i', 'o'],
            ['6', '7', '8', '9', '0']
        ];

        for (let s = 0; s < 4; s++) {
            const frets = this.uiElements.strings[s].querySelectorAll('.bass-fret');
            for (let f = 0; f < 5; f++) {
                const note = this.midiToNoteName(this.currentTunings[s] + f);
                frets[f].querySelector('.fret-label').innerText = note;
                const keyHint = frets[f].querySelector('.key-hint');
                if (keyHint) keyHint.innerText = `[${keyMapGrid[s][f]}]`;
            }
        }
    }

    getNodes() { return { input: this.input, output: this.output }; }

    getState() {
        return {
            eqBass: this.eqBass.gain.value,
            eqMid: this.eqMid.gain.value,
            eqTreble: this.eqTreble.gain.value,
            gain: this.vcaOut.gain.value,
            styleTriggers: this.styleTriggers,
            tunings: this.currentTunings
        };
    }

    setState(state) {
        if (!state) return;
        if (state.eqBass !== undefined && this.knobs['bass']) this.knobs['bass'].setValue(state.eqBass);
        if (state.eqMid !== undefined && this.knobs['mid']) this.knobs['mid'].setValue(state.eqMid);
        if (state.eqTreble !== undefined && this.knobs['treble']) this.knobs['treble'].setValue(state.eqTreble);
        if (state.gain !== undefined && this.knobs['gain']) this.knobs['gain'].setValue(state.gain);
        if (state.styleTriggers) {
            this.styleTriggers = state.styleTriggers;
            if (this.uiElements.triggerInputs) {
                this.uiElements.triggerInputs[0].value = this.styleTriggers[0];
                this.uiElements.triggerInputs[1].value = this.styleTriggers[1];
                this.uiElements.triggerInputs[2].value = this.styleTriggers[2];
            }
        }
        if (state.tunings) {
            this.currentTunings = state.tunings;
            this.renderFretboardLabels();
        }
    }

    renderUI(containerElement) {
        const color = '#ff8800'; 
        containerElement.style.setProperty('--fx-color', color);

        const styleId = 'fx-bass-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .bass-panel { background: #111; padding: 15px; border-radius: 8px; border: 1px solid #333; box-shadow: inset 0 0 20px rgba(0,0,0,0.5); font-family: monospace; display: flex; flex-direction: column; gap: 15px; }
                .bass-row { display: flex; justify-content: space-between; align-items: flex-end; gap: 15px; flex-wrap: wrap; }
                
                .btn-neon { background: #0a0a0a; border: 1px solid var(--fx-color); color: var(--fx-color); cursor: pointer; padding: 6px 10px; border-radius: 4px; font-weight: bold; font-size: 11px; transition: all 0.2s; text-align: center; font-family: monospace;}
                .btn-neon:hover { background: rgba(255, 136, 0, 0.1); box-shadow: 0 0 5px rgba(255,136,0,0.4); }
                .btn-neon.active { background: var(--fx-color); color: #000; box-shadow: 0 0 10px var(--fx-color); }
                .btn-neon.small { padding: 2px 6px; font-size: 10px; }

                .trigger-input { width: 35px; background: #000; border: 1px solid #333; color: var(--fx-color); text-align: center; font-family: monospace; border-radius: 3px; font-size: 11px;}
                
                /* Fretboard */
                .fretboard-container { background: #151515; border: 2px solid #333; border-radius: 4px; padding: 10px 0; position: relative; display: flex; flex-direction: column-reverse; gap: 0; box-shadow: inset 0 0 10px #000, 0 5px 15px rgba(0,0,0,0.8); }
                .fretboard-row { display: flex; height: 42px; position: relative; align-items: center; }
                
                @keyframes string-vibrate { 0% { transform: translateY(-50%); } 25% { transform: translateY(calc(-50% - 2px)); } 50% { transform: translateY(-50%); } 75% { transform: translateY(calc(-50% + 2px)); } 100% { transform: translateY(-50%); } }

                /* Strings */
                .string-container { position: absolute; left: 45px; right: 0; height: 100%; z-index: 1; pointer-events: none; }
                .string-static, .string-vibrating { position: absolute; top: 50%; transform: translateY(-50%); background: linear-gradient(to bottom, #777, #ccc, #444); border-radius: 2px; }
                .string-vibrating.is-vibrating { animation: string-vibrate 0.05s infinite; }

                .row-0 .string-static, .row-0 .string-vibrating { height: 4px; } /* E string */
                .row-1 .string-static, .row-1 .string-vibrating { height: 3px; } /* A string */
                .row-2 .string-static, .row-2 .string-vibrating { height: 2px; } /* D string */
                .row-3 .string-static, .row-3 .string-vibrating { height: 1px; } /* G string */

                /* Frets */
                .bass-fret { flex: 1; height: 100%; border-right: 3px solid #777; position: relative; z-index: 2; display: flex; justify-content: center; align-items: center; cursor: pointer; user-select: none; box-sizing: border-box; background: rgba(0,0,0,0.2); }
                .bass-fret:hover { background: rgba(255,136,0,0.15); }
                
                /* Satula (Nut) */
                .nut-fret { border-right: 6px solid #d4d4d4 !important; background: rgba(255,255,255,0.03); }

                /* Active Note Dot */
                .bass-fret::after { content: attr(data-note); position: absolute; width: 20px; height: 20px; background: var(--fx-color); border-radius: 50%; display: flex; justify-content: center; align-items: center; font-size: 9px; font-weight: bold; color: #000; opacity: 0; transition: opacity 0.1s; box-shadow: 0 0 10px var(--fx-color); pointer-events: none; }
                .bass-fret.active::after { opacity: 1; }

                .fret-label { position: absolute; bottom: 2px; font-size: 8px; color: #777; pointer-events: none; font-weight: bold; text-shadow: 1px 1px 0 #000; }
                .key-hint { position: absolute; top: 2px; font-size: 8px; color: #00ffff; display: none; pointer-events: none; background: rgba(0,0,0,0.5); padding: 1px 3px; border-radius: 2px;}
                .show-keys .key-hint { display: block; }
                
                .tuning-controls { width: 40px; display: flex; flex-direction: column; align-items: center; justify-content: center; z-index: 2; margin-left: 5px;}

                /* Knobs */
                .knob-container { display: flex; flex-direction: column; align-items: center; user-select: none; width: 50px; }
                .knob-wrapper { position: relative; width: 40px; height: 40px; cursor: ns-resize; margin-bottom: 5px; touch-action: none; }
                .knob-svg { width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 3px rgba(255,136,0,0.2));}
                .knob-track { fill: none; stroke: #222; stroke-width: 6; stroke-linecap: round; }
                .knob-value-path { fill: none; stroke: var(--fx-color); stroke-width: 6; stroke-linecap: round; transition: stroke 0.2s; }
                .knob-center { fill: #111; stroke: #333; stroke-width: 1.5; }
                .knob-indicator { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
                .knob-dot { position: absolute; width: 4px; height: 4px; background: var(--fx-color); border-radius: 50%; top: 4px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 5px var(--fx-color);}
                .knob-label { font-size: 9px; color: #8b8b9f; margin-bottom: 3px; text-align: center;}
                .knob-value-display { font-size: 9px; color: #ccc; background: #000; padding: 2px 5px; border-radius: 3px; border: 1px solid #333; }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div style="margin-bottom: 10px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 4px; font-size: 14px; text-shadow: 0 0 10px rgba(255,136,0,0.5); font-family: monospace;">MIDI BASS SYNTH</div>
            
            <div class="bass-panel">
                <div class="bass-row">
                    <div style="display:flex; flex-direction:column; gap:8px;">
                        <div style="font-size: 9px; color: #888;">STYLES (MIDI TRIGGERS)</div>
                        <div style="display:flex; gap: 5px;">
                            <button class="btn-neon style-btn active">1</button><input type="number" class="trigger-input" value="${this.styleTriggers[0]}">
                            <button class="btn-neon style-btn">2</button><input type="number" class="trigger-input" value="${this.styleTriggers[1]}">
                            <button class="btn-neon style-btn">3</button><input type="number" class="trigger-input" value="${this.styleTriggers[2]}">
                        </div>
                        <input type="file" id="bass-wav-upload" accept="audio/wav,audio/mp3" style="display:none;">
                        <button class="btn-neon" id="btn-load-bass" style="font-size:9px;">LOAD CUSTOM WAV TO STYLE</button>
                    </div>

                    <div style="display:flex; gap:10px;" id="bass-knobs"></div>
                    
                    <button class="btn-neon" id="btn-toggle-keys" style="height: fit-content; align-self: center;">SHOW KEYS</button>
                </div>

                <div class="fretboard-container" id="bass-fretboard">
                    <!-- Generoidaan JS:llä -->
                </div>
            </div>
        `;

        this.uiElements.styleBtns = containerElement.querySelectorAll('.style-btn');
        this.uiElements.styleBtns.forEach((btn, idx) => {
            btn.addEventListener('click', () => this.setStyle(idx));
        });

        this.uiElements.triggerInputs = containerElement.querySelectorAll('.trigger-input');
        this.uiElements.triggerInputs.forEach((inp, idx) => {
            inp.addEventListener('change', (e) => {
                this.styleTriggers[idx] = parseInt(e.target.value) || this.styleTriggers[idx];
            });
        });

        const fileInput = containerElement.querySelector('#bass-wav-upload');
        containerElement.querySelector('#btn-load-bass').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                try {
                    if (this.ctx.state === 'suspended') await this.ctx.resume();
                    const arrayBuffer = await e.target.files[0].arrayBuffer();
                    this.buffers[this.currentStyle] = await this.ctx.decodeAudioData(arrayBuffer);
                    alert(`Custom WAV ladattu tyyliin ${this.currentStyle + 1}`);
                } catch (err) { console.error("Virhe:", err); }
            }
        });

        const toggleBtn = containerElement.querySelector('#btn-toggle-keys');
        const fretboardDiv = containerElement.querySelector('#bass-fretboard');
        toggleBtn.addEventListener('click', () => {
            this.keysVisible = !this.keysVisible;
            fretboardDiv.classList.toggle('show-keys', this.keysVisible);
            toggleBtn.classList.toggle('active', this.keysVisible);
        });

        this.uiElements.strings = [];
        for (let s = 0; s < 4; s++) { 
            const row = document.createElement('div');
            row.className = `fretboard-row row-${s}`;
            
            const tuningDiv = document.createElement('div');
            tuningDiv.className = 'tuning-controls';
            tuningDiv.innerHTML = `
                <button class="btn-neon small btn-tune-up">+</button>
                <button class="btn-neon small btn-tune-down">-</button>
            `;
            tuningDiv.querySelector('.btn-tune-up').addEventListener('click', () => this.changeTuning(s, 1));
            tuningDiv.querySelector('.btn-tune-down').addEventListener('click', () => this.changeTuning(s, -1));
            row.appendChild(tuningDiv);

            const stringContainer = document.createElement('div');
            stringContainer.className = 'string-container';
            stringContainer.innerHTML = `
                <div class="string-static" style="width: 100%; left: 0;"></div>
                <div class="string-vibrating" style="width: 0%; left: 0%;"></div>
            `;
            row.appendChild(stringContainer);

            for (let f = 0; f < 5; f++) {
                const fretCell = document.createElement('div');
                fretCell.className = 'bass-fret';
                
                if (f === 0) fretCell.classList.add('nut-fret');

                fretCell.innerHTML = `
                    <div class="key-hint"></div>
                    <div class="fret-label"></div>
                `;

                const triggerNote = async (velocity) => {
                    if (this.ctx.state === 'suspended') await this.ctx.resume();
                    const note = this.currentTunings[s] + f;
                    this.noteOn(note, velocity, s);
                };
                const releaseNote = () => {
                    const note = this.currentTunings[s] + f;
                    this.noteOff(note);
                };

                fretCell.addEventListener('mousedown', (e) => { e.preventDefault(); triggerNote(100); });
                fretCell.addEventListener('mouseup', releaseNote);
                fretCell.addEventListener('mouseleave', releaseNote);
                
                fretCell.addEventListener('touchstart', (e) => { e.preventDefault(); triggerNote(100); }, {passive: false});
                fretCell.addEventListener('touchend', (e) => { e.preventDefault(); releaseNote(); }, {passive: false});
                fretCell.addEventListener('touchcancel', releaseNote);

                row.appendChild(fretCell);
            }
            this.uiElements.strings[s] = row;
            fretboardDiv.appendChild(row); 
        }
        
        this.renderFretboardLabels();

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

        const knobContainer = containerElement.querySelector('#bass-knobs');
        this.knobs['bass'] = createKnob(knobContainer, 'BASS', -15, 15, this.eqBass.gain.value, v => Math.round(v)+'dB', v => { this.eqBass.gain.value = v; });
        this.knobs['mid'] = createKnob(knobContainer, 'MID', -15, 15, this.eqMid.gain.value, v => Math.round(v)+'dB', v => { this.eqMid.gain.value = v; });
        this.knobs['treble'] = createKnob(knobContainer, 'TREBLE', -15, 15, this.eqTreble.gain.value, v => Math.round(v)+'dB', v => { this.eqTreble.gain.value = v; });
        this.knobs['gain'] = createKnob(knobContainer, 'GAIN', 0, 2.0, this.vcaOut.gain.value, v => Math.round(v*100)+'%', v => { this.vcaOut.gain.value = v; });
    }
}