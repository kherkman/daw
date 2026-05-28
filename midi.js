/* =========================================
   MIDI LOGIC (Midi.js)
========================================= */

(function(exports) {
    class RoundRobinSampler {
        constructor() { 
            this.samples = []; 
            this.rrIndex = 0; 
            this.baseNote = 60; 
        }

        async addSample(note, file, ctx) {
            try {
                const ab = await file.arrayBuffer(); 
                const buffer = await ctx.decodeAudioData(ab);
                this.samples.push({ file: file, buffer: buffer, name: file.name }); 
                return true;
            } catch (e) { 
                console.error("Virhe samplen latauksessa:", e);
                return false; 
            }
        }

        playNote(ctx, dest, note, velocity, when, offsetTimeline, duration) {
            if (this.samples.length === 0) return null;
            
            let sampleData = this.samples[this.rrIndex];
            this.rrIndex = (this.rrIndex + 1) % this.samples.length;

            const src = ctx.createBufferSource(); 
            src.buffer = sampleData.buffer;
            
            const playbackRate = Math.pow(2, (note - this.baseNote) / 12);
            src.playbackRate.value = playbackRate;
            
            const bufferOffset = offsetTimeline * playbackRate;
            
            const gain = ctx.createGain(); 
            const velFloat = velocity / 127.0;
            
            const safeAttack = Math.min(0.01, duration * 0.1);
            const safeRelease = Math.min(0.05, duration * 0.2);

            gain.gain.value = 0;
            try {
                gain.gain.setValueAtTime(0, when);
                gain.gain.linearRampToValueAtTime(velFloat, when + safeAttack);
                gain.gain.setValueAtTime(velFloat, Math.max(when + safeAttack, when + duration - safeRelease));
                gain.gain.setTargetAtTime(0, when + duration - safeRelease, safeRelease / 3);
            } catch(e) {
                gain.gain.value = velFloat;
            }

            src.connect(gain); 
            gain.connect(dest);
            
            try {
                src.start(when, bufferOffset); 
                src.stop(when + duration + safeRelease + 0.1);
            } catch(e) {}

            return { src, gain };
        }

        stopNote(srcInfo, ctx) {
            if (!srcInfo || !srcInfo.gain || !srcInfo.src) return;
            const now = ctx.currentTime;
            
            try {
                srcInfo.gain.gain.cancelScheduledValues(now);
                srcInfo.gain.gain.setValueAtTime(srcInfo.gain.gain.value || 0, now);
                srcInfo.gain.gain.setTargetAtTime(0, now, 0.015);

                setTimeout(() => {
                    try { srcInfo.src.stop(); } catch(e){}
                    try { srcInfo.gain.disconnect(); } catch(e){}
                    try { srcInfo.src.disconnect(); } catch(e){}
                }, 50);
            } catch(e) {
                try { srcInfo.gain.disconnect(); } catch(err){}
                try { srcInfo.src.stop(); } catch(err){}
            }
        }
    }

    // Globaali MIDI-reititin Sidechainia varten
    window.broadcastSidechainMidi = function(sourceTrackId, msg) {
        if (!window.masterTrackPool) return;
        
        window.masterTrackPool.forEach(targetTrack => {
            if (targetTrack.isMidi && targetTrack.midiInputSource === 'SIDECHAIN' && targetTrack.sidechainSource === sourceTrackId) {
                if (window.pianoRollUI && window.pianoRollUI.activeTrack === targetTrack && window.pianoRollUI.isModalOpen) {
                    window.pianoRollUI.handleMidiMessage({ data: msg });
                } else {
                    window.pianoRollUI.deliverMidiToTrack(targetTrack, msg);
                }
            }
        });
    };

    class PianoRollUI {
        constructor() {
            this.activeTrack = null; 
            this.selectedNoteNumber = 60; 
            this.snapToGrid = true; 
            this.gridBeatDivision = 4;
            this.selectedNotes = []; 
            this.clipboardNotes = []; 
            
            this.scaleRoot = 0; 
            this.scaleSteps = "2212221"; 
            this.currentScaleNotes = new Set();
            
            this.virtualOctave = 4; 
            this.virtualKeyOffset = 0; 
            this.currentKeyMap = {}; 
            this.pressedKeys = {}; 
            this.isKeysOpen = false; 

            this.activeAutomation = null; 
            this.autoLaneHeight = 150;

            this.isLassoing = false;
            this.lassoStart = { x: 0, y: 0 };
            this.lassoCurrent = { x: 0, y: 0 };

            this.midiAccess = null;
            this.activeMidiInput = null;
            this.isRecordingMidi = false;
            this.recordingNotes = {}; 
            this.activePreviewNotes = {}; 
            
            this.activePlayingNotes = new Set();

            this.isModalOpen = false;
            this.animationId = null;

            this.createModal(); 
            this.setupCanvas();
            this.initWebMIDI();
            this.updateScale();
            this.setupKeyboardShortcuts();
        }

        updateScale() {
            this.currentScaleNotes.clear();
            let current = this.scaleRoot;
            this.currentScaleNotes.add(current % 12);
            for(let char of this.scaleSteps) {
                let step = parseInt(char);
                if(isNaN(step)) continue;
                current = (current + step) % 12;
                this.currentScaleNotes.add(current);
            }
            this.draw();
            if(document.getElementById('pr-vk-container').style.display !== 'none') {
                this.buildVirtualKeyboard();
            }
        }

        async initWebMIDI() {
            if (navigator.requestMIDIAccess) {
                try {
                    this.midiAccess = await navigator.requestMIDIAccess();
                    this.updateMidiInputs();
                    this.midiAccess.onstatechange = () => this.updateMidiInputs();
                } catch (e) {
                    console.log("MIDI ei ole käytettävissä selaimesi kautta.");
                    this.updateMidiInputs(); 
                }
            } else {
                this.updateMidiInputs(); 
            }
        }

        updateMidiInputs() {
            const select = document.getElementById('pr-midi-in');
            if(!select) return;
            
            let currentVal = select.value;
            if (this.activeTrack && this.activeTrack.midiInputSource !== undefined) {
                currentVal = this.activeTrack.midiInputSource;
            }

            select.innerHTML = '<option value="">-- MIDI In --</option>';
            select.innerHTML += '<option value="SIDECHAIN">Sidechain (MIDI Router)</option>';
            
            if (this.midiAccess) {
                for (let input of this.midiAccess.inputs.values()) {
                    select.innerHTML += `<option value="${input.id}">${input.name}</option>`;
                }
            }
            select.value = currentVal;
            
            select.onchange = (e) => {
                const id = e.target.value;
                if(this.activeTrack) {
                    this.activeTrack.midiInputSource = id;
                    if(typeof window.saveState === 'function') window.saveState();
                }
                
                if (id === 'SIDECHAIN') {
                    if (!this.activeTrack || !this.activeTrack.sidechainSource) {
                        alert("Valitse ensin Sidechain-lähde raidan FX-valikosta (Routing & Sidechain)!");
                    }
                }
                
                this.bindFXMidi();
            };
        }

        bindFXMidi() {
            if (!this.activeTrack) return;

            // Varmistetaan että raidan mahdollinen FX-ketju on reititetty
            if (typeof this.activeTrack.patchFxChain === 'function') {
                this.activeTrack.patchFxChain();
            }

            // Hardware MIDI In (jos valittu ja ei ole Sidechain)
            const sourceId = this.activeTrack.midiInputSource;
            if (this.activeMidiInput && this.activeMidiInput.onmidimessage) {
                this.activeMidiInput.onmidimessage = null;
            }
            this.activeMidiInput = null;

            if (sourceId && sourceId !== 'SIDECHAIN' && this.midiAccess) {
                this.activeMidiInput = this.midiAccess.inputs.get(sourceId);
                if(this.activeMidiInput) {
                    this.activeMidiInput.onmidimessage = (msg) => this.handleMidiMessage(msg);
                }
            }
        }

        deliverMidiToTrack(track, msg) {
            if (typeof track.patchFxChain === 'function') track.patchFxChain();

            const [status, data1, data2] = msg;
            const type = status & 0xf0;
            const pitch = data1;
            const velocity = data2;

            if ((type === 0xE0 || type === 0xB0 || type === 0x90 || type === 0x80) && track.customFX && track.customFX.length > 0) {
                if (typeof track.customFX[0].onMidi === 'function') {
                    track.customFX[0].onMidi(msg);
                }
                return; 
            }

            if (type === 0x90 && velocity > 0) {
                if (window.audioCtx && window.masterBusInput && track.sampler) {
                    let srcInfo = track.sampler.playNote(window.audioCtx, window.masterBusInput, pitch, velocity, window.audioCtx.currentTime, 0, 10);
                    if (!track._bgPlayingNotes) track._bgPlayingNotes = {};
                    track._bgPlayingNotes[pitch] = srcInfo;
                }
            } else if (type === 0x80 || (type === 0x90 && velocity === 0)) {
                if (track._bgPlayingNotes && track._bgPlayingNotes[pitch]) {
                    if (track.sampler) track.sampler.stopNote(track._bgPlayingNotes[pitch], window.audioCtx);
                    delete track._bgPlayingNotes[pitch];
                }
            }
        }

        handleGeneratedMidi(data) {
            const [status, data1, data2] = data;
            const type = status & 0xf0;
            const pitch = data1;
            const velocity = data2;

            if (type === 0x90 && velocity > 0) {
                this.activePlayingNotes.add(pitch);
                
                if (window.audioCtx && window.masterBusInput && this.activeTrack && this.activeTrack.sampler) {
                    let srcInfo = this.activeTrack.sampler.playNote(window.audioCtx, window.masterBusInput, pitch, velocity, window.audioCtx.currentTime, 0, 10);
                    this.activePreviewNotes[pitch] = srcInfo;
                }
                
                if (this.isRecordingMidi && window.isPlaying) {
                    let startRel = (window.currentPlayTime || 0) - (this.activeTrack.startTimeOffset || 0);
                    this.recordingNotes[pitch] = { start: Math.max(0, startRel), velocity: velocity };
                }
                this.highlightVirtualKey(pitch, true);

            } else if (type === 0x80 || (type === 0x90 && velocity === 0)) {
                this.activePlayingNotes.delete(pitch);

                if(this.activePreviewNotes[pitch]) {
                    if (this.activeTrack && this.activeTrack.sampler) {
                        this.activeTrack.sampler.stopNote(this.activePreviewNotes[pitch], window.audioCtx);
                    }
                    delete this.activePreviewNotes[pitch];
                }

                if (this.isRecordingMidi && this.recordingNotes[pitch] && window.isPlaying) {
                    let endRel = (window.currentPlayTime || 0) - (this.activeTrack.startTimeOffset || 0);
                    let duration = endRel - this.recordingNotes[pitch].start;
                    
                    if (duration > 0.02) {
                        const newNote = { pitch, start: this.recordingNotes[pitch].start, duration, velocity: this.recordingNotes[pitch].velocity };
                        this.activeTrack.notes.push(newNote);
                        
                        if (newNote.start + duration > this.activeTrack.contentDuration) {
                            this.activeTrack.contentDuration = newNote.start + duration;
                            this.activeTrack.trimEnd = this.activeTrack.contentDuration;
                            if (typeof window.refreshTimeline === 'function') window.refreshTimeline();
                        }
                        if(typeof window.saveState === 'function') window.saveState();
                    }
                    delete this.recordingNotes[pitch];
                }
                this.highlightVirtualKey(pitch, false);
            }
        }

        triggerNoteOn(pitch, velocity = 100) {
            if(!this.activeTrack) return;
            if (typeof this.activeTrack.patchFxChain === 'function') this.activeTrack.patchFxChain();
            
            const hasMidiFX = this.activeTrack.customFX && this.activeTrack.customFX.length > 0;

            if (hasMidiFX) {
                if (typeof this.activeTrack.customFX[0].onMidi === 'function') {
                    this.activeTrack.customFX[0].onMidi([0x90, pitch, velocity]);
                }
            } else {
                this.activePlayingNotes.add(pitch);
                
                if (window.audioCtx && window.masterBusInput && this.activeTrack.sampler) {
                    let srcInfo = this.activeTrack.sampler.playNote(window.audioCtx, window.masterBusInput, pitch, velocity, window.audioCtx.currentTime, 0, 10);
                    this.activePreviewNotes[pitch] = srcInfo;
                }

                if (this.isRecordingMidi && window.isPlaying) {
                    let startRel = (window.currentPlayTime || 0) - (this.activeTrack.startTimeOffset || 0);
                    this.recordingNotes[pitch] = { 
                        start: Math.max(0, startRel), 
                        velocity: velocity 
                    };
                }

                if (window.broadcastSidechainMidi) {
                    window.broadcastSidechainMidi(this.activeTrack.id, [0x90, pitch, velocity]);
                }
            }
        }

        triggerNoteOff(pitch) {
            if(!this.activeTrack) return;
            if (typeof this.activeTrack.patchFxChain === 'function') this.activeTrack.patchFxChain();

            const hasMidiFX = this.activeTrack.customFX && this.activeTrack.customFX.length > 0;

            if (hasMidiFX) {
                if (typeof this.activeTrack.customFX[0].onMidi === 'function') {
                    this.activeTrack.customFX[0].onMidi([0x80, pitch, 0]);
                }
            } else {
                this.activePlayingNotes.delete(pitch);

                if(this.activePreviewNotes[pitch]) {
                    if (this.activeTrack.sampler) {
                        this.activeTrack.sampler.stopNote(this.activePreviewNotes[pitch], window.audioCtx);
                    }
                    delete this.activePreviewNotes[pitch];
                }

                if (this.isRecordingMidi && this.recordingNotes[pitch] && window.isPlaying) {
                    let endRel = (window.currentPlayTime || 0) - (this.activeTrack.startTimeOffset || 0);
                    let duration = endRel - this.recordingNotes[pitch].start;
                    
                    if (duration > 0.02) {
                        const newNote = {
                            pitch: pitch,
                            start: this.recordingNotes[pitch].start,
                            duration: duration,
                            velocity: this.recordingNotes[pitch].velocity
                        };
                        this.activeTrack.notes.push(newNote);
                        
                        const noteEnd = newNote.start + newNote.duration;
                        if (noteEnd > this.activeTrack.contentDuration) {
                            this.activeTrack.contentDuration = noteEnd;
                            this.activeTrack.trimEnd = noteEnd;
                            if (typeof window.refreshTimeline === 'function') window.refreshTimeline();
                        }
                        if(typeof window.saveState === 'function') window.saveState();
                    }
                    delete this.recordingNotes[pitch];
                }

                if (window.broadcastSidechainMidi) {
                    window.broadcastSidechainMidi(this.activeTrack.id, [0x80, pitch, 0]);
                }
            }
        }

        recordAutomation(type, value) {
            if (this.isRecordingMidi && window.isPlaying && this.activeTrack) {
                let startRel = (window.currentPlayTime || 0) - (this.activeTrack.startTimeOffset || 0);
                if (startRel >= 0) {
                    if (!this.activeTrack.automation) {
                        this.activeTrack.automation = { pitch: [], mod: [], pan: [] };
                    }
                    this.activeTrack.automation[type].push({ time: startRel, value: value });
                    this.activeTrack.automation[type].sort((a,b) => a.time - b.time);

                    if (startRel > this.activeTrack.contentDuration) {
                        this.activeTrack.contentDuration = startRel;
                        this.activeTrack.trimEnd = startRel;
                        if (typeof window.refreshTimeline === 'function') window.refreshTimeline();
                    }
                }
            }
        }

        handleMidiMessage(msg) {
            const [status, data1, data2] = msg.data;
            const type = status & 0xf0;
            const channel = status & 0x0f;
            const pitch = data1;
            const velocity = data2;

            if (this.activeTrack && typeof this.activeTrack.patchFxChain === 'function') {
                this.activeTrack.patchFxChain();
            }

            if ((type === 0xE0 || type === 0xB0) && this.activeTrack && this.activeTrack.customFX && this.activeTrack.customFX.length > 0) {
                if (typeof this.activeTrack.customFX[0].onMidi === 'function') {
                    this.activeTrack.customFX[0].onMidi(msg.data);
                }
            }

            if (type === 0x90 && velocity > 0) {
                this.triggerNoteOn(pitch, velocity);
                this.highlightVirtualKey(pitch, true);
            } else if (type === 0x80 || (type === 0x90 && velocity === 0)) {
                this.triggerNoteOff(pitch);
                this.highlightVirtualKey(pitch, false);
            } else if (type === 0xE0) { 
                const val = (data2 << 7) | data1;
                const norm = (val - 8192) / 8192; 
                this.recordAutomation('pitch', norm);
            } else if (type === 0xB0) { 
                if (data1 === 1) { 
                    this.recordAutomation('mod', data2 / 127);
                } else if (data1 === 10) { 
                    this.recordAutomation('pan', (data2 - 64) / 64);
                }
            }
        }

        createModal() {
            this.modal = document.createElement('div'); 
            this.modal.className = 'modal'; 
            this.modal.id = 'pianoRollModal';
            this.modal.tabIndex = -1; 
            
            this.modal.innerHTML = `
                <div class="modal-wrapper" style="max-width: 98%; height: 95vh; flex-direction: column;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px; flex-wrap:wrap; gap:5px;">
                        <h3 style="margin:0; color:white;" id="pr-title">Piano Roll</h3>
                        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                            
                            <select id="pr-scale-root" class="input-label" style="background:#222;" title="Asteikon perusääni">
                                <option value="0">C</option><option value="1">C#</option><option value="2">D</option><option value="3">D#</option>
                                <option value="4">E</option><option value="5">F</option><option value="6">F#</option><option value="7">G</option>
                                <option value="8">G#</option><option value="9">A</option><option value="10">A#</option><option value="11">B</option>
                            </select>
                            <input type="text" id="pr-scale-steps" value="2212221" class="bpm-input" style="width:70px;" title="Asteikon välit (esim 2212221 = Duuri)">
                            
                            <div style="width:1px; height:20px; background:#666; margin:0 5px;"></div>

                            <button id="pr-play-btn" class="primary" style="background:#4caf50; border-color:#388e3c;">Toista</button>
                            <button id="pr-stop-btn" class="primary" style="background:#555; border-color:#444;">Stop</button>

                            <div style="width:1px; height:20px; background:#666; margin:0 5px;"></div>

                            <button id="pr-auto-pitch" class="primary" style="background:#444; border-color:#555;" title="Pitch Bend automaatio">Pitch</button>
                            <button id="pr-auto-mod" class="primary" style="background:#444; border-color:#555;" title="Modulaatio (CC1)">Mod</button>
                            <button id="pr-auto-pan" class="primary" style="background:#444; border-color:#555;" title="Panorointi (CC10)">Pan</button>

                            <div style="width:1px; height:20px; background:#666; margin:0 5px;"></div>

                            <select id="pr-midi-in" class="input-label" style="background:#222; max-width:120px;" title="Valitse MIDI-koskettimisto">
                                <option value="">-- MIDI In --</option>
                            </select>
                            <button id="pr-rec-midi" class="primary" style="background:#8b1a1a; border-color:#cc3333;">REC MIDI</button>
                            <button id="pr-metro" class="primary" style="background:#555; border-color:#666;">Metro: OFF</button>
                            <button id="pr-toggle-keys" class="primary" style="background:#673ab7; border-color:#673ab7;">Keys 🎹</button>
                            
                            <div style="width:1px; height:20px; background:#666; margin:0 5px;"></div>

                            <label style="color:#aaa; font-size:12px;">Grid:</label>
                            <select id="pr-grid" class="input-label" style="background:#222;">
                                <option value="0.25">4/4</option>
                                <option value="0.5">2/4</option>
                                <option value="1">1/4</option>
                                <option value="2">1/8</option>
                                <option value="4" selected>1/16</option>
                                <option value="8">1/32</option>
                            </select>
                            <button id="pr-export-midi" class="primary" style="background:#2196f3; border-color:#2196f3;">Export MIDI</button>
                            <button onclick="document.getElementById('pianoRollModal').classList.remove('active')" class="primary">Sulje</button>
                        </div>
                    </div>
                    <div style="display:flex; flex-grow:1; gap:10px; overflow:hidden;">
                        <div style="width: 200px; background: #222; border-radius: 4px; border: 1px solid #444; display:flex; flex-direction:column; padding:10px; flex-shrink:0;">
                            <h4 style="margin:0 0 10px 0; color:var(--accent);">Instrumentti</h4>
                            <label style="color:#aaa; font-size:12px; margin-bottom:5px;">Base Note:</label>
                            <input type="number" id="pr-base-note" value="60" min="0" max="127" class="bpm-input" style="width:60px; margin-bottom:15px;">
                            
                            <label class="file-upload-label" style="text-align:center; margin-bottom:10px; background:#ffaa00; border-color:#ffaa00; color:#000; font-weight:bold;">
                                + Lataa JS Inst.
                                <input type="file" id="pr-js-upload" accept=".js" style="display:none;">
                            </label>
                            <label class="file-upload-label" style="text-align:center; margin-bottom:10px;">+ Lataa WAV<input type="file" id="pr-sample-upload" multiple accept="audio/*"></label>
                            
                            <div id="pr-sample-list" style="flex-grow:1; background:#111; overflow-y:auto; border:1px solid #333; padding:5px; font-size:11px; color:#ccc; margin-bottom:15px; max-height:150px;"></div>

                            <div style="background:#111; border:1px solid #333; padding:10px; border-radius:4px;">
                                <label style="color:#aaa; font-size:12px; display:block; margin-bottom:5px;">Velocity: <span id="pr-vel-val" style="color:#fff; font-weight:bold;">--</span></label>
                                <input type="range" id="pr-velocity" min="1" max="127" value="100" style="width:100%;" disabled>
                            </div>
                        </div>
                        <div style="flex-grow:1; background: #111; border: 1px solid #444; position:relative; overflow:auto;" id="pr-scroll-area">
                            <canvas id="pr-canvas" style="cursor: crosshair; display:block;"></canvas>
                        </div>
                    </div>
                    
                    <div id="pr-vk-container" style="display:none; height:120px; background:#333; border-top:2px solid #555; position:relative; flex-shrink:0; margin-top:5px; border-radius:4px; overflow:hidden;">
                        <div style="position:absolute; top:5px; right:10px; z-index:10;">
                            <span style="color:#aaa; font-size:12px; margin-right:15px;">Ohjaus: (1/2 Oct, 3/4 Shift) | <span id="pr-vk-octave" style="color:#fff;"></span></span>
                            <button id="pr-vk-close" style="background:transparent; border:none; color:white; font-weight:bold; cursor:pointer; font-size:16px;">X</button>
                        </div>
                        <div id="pr-vk-keys" style="display:flex; height:100%; width:100%; padding-top:15px; justify-content:center;">
                        </div>
                    </div>
                </div>`;
            document.body.appendChild(this.modal);
            this.canvas = document.getElementById('pr-canvas'); 
            this.ctx = this.canvas.getContext('2d');
            
            document.getElementById('pr-grid').onchange = (e) => { this.gridBeatDivision = parseFloat(e.target.value); this.draw(); };
            document.getElementById('pr-base-note').onchange = (e) => { if(this.activeTrack) { this.activeTrack.sampler.baseNote = parseInt(e.target.value); if(typeof window.saveState === 'function') window.saveState(); }};
            document.getElementById('pr-scale-root').onchange = (e) => { this.scaleRoot = parseInt(e.target.value); this.updateScale(); };
            document.getElementById('pr-scale-steps').oninput = (e) => { this.scaleSteps = e.target.value; this.updateScale(); };
            
            document.getElementById('pr-play-btn').onclick = () => { if(window.togglePlay) window.togglePlay(); };
            document.getElementById('pr-stop-btn').onclick = () => { if(window.stop) { window.stop(false); window.toBeginning(); } };

            ['pitch', 'mod', 'pan'].forEach(type => {
                const btn = document.getElementById(`pr-auto-${type}`);
                btn.onclick = () => {
                    if (this.activeAutomation === type) {
                        this.activeAutomation = null;
                    } else {
                        this.activeAutomation = type;
                    }
                    this.updateAutomationUI();
                    this.draw();
                };
            });

            const velSlider = document.getElementById('pr-velocity');
            const velVal = document.getElementById('pr-vel-val');
            velSlider.oninput = (e) => {
                if(this.selectedNotes.length > 0) {
                    const v = parseInt(e.target.value);
                    this.selectedNotes.forEach(n => n.velocity = v);
                    velVal.innerText = v;
                    this.draw();
                }
            };
            velSlider.onchange = () => { if(typeof window.saveState === 'function') window.saveState(); };

            document.getElementById('pr-rec-midi').onclick = (e) => {
                this.isRecordingMidi = !this.isRecordingMidi;
                const btn = e.target;
                if(this.isRecordingMidi) {
                    btn.style.backgroundColor = "#ff0000"; btn.style.borderColor = "#ff4444";
                    if (window.togglePlay && !window.isPlaying) window.togglePlay();
                } else {
                    btn.style.backgroundColor = "#8b1a1a"; btn.style.borderColor = "#cc3333";
                    this.recordingNotes = {}; 
                }
            };

            document.getElementById('pr-metro').onclick = () => {
                if(window.toggleMetronome) window.toggleMetronome();
                this.updateMetroBtnUI();
            };

            const vkContainer = document.getElementById('pr-vk-container');
            const toggleKeysBtn = document.getElementById('pr-toggle-keys');
            const toggleKeys = () => {
                if(vkContainer.style.display === 'none') {
                    vkContainer.style.display = 'block';
                    toggleKeysBtn.style.backgroundColor = "#8e24aa";
                    this.isKeysOpen = true; 
                    this.buildVirtualKeyboard();
                } else {
                    vkContainer.style.display = 'none';
                    toggleKeysBtn.style.backgroundColor = "#673ab7";
                    this.isKeysOpen = false;
                    this.currentKeyMap = {}; 
                }
            };
            toggleKeysBtn.onclick = toggleKeys;
            document.getElementById('pr-vk-close').onclick = toggleKeys;

            document.getElementById('pr-js-upload').onchange = (e) => {
                const file = e.target.files[0];
                if(!file || !this.activeTrack) return;
                const reader = new FileReader();
                reader.onload = (event) => {
                    if (typeof window.instantiateCustomFX === 'function') {
                        window.instantiateCustomFX(
                            event.target.result, file.name, null,
                            this.activeTrack.customFX, this.activeTrack.customFxDom,
                            () => { 
                                this.bindFXMidi(); 
                                if(window.isPlaying) window.play(); 
                            }
                        );
                        alert(`Instrumentti ladattu! Muokkaa asetuksia FX-valikosta.`);
                        if(typeof window.saveState === 'function') window.saveState();
                    }
                };
                reader.readAsText(file); e.target.value = '';
            };

            document.getElementById('pr-sample-upload').onchange = async (e) => {
                if(!this.activeTrack) return;
                for(let f of Array.from(e.target.files)) {
                    await this.activeTrack.sampler.addSample(this.selectedNoteNumber, f, window.audioCtx);
                }
                this.updateSampleList(); 
                if(typeof window.saveState === 'function') window.saveState();
                e.target.value = '';
            };

            document.getElementById('pr-export-midi').onclick = () => this.exportMidi();
            
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.attributeName === "class") {
                        if(!this.modal.classList.contains('active')) {
                            this.isModalOpen = false;
                            this.isKeysOpen = false; 
                            this.currentKeyMap = {}; 
                            
                            cancelAnimationFrame(this.animationId);
                            if (this.activeTrack) this.activeTrack.updateVisuals();
                        }
                    }
                });
            });
            observer.observe(this.modal, { attributes: true });
        }

        updateAutomationUI() {
            ['pitch', 'mod', 'pan'].forEach(type => {
                const btn = document.getElementById(`pr-auto-${type}`);
                if (this.activeAutomation === type) {
                    btn.style.backgroundColor = '#2196f3';
                    btn.style.borderColor = '#1e88e5';
                    btn.style.color = '#fff';
                } else {
                    btn.style.backgroundColor = '#444';
                    btn.style.borderColor = '#555';
                    btn.style.color = '#fff';
                }
            });
        }

        buildVirtualKeyboard() {
            const container = document.getElementById('pr-vk-keys');
            container.innerHTML = '';
            
            const shiftStr = this.virtualKeyOffset > 0 ? '+' + this.virtualKeyOffset : this.virtualKeyOffset;
            document.getElementById('pr-vk-octave').innerText = `Oct: ${this.virtualOctave} | Shift: ${shiftStr}`;

            const whiteChars = ['A','S','D','F','G','H','J','K','L'];
            
            const blackKeyMap = {
                'A': 'W',
                'S': 'E',
                'D': 'R',
                'F': 'T',
                'G': 'Y',
                'H': 'U',
                'J': 'I',
                'K': 'O',
                'L': 'P'
            };
            
            let wIdx = 0;
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

            this.currentKeyMap = {};
            let currentPitch = startPitch;
            let renderedWhiteCount = 0;
            let lastWhiteChar = null; 

            while(wIdx < whiteChars.length && currentPitch < 128) {
                const black = isBlack(currentPitch);
                
                let char = '';
                if (black) {
                    if (lastWhiteChar && blackKeyMap[lastWhiteChar]) {
                        char = blackKeyMap[lastWhiteChar];
                    } else {
                        currentPitch++; 
                        continue;
                    }
                } else {
                    char = whiteChars[wIdx++];
                    lastWhiteChar = char; 
                }

                this.currentKeyMap[char.toLowerCase()] = currentPitch;

                const isRoot = (currentPitch % 12) === this.scaleRoot;
                const inScale = this.currentScaleNotes.has(currentPitch % 12);

                let baseBg = '';
                let textColor = '';

                if (isRoot) {
                    baseBg = '#3498db'; 
                    textColor = '#fff';
                } else if (inScale) {
                    baseBg = black ? '#111' : '#fff'; 
                    textColor = black ? '#fff' : '#333';
                } else {
                    baseBg = black ? '#444' : '#bbb'; 
                    textColor = black ? '#888' : '#666';
                }

                const el = document.createElement('div');
                el.className = `vk-key vk-${black ? 'black' : 'white'}`;
                el.dataset.pitch = currentPitch;
                el.dataset.basebg = baseBg;
                
                el.style.position = black ? 'absolute' : 'relative';
                el.style.border = '1px solid #000';
                el.style.borderRadius = '0 0 4px 4px';
                el.style.cursor = 'pointer';
                el.style.userSelect = 'none';
                el.style.display = 'flex';
                el.style.alignItems = 'flex-end';
                el.style.justifyContent = 'center';
                el.style.paddingBottom = '10px';
                el.style.fontWeight = 'bold';
                el.style.background = baseBg;
                el.style.color = textColor;
                el.innerText = char;

                if(!black) {
                    el.style.width = '40px';
                    el.style.height = '100px';
                    el.style.zIndex = 1;
                    renderedWhiteCount++;
                } else {
                    el.style.width = '24px';
                    el.style.height = '65px';
                    el.style.zIndex = 2;
                    el.style.left = `calc(50% - ${(whiteChars.length * 40)/2}px + ${(renderedWhiteCount * 40) - 12}px)`;
                }

                const pitchCapture = currentPitch;
                const triggerOn = (e) => { e.preventDefault(); this.triggerNoteOn(pitchCapture, 100); this.highlightVirtualKey(pitchCapture, true); };
                const triggerOff = (e) => { e.preventDefault(); this.triggerNoteOff(pitchCapture); this.highlightVirtualKey(pitchCapture, false); };

                el.addEventListener('mousedown', triggerOn);
                el.addEventListener('mouseup', triggerOff);
                el.addEventListener('mouseleave', (e) => { if(e.buttons > 0) triggerOff(e); });
                el.addEventListener('touchstart', triggerOn, {passive:false});
                el.addEventListener('touchend', triggerOff, {passive:false});

                container.appendChild(el);
                currentPitch++;
            }
        }

        highlightVirtualKey(pitch, isOn) {
            const keys = document.querySelectorAll('.vk-key');
            keys.forEach(k => {
                if(parseInt(k.dataset.pitch) === pitch) {
                    if(isOn) {
                        k.style.background = '#ffeb3b'; 
                    } else {
                        k.style.background = k.dataset.basebg; 
                    }
                }
            });
        }

        setupKeyboardShortcuts() {
            window.addEventListener('keydown', (e) => {
                if(!this.modal.classList.contains('active') || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
                
                const k = e.key.toLowerCase();
                
                if (this.currentKeyMap[k] !== undefined && !this.pressedKeys[k]) {
                    this.pressedKeys[k] = true;
                    const pitch = this.currentKeyMap[k];
                    this.triggerNoteOn(pitch, 100);
                    this.highlightVirtualKey(pitch, true);
                    return; 
                }

                if (this.isKeysOpen) {
                    if (k === '1') { this.virtualOctave = Math.max(0, this.virtualOctave - 1); this.buildVirtualKeyboard(); return; }
                    if (k === '2') { this.virtualOctave = Math.min(8, this.virtualOctave + 1); this.buildVirtualKeyboard(); return; }
                    if (k === '3') { this.virtualKeyOffset--; this.buildVirtualKeyboard(); return; }
                    if (k === '4') { this.virtualKeyOffset++; this.buildVirtualKeyboard(); return; }
                }

                if(e.ctrlKey || e.metaKey) {
                    if (k === 'a') {
                        e.preventDefault();
                        if (this.activeTrack) {
                            this.selectedNotes = [...this.activeTrack.notes];
                            this.updateSelectionUI();
                            this.draw();
                        }
                    }
                    if (k === 'c') { e.preventDefault(); this.copySelection(); }
                    if (k === 'v') { e.preventDefault(); this.pasteSelection(); }
                    if (k === 'x') { e.preventDefault(); this.copySelection(); this.deleteSelection(); }
                } else if (e.key === 'Delete' || e.key === 'Backspace') {
                    e.preventDefault();
                    this.deleteSelection();
                } else if (e.code === 'Space') {
                    e.preventDefault();
                    if(window.togglePlay) window.togglePlay();
                }
            });

            window.addEventListener('keyup', (e) => {
                if(!this.modal.classList.contains('active')) return;
                
                const k = e.key.toLowerCase();
                if (this.currentKeyMap[k] !== undefined) {
                    this.pressedKeys[k] = false;
                    const pitch = this.currentKeyMap[k];
                    this.triggerNoteOff(pitch);
                    this.highlightVirtualKey(pitch, false);
                }
            });
        }

        copySelection() {
            if(this.selectedNotes.length === 0) return;
            let minStart = Infinity;
            this.selectedNotes.forEach(n => { if(n.start < minStart) minStart = n.start; });
            
            this.clipboardNotes = this.selectedNotes.map(n => ({
                pitch: n.pitch,
                relStart: n.start - minStart,
                duration: n.duration,
                velocity: n.velocity
            }));
            
            let maxEnd = 0;
            this.selectedNotes.forEach(n => { if(n.start + n.duration - minStart > maxEnd) maxEnd = n.start + n.duration - minStart; });
            this.clipboardBlockLength = maxEnd;
            this.lastPasteTime = minStart; 
        }

        pasteSelection() {
            if(this.clipboardNotes.length === 0 || !this.activeTrack) return;
            
            let pasteTime = this.lastPasteTime + this.clipboardBlockLength;
            if(this.snapToGrid) {
                const beatDur = 60 / window.bpm;
                const snapBeat = beatDur / this.gridBeatDivision; 
                pasteTime = Math.ceil(pasteTime / snapBeat) * snapBeat; 
            }

            this.selectedNotes = []; 
            
            this.clipboardNotes.forEach(cn => {
                const newNote = {
                    pitch: cn.pitch,
                    start: pasteTime + cn.relStart,
                    duration: cn.duration,
                    velocity: cn.velocity
                };
                this.activeTrack.notes.push(newNote);
                this.selectedNotes.push(newNote); 
            });

            this.lastPasteTime = pasteTime; 
            if(typeof window.saveState === 'function') window.saveState();
            
            let maxEnd = 0;
            this.activeTrack.notes.forEach(n => { if(n.start + n.duration > maxEnd) maxEnd = n.start + n.duration; });
            if (maxEnd > this.activeTrack.contentDuration) {
                this.activeTrack.contentDuration = maxEnd;
                this.activeTrack.trimEnd = maxEnd;
                if (typeof window.refreshTimeline === 'function') window.refreshTimeline();
            }

            this.draw();
            this.updateSelectionUI();
        }

        deleteSelection() {
            if(this.selectedNotes.length === 0 || !this.activeTrack) return;
            this.activeTrack.notes = this.activeTrack.notes.filter(n => !this.selectedNotes.includes(n));
            this.selectedNotes = [];
            if(typeof window.saveState === 'function') window.saveState();
            this.draw();
            this.updateSelectionUI();
        }

        handleAutomationInput(x, y, startY, autoH) {
            if (!this.activeAutomation || !this.activeTrack) return;

            const beatDur = 60 / window.bpm;
            let time = (x / this.pixelsPerBeat) * beatDur;

            if(this.snapToGrid) {
                const snapBeat = beatDur / this.gridBeatDivision;
                time = Math.round(time / snapBeat) * snapBeat;
            }

            let val;
            if (this.activeAutomation === 'mod') {
                val = 1.0 - ((y - startY) / autoH);
                val = Math.max(0, Math.min(1, val));
            } else {
                val = 1.0 - (((y - startY) / (autoH / 2)));
                val = Math.max(-1, Math.min(1, val));
            }

            if (!this.activeTrack.automation) {
                this.activeTrack.automation = { pitch: [], mod: [], pan: [] };
            }

            const arr = this.activeTrack.automation[this.activeAutomation];
            const filtered = arr.filter(pt => Math.abs(pt.time - time) > (beatDur/32));
            filtered.push({ time: time, value: val });
            filtered.sort((a,b) => a.time - b.time);
            this.activeTrack.automation[this.activeAutomation] = filtered;

            if (time > this.activeTrack.contentDuration) {
                this.activeTrack.contentDuration = time;
                this.activeTrack.trimEnd = time;
                if (typeof window.refreshTimeline === 'function') window.refreshTimeline();
            }

            this.draw();
        }

        setupCanvas() {
            this.noteHeight = 16; 
            this.pixelsPerBeat = 100; 
            this.totalKeys = 128;
            this.canvas.width = 3000; 
            
            let action = null; 
            let dragOriginX = 0;
            let dragOriginY = 0;
            let initialNoteStates = [];

            this.canvas.addEventListener('mousedown', (e) => {
                const rect = this.canvas.getBoundingClientRect(); 
                const x = e.clientX - rect.left; 
                const y = e.clientY - rect.top;
                
                const autoH = this.activeAutomation ? this.autoLaneHeight : 0;
                const noteAreaHeight = this.canvas.height - autoH;

                if (this.activeAutomation && y > noteAreaHeight) {
                    action = 'draw-automation';
                    this.handleAutomationInput(x, y, noteAreaHeight, autoH);
                    return;
                }

                const noteNum = 127 - Math.floor(y / this.noteHeight); 
                this.selectedNoteNumber = noteNum; 
                
                const beatDur = 60 / window.bpm; 
                const time = (x / this.pixelsPerBeat) * beatDur;

                if(e.button === 2) { 
                    const idx = this.activeTrack.notes.findIndex(n => n.pitch === noteNum && time >= n.start && time <= n.start + n.duration);
                    if(idx > -1) { 
                        this.activeTrack.notes.splice(idx, 1); 
                        this.selectedNotes = this.selectedNotes.filter(n => n !== this.activeTrack.notes[idx]);
                        this.draw(); this.updateSelectionUI();
                    } 
                    return;
                }

                const existing = this.activeTrack.notes.find(n => n.pitch === noteNum && time >= n.start && time <= n.start + n.duration);
                
                if (existing) {
                    if (!this.selectedNotes.includes(existing) && !e.shiftKey) {
                        this.selectedNotes = [existing];
                    } else if (e.shiftKey && !this.selectedNotes.includes(existing)) {
                        this.selectedNotes.push(existing);
                    } else if (e.shiftKey && this.selectedNotes.includes(existing)) {
                        this.selectedNotes = this.selectedNotes.filter(n => n !== existing);
                        this.draw(); this.updateSelectionUI(); return; 
                    }

                    this.updateSelectionUI();

                    initialNoteStates = this.selectedNotes.map(n => ({ note: n, start: n.start, duration: n.duration, pitch: n.pitch }));
                    dragOriginX = time;
                    dragOriginY = noteNum;

                    const pxStart = existing.start * (this.pixelsPerBeat / beatDur);
                    const pxEnd = (existing.start + existing.duration) * (this.pixelsPerBeat / beatDur);
                    const EDGE_TOLERANCE = 8; 

                    if (Math.abs(x - pxEnd) < EDGE_TOLERANCE) {
                        action = 'resize-right';
                        document.body.style.cursor = 'ew-resize';
                    } else if (Math.abs(x - pxStart) < EDGE_TOLERANCE) {
                        action = 'resize-left';
                        document.body.style.cursor = 'ew-resize';
                    } else { 
                        action = 'move'; 
                        document.body.style.cursor = 'grabbing';
                    }
                } else {
                    if (!e.shiftKey) {
                        this.selectedNotes = [];
                        this.updateSelectionUI();
                    }
                    
                    if (e.ctrlKey || e.metaKey || e.altKey) {
                        action = 'lasso';
                        this.isLassoing = true;
                        this.lassoStart = { x: x, y: y };
                        this.lassoCurrent = { x: x, y: y };
                    } else {
                        action = 'create'; 
                        let start = time;
                        if(this.snapToGrid) { 
                            const snapBeat = beatDur / this.gridBeatDivision; 
                            start = Math.floor(start / snapBeat) * snapBeat; 
                        }
                        
                        let newVel = this.selectedNotes.length > 0 ? this.selectedNotes[0].velocity : 100;
                        const dragNote = { pitch: noteNum, start: start, duration: beatDur / this.gridBeatDivision, velocity: newVel };
                        this.activeTrack.notes.push(dragNote);
                        this.selectedNotes = [dragNote];
                        this.updateSelectionUI();
                        
                        initialNoteStates = [{ note: dragNote, start: dragNote.start, duration: dragNote.duration, pitch: dragNote.pitch }];
                        dragOriginX = start;
                        action = 'resize-right'; 
                    }
                }
                this.draw();
            });

            window.addEventListener('mousemove', (e) => {
                const rect = this.canvas.getBoundingClientRect(); 
                if(e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;

                const x = e.clientX - rect.left; 
                const y = e.clientY - rect.top;
                const autoH = this.activeAutomation ? this.autoLaneHeight : 0;
                const noteAreaHeight = this.canvas.height - autoH;

                if (action === 'draw-automation') {
                    this.handleAutomationInput(x, y, noteAreaHeight, autoH);
                    return;
                }

                if(!action) {
                    if(!this.activeTrack) return;
                    
                    if (this.activeAutomation && y > noteAreaHeight) {
                        this.canvas.style.cursor = 'crosshair';
                        return;
                    }

                    const noteNum = 127 - Math.floor(y / this.noteHeight); 
                    const beatDur = 60 / window.bpm; 
                    const time = (x / this.pixelsPerBeat) * beatDur;

                    const existing = this.activeTrack.notes.find(n => n.pitch === noteNum && time >= n.start && time <= n.start + n.duration);
                    if(existing) {
                        const pxStart = existing.start * (this.pixelsPerBeat / beatDur);
                        const pxEnd = (existing.start + existing.duration) * (this.pixelsPerBeat / beatDur);
                        if (Math.abs(x - pxEnd) < 8 || Math.abs(x - pxStart) < 8) this.canvas.style.cursor = 'ew-resize';
                        else this.canvas.style.cursor = 'pointer';
                    } else {
                        this.canvas.style.cursor = 'crosshair';
                    }
                    return;
                }

                const beatDur = 60 / window.bpm;
                let time = (x / this.pixelsPerBeat) * beatDur;
                const noteNum = 127 - Math.floor(y / this.noteHeight); 
                
                if (action === 'lasso') {
                    this.lassoCurrent = { x: x, y: y };
                    this.draw();
                    return;
                }

                if(this.snapToGrid) { 
                    const snapBeat = beatDur / this.gridBeatDivision; 
                    time = Math.round(time / snapBeat) * snapBeat; 
                }

                const deltaTime = time - (this.snapToGrid ? Math.round(dragOriginX/(beatDur/this.gridBeatDivision))*(beatDur/this.gridBeatDivision) : dragOriginX);
                const deltaPitch = noteNum - dragOriginY;

                initialNoteStates.forEach(state => {
                    const n = state.note;
                    if(action === 'resize-right') {
                        n.duration = Math.max(beatDur/32, state.duration + deltaTime);
                    } else if (action === 'resize-left') {
                        const newStart = Math.max(0, state.start + deltaTime);
                        const newDur = state.duration - (newStart - state.start);
                        if(newDur >= beatDur/32) {
                            n.start = newStart;
                            n.duration = newDur;
                        }
                    } else if (action === 'move') {
                        n.start = Math.max(0, state.start + deltaTime);
                        n.pitch = Math.max(0, Math.min(127, state.pitch + deltaPitch));
                    }
                });
                this.draw();
            });

            window.addEventListener('mouseup', () => { 
                if (action === 'lasso') {
                    this.isLassoing = false;
                    const minX = Math.min(this.lassoStart.x, this.lassoCurrent.x);
                    const maxX = Math.max(this.lassoStart.x, this.lassoCurrent.x);
                    const minY = Math.min(this.lassoStart.y, this.lassoCurrent.y);
                    const maxY = Math.max(this.lassoStart.y, this.lassoCurrent.y);

                    const beatDur = 60 / window.bpm;
                    const timeStart = (minX / this.pixelsPerBeat) * beatDur;
                    const timeEnd = (maxX / this.pixelsPerBeat) * beatDur;
                    const pitchMax = 127 - Math.floor(minY / this.noteHeight);
                    const pitchMin = 127 - Math.floor(maxY / this.noteHeight);

                    this.activeTrack.notes.forEach(n => {
                        const nEnd = n.start + n.duration;
                        if(n.pitch >= pitchMin && n.pitch <= pitchMax &&
                           nEnd >= timeStart && n.start <= timeEnd) {
                            if(!this.selectedNotes.includes(n)) this.selectedNotes.push(n);
                        }
                    });
                    this.updateSelectionUI();
                }

                if(action) { 
                    action = null; 
                    document.body.style.cursor = 'default';
                    this.canvas.style.cursor = 'crosshair';

                    let maxEnd = 0;
                    this.activeTrack.notes.forEach(n => { if(n.start + n.duration > maxEnd) maxEnd = n.start + n.duration; });
                    if (maxEnd > this.activeTrack.contentDuration) {
                        this.activeTrack.contentDuration = maxEnd;
                        this.activeTrack.trimEnd = maxEnd;
                        if (typeof window.refreshTimeline === 'function') window.refreshTimeline();
                    }

                    if(typeof window.saveState === 'function') window.saveState(); 
                    this.draw();
                } 
            });
            this.canvas.addEventListener('contextmenu', e => e.preventDefault());
        }

        updateSelectionUI() {
            const velSlider = document.getElementById('pr-velocity');
            const velVal = document.getElementById('pr-vel-val');
            if(this.selectedNotes.length > 0) {
                velSlider.disabled = false;
                velSlider.value = this.selectedNotes[0].velocity;
                velVal.innerText = this.selectedNotes[0].velocity + (this.selectedNotes.length > 1 ? " (*)" : "");
            } else {
                velSlider.disabled = true;
                velVal.innerText = "--";
            }
        }

        open(track) {
            this.activeTrack = track; 
            
            if (!this.activeTrack.automation) {
                this.activeTrack.automation = { pitch: [], mod: [], pan: [] };
            }

            this.selectedNotes = []; 
            this.updateSelectionUI();
            this.updateAutomationUI();
            
            const select = document.getElementById('pr-midi-in');
            if(select) {
                select.value = track.midiInputSource || "";
            }
            this.bindFXMidi();

            document.getElementById('pr-title').innerText = "Piano Roll: " + track.name;
            document.getElementById('pr-base-note').value = track.sampler.baseNote;
            
            this.updateMetroBtnUI(); 
            
            this.isRecordingMidi = false;
            document.getElementById('pr-rec-midi').style.backgroundColor = "#8b1a1a";
            document.getElementById('pr-rec-midi').style.borderColor = "#cc3333";
            
            document.getElementById('pr-vk-container').style.display = 'none';
            document.getElementById('pr-toggle-keys').style.backgroundColor = "#673ab7";
            this.isKeysOpen = false;
            this.currentKeyMap = {}; 

            this.modal.classList.add('active'); 
            this.modal.focus(); 
            
            this.activePlayingNotes.clear();
            
            this.updateSampleList();
            this.updateScale(); 
            document.getElementById('pr-scroll-area').scrollTop = (127 - 72) * this.noteHeight; 

            this.isModalOpen = true;
            this.renderLoop();
        }

        renderLoop() {
            if (!this.isModalOpen) return;
            
            const playBtn = document.getElementById('pr-play-btn');
            if (playBtn) {
                playBtn.innerText = (window.isPlaying) ? "Tauko" : "Toista";
                playBtn.style.backgroundColor = (window.isPlaying) ? "#ff9800" : "#4caf50";
                playBtn.style.borderColor = (window.isPlaying) ? "#f57c00" : "#388e3c";
            }

            this.draw(); 
            this.animationId = requestAnimationFrame(() => this.renderLoop());
        }

        updateMetroBtnUI() {
            const metroBtn = document.getElementById('pr-metro');
            if(metroBtn) {
                const isOn = window.metronomeEnabled;
                metroBtn.innerText = isOn ? "Metro: ON" : "Metro: OFF";
                metroBtn.style.backgroundColor = isOn ? "#4caf50" : "#555";
                metroBtn.style.borderColor = isOn ? "#4caf50" : "#666";
            }
        }

        updateSampleList() {
            const list = document.getElementById('pr-sample-list'); 
            list.innerHTML = '';
            if(this.activeTrack && this.activeTrack.sampler.samples) {
                this.activeTrack.sampler.samples.forEach((s, i) => {
                    list.innerHTML += `<div style="border-bottom:1px solid #333; padding:3px 0;">${i+1}. ${s.name}</div>`;
                });
            }
            if(list.innerHTML === '') list.innerHTML = 'Ei sampleja. Lataa aloittaaksesi.';
        }

        exportMidi() {
            if (!this.activeTrack || !this.activeTrack.notes || this.activeTrack.notes.length === 0) {
                return alert("Ei nuotteja vietäväksi.");
            }
            if (typeof window.LocalMidi === 'undefined') {
                return alert("Paikallista MIDI-kirjastoa ei ole ladattu.");
            }

            const buf = window.LocalMidi.exportTrack(this.activeTrack.name, this.activeTrack.notes);
            const blob = new Blob([buf], { type: "audio/midi" });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = (this.activeTrack.name || "raita").replace(/[^a-z0-9]/gi, '_').toLowerCase() + ".mid";
            a.click();
        }

        draw() {
            if(!this.activeTrack) return;
            
            const beatDur = 60 / window.bpm;

            let maxTime = Math.max(16 * beatDur, this.activeTrack.contentDuration);
            this.activeTrack.notes.forEach(n => {
                if (n.start + n.duration > maxTime) maxTime = n.start + n.duration;
            });
            const neededWidth = Math.max(3000, (maxTime / beatDur) * this.pixelsPerBeat + 500);
            
            const autoHeight = this.activeAutomation ? this.autoLaneHeight : 0;
            const neededHeight = (this.totalKeys * this.noteHeight) + autoHeight;

            if (this.canvas.width !== neededWidth || this.canvas.height !== neededHeight) {
                this.canvas.width = neededWidth;
                this.canvas.height = neededHeight;
            }

            const w = this.canvas.width; 
            const h = this.canvas.height; 
            this.ctx.clearRect(0,0,w,h); 
            
            const scrollArea = document.getElementById('pr-scroll-area');
            const scrollX = scrollArea ? scrollArea.scrollLeft : 0;
            const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
            const activePitches = new Set(this.activeTrack.notes.map(n => n.pitch));

            for(let i = 0; i < this.totalKeys; i++) {
                const y = i * this.noteHeight; 
                const pitch = 127 - i;
                const isBlack = [1,3,6,8,10].includes(pitch % 12);
                const inScale = this.currentScaleNotes.has(pitch % 12);
                const isRoot = (pitch % 12) === this.scaleRoot;
                const isPlaying = this.activePlayingNotes.has(pitch);
                
                if (isPlaying) {
                    this.ctx.fillStyle = isBlack ? '#c8b900' : '#ffeb3b'; 
                } else if (isRoot) {
                    this.ctx.fillStyle = isBlack ? '#2980b9' : '#3498db'; 
                } else if (inScale) {
                    this.ctx.fillStyle = isBlack ? '#3c3c3c' : '#4d4d4d'; 
                } else {
                    this.ctx.fillStyle = isBlack ? '#111111' : '#1e1e1e'; 
                }
                
                this.ctx.fillRect(0, y, w, this.noteHeight); 
                this.ctx.strokeStyle = '#111'; 
                this.ctx.strokeRect(0, y, w, this.noteHeight);
                
                const octave = Math.floor(pitch / 12) - 1;
                const noteNameStr = noteNames[pitch % 12] + octave;
                
                if (isPlaying) {
                    this.ctx.fillStyle = '#000000';
                } else if (activePitches.has(pitch)) {
                    this.ctx.fillStyle = '#4caf50';
                } else if (isRoot) {
                    this.ctx.fillStyle = '#ffffff'; 
                } else {
                    this.ctx.fillStyle = isBlack ? '#666666' : '#888888'; 
                }
                
                this.ctx.font = '10px sans-serif';
                this.ctx.textAlign = 'left';
                this.ctx.textBaseline = 'middle';
                this.ctx.fillText(noteNameStr, scrollX + 5, y + (this.noteHeight / 2));
            }
            
            this.ctx.strokeStyle = '#444'; 
            for(let x = 0; x < w; x += this.pixelsPerBeat) { 
                this.ctx.beginPath(); 
                this.ctx.moveTo(x, 0); 
                this.ctx.lineTo(x, h - autoHeight); 
                this.ctx.stroke(); 
            }
            
            this.activeTrack.notes.forEach(n => {
                const x = (n.start / beatDur) * this.pixelsPerBeat; 
                const y = (127 - n.pitch) * this.noteHeight; 
                const nw = (n.duration / beatDur) * this.pixelsPerBeat;
                
                const alpha = 0.3 + (n.velocity / 127) * 0.7;
                this.ctx.fillStyle = `rgba(76, 175, 80, ${alpha})`; 
                
                if (this.selectedNotes.includes(n)) {
                    this.ctx.strokeStyle = '#ffffff';
                    this.ctx.lineWidth = 2;
                } else {
                    this.ctx.strokeStyle = '#388e3c';
                    this.ctx.lineWidth = 1;
                }

                this.ctx.fillRect(x, y, nw, this.noteHeight - 1); 
                this.ctx.strokeRect(x, y, nw, this.noteHeight - 1);

                this.ctx.save();
                this.ctx.beginPath();
                this.ctx.rect(x, y, nw, this.noteHeight - 1);
                this.ctx.clip(); 

                const octave = Math.floor(n.pitch / 12) - 1;
                const noteNameStr = noteNames[n.pitch % 12] + octave;

                this.ctx.fillStyle = '#ffffff'; 
                this.ctx.font = '10px sans-serif';
                this.ctx.textAlign = 'left';
                this.ctx.textBaseline = 'middle';
                this.ctx.fillText(noteNameStr, x + 2, y + (this.noteHeight / 2));

                this.ctx.restore(); 
            });
            
            if (this.isLassoing) {
                const x = Math.min(this.lassoStart.x, this.lassoCurrent.x);
                const y = Math.min(this.lassoStart.y, this.lassoCurrent.y);
                const lw = Math.abs(this.lassoCurrent.x - this.lassoStart.x);
                const lh = Math.abs(this.lassoCurrent.y - this.lassoStart.y);
                
                this.ctx.fillStyle = 'rgba(33, 150, 243, 0.2)';
                this.ctx.strokeStyle = 'rgba(33, 150, 243, 0.8)';
                this.ctx.lineWidth = 1;
                this.ctx.fillRect(x, y, lw, lh);
                this.ctx.strokeRect(x, y, lw, lh);
            }

            if (this.activeAutomation && this.activeTrack.automation) {
                const startY = h - autoHeight;
                
                this.ctx.fillStyle = '#1a1a1a';
                this.ctx.fillRect(0, startY, w, autoHeight);
                this.ctx.strokeStyle = '#00bcd4';
                this.ctx.lineWidth = 2;
                this.ctx.beginPath();
                this.ctx.moveTo(0, startY);
                this.ctx.lineTo(w, startY);
                this.ctx.stroke();

                this.ctx.strokeStyle = '#333';
                this.ctx.lineWidth = 1;
                for(let x = 0; x < w; x += this.pixelsPerBeat) { 
                    this.ctx.beginPath(); this.ctx.moveTo(x, startY); this.ctx.lineTo(x, h); this.ctx.stroke(); 
                }

                if (this.activeAutomation === 'pitch' || this.activeAutomation === 'pan') {
                    this.ctx.strokeStyle = '#555';
                    this.ctx.setLineDash([5, 5]);
                    this.ctx.beginPath();
                    this.ctx.moveTo(0, startY + autoHeight / 2);
                    this.ctx.lineTo(w, startY + autoHeight / 2);
                    this.ctx.stroke();
                    this.ctx.setLineDash([]);
                }

                const data = this.activeTrack.automation[this.activeAutomation];
                if (data && data.length > 0) {
                    this.ctx.beginPath();
                    this.ctx.strokeStyle = '#00bcd4';
                    this.ctx.lineWidth = 2;

                    data.forEach((pt, i) => {
                        const px = (pt.time / beatDur) * this.pixelsPerBeat;
                        let py;
                        if (this.activeAutomation === 'mod') {
                            py = startY + autoHeight - (pt.value * autoHeight);
                        } else {
                            py = startY + autoHeight / 2 - (pt.value * (autoHeight / 2));
                        }

                        if (i === 0) this.ctx.moveTo(px, py);
                        else this.ctx.lineTo(px, py);
                    });
                    this.ctx.stroke();

                    this.ctx.fillStyle = '#fff';
                    data.forEach(pt => {
                        const px = (pt.time / beatDur) * this.pixelsPerBeat;
                        let py = this.activeAutomation === 'mod' ? startY + autoHeight - (pt.value * autoHeight) : startY + autoHeight / 2 - (pt.value * (autoHeight / 2));
                        this.ctx.fillRect(px - 2, py - 2, 4, 4);
                    });
                }

                this.ctx.fillStyle = 'rgba(0, 188, 212, 0.5)';
                this.ctx.font = '12px Arial';
                this.ctx.fillText(this.activeAutomation.toUpperCase() + " AUTOMATION", 10, startY + 20);
            }

            if (window.isPlaying && window.currentPlayTime !== undefined) {
                const phTime = window.currentPlayTime - this.activeTrack.startTimeOffset;
                if (phTime >= 0) {
                    const px = (phTime / beatDur) * this.pixelsPerBeat;
                    
                    this.ctx.strokeStyle = '#ff3333';
                    this.ctx.lineWidth = 2;
                    this.ctx.beginPath();
                    this.ctx.moveTo(px, 0);
                    this.ctx.lineTo(px, h);
                    this.ctx.stroke();

                    const scrollArea = document.getElementById('pr-scroll-area');
                    if (scrollArea) {
                        const visibleWidth = scrollArea.clientWidth;
                        const scrollX = scrollArea.scrollLeft;

                        if (px > scrollX + visibleWidth - 100) {
                            scrollArea.scrollLeft = px - 100;
                        } else if (px < scrollX) {
                            scrollArea.scrollLeft = px - 50;
                        }
                    }
                }
            }
            
            this.ctx.lineWidth = 1;
        }
    }

    exports.RoundRobinSampler = RoundRobinSampler;
    exports.pianoRollUI = new PianoRollUI();

})(window);