// midi-sequencer.js
window.CustomAudioEffect = class MidiSeqPads {
    constructor(audioCtx) {
        this.ctx = audioCtx;

        // Audio Routing: Pass-through
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.input.connect(this.output);

        // State
        this.pads = []; 
        this.activePads = new Set();
        
        // Sequencer Clock
        this.masterStep = 0;
        this.clockTimer = null;

        // Timing Settings
        this.tempoSyncEnabled = true; // Oletuksena päällä
        this.seqSpeed = 125; // ms per step (jos sync pois)
        this.seqSyncIndex = 1; // 1/16 oletus
        this.syncDivisions = [
            { label: '1/32', mult: 0.125 },
            { label: '1/16', mult: 0.25 },
            { label: '1/8T', mult: 1/3 }, 
            { label: '1/8',  mult: 0.5 },
            { label: '1/4T', mult: 2/3 }, 
            { label: '1/4',  mult: 1.0 }
        ];

        // Editor State
        this.editingPadId = null;
        this.editorViewMode = 'grid'; // 'binary' tai 'grid'

        // Presets
        this.presets = {
            "Preset 1 (8 steps)": [
                { name: "kick", note: 36, pattern: "10000000" },
                { name: "snare", note: 38, pattern: "00001000" },
                { name: "hi-hat closed", note: 42, pattern: "01110110" },
                { name: "hi-hat open", note: 46, pattern: "00001000" },
                { name: "crash", note: 49, pattern: "10000000" },
                { name: "ride", note: 51, pattern: "00000001" }
            ],
            "House (16 steps)": [
                { name: "Kick", note: 36, pattern: "1000100010001000" },
                { name: "Clap", note: 39, pattern: "0000100000001000" },
                { name: "HH Closed", note: 42, pattern: "0010001000100010" },
                { name: "HH Open", note: 46, pattern: "0000000000000000" },
                { name: "Crash", note: 49, pattern: "1000000000000000" }
            ],
            "Breakbeat (16 steps)": [
                { name: "Kick", note: 36, pattern: "1000001000100000" },
                { name: "Snare", note: 38, pattern: "0000100000001000" },
                { name: "Hi-Hat", note: 42, pattern: "1111111111111111" }
            ],
            "Funk (16 steps)": [
                { name: "Kick", note: 36, pattern: "1000000010100000" },
                { name: "Snare", note: 38, pattern: "0000100000001001" },
                { name: "HH Closed", note: 42, pattern: "1111111111111111" },
                { name: "HH Open", note: 46, pattern: "0000000000000010" }
            ],
            "Rock (8 steps)": [
                { name: "Kick", note: 36, pattern: "10001000" },
                { name: "Snare", note: 38, pattern: "00100010" },
                { name: "HH Closed", note: 42, pattern: "11111111" }
            ],
            "Disco (16 steps)": [
                { name: "Kick", note: 36, pattern: "1010101010101010" },
                { name: "Snare", note: 38, pattern: "0010001000100010" },
                { name: "HH Open", note: 46, pattern: "0101010101010101" }
            ],
            "FILL: Snare Roll": [
                { name: "Snare", note: 38, pattern: "1111111111111111" }
            ],
            "FILL: Basic Fill": [
                { name: "Kick", note: 36, pattern: "1000000000000000" },
                { name: "Snare", note: 38, pattern: "0000000000001111" },
                { name: "Tom High", note: 50, pattern: "0000110000000000" },
                { name: "Tom Mid", note: 48, pattern: "0000000011000000" }
            ],
            "FILL: Tom Run": [
                { name: "Tom H", note: 50, pattern: "1100000000000000" },
                { name: "Tom M", note: 48, pattern: "0000110000000000" },
                { name: "Tom L", note: 45, pattern: "0000000011000000" },
                { name: "Snare", note: 38, pattern: "0000000000001111" }
            ],
            "FILL: Triplet Fill": [
                { name: "Kick", note: 36, pattern: "100100100100" },
                { name: "Snare", note: 38, pattern: "000000000111" },
                { name: "Tom", note: 45, pattern: "011011011000" }
            ]
        };

        // Initialize with 4 pads
        this.addPad("Main Beat", "z");
        this.loadPreset(this.pads[0], "House (16 steps)");

        this.addPad("Funk", "x");
        this.loadPreset(this.pads[1], "Funk (16 steps)");

        this.addPad("Fill 1", "c");
        this.loadPreset(this.pads[2], "FILL: Snare Roll");

        this.addPad("Fill 2", "v");
        this.loadPreset(this.pads[3], "FILL: Tom Run");

        this.initKeyboardListeners();
    }

    getNodes() {
        return { input: this.input, output: this.output };
    }

    // --- MIDI Out ---
    playNote(midiNote, velocity = 100) {
        if (typeof this.sendMidi === 'function') {
            this.sendMidi([0x90, midiNote, Math.floor(velocity)]);
            // Auto note off for drum hits
            setTimeout(() => {
                if (typeof this.sendMidi === 'function') {
                    this.sendMidi([0x80, midiNote, 0]);
                }
            }, 60);
        }
    }

    // --- Pads Control ---
    addPad(name, keyBind) {
        this.pads.push({
            id: Date.now() + Math.random(),
            name: name,
            keyBind: keyBind.toLowerCase(),
            tracks: [
                { name: "Kick", note: 36, pattern: "1000" }
            ]
        });
    }

    removePad(id) {
        this.pads = this.pads.filter(p => p.id !== id);
        if (this.editingPadId === id) this.closeEditor();
        this.renderPads();
    }

    triggerPadOn(id) {
        if (this.activePads.has(id)) return;
        const wasEmpty = this.activePads.size === 0;
        this.activePads.add(id);

        const padEl = this.uiContainer.querySelector(`[data-id="${id}"]`);
        if (padEl) padEl.classList.add('active');

        if (wasEmpty) {
            this.masterStep = 0;
            this.clockTick();
        }
    }

    triggerPadOff(id) {
        if (!this.activePads.has(id)) return;
        this.activePads.delete(id);
        
        const padEl = this.uiContainer.querySelector(`[data-id="${id}"]`);
        if (padEl) padEl.classList.remove('active');

        if (this.activePads.size === 0) {
            clearTimeout(this.clockTimer);
        }
    }

    // --- Sequencer Logic ---
    getStepDelay() {
        if (this.tempoSyncEnabled) {
            const currentBpm = window.bpm || window.globalTempo || 120;
            const quarterNoteMs = 60000 / currentBpm;
            const div = this.syncDivisions[this.seqSyncIndex];
            return quarterNoteMs * div.mult;
        }
        return this.seqSpeed;
    }

    clockTick() {
        if (this.activePads.size === 0) return;

        this.activePads.forEach(padId => {
            const pad = this.pads.find(p => p.id === padId);
            if (!pad) return;

            pad.tracks.forEach(track => {
                if (!track.pattern || track.pattern.length === 0) return;
                const char = track.pattern[this.masterStep % track.pattern.length];
                if (char === '1') {
                    this.playNote(track.note, 100);
                }
            });
        });

        // Visual step update
        this.highlightEditorStep(this.masterStep);

        this.masterStep++;
        this.clockTimer = setTimeout(() => this.clockTick(), this.getStepDelay());
    }

    loadPreset(pad, presetName) {
        const p = this.presets[presetName];
        if (!p) return;
        pad.tracks = JSON.parse(JSON.stringify(p));
    }

    randomizeTrack(track) {
        const type = track.name.toLowerCase();
        const len = track.pattern.length > 0 ? track.pattern.length : 16;
        let p = "";
        for (let i = 0; i < len; i++) {
            let hit = '0';
            const rnd = Math.random();
            if (type.includes('kick')) {
                if (i % 4 === 0 && rnd > 0.2) hit = '1';
                else if (rnd > 0.85) hit = '1';
            } else if (type.includes('snare') || type.includes('clap')) {
                if (i % 8 === 4 && rnd > 0.1) hit = '1';
                else if (rnd > 0.92) hit = '1';
            } else if (type.includes('hat') || type.includes('hh')) {
                if (rnd > 0.4) hit = '1';
            } else if (type.includes('crash') || type.includes('ride') || type.includes('cymbal')) {
                if (i === 0 && rnd > 0.3) hit = '1';
                else if (rnd > 0.95) hit = '1';
            } else {
                if (rnd > 0.7) hit = '1';
            }
            p += hit;
        }
        track.pattern = p;
    }

    randomizePad(pad) {
        pad.tracks.forEach(t => this.randomizeTrack(t));
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
            seqSpeed: this.seqSpeed,
            seqSyncIndex: this.seqSyncIndex,
            tempoSyncEnabled: this.tempoSyncEnabled,
            editorViewMode: this.editorViewMode
        };
    }

    setState(state) {
        if (!state) return;
        if (state.pads) this.pads = state.pads;
        if (state.seqSpeed !== undefined) this.seqSpeed = state.seqSpeed;
        if (state.seqSyncIndex !== undefined) this.seqSyncIndex = state.seqSyncIndex;
        if (state.tempoSyncEnabled !== undefined) this.tempoSyncEnabled = state.tempoSyncEnabled;
        if (state.editorViewMode !== undefined) this.editorViewMode = state.editorViewMode;
        if (this.uiContainer) {
            this.renderPads();
            this.updateSyncUI();
            this.renderKnob();
        }
    }

    renderUI(container) {
        this.uiContainer = container;
        const color = '#00ffcc'; 
        container.style.setProperty('--sp-color', color);

        if (!document.getElementById('sp-styles')) {
            const style = document.createElement('style');
            style.id = 'sp-styles';
            style.textContent = `
                .sp-panel { background: #111; padding: 15px; border-radius: 8px; border: 1px solid #333; font-family: monospace; color: #eee; min-width: 320px; }
                .sp-header { text-align: center; color: var(--sp-color); font-weight: bold; letter-spacing: 2px; text-shadow: 0 0 10px rgba(0,255,204,0.5); margin-bottom: 15px; font-size: 14px; }
                .sp-controls { display: flex; gap: 15px; align-items: center; flex-wrap: wrap; background: #1a1a1a; border: 1px solid #333; padding: 10px; border-radius: 6px; margin-bottom: 15px; }
                .sp-btn { background: #222; border: 1px solid #555; color: #ddd; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-family: monospace; font-size: 11px; transition: 0.2s; }
                .sp-btn:hover { background: #333; border-color: var(--sp-color); }
                .sp-btn.active { background: var(--sp-color); color: #000; border-color: #fff; box-shadow: 0 0 10px var(--sp-color); font-weight: bold; }
                .sp-input { background: #000; border: 1px solid #444; color: var(--sp-color); padding: 5px; font-family: monospace; border-radius: 3px; }
                .sp-pad-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 10px; margin-bottom: 15px; }
                .sp-pad { position: relative; background: linear-gradient(145deg, #222, #111); border: 2px solid #444; border-radius: 8px; height: 90px; display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: pointer; user-select: none; transition: 0.1s; box-shadow: 3px 3px 10px rgba(0,0,0,0.5); overflow: hidden; }
                .sp-pad.active { transform: scale(0.95); border-color: var(--sp-color); background: #103a35; box-shadow: inset 0 0 15px var(--sp-color); }
                .sp-pad-key { position: absolute; top: 4px; left: 6px; font-size: 10px; color: var(--sp-color); background: rgba(0,0,0,0.6); padding: 1px 4px; border-radius: 3px; border: 1px solid #333;}
                .sp-pad-edit-btn { position: absolute; top: 4px; right: 4px; font-size: 10px; background: none; border: none; color: #666; cursor: pointer; padding: 2px; }
                .sp-editor { display: none; background: #1a1a1a; border: 1px solid var(--sp-color); padding: 15px; border-radius: 6px; flex-direction: column; gap: 10px; box-shadow: 0 0 15px rgba(0,255,204,0.2); }
                .sp-editor.visible { display: flex; }
                .sp-tracks-container { display: flex; flex-direction: column; gap: 8px; max-height: 400px; overflow-y: auto; overflow-x: hidden; padding-right: 5px; }
                .sp-track-row { display: flex; gap: 5px; align-items: center; background: #0a0a0a; padding: 8px; border-radius: 4px; border: 1px solid #222; flex-wrap: nowrap; min-width: 100%; }
                .sp-step-grid { display: flex; gap: 3px; flex-wrap: nowrap; flex-grow: 1; min-width: 0; overflow-x: auto; padding: 2px; }
                .sp-step-btn { flex: 0 0 18px; width: 18px; height: 18px; background: #222; border: 1px solid #333; border-radius: 2px; cursor: pointer; transition: 0.1s; }
                .sp-step-btn.active { background: var(--sp-color); border-color: #fff; box-shadow: 0 0 5px var(--sp-color); }
                .sp-step-btn.current { border-color: #fff; box-shadow: 0 0 8px #fff; transform: scale(1.1); z-index: 5; }
                .sp-knob-svg { width: 30px; height: 30px; transform: rotate(135deg); cursor: ns-resize; }
                .sp-knob-track { fill: none; stroke: #333; stroke-width: 5; stroke-linecap: round; }
                .sp-knob-val { fill: none; stroke: var(--sp-color); stroke-width: 5; stroke-linecap: round; }
            `;
            document.head.appendChild(style);
        }

        container.innerHTML = `
            <div class="sp-panel">
                <div class="sp-header">MIDI SEQ PADS</div>
                <div class="sp-controls">
                    <div class="sp-speed-knob"></div>
                    <button class="sp-btn sp-sync-toggle" title="Sync to Host Tempo">SYNC</button>
                    <div style="flex-grow:1; text-align:right;">
                        <button class="sp-btn sp-add-pad-btn">+ ADD PAD</button>
                    </div>
                </div>
                <div class="sp-pad-grid"></div>
                <div class="sp-editor">
                    <div style="font-weight:bold; border-bottom:1px solid #444; padding-bottom:5px; margin-bottom:5px; display:flex; justify-content:space-between; align-items:center;">
                        <span>EDIT PAD</span>
                        <div style="display:flex; gap:5px;">
                            <button class="sp-btn sp-view-toggle" style="font-size:9px; border-color:#888;">VIEW: GRID</button>
                            <button class="sp-btn sp-editor-close" style="padding: 2px 5px; font-size:9px;">X</button>
                        </div>
                    </div>
                    <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                        <label style="font-size:10px; color:#aaa;">Name:</label>
                        <input type="text" class="sp-input sp-edit-name" style="width:100px;">
                        <label style="font-size:10px; color:#aaa;">Key:</label>
                        <input type="text" class="sp-input sp-edit-key" style="width:30px; text-align:center;" maxlength="1">
                        <label style="font-size:10px; color:#aaa;">Tracks:</label>
                        <input type="number" class="sp-input sp-edit-tracks-count" style="width:40px; text-align:center;" min="1" max="32">
                    </div>
                    <div style="display:flex; gap:10px; align-items:center; justify-content:space-between; background:#000; padding:10px; border-radius:4px;">
                        <select class="sp-input sp-edit-preset" style="font-size:10px;">
                            <option value="">-- Load Preset --</option>
                            ${Object.keys(this.presets).map(p => `<option value="${p}">${p}</option>`).join('')}
                        </select>
                        <button class="sp-btn sp-btn-rnd-pad" style="border-color:#ff00ff; color:#ff00ff;">RND PAD</button>
                    </div>
                    <div class="sp-tracks-container"></div>
                    <div style="text-align:right; margin-top:5px;">
                        <button class="sp-btn sp-btn-delete" style="background:#521; border-color:#922; color:#f88;">DELETE PAD</button>
                    </div>
                </div>
            </div>
        `;

        this.bindEvents();
        this.renderPads();
        this.updateSyncUI();
        this.renderKnob(); 
    }

    bindEvents() {
        const ui = this.uiContainer;
        ui.querySelector('.sp-sync-toggle').addEventListener('click', () => {
            this.tempoSyncEnabled = !this.tempoSyncEnabled;
            this.updateSyncUI();
            this.renderKnob(); 
        });

        ui.querySelector('.sp-add-pad-btn').addEventListener('click', () => {
            this.addPad("New Pad", "");
            this.openEditor(this.pads[this.pads.length - 1].id);
        });

        ui.querySelector('.sp-view-toggle').addEventListener('click', (e) => {
            this.editorViewMode = this.editorViewMode === 'grid' ? 'binary' : 'grid';
            e.target.innerText = `VIEW: ${this.editorViewMode.toUpperCase()}`;
            this.renderEditorTracks();
        });

        ui.querySelector('.sp-editor-close').addEventListener('click', () => this.closeEditor());
        
        const updatePadGeneral = () => {
            if (!this.editingPadId) return;
            const pad = this.pads.find(p => p.id === this.editingPadId);
            if (pad) {
                pad.name = ui.querySelector('.sp-edit-name').value;
                pad.keyBind = ui.querySelector('.sp-edit-key').value.toLowerCase();
                const newCount = parseInt(ui.querySelector('.sp-edit-tracks-count').value);
                if (newCount > 0) {
                    if (newCount > pad.tracks.length) {
                        for(let i = pad.tracks.length; i < newCount; i++) {
                            pad.tracks.push({ name: `Track ${i+1}`, note: 60, pattern: '00000000' });
                        }
                    } else if (newCount < pad.tracks.length) {
                        pad.tracks = pad.tracks.slice(0, newCount);
                    }
                }
                this.renderPads();
                this.renderEditorTracks();
            }
        };

        ui.querySelector('.sp-edit-name').addEventListener('change', updatePadGeneral);
        ui.querySelector('.sp-edit-key').addEventListener('change', updatePadGeneral);
        ui.querySelector('.sp-edit-tracks-count').addEventListener('change', updatePadGeneral);

        ui.querySelector('.sp-edit-preset').addEventListener('change', (e) => {
            if (!this.editingPadId || !e.target.value) return;
            const pad = this.pads.find(p => p.id === this.editingPadId);
            if (pad) {
                this.loadPreset(pad, e.target.value);
                ui.querySelector('.sp-edit-tracks-count').value = pad.tracks.length;
                this.renderPads();
                this.renderEditorTracks();
            }
            e.target.value = '';
        });

        ui.querySelector('.sp-btn-rnd-pad').addEventListener('click', () => {
            const pad = this.pads.find(p => p.id === this.editingPadId);
            if (pad) { this.randomizePad(pad); this.renderEditorTracks(); }
        });

        ui.querySelector('.sp-btn-delete').addEventListener('click', () => {
            if (this.editingPadId && confirm("Delete pad?")) this.removePad(this.editingPadId);
        });
    }

    renderPads() {
        if (!this.uiContainer) return;
        const container = this.uiContainer.querySelector('.sp-pad-grid');
        container.innerHTML = '';
        this.pads.forEach(pad => {
            const div = document.createElement('div');
            div.className = `sp-pad ${this.activePads.has(pad.id) ? 'active' : ''}`;
            div.dataset.id = pad.id;
            div.innerHTML = `
                <div class="sp-pad-key">${pad.keyBind ? `[${pad.keyBind.toUpperCase()}]` : ''}</div>
                <button class="sp-pad-edit-btn">⚙️</button>
                <div style="font-weight:bold; font-size:12px;">${pad.name}</div>
                <div style="font-size:9px; color:#888;">${pad.tracks.length} Trk</div>
            `;
            const play = (e) => { e.preventDefault(); this.triggerPadOn(pad.id); };
            const stop = (e) => { e.preventDefault(); this.triggerPadOff(pad.id); };
            div.addEventListener('mousedown', play);
            div.addEventListener('mouseup', stop);
            div.addEventListener('mouseleave', stop);
            div.querySelector('.sp-pad-edit-btn').addEventListener('mousedown', (e) => {
                e.stopPropagation(); this.openEditor(pad.id);
            });
            container.appendChild(div);
        });
    }

    openEditor(id) {
        this.editingPadId = id;
        const pad = this.pads.find(p => p.id === id);
        if (!pad) return;
        const ui = this.uiContainer;
        ui.querySelector('.sp-editor').classList.add('visible');
        ui.querySelector('.sp-edit-name').value = pad.name;
        ui.querySelector('.sp-edit-key').value = pad.keyBind;
        ui.querySelector('.sp-edit-tracks-count').value = pad.tracks.length;
        this.renderEditorTracks();
    }

    closeEditor() {
        this.editingPadId = null;
        this.uiContainer.querySelector('.sp-editor').classList.remove('visible');
    }

    renderEditorTracks() {
        if (!this.editingPadId || !this.uiContainer) return;
        const pad = this.pads.find(p => p.id === this.editingPadId);
        const container = this.uiContainer.querySelector('.sp-tracks-container');
        container.innerHTML = '';

        pad.tracks.forEach((track, tIdx) => {
            const row = document.createElement('div');
            row.className = 'sp-track-row';
            row.dataset.tidx = tIdx;
            
            const controls = `
                <input type="text" class="sp-input sp-t-name" value="${track.name}" style="width:60px; font-size:10px;">
                <input type="number" class="sp-input sp-t-note" value="${track.note}" style="width:38px; font-size:10px;">
            `;

            if (this.editorViewMode === 'binary') {
                row.innerHTML = `${controls} <input type="text" class="sp-input sp-t-pattern" value="${track.pattern}" style="flex-grow:1;">`;
                row.querySelector('.sp-t-pattern').addEventListener('input', (e) => {
                    track.pattern = e.target.value.replace(/[^01]/g, '');
                });
            } else {
                row.innerHTML = `
                    ${controls}
                    <div style="display:flex; flex-direction:column; align-items:center;">
                        <span style="font-size:7px;">LEN</span>
                        <input type="number" class="sp-input sp-t-len" value="${track.pattern.length}" style="width:30px; font-size:9px; padding:1px;">
                    </div>
                    <div class="sp-step-grid"></div>
                `;
                const grid = row.querySelector('.sp-step-grid');
                track.pattern.split('').forEach((char, sIdx) => {
                    const btn = document.createElement('div');
                    btn.className = `sp-step-btn ${char === '1' ? 'active' : ''}`;
                    btn.addEventListener('click', () => {
                        let arr = track.pattern.split('');
                        arr[sIdx] = arr[sIdx] === '1' ? '0' : '1';
                        track.pattern = arr.join('');
                        btn.classList.toggle('active');
                    });
                    grid.appendChild(btn);
                });
                row.querySelector('.sp-t-len').addEventListener('change', (e) => {
                    let nl = parseInt(e.target.value) || 1;
                    track.pattern = nl > track.pattern.length ? track.pattern.padEnd(nl, '0') : track.pattern.substring(0, nl);
                    this.renderEditorTracks();
                });
            }

            row.querySelector('.sp-t-name').addEventListener('change', (e) => track.name = e.target.value);
            row.querySelector('.sp-t-note').addEventListener('change', (e) => track.note = parseInt(e.target.value) || 0);
            container.appendChild(row);
        });
    }

    highlightEditorStep(step) {
        if (!this.editingPadId || !this.uiContainer || this.editorViewMode !== 'grid') return;
        const rows = this.uiContainer.querySelectorAll('.sp-track-row');
        const pad = this.pads.find(p => p.id === this.editingPadId);
        
        rows.forEach((row, i) => {
            const track = pad.tracks[i];
            if (!track) return;
            const current = step % track.pattern.length;
            const btns = row.querySelectorAll('.sp-step-btn');
            btns.forEach((b, idx) => {
                if (idx === current) b.classList.add('current');
                else b.classList.remove('current');
            });
        });
    }

    updateSyncUI() {
        const btn = this.uiContainer.querySelector('.sp-sync-toggle');
        if (this.tempoSyncEnabled) btn.classList.add('active');
        else btn.classList.remove('active');
    }

    renderKnob() {
        const container = this.uiContainer.querySelector('.sp-speed-knob');
        container.innerHTML = ''; 
        if (this.tempoSyncEnabled) {
            this.createKnob(container, "SYNC", 0, this.syncDivisions.length - 1, this.seqSyncIndex, 
                (v) => this.syncDivisions[Math.round(v)].label, (v) => this.seqSyncIndex = Math.round(v), true);
        } else {
            this.createKnob(container, "MS", 50, 1000, this.seqSpeed, 
                (v) => Math.round(v) + 'ms', (v) => this.seqSpeed = v, false);
        }
    }

    createKnob(container, label, min, max, def, format, onChange, isLinear) {
        const rad = 12, circ = 2 * Math.PI * rad, maxD = circ * 0.75;
        container.innerHTML = `
            <div style="font-size:8px; color:#888; text-align:center; font-weight:bold;">${label}</div>
            <svg class="sp-knob-svg" viewBox="0 0 30 30">
                <circle class="sp-knob-track" cx="15" cy="15" r="${rad}" stroke-dasharray="${maxD} ${circ}"></circle>
                <circle class="sp-knob-val" cx="15" cy="15" r="${rad}" stroke-dasharray="0 ${circ}"></circle>
            </svg>
            <div style="font-size:8px; color:#aaa; text-align:center;" class="k-disp">${format(def)}</div>
        `;
        const vCircle = container.querySelector('.sp-knob-val');
        const disp = container.querySelector('.k-disp');
        const svg = container.querySelector('svg');
        let cur = def;

        const up = (val) => {
            let n = isLinear ? (val - min) / (max - min) : (Math.log(val) - Math.log(min)) / (Math.log(max) - Math.log(min));
            vCircle.setAttribute('stroke-dasharray', `${n * maxD} ${circ}`);
            disp.innerText = format(val);
        };
        up(cur);

        let drag = false, sy = 0, sv = 0;
        const start = (y) => { drag = true; sy = y; sv = cur; };
        const move = (y) => {
            if (!drag) return;
            const d = (sy - y) / 100;
            let nv;
            if (isLinear) {
                let n = Math.max(0, Math.min(1, (sv - min) / (max - min) + d));
                nv = Math.round(min + n * (max - min));
            } else {
                let n = Math.max(0, Math.min(1, (Math.log(sv) - Math.log(min)) / (Math.log(max) - Math.log(min)) + d));
                nv = Math.exp(Math.log(min) + n * (Math.log(max) - Math.log(min)));
            }
            if (nv !== cur) { cur = nv; up(nv); onChange(nv); }
        };
        svg.addEventListener('mousedown', e => start(e.clientY));
        window.addEventListener('mousemove', e => move(e.clientY));
        window.addEventListener('mouseup', () => drag = false);
    }
}