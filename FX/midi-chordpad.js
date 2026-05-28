// midi-chordpad.js
window.CustomAudioEffect = class MidiChordPad {
    constructor(audioCtx) {
        this.ctx = audioCtx;

        // Audio Routing: Pass-through (Ei muuteta ääntä)
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.input.connect(this.output);

        // Tietorakenteet
        this.pads = []; // { id, name, notes: [midi1, midi2...], keyBind: 'a' }
        this.activePads = new Set();
        this.playingNotes = new Map(); // Seuranta: midiNote -> padId/Arp

        // Arpeggiator tila
        this.arpEnabled = false;
        this.arpPattern = "1231234-";
        
        // Harmonia-asetukset
        this.harmony2nd = false;
        this.harmony3rd = false;

        // Aika-asetukset
        this.tempoSyncEnabled = false; 
        this.arpSpeed = 250; // Millisekunteja per askel (Manuaalinen)
        
        // Sync tahtiosuudet ja oletusindeksi (1 = 1/16)
        this.arpSyncIndex = 1; 
        this.syncDivisions = [
            { label: '1/32', mult: 0.125 },
            { label: '1/16', mult: 0.25 },
            { label: '1/8T', mult: 1/3 }, // Trioli
            { label: '1/8',  mult: 0.5 },
            { label: '1/4T', mult: 2/3 }, // Trioli
            { label: '1/4',  mult: 1.0 },
            { label: '1/2',  mult: 2.0 },
            { label: '1/1',  mult: 4.0 }
        ];

        this.arpTimer = null;
        this.arpStep = 0;
        this.arpActiveNotes = []; // Arpin tällä hetkellä soittamat nuotit
        this.arpActivePadId = null;
        
        // Velocity Curve
        this.arpVelocities = Array(this.arpPattern.length).fill(100);

        // Editointi tila
        this.editingPadId = null;
        this.learningMidi = false;

        // Sointutyypit (Intervallit puolisävelaskelina perusäänestä)
        this.chordTypes = {
            "Major": [0, 4, 7], "Minor": [0, 3, 7], "Diminished": [0, 3, 6], "Augmented": [0, 4, 8],
            "Sus2": [0, 2, 7], "Sus4": [0, 5, 7], 
            "Maj7": [0, 4, 7, 11], "Min7": [0, 3, 7, 10], "Dom7": [0, 4, 7, 10], "Dim7": [0, 3, 6, 9], "Half-Dim7": [0, 3, 6, 10],
            "Add9": [0, 4, 7, 14], "Maj9": [0, 4, 7, 11, 14], "Min9": [0, 3, 7, 10, 14], "Dom9": [0, 4, 7, 10, 14],
            "11th": [0, 4, 7, 10, 14, 17], "13th": [0, 4, 7, 10, 14, 17, 21]
        };

        // Oletuspadit
        this.addPad("C Maj", [60, 64, 67], "z");
        this.addPad("G Maj", [55, 59, 62], "x");
        this.addPad("A Min", [57, 60, 64], "c");
        this.addPad("F Maj", [53, 57, 60], "v");

        this.initKeyboardListeners();
    }

    getNodes() {
        return { input: this.input, output: this.output };
    }

    // --- MIDI Käsittely (Ulos) ---

    playNote(midiNote, velocity = 100) {
        if (this.playingNotes.has(midiNote)) return;
        this.playingNotes.set(midiNote, true);
        if (typeof this.sendMidi === 'function') {
            this.sendMidi([0x90, midiNote, Math.floor(velocity)]);
        }
    }

    stopNote(midiNote) {
        if (!this.playingNotes.has(midiNote)) return;
        this.playingNotes.delete(midiNote);
        if (typeof this.sendMidi === 'function') {
            this.sendMidi([0x80, midiNote, 0]);
        }
    }

    stopAllNotes() {
        this.playingNotes.forEach((val, note) => this.stopNote(note));
        this.playingNotes.clear();
        this.arpActiveNotes = [];
        this.highlightVelocityStep(-1); 
    }

    // --- MIDI Käsittely (Sisään - Opetustilaa varten) ---
    onMidi(msg) {
        if (typeof this.onMidiOut === 'function') this.onMidiOut(msg);

        const status = msg[0] & 0xF0;
        const note = msg[1];
        const velocity = msg[2];

        if (this.learningMidi && this.editingPadId !== null) {
            if (status === 0x90 && velocity > 0) {
                const pad = this.pads.find(p => p.id === this.editingPadId);
                if (pad && !pad.notes.includes(note)) {
                    pad.notes.push(note);
                    pad.notes.sort((a, b) => a - b);
                    this.updateEditorUI();
                    this.renderPads();
                }
            }
        }
    }

    // --- Padien ohjaus ---

    addPad(name, notes, keyBind) {
        this.pads.push({
            id: Date.now() + Math.random(),
            name: name,
            notes: notes,
            keyBind: keyBind.toLowerCase()
        });
    }

    removePad(id) {
        this.pads = this.pads.filter(p => p.id !== id);
        if (this.editingPadId === id) this.closeEditor();
        this.renderPads();
    }

    triggerPadOn(id) {
        if (this.activePads.has(id)) return;
        this.activePads.add(id);
        const pad = this.pads.find(p => p.id === id);
        if (!pad) return;

        const padEl = this.uiContainer.querySelector(`[data-id="${id}"]`);
        if (padEl) padEl.classList.add('active');

        if (this.arpEnabled) {
            if (this.arpActivePadId !== null) this.triggerPadOff(this.arpActivePadId);
            this.arpActivePadId = id;
            this.arpStep = 0;
            this.stopAllNotes(); 
            this.runArpStep();
        } else {
            pad.notes.forEach(n => this.playNote(n, 100));
        }
    }

    triggerPadOff(id) {
        if (!this.activePads.has(id)) return;
        this.activePads.delete(id);
        const pad = this.pads.find(p => p.id === id);
        
        const padEl = this.uiContainer.querySelector(`[data-id="${id}"]`);
        if (padEl) padEl.classList.remove('active');

        if (this.arpEnabled && this.arpActivePadId === id) {
            clearTimeout(this.arpTimer);
            this.arpActivePadId = null;
            this.stopAllNotes();
        } else if (!this.arpEnabled && pad) {
            pad.notes.forEach(n => this.stopNote(n));
        }
    }

    // --- Arpeggiator ---

    getArpDelay() {
        if (this.tempoSyncEnabled) {
            const currentBpm = window.bpm || window.globalTempo || 120;
            const quarterNoteMs = 60000 / currentBpm;
            const div = this.syncDivisions[this.arpSyncIndex];
            return quarterNoteMs * div.mult;
        }
        return this.arpSpeed;
    }

    generateRandomPattern() {
        let len = this.arpPattern.length > 0 ? this.arpPattern.length : 8;
        let res = "";
        for(let i = 0; i < len; i++) {
            let r = Math.random();
            // Painotetaan numeroita 1-4, vähemmän sitomista (-), harvoin taukoja (0)
            if(r < 0.15) res += '-';
            else if(r < 0.25) res += '0';
            else res += Math.floor(Math.random() * 4) + 1; // 1 to 4
        }
        this.arpPattern = res;
        if (this.uiContainer) {
            const input = this.uiContainer.querySelector('#cp-arp-pattern');
            if(input) input.value = res;
        }
        this.updateVelocityArray();
    }

    runArpStep() {
        if (!this.arpEnabled || this.arpActivePadId === null) return;
        
        const pad = this.pads.find(p => p.id === this.arpActivePadId);
        if (!pad || pad.notes.length === 0) return;

        if (this.arpPattern.length === 0) return;

        this.arpStep = this.arpStep % this.arpPattern.length;
        const char = this.arpPattern[this.arpStep];
        
        const stepVelocity = this.arpVelocities[this.arpStep] || 100;
        this.highlightVelocityStep(this.arpStep);

        if (char === '-') {
            // Tie / Hold (Säilytetään soivat nuotit)
        } else {
            // Sammutetaan edelliset nuotit
            this.arpActiveNotes.forEach(n => this.stopNote(n));
            this.arpActiveNotes = [];

            if (char >= '1' && char <= '9') {
                const noteIndexInput = parseInt(char) - 1;
                
                // Helper funktio, joka laskee ja soittaa oikean sävelen soinnun sisältä
                const playChordDegree = (degreeInput) => {
                    const numNotesInChord = pad.notes.length;
                    const octaveShift = Math.floor(degreeInput / numNotesInChord);
                    const baseIndex = degreeInput % numNotesInChord;
                    const midiToPlay = pad.notes[baseIndex] + (octaveShift * 12);
                    
                    this.playNote(midiToPlay, stepVelocity);
                    this.arpActiveNotes.push(midiToPlay);
                };

                // Soitetaan perussävel
                playChordDegree(noteIndexInput);
                
                // Soitetaan harmoniat (jos päällä)
                if (this.harmony2nd) playChordDegree(noteIndexInput + 1);
                if (this.harmony3rd) playChordDegree(noteIndexInput + 2);
            }
        }

        this.arpStep++;
        this.arpTimer = setTimeout(() => this.runArpStep(), this.getArpDelay());
    }

    updateVelocityArray() {
        const len = this.arpPattern.length;
        if (len === 0) {
            this.arpVelocities = [];
        } else {
            while(this.arpVelocities.length < len) this.arpVelocities.push(100);
            if(this.arpVelocities.length > len) this.arpVelocities.length = len;
        }
        this.renderVelocityUI();
    }

    // --- Apufunktiot ---

    midiToName(midi) {
        const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
        return `${notes[midi % 12]}${Math.floor(midi / 12) - 1}`;
    }

    nameToMidi(name) {
        const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
        const match = name.trim().toUpperCase().match(/^([A-G]#?)(-?\d+)$/);
        if (!match) return -1;
        const noteIndex = notes.indexOf(match[1]);
        const octave = parseInt(match[2]);
        if (noteIndex === -1) return -1;
        return (octave + 1) * 12 + noteIndex;
    }

    notesToString(notesArr) {
        return notesArr.map(n => this.midiToName(n)).join(', ');
    }

    parseNotesString(str) {
        const parts = str.split(',');
        const result = [];
        for (let p of parts) {
            let m = this.nameToMidi(p);
            if (m >= 0 && m <= 127) result.push(m);
        }
        return result.sort((a, b) => a - b);
    }

    initKeyboardListeners() {
        this.keyStates = {};
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.repeat) return;
            const key = e.key.toLowerCase();
            this.keyStates[key] = true;
            
            const pad = this.pads.find(p => p.keyBind === key);
            if (pad) this.triggerPadOn(pad.id);
        });

        window.addEventListener('keyup', (e) => {
            const key = e.key.toLowerCase();
            this.keyStates[key] = false;
            
            const pad = this.pads.find(p => p.keyBind === key);
            if (pad) this.triggerPadOff(pad.id);
        });
    }

    getState() {
        return {
            pads: this.pads,
            arpEnabled: this.arpEnabled,
            arpPattern: this.arpPattern,
            arpSpeed: this.arpSpeed,
            arpSyncIndex: this.arpSyncIndex,
            tempoSyncEnabled: this.tempoSyncEnabled,
            harmony2nd: this.harmony2nd,
            harmony3rd: this.harmony3rd,
            arpVelocities: this.arpVelocities
        };
    }

    setState(state) {
        if (!state) return;
        if (state.pads) this.pads = state.pads;
        if (state.arpEnabled !== undefined) this.arpEnabled = state.arpEnabled;
        if (state.arpPattern !== undefined) this.arpPattern = state.arpPattern;
        if (state.arpSpeed !== undefined) this.arpSpeed = state.arpSpeed;
        if (state.arpSyncIndex !== undefined) this.arpSyncIndex = state.arpSyncIndex;
        if (state.tempoSyncEnabled !== undefined) this.tempoSyncEnabled = state.tempoSyncEnabled;
        if (state.harmony2nd !== undefined) this.harmony2nd = state.harmony2nd;
        if (state.harmony3rd !== undefined) this.harmony3rd = state.harmony3rd;
        if (state.arpVelocities !== undefined) this.arpVelocities = state.arpVelocities;
        
        if (this.uiContainer) {
            this.renderPads();
            this.updateArpUI();
            this.updateVelocityArray();
            this.renderKnob();
        }
    }

    // --- UI Renderöinti ---

    renderUI(container) {
        this.uiContainer = container;
        const color = '#b026ff'; 
        container.style.setProperty('--cp-color', color);

        if (!document.getElementById('cp-styles')) {
            const style = document.createElement('style');
            style.id = 'cp-styles';
            style.textContent = `
                .cp-panel { background: #111; padding: 15px; border-radius: 8px; border: 1px solid #333; font-family: monospace; color: #eee; }
                .cp-header { text-align: center; color: var(--cp-color); font-weight: bold; letter-spacing: 2px; text-shadow: 0 0 10px rgba(176,38,255,0.5); margin-bottom: 15px; font-size: 14px; }
                
                /* Arp Section */
                .cp-arp-section { background: #1a1a1a; border: 1px solid #333; padding: 10px; border-radius: 6px; margin-bottom: 15px; display: flex; flex-direction: column; gap: 10px; }
                .cp-arp-controls { display: flex; gap: 15px; align-items: center; flex-wrap: wrap; }
                
                .cp-btn { background: #222; border: 1px solid #555; color: #ddd; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-family: monospace; font-size: 11px; transition: 0.2s; }
                .cp-btn:hover { background: #333; border-color: var(--cp-color); }
                .cp-btn.active { background: var(--cp-color); color: #000; border-color: #fff; box-shadow: 0 0 10px var(--cp-color); font-weight: bold; }
                
                .cp-input { background: #000; border: 1px solid #444; color: var(--cp-color); padding: 5px; font-family: monospace; border-radius: 3px; }
                
                /* Velocity Sequencer */
                .cp-vel-wrapper { display: flex; flex-direction: column; gap: 5px; background: #0a0a0a; padding: 10px; border-radius: 4px; border: 1px inset #222; overflow-x: auto; }
                .cp-vel-label { font-size: 9px; color: #888; text-transform: uppercase; }
                .cp-vel-container { display: flex; gap: 2px; height: 50px; align-items: flex-end; cursor: crosshair; touch-action: none; }
                .cp-vel-bar { flex: 1; min-width: 15px; background: #222; height: 100%; position: relative; border-radius: 2px 2px 0 0; }
                .cp-vel-fill { position: absolute; bottom: 0; left: 0; width: 100%; background: var(--cp-color); border-radius: 2px 2px 0 0; pointer-events: none; opacity: 0.7; }
                .cp-vel-bar:hover .cp-vel-fill { opacity: 1; box-shadow: 0 0 5px var(--cp-color); }
                .cp-vel-bar.playing { background: #444; }
                .cp-vel-bar.playing .cp-vel-fill { background: #fff; box-shadow: 0 0 10px #fff; opacity: 1; }

                /* Pads Grid */
                .cp-pad-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 10px; margin-bottom: 15px; }
                .cp-pad { position: relative; background: linear-gradient(145deg, #222, #111); border: 2px solid #444; border-radius: 8px; height: 90px; display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: pointer; user-select: none; transition: 0.1s; box-shadow: 3px 3px 10px rgba(0,0,0,0.5); overflow: hidden; }
                .cp-pad:hover { border-color: #666; }
                .cp-pad.active { transform: scale(0.95); border-color: var(--cp-color); background: #2a103a; box-shadow: inset 0 0 15px var(--cp-color); }
                .cp-pad-name { font-size: 14px; font-weight: bold; color: #fff; pointer-events: none; }
                .cp-pad-notes { font-size: 9px; color: #888; pointer-events: none; margin-top: 5px; text-align: center; padding: 0 5px; }
                .cp-pad-key { position: absolute; top: 4px; left: 6px; font-size: 10px; color: var(--cp-color); background: rgba(0,0,0,0.6); padding: 1px 4px; border-radius: 3px; border: 1px solid #333;}
                .cp-pad-edit-btn { position: absolute; top: 4px; right: 4px; font-size: 10px; background: none; border: none; color: #666; cursor: pointer; padding: 2px; }
                .cp-pad-edit-btn:hover { color: #fff; }

                /* Editor Panel */
                .cp-editor { display: none; background: #1a1a1a; border: 1px solid var(--cp-color); padding: 15px; border-radius: 6px; flex-direction: column; gap: 10px; box-shadow: 0 0 15px rgba(176,38,255,0.2); }
                .cp-editor.visible { display: flex; }
                .cp-editor-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
                .cp-editor label { font-size: 10px; color: #aaa; min-width: 60px;}
                
                /* Knob */
                .cp-knob { display: flex; flex-direction: column; align-items: center; min-width: 45px; }
                .cp-knob-svg { width: 30px; height: 30px; transform: rotate(135deg); cursor: ns-resize; }
                .cp-knob-track { fill: none; stroke: #333; stroke-width: 5; stroke-linecap: round; }
                .cp-knob-val { fill: none; stroke: var(--cp-color); stroke-width: 5; stroke-linecap: round; }
            `;
            document.head.appendChild(style);
        }

        container.innerHTML = `
            <div class="cp-panel">
                <div class="cp-header">MIDI CHORD PAD</div>
                
                <!-- Arp Controls -->
                <div class="cp-arp-section">
                    <div class="cp-arp-controls">
                        <button class="cp-btn" id="cp-arp-toggle">ARP OFF</button>
                        
                        <div style="display:flex; flex-direction:column; gap:3px;">
                            <div style="font-size:9px; color:#888;">PATTERN (1-9, 0=rest, -=tie)</div>
                            <div style="display:flex; align-items:center; gap:5px;">
                                <input type="text" id="cp-arp-pattern" class="cp-input" value="${this.arpPattern}" style="width: 100px; letter-spacing: 2px;">
                                <button class="cp-btn" id="cp-rnd-pattern" title="Random Pattern" style="padding:4px; font-size:9px; border-color:#00f0ff;">RND</button>
                            </div>
                        </div>
                        
                        <div class="cp-knob" id="cp-speed-knob"></div>
                        <button class="cp-btn" id="cp-sync-toggle" title="Sync to Host Tempo">SYNC</button>
                        
                        <div style="display:flex; gap:5px; margin-left: 10px;">
                            <button class="cp-btn" id="cp-harm-2nd" title="Add 2nd note of the chord">2ND</button>
                            <button class="cp-btn" id="cp-harm-3rd" title="Add 3rd note of the chord">3RD</button>
                        </div>
                        
                        <div style="flex-grow:1; text-align:right;">
                            <button class="cp-btn" id="cp-add-pad">+ ADD PAD</button>
                        </div>
                    </div>

                    <!-- Velocity Curve Editor -->
                    <div class="cp-vel-wrapper">
                        <div class="cp-vel-label">Velocity Curve</div>
                        <div class="cp-vel-container" id="cp-vel-editor"></div>
                    </div>
                </div>

                <!-- Pads Container -->
                <div class="cp-pad-grid" id="cp-pads-container"></div>

                <!-- Editor Container -->
                <div class="cp-editor" id="cp-editor-panel">
                    <div style="font-weight:bold; border-bottom:1px solid #444; padding-bottom:5px; margin-bottom:5px; display:flex; justify-content:space-between;">
                        <span>EDIT PAD</span>
                        <button class="cp-btn" id="cp-editor-close" style="padding: 2px 5px; font-size:9px;">X</button>
                    </div>
                    
                    <div class="cp-editor-row">
                        <label>Name:</label>
                        <input type="text" id="cp-edit-name" class="cp-input" style="width:120px;">
                        <label style="min-width:30px; margin-left:10px;">Key:</label>
                        <input type="text" id="cp-edit-key" class="cp-input" style="width:30px; text-align:center;" maxlength="1">
                    </div>

                    <div class="cp-editor-row" style="background:#000; padding:10px; border-radius:4px;">
                        <label style="color:var(--cp-color);">Generator:</label>
                        <select id="cp-edit-root" class="cp-input">
                            ${["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"].map(n=>`<option value="${n}">${n}</option>`).join('')}
                        </select>
                        <select id="cp-edit-oct" class="cp-input">
                            ${[2,3,4,5,6].map(o=>`<option value="${o}">Oct ${o}</option>`).join('')}
                        </select>
                        <select id="cp-edit-type" class="cp-input">
                            ${Object.keys(this.chordTypes).map(t=>`<option value="${t}">${t}</option>`).join('')}
                        </select>
                        <button class="cp-btn" id="cp-btn-generate">GENERATE</button>
                        <button class="cp-btn" id="cp-btn-rnd-chord" title="Random Chord" style="padding:4px; font-size:9px; border-color:#00f0ff;">RND</button>
                    </div>

                    <div class="cp-editor-row">
                        <label>Notes:</label>
                        <input type="text" id="cp-edit-notes" class="cp-input" style="flex-grow:1;" placeholder="C4, E4, G4">
                        <button class="cp-btn" id="cp-btn-learn">MIDI LEARN</button>
                    </div>

                    <div style="text-align:right; margin-top:5px;">
                        <button class="cp-btn" id="cp-btn-delete" style="background:#521; border-color:#922; color:#f88;">DELETE PAD</button>
                    </div>
                </div>
            </div>
        `;

        this.bindEvents();
        this.renderPads();
        this.updateArpUI();
        this.renderVelocityUI();
        this.renderKnob(); 
    }

    renderKnob() {
        if (!this.uiContainer) return;
        const container = this.uiContainer.querySelector('#cp-speed-knob');
        container.innerHTML = ''; 

        if (this.tempoSyncEnabled) {
            this.createKnob(container, "SYNC DIV", 0, this.syncDivisions.length - 1, this.arpSyncIndex, 
                (v) => this.syncDivisions[Math.round(v)].label, 
                (v) => { this.arpSyncIndex = Math.round(v); },
                true
            );
        } else {
            this.createKnob(container, "SPEED", 50, 1000, this.arpSpeed, 
                (v) => Math.round(v) + 'ms', 
                (v) => { this.arpSpeed = v; },
                false 
            );
        }
    }

    bindEvents() {
        const arpToggle = this.uiContainer.querySelector('#cp-arp-toggle');
        arpToggle.addEventListener('click', () => {
            this.arpEnabled = !this.arpEnabled;
            this.updateArpUI();
            if (!this.arpEnabled) this.stopAllNotes();
        });

        const syncToggle = this.uiContainer.querySelector('#cp-sync-toggle');
        syncToggle.addEventListener('click', () => {
            this.tempoSyncEnabled = !this.tempoSyncEnabled;
            this.updateArpUI();
            this.renderKnob(); 
        });

        const rndBtn = this.uiContainer.querySelector('#cp-rnd-pattern');
        rndBtn.addEventListener('click', () => {
            this.generateRandomPattern();
        });

        const harm2ndBtn = this.uiContainer.querySelector('#cp-harm-2nd');
        harm2ndBtn.addEventListener('click', () => {
            this.harmony2nd = !this.harmony2nd;
            this.updateArpUI();
        });

        const harm3rdBtn = this.uiContainer.querySelector('#cp-harm-3rd');
        harm3rdBtn.addEventListener('click', () => {
            this.harmony3rd = !this.harmony3rd;
            this.updateArpUI();
        });

        const arpInput = this.uiContainer.querySelector('#cp-arp-pattern');
        arpInput.addEventListener('input', (e) => {
            this.arpPattern = e.target.value.replace(/[^0-9\-]/g, '');
            e.target.value = this.arpPattern;
            this.updateVelocityArray();
        });

        this.uiContainer.querySelector('#cp-add-pad').addEventListener('click', () => {
            this.addPad("New Pad", [], "");
            this.openEditor(this.pads[this.pads.length - 1].id);
        });

        // Editor events
        this.uiContainer.querySelector('#cp-editor-close').addEventListener('click', () => this.closeEditor());
        
        const elName = this.uiContainer.querySelector('#cp-edit-name');
        const elKey = this.uiContainer.querySelector('#cp-edit-key');
        const elNotes = this.uiContainer.querySelector('#cp-edit-notes');

        const updatePad = () => {
            if (!this.editingPadId) return;
            const pad = this.pads.find(p => p.id === this.editingPadId);
            if (pad) {
                pad.name = elName.value;
                pad.keyBind = elKey.value.toLowerCase();
                pad.notes = this.parseNotesString(elNotes.value);
                this.renderPads();
            }
        };

        elName.addEventListener('change', updatePad);
        elKey.addEventListener('change', updatePad);
        elNotes.addEventListener('change', updatePad);

        // Yhteinen funktio soinnun luomiseen (Generointi ja Randomointi)
        const generateChord = (root, oct, type) => {
            const rootMidi = this.nameToMidi(root + oct);
            const intervals = this.chordTypes[type];
            
            if (intervals && rootMidi !== -1) {
                const notes = intervals.map(i => rootMidi + i);
                elNotes.value = this.notesToString(notes);
                
                // Lyhennetään yleisimmät sointutyypit selkeämmiksi nimeä varten
                let shortType = type;
                if (type === "Major") shortType = "Maj";
                else if (type === "Minor") shortType = "Min";
                else if (type === "Diminished") shortType = "Dim";
                else if (type === "Augmented") shortType = "Aug";
                
                elName.value = `${root} ${shortType}`;
                updatePad();
            }
        };

        // Generator
        this.uiContainer.querySelector('#cp-btn-generate').addEventListener('click', () => {
            const root = this.uiContainer.querySelector('#cp-edit-root').value;
            const oct = parseInt(this.uiContainer.querySelector('#cp-edit-oct').value);
            const type = this.uiContainer.querySelector('#cp-edit-type').value;
            generateChord(root, oct, type);
        });

        // RND Chord
        this.uiContainer.querySelector('#cp-btn-rnd-chord').addEventListener('click', () => {
            const roots = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
            const octs = [2, 3, 4, 5, 6];
            const types = Object.keys(this.chordTypes);

            const root = roots[Math.floor(Math.random() * roots.length)];
            const oct = octs[Math.floor(Math.random() * octs.length)];
            const type = types[Math.floor(Math.random() * types.length)];

            this.uiContainer.querySelector('#cp-edit-root').value = root;
            this.uiContainer.querySelector('#cp-edit-oct').value = oct;
            this.uiContainer.querySelector('#cp-edit-type').value = type;

            generateChord(root, oct, type);
        });

        // Learn
        const btnLearn = this.uiContainer.querySelector('#cp-btn-learn');
        btnLearn.addEventListener('click', () => {
            this.learningMidi = !this.learningMidi;
            if (this.learningMidi) {
                btnLearn.classList.add('active');
                btnLearn.innerText = "LEARNING... (PLAY MIDI)";
                if (this.editingPadId) {
                    const pad = this.pads.find(p => p.id === this.editingPadId);
                    if (pad) { pad.notes = []; updatePad(); }
                }
            } else {
                btnLearn.classList.remove('active');
                btnLearn.innerText = "MIDI LEARN";
            }
        });

        // Delete
        this.uiContainer.querySelector('#cp-btn-delete').addEventListener('click', () => {
            if (this.editingPadId && confirm("Delete this pad?")) {
                this.removePad(this.editingPadId);
            }
        });
    }

    renderPads() {
        const container = this.uiContainer.querySelector('#cp-pads-container');
        container.innerHTML = '';

        this.pads.forEach(pad => {
            const div = document.createElement('div');
            div.className = `cp-pad ${this.activePads.has(pad.id) ? 'active' : ''}`;
            div.dataset.id = pad.id;

            div.innerHTML = `
                <div class="cp-pad-key">${pad.keyBind ? `[${pad.keyBind.toUpperCase()}]` : ''}</div>
                <button class="cp-pad-edit-btn">⚙️</button>
                <div class="cp-pad-name">${pad.name}</div>
                <div class="cp-pad-notes">${this.notesToString(pad.notes)}</div>
            `;

            const play = (e) => { e.preventDefault(); this.triggerPadOn(pad.id); };
            const stop = (e) => { e.preventDefault(); this.triggerPadOff(pad.id); };

            div.addEventListener('mousedown', play);
            div.addEventListener('mouseup', stop);
            div.addEventListener('mouseleave', stop);
            div.addEventListener('touchstart', play, {passive: false});
            div.addEventListener('touchend', stop, {passive: false});
            div.addEventListener('touchcancel', stop);

            div.querySelector('.cp-pad-edit-btn').addEventListener('mousedown', (e) => {
                e.stopPropagation();
                this.openEditor(pad.id);
            });
            div.querySelector('.cp-pad-edit-btn').addEventListener('touchstart', (e) => {
                e.stopPropagation();
                this.openEditor(pad.id);
            });

            container.appendChild(div);
        });
    }

    renderVelocityUI() {
        const container = this.uiContainer.querySelector('#cp-vel-editor');
        if (!container) return;
        
        container.innerHTML = '';
        const len = this.arpVelocities.length;
        if (len === 0) return;

        let isDrawing = false;

        const updateBarHeight = (bar, fill, index, clientY) => {
            const rect = bar.getBoundingClientRect();
            let percent = 1 - ((clientY - rect.top) / rect.height);
            percent = Math.max(0, Math.min(1, percent));
            
            const vel = Math.round(percent * 127);
            this.arpVelocities[index] = vel;
            fill.style.height = `${percent * 100}%`;
        };

        for (let i = 0; i < len; i++) {
            const bar = document.createElement('div');
            bar.className = 'cp-vel-bar';
            bar.dataset.index = i;
            
            const fill = document.createElement('div');
            fill.className = 'cp-vel-fill';
            
            const velPercent = (this.arpVelocities[i] / 127) * 100;
            fill.style.height = `${velPercent}%`;

            bar.appendChild(fill);
            container.appendChild(bar);

            bar.addEventListener('mousedown', (e) => {
                isDrawing = true;
                updateBarHeight(bar, fill, i, e.clientY);
            });
            bar.addEventListener('mouseenter', (e) => {
                if (isDrawing) updateBarHeight(bar, fill, i, e.clientY);
            });
        }

        container.addEventListener('mouseup', () => { isDrawing = false; });
        container.addEventListener('mouseleave', () => { isDrawing = false; });
        
        container.addEventListener('touchmove', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            const elem = document.elementFromPoint(touch.clientX, touch.clientY);
            if (elem && (elem.classList.contains('cp-vel-bar') || elem.classList.contains('cp-vel-fill'))) {
                const bar = elem.classList.contains('cp-vel-bar') ? elem : elem.parentElement;
                const index = parseInt(bar.dataset.index);
                const fill = bar.querySelector('.cp-vel-fill');
                updateBarHeight(bar, fill, index, touch.clientY);
            }
        }, {passive: false});
    }

    highlightVelocityStep(index) {
        if (!this.uiContainer) return;
        const bars = this.uiContainer.querySelectorAll('.cp-vel-bar');
        bars.forEach((bar, i) => {
            if (i === index) bar.classList.add('playing');
            else bar.classList.remove('playing');
        });
    }

    updateArpUI() {
        if (!this.uiContainer) return;
        
        const btnArp = this.uiContainer.querySelector('#cp-arp-toggle');
        if (this.arpEnabled) {
            btnArp.classList.add('active');
            btnArp.innerText = "ARP ON";
        } else {
            btnArp.classList.remove('active');
            btnArp.innerText = "ARP OFF";
        }

        const btnSync = this.uiContainer.querySelector('#cp-sync-toggle');
        if (this.tempoSyncEnabled) {
            btnSync.classList.add('active');
        } else {
            btnSync.classList.remove('active');
        }

        const harm2 = this.uiContainer.querySelector('#cp-harm-2nd');
        if (harm2) {
            this.harmony2nd ? harm2.classList.add('active') : harm2.classList.remove('active');
        }

        const harm3 = this.uiContainer.querySelector('#cp-harm-3rd');
        if (harm3) {
            this.harmony3rd ? harm3.classList.add('active') : harm3.classList.remove('active');
        }
    }

    openEditor(id) {
        this.editingPadId = id;
        const pad = this.pads.find(p => p.id === id);
        if (!pad) return;

        this.uiContainer.querySelector('#cp-editor-panel').classList.add('visible');
        this.updateEditorUI();
    }

    updateEditorUI() {
        const pad = this.pads.find(p => p.id === this.editingPadId);
        if (!pad) return;
        this.uiContainer.querySelector('#cp-edit-name').value = pad.name;
        this.uiContainer.querySelector('#cp-edit-key').value = pad.keyBind;
        this.uiContainer.querySelector('#cp-edit-notes').value = this.notesToString(pad.notes);
    }

    closeEditor() {
        this.editingPadId = null;
        this.learningMidi = false;
        const btnLearn = this.uiContainer.querySelector('#cp-btn-learn');
        if(btnLearn) {
            btnLearn.classList.remove('active');
            btnLearn.innerText = "MIDI LEARN";
        }
        this.uiContainer.querySelector('#cp-editor-panel').classList.remove('visible');
    }

    createKnob(container, label, min, max, defaultValue, formatValue, onChange, isLinear = false) {
        const radius = 12, circ = 2 * Math.PI * radius, maxDash = circ * 0.75;
        container.innerHTML = `
            <div style="font-size:8px; color:#888; text-align:center; margin-bottom:2px; font-weight:bold;">${label}</div>
            <div style="position:relative; width:30px; height:30px; margin: 0 auto;">
                <svg class="cp-knob-svg" viewBox="0 0 30 30">
                    <circle class="cp-knob-track" cx="15" cy="15" r="${radius}" stroke-dasharray="${maxDash} ${circ}"></circle>
                    <circle class="cp-knob-val" cx="15" cy="15" r="${radius}" stroke-dasharray="0 ${circ}"></circle>
                </svg>
            </div>
            <div style="font-size:8px; margin-top:2px; color:#aaa; text-align:center;" class="knob-display">${formatValue(defaultValue)}</div>
        `;

        const valCircle = container.querySelector('.cp-knob-val');
        const display = container.querySelector('.knob-display');
        const svg = container.querySelector('svg');
        let currentVal = defaultValue;

        const updateVis = (val) => {
            let norm;
            if (isLinear) {
                norm = (val - min) / (max - min);
            } else {
                norm = (Math.log(val) - Math.log(min)) / (Math.log(max) - Math.log(min)); 
            }
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
            let newVal;

            if (isLinear) {
                const currentNorm = (startVal - min) / (max - min);
                let newNorm = Math.max(0, Math.min(1, currentNorm + delta));
                newVal = min + newNorm * (max - min);
                newVal = Math.round(newVal); 
            } else {
                const logMin = Math.log(min), logMax = Math.log(max);
                const currentNorm = (Math.log(startVal) - logMin) / (logMax - logMin);
                let newNorm = Math.max(0, Math.min(1, currentNorm + delta));
                newVal = Math.exp(logMin + newNorm * (logMax - logMin));
            }
            
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
        svg.addEventListener('touchstart', e => start(e.touches[0].clientY), {passive:false});
        window.addEventListener('touchmove', e => { if(isDragging){e.preventDefault(); move(e.touches[0].clientY);} }, {passive:false});
        window.addEventListener('touchend', end);
    }
}