/* =========================================
   CORE DAW LOGIC & STATE (main.js)
========================================= */

(function(global) {
    "use strict";

    global.PIXELS_PER_SECOND = 50; 
    const CONTROL_WIDTH = 170; 
    
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioContext(); 
    global.audioCtx = audioCtx; 
    global.scBusses = new Map(); 

    let hotkeysEnabled = true;
    global.snapEnabled = false; 
    let metronomeEnabled = false; 
    global.metronomeEnabled = metronomeEnabled;
    let isRecording = false;
    global.bpm = 120; 
    window.bpm = global.bpm; 
    
    let isRepeatEnabled = false;
    let repeatStart = 0;
    let repeatEnd = 4;
    
    let markers = [];
    
    let nextMetroTime = 0; let currentBeat = 0;
    let mediaRecorder = null; let recordedChunks = []; let recordStartTime = 0;
    
    const masterTrackPool = new Map(); const masterGroupPool = new Map();
    global.localFxCache = new Map();

    global.masterCustomFX = []; 
    let masterCustomFxDom = document.createElement('div'); masterCustomFxDom.className = 'custom-fx-list';
    
    global.createDefaultFX = () => ({
        channelMode: 'stereo', invertPhase: false,
        vol: 1.0, pan: 0.0, playbackRate: 1.0, lpf: { on: false, freq: 20000, q: 1 }, hpf: { on: false, freq: 20, q: 1 },
        eq: { on: false, values: new Array(16).fill(0) }, chorus: { on: false, mix: 0.5, rate: 1.5, depth: 0.002 },
        flanger: { on: false, mix: 0.5, rate: 0.5, depth: 0.005, feedback: 0.5 }, delay: { on: false, time: 0.3, feedback: 0.4, mix: 0.3 },
        reverb: { on: false, mix: 0.3, decay: 2.0 }, limiter: { on: false, threshold: -1.0 }
    });
    
    global.masterFX = global.createDefaultFX(); 
    let recFX = global.createDefaultFX();
    let recCustomFX = []; 
    let recCustomFxDom = document.createElement('div'); recCustomFxDom.className = 'custom-fx-list';
    let liveRecNodes = null;

    global.tracks = []; 
    global.groups = []; 
    let undoStack = []; let redoStack = []; let isRestoringState = false;

    let pendingProjectJSON = null; let requiredAudio = new Set(); let requiredJS = new Set(); let availableFiles = new Map();

    let isPlaying = false; global.isPlaying = isPlaying;
    let currentPlayTime = 0; global.currentPlayTime = currentPlayTime;
    let playStartTime = 0; let playStartOffset = 0; let animationId;
    
    const timelineContainer = document.getElementById('timeline-container');
    const rulerCanvas = document.getElementById('rulerCanvas');
    const playheadContainer = document.getElementById('playhead-container');
    const timeDisplay = document.getElementById('timeDisplay');
    const masterArea = document.getElementById('tracks-area');

    global.masterAnalyserL = audioCtx.createAnalyser(); global.masterAnalyserL.fftSize = 1024;
    global.masterAnalyserR = audioCtx.createAnalyser(); global.masterAnalyserR.fftSize = 1024;
    global.masterBusInput = audioCtx.createGain(); 

    const micAnalyser = audioCtx.createAnalyser(); micAnalyser.fftSize = 1024;
    let micStreamSource = null;

    // Kun solmut on luotu, alustetaan masterketju
    if (typeof global.rebuildMasterGraph === 'function') {
        global.rebuildMasterGraph();
    }

    // UI Nuppien luontifunktio X ja Y zoomeille
    function createUIKnob(containerId, labelText, min, max, value, step, displayFormatter, onChangeCallback) {
        const container = document.getElementById(containerId);
        if (!container) return null;
        container.innerHTML = '';
        
        const wrapper = document.createElement('div');
        wrapper.className = 'knob-container';
        wrapper.style.margin = '0 5px';

        const label = document.createElement('div');
        label.className = 'knob-label';
        label.innerText = labelText;

        const valDisplay = document.createElement('div');
        valDisplay.className = 'knob-value';
        valDisplay.innerText = displayFormatter(value);

        const knob = document.createElement('div');
        knob.className = 'knob';
        
        const indicator = document.createElement('div');
        indicator.className = 'knob-indicator';
        knob.appendChild(indicator);

        wrapper.appendChild(label);
        wrapper.appendChild(knob);
        wrapper.appendChild(valDisplay);
        container.appendChild(wrapper);

        const updateRotation = (val) => {
            const pct = (val - min) / (max - min);
            const deg = -135 + (pct * 270);
            indicator.style.transform = `rotate(${deg}deg)`;
            knob.title = displayFormatter(val);
        };
        updateRotation(value);

        let isDragging = false, startY = 0, startVal = 0, currentValue = value;

        const onDragStart = (e) => {
            isDragging = true;
            startY = e.clientY !== undefined ? e.clientY : e.touches[0].clientY;
            startVal = currentValue;
            e.preventDefault();
        };

        const onDragMove = (e) => {
            if (!isDragging) return;
            const currentY = e.clientY !== undefined ? e.clientY : e.touches[0].clientY;
            const deltaY = startY - currentY;
            let newVal = startVal + (deltaY * (max - min) / 150); 
            newVal = Math.max(min, Math.min(max, newVal));
            if (step > 0) newVal = Math.round(newVal / step) * step;
            if (Math.abs(newVal) < 0.0001) newVal = 0;

            if (currentValue !== newVal) {
                currentValue = newVal;
                updateRotation(currentValue);
                valDisplay.innerText = displayFormatter(currentValue);
                onChangeCallback(currentValue);
            }
        };

        const onDragEnd = () => {
            if(isDragging) {
                isDragging = false;
                global.saveState();
            }
        };

        knob.addEventListener('mousedown', (e) => {
            onDragStart(e);
            window.addEventListener('mousemove', onDragMove);
            window.addEventListener('mouseup', () => { onDragEnd(); window.removeEventListener('mousemove', onDragMove); }, { once: true });
        });

        knob.addEventListener('touchstart', (e) => {
            onDragStart(e);
            window.addEventListener('touchmove', onDragMove, { passive: false });
            window.addEventListener('touchend', () => { onDragEnd(); window.removeEventListener('touchmove', onDragMove); }, { once: true });
        }, { passive: false });

        return {
            updateValue: (newVal) => {
                currentValue = newVal;
                updateRotation(currentValue);
                valDisplay.innerText = displayFormatter(currentValue);
            }
        };
    }

    function openInfoModal() {
        document.getElementById('infoModal').classList.add('active');
        if (typeof window.loadDawInfo === 'function') {
            window.loadDawInfo(document.getElementById('infoContent'));
        } else {
            document.getElementById('infoContent').innerHTML = "<p>Ohjetiedostoa (info.js) ei löytynyt tai sitä ei voitu ladata.</p>";
        }
    }
    
    function toggleHotkeys() {
        hotkeysEnabled = !hotkeysEnabled;
        const btn = document.getElementById('hotkeysBtn');
        btn.innerText = hotkeysEnabled ? "Hotkeys: ON" : "Hotkeys: OFF";
        btn.classList.toggle('primary', hotkeysEnabled);
        if (!hotkeysEnabled) {
            btn.style.backgroundColor = "#555";
            btn.style.borderColor = "#666";
        } else {
            btn.style.backgroundColor = "";
            btn.style.borderColor = "";
        }
    }

    let tapTimes = [];
    function tapTempo() {
        const now = performance.now();
        tapTimes.push(now);
        if (tapTimes.length > 5) tapTimes.shift(); 
        if (tapTimes.length > 1) {
            let sum = 0;
            for (let i = 1; i < tapTimes.length; i++) {
                sum += (tapTimes[i] - tapTimes[i-1]);
            }
            const avgMs = sum / (tapTimes.length - 1);
            let newBpm = Math.round(60000 / avgMs);
            if (newBpm < 30) newBpm = 30;
            if (newBpm > 300) newBpm = 300;
            
            document.getElementById('bpmInput').value = newBpm;
            global.bpm = newBpm; window.bpm = global.bpm;
            updateGrid();
        }
    }

    function updateSelectionCount() {
        const count = global.tracks.filter(t => t.isSelected).length + global.groups.filter(g => g.isSelected).length;
        const label = document.getElementById('selectionCountLabel'); if(label) label.innerText = `Valitut: ${count} kpl`;
    }
    global.updateSelectionCount = updateSelectionCount;

    const dragOverlay = document.getElementById('drag-overlay'); let dragCounter = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; dragOverlay.classList.add('active'); });
    window.addEventListener('dragleave', (e) => { e.preventDefault(); dragCounter--; if(dragCounter === 0) dragOverlay.classList.remove('active'); });
    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('drop', async (e) => {
        e.preventDefault(); dragCounter = 0; dragOverlay.classList.remove('active');
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        
        const files = Array.from(e.dataTransfer.files);
        const audioFiles = files.filter(f => f.type.startsWith('audio/') || f.name.endsWith('.wav') || f.name.endsWith('.mp3'));
        const midiFiles = files.filter(f => f.name.toLowerCase().endsWith('.mid') || f.name.toLowerCase().endsWith('.midi'));
        
        if(audioFiles.length > 0) loadAudioFilesAsTracks(audioFiles);
        if(midiFiles.length > 0) loadMidiFilesAsTracks(midiFiles);
    });

    document.getElementById('fileInput').addEventListener('change', async (e) => {
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        const files = Array.from(e.target.files); if(files.length > 0) loadAudioFilesAsTracks(files); e.target.value = '';
    });

    async function loadAudioFilesAsTracks(files) {
        document.getElementById('statusText').innerText = "Ladataan..."; document.getElementById('statusText').classList.add('busy');
        setTimeout(async () => {
            for (let file of files) {
                try {
                    const ab = await file.arrayBuffer(); const buff = await audioCtx.decodeAudioData(ab);
                    const id = 't_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
                    const t = new global.Track(id, file, buff, file.name); masterTrackPool.set(t.id, t); 
                    global.tracks.push(t); masterArea.appendChild(t.DOM); t.updateUIPlacements();
                } catch(err) { console.error("Tiedoston avaus epäonnistui", file.name); }
            }
            syncTracksArrayOrder(); updateBatchGroupSelect(); refreshTimeline(); saveState(); 
            document.getElementById('statusText').innerText = "Valmis"; document.getElementById('statusText').classList.remove('busy');
        }, 50);
    }

    document.getElementById('midiFileInput').addEventListener('change', async (e) => {
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        const files = Array.from(e.target.files);
        if(files.length > 0) loadMidiFilesAsTracks(files);
        e.target.value = '';
    });

    async function loadMidiFilesAsTracks(files) {
        if (typeof window.LocalMidi === 'undefined') { return alert("Paikallista MIDI-kirjastoa ei ole ladattu."); }
        document.getElementById('statusText').innerText = "Ladataan MIDI..."; document.getElementById('statusText').classList.add('busy');
        setTimeout(async () => {
            for (let file of files) {
                try {
                    const ab = await file.arrayBuffer(); const midiData = window.LocalMidi.parse(ab);
                    midiData.tracks.forEach((track, i) => {
                        if (track.notes && track.notes.length > 0) {
                            const id = 'm_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
                            const tName = track.name || file.name.replace(/\.[^/.]+$/, "") + (midiData.tracks.length > 1 ? ` (Ch ${i+1})` : '');
                            const t = new global.MidiTrack(id, tName);
                            let maxEnd = 4;
                            track.notes.forEach(note => { t.notes.push({ pitch: note.pitch, start: note.start, duration: note.duration, velocity: note.velocity }); if (note.start + note.duration > maxEnd) maxEnd = note.start + note.duration; });
                            t.contentDuration = maxEnd; t.trimEnd = maxEnd;
                            masterTrackPool.set(t.id, t); global.tracks.push(t); masterArea.appendChild(t.DOM); t.updateUIPlacements(); t.drawNotes();
                        }
                    });
                } catch(err) { console.error("MIDI tiedoston avaus epäonnistui", file.name, err); alert("Virhe luettaessa MIDI-tiedostoa: " + err.message); }
            }
            syncTracksArrayOrder(); updateBatchGroupSelect(); refreshTimeline(); saveState();
            document.getElementById('statusText').innerText = "Valmis"; document.getElementById('statusText').classList.remove('busy');
        }, 50);
    }

    function extractCustomFX(fxArray) { return fxArray.map(fx => ({ scriptText: fx._scriptText, fileName: fx._fileName, state: typeof fx.getState === 'function' ? fx.getState() : {} })); }

    function createSnapshot() {
        return {
            bpm: global.bpm, PIXELS_PER_SECOND: global.PIXELS_PER_SECOND, 
            isRepeatEnabled, repeatStart, repeatEnd,
            markers: JSON.parse(JSON.stringify(markers)),
            masterFX: JSON.parse(JSON.stringify(global.masterFX)), masterCustomFX: extractCustomFX(global.masterCustomFX),
            groups: global.groups.map(g => ({ id: g.id, name: g.name, isMuted: g.isMuted, isCollapsed: g.isCollapsed, isSelected: g.isSelected, sidechainSource: g.sidechainSource, fx: JSON.parse(JSON.stringify(g.fx)), customFX: extractCustomFX(g.customFX) })),
            tracks: global.tracks.map(t => {
                let base = { id: t.id, name: t.name, isMuted: t.isMuted, isSelected: t.isSelected, groupId: t.groupId, isMidi: t.isMidi, sidechainSource: t.sidechainSource, fx: JSON.parse(JSON.stringify(t.fx)), customFX: extractCustomFX(t.customFX) };
                if(t.isMidi) { 
                    base.notes = JSON.parse(JSON.stringify(t.notes)); 
                    base.automation = t.automation ? JSON.parse(JSON.stringify(t.automation)) : { pitch: [], mod: [], pan: [] };
                    base.startTimeOffset = t.startTimeOffset; base.trimStart = t.trimStart; base.trimEnd = t.trimEnd; base.contentDuration = t.contentDuration;
                    if(t.sampler) base.baseNote = t.sampler.baseNote;
                    base.midiInputSource = t.midiInputSource || ""; // Sidechain-tila
                } else { 
                    base.fileName = t.fileName; base.startTimeOffset = t.startTimeOffset; base.trimStart = t.trimStart; base.trimEnd = t.trimEnd; base.fadeIn = t.fadeIn; base.fadeOut = t.fadeOut; 
                }
                return base;
            })
        };
    }
    
    function saveState() { if(isRestoringState) return; undoStack.push(createSnapshot()); if(undoStack.length > 50) undoStack.shift(); redoStack = []; updateUndoRedoButtons(); }
    global.saveState = saveState; 

    function restoreState(snap) {
        isRestoringState = true; stop();
        global.bpm = snap.bpm; window.bpm = global.bpm; document.getElementById('bpmInput').value = Math.round(global.bpm * 10)/10; updateGrid();
        global.PIXELS_PER_SECOND = snap.PIXELS_PER_SECOND; 
        if (typeof zoomXKnob !== 'undefined') zoomXKnob.updateValue(global.PIXELS_PER_SECOND);
        
        isRepeatEnabled = snap.isRepeatEnabled || false;
        repeatStart = snap.repeatStart !== undefined ? snap.repeatStart : 0;
        repeatEnd = snap.repeatEnd !== undefined ? snap.repeatEnd : 4;
        updateRepeatUI();

        markers = snap.markers || [];
        
        global.masterFX = snap.masterFX; global.masterCustomFX.forEach(fx => { if(typeof fx.destroy === 'function') fx.destroy(); }); global.masterCustomFX = []; masterCustomFxDom.innerHTML = '';
        if(snap.masterCustomFX) snap.masterCustomFX.forEach(fxD => global.instantiateCustomFX(fxD.scriptText, fxD.fileName, fxD.state, global.masterCustomFX, masterCustomFxDom, global.rebuildMasterGraph));
        if (typeof global.rebuildMasterGraph === 'function') global.rebuildMasterGraph();

        global.tracks.forEach(t => { t.customFX.forEach(fx => { if(typeof fx.destroy === 'function') fx.destroy(); }); if(t.DOM) t.DOM.remove(); global.scBusses.delete(t.id); }); global.tracks = [];
        global.groups.forEach(g => { g.customFX.forEach(fx => { if(typeof fx.destroy === 'function') fx.destroy(); }); if(g.DOM) g.DOM.remove(); global.scBusses.delete(g.id); }); global.groups = [];

        snap.groups.forEach(gData => {
            let g = masterGroupPool.get(gData.id); if(!g) { g = new global.TrackGroup(gData.id, gData.name); masterGroupPool.set(g.id, g); }
            g.name = gData.name; g.fx = gData.fx; g.isMuted = gData.isMuted; g.isSelected = gData.isSelected; g.isCollapsed = gData.isCollapsed; g.sidechainSource = gData.sidechainSource || "";
            g.customFX.forEach(fx => { if(typeof fx.destroy === 'function') fx.destroy(); }); g.customFX = []; g.customFxDom.innerHTML = '';
            if(gData.customFX) gData.customFX.forEach(fxD => global.instantiateCustomFX(fxD.scriptText, fxD.fileName, fxD.state, g.customFX, g.customFxDom, () => {if(isPlaying)play();}));
            masterArea.appendChild(g.DOM); g.DOM.querySelector(`#name-input-${g.id}`).value = g.name; g.DOM.querySelector(`#cb-${g.id}`).checked = g.isSelected;
            global.groups.push(g); g.updateVisuals();
        });

        snap.tracks.forEach(tData => {
            let t = masterTrackPool.get(tData.id); 
            if(!t) { if(tData.isMidi) { t = new global.MidiTrack(tData.id, tData.name); masterTrackPool.set(t.id, t); } else return; }
            t.name = tData.name; t.fx = tData.fx; t.isMuted = tData.isMuted; t.isSelected = tData.isSelected; t.groupId = tData.groupId; t.sidechainSource = tData.sidechainSource || "";
            if(t.isMidi) { 
                t.notes = tData.notes || [];
                t.automation = tData.automation || { pitch: [], mod: [], pan: [] };
                t.startTimeOffset = tData.startTimeOffset || 0; t.trimStart = tData.trimStart || 0; t.trimEnd = tData.trimEnd || 4; t.contentDuration = tData.contentDuration || 4;
                if(tData.baseNote !== undefined) t.sampler.baseNote = tData.baseNote;
                t.midiInputSource = tData.midiInputSource || ""; // Sidechain-tila
            } else { 
                t.startTimeOffset = tData.startTimeOffset; t.trimStart = tData.trimStart; t.trimEnd = tData.trimEnd; t.fadeIn = tData.fadeIn; t.fadeOut = tData.fadeOut; 
            }
            
            t.customFX.forEach(fx => { if(typeof fx.destroy === 'function') fx.destroy(); }); t.customFX = []; t.customFxDom.innerHTML = '';
            if(tData.customFX) tData.customFX.forEach(fxD => global.instantiateCustomFX(fxD.scriptText, fxD.fileName, fxD.state, t.customFX, t.customFxDom, () => {if(isPlaying)play();}));
            
            if (t.groupId) { const gDom = document.getElementById(`group-tracks-${t.groupId}`); if(gDom) gDom.appendChild(t.DOM); else masterArea.appendChild(t.DOM); } else { masterArea.appendChild(t.DOM); }
            t.DOM.querySelector(`#name-input-${t.id}`).value = t.name; t.DOM.querySelector(`#cb-${t.id}`).checked = t.isSelected;
            global.tracks.push(t); t.updateUIPlacements(); t.updateVisuals();
        });

        updateBatchGroupSelect(); syncTracksArrayOrder(); refreshTimeline(); updateUndoRedoButtons(); updateSelectionCount(); isRestoringState = false;
    }
    function undo() { if(undoStack.length === 0) return; redoStack.push(createSnapshot()); restoreState(undoStack.pop()); }
    function redo() { if(redoStack.length === 0) return; undoStack.push(createSnapshot()); restoreState(redoStack.pop()); }
    function updateUndoRedoButtons() { document.getElementById('btnUndo').style.opacity = undoStack.length > 0 ? '1' : '0.5'; document.getElementById('btnRedo').style.opacity = redoStack.length > 0 ? '1' : '0.5'; }
    
    async function saveProject() {
        const snap = createSnapshot();
        
        if (window.showDirectoryPicker) {
            try {
                const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
                document.getElementById('statusText').innerText = "Tallennetaan..."; document.getElementById('statusText').classList.add('busy');

                for (let tData of snap.tracks) {
                    if (!tData.isMidi) {
                        const trackObj = masterTrackPool.get(tData.id);
                        if (trackObj && trackObj.buffer) {
                            let fName = trackObj.fileName || trackObj.name;
                            if(!fName.toLowerCase().endsWith('.wav') && !fName.toLowerCase().endsWith('.mp3')) fName += '.wav';
                            
                            const wavBlob = global.audioBufferToWav(trackObj.buffer);
                            const fileHandle = await dirHandle.getFileHandle(fName, { create: true });
                            const writable = await fileHandle.createWritable();
                            await writable.write(wavBlob);
                            await writable.close();
                            
                            tData.fileName = fName;
                        }
                    }
                }
                
                const jsonBlob = new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" });
                const jsonHandle = await dirHandle.getFileHandle("projekti.json", { create: true });
                const jsonWritable = await jsonHandle.createWritable();
                await jsonWritable.write(jsonBlob);
                await jsonWritable.close();
                
                document.getElementById('statusText').innerText = "Valmis"; document.getElementById('statusText').classList.remove('busy');
                alert("Projekti ja kaikki siihen liittyvät audioraidat tallennettu valitsemaasi kansioon!");
                return;
            } catch (err) {
                if (err.name !== 'AbortError') { console.error(err); alert("Tallennus valittuun kansioon epäonnistui. Ladataan selainlatauksena."); } 
                else { return; } 
            }
        }

        const blob = new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = "projekti.json"; a.click();
        
        snap.tracks.forEach(tData => {
            if (!tData.isMidi) {
                const trackObj = masterTrackPool.get(tData.id);
                if (trackObj && trackObj.buffer && trackObj.fileName && trackObj.fileName.startsWith('Äänitys')) {
                     const wavBlob = global.audioBufferToWav(trackObj.buffer);
                     const aWav = document.createElement('a'); aWav.href = URL.createObjectURL(wavBlob); aWav.download = trackObj.fileName + '.wav'; aWav.click();
                }
            }
        });
    }

    async function initiateProjectLoad() {
        if (window.showDirectoryPicker) {
            try {
                const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
                document.getElementById('statusText').innerText = "Luetaan kansiota..."; 
                document.getElementById('statusText').classList.add('busy');

                let jsonFile = null;
                availableFiles.clear();

                for await (const entry of dirHandle.values()) {
                    if (entry.kind === 'file') {
                        const file = await entry.getFile();
                        if (file.name.endsWith('.json')) jsonFile = file;
                        else availableFiles.set(file.name, file);
                    }
                }

                if (!jsonFile) {
                    alert("Valitusta kansiosta ei löytynyt .json-tiedostoa.");
                    document.getElementById('statusText').innerText = "Valmis"; document.getElementById('statusText').classList.remove('busy');
                    return;
                }

                await parseAndCheckJSON(jsonFile);
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error(err);
                    document.getElementById('loadInputFallback').click();
                }
            }
        } else {
            document.getElementById('loadInputFallback').click();
        }
    }

    document.getElementById('loadInputFallback').addEventListener('change', async (e) => {
        const files = Array.from(e.target.files); if (!files.length) return;
        const jsonFile = files.find(f => f.name.endsWith('.json')); 
        if (!jsonFile) return alert("Valitse .json projektitiedosto.");
        
        availableFiles.clear(); 
        files.forEach(f => { if(!f.name.endsWith('.json')) availableFiles.set(f.name, f); });
        
        await parseAndCheckJSON(jsonFile);
        e.target.value = '';
    });

    async function parseAndCheckJSON(jsonFile) {
        try {
            const text = await jsonFile.text(); 
            pendingProjectJSON = JSON.parse(text); 
            requiredAudio.clear(); requiredJS.clear();
            
            pendingProjectJSON.tracks.forEach(t => { 
                if(t.fileName) requiredAudio.add(t.fileName); 
                else if (t.name && !t.isMidi) requiredAudio.add(t.name); 
                if(t.customFX) t.customFX.forEach(fx => requiredJS.add(fx.fileName)); 
            });
            
            if(pendingProjectJSON.masterCustomFX) pendingProjectJSON.masterCustomFX.forEach(fx => requiredJS.add(fx.fileName));
            if(pendingProjectJSON.groups) pendingProjectJSON.groups.forEach(g => { if(g.customFX) g.customFX.forEach(fx => requiredJS.add(fx.fileName)); });
            
            let allFound = true; 
            requiredAudio.forEach(f => { if(!availableFiles.has(f)) allFound = false; });
            
            if (allFound) {
                await executeProjectLoad();
            } else {
                openResourceModal(); 
            }
        } catch(err) { 
            alert("Virhe luettaessa JSON-tiedostoa: " + err.message); 
            document.getElementById('statusText').innerText = "Valmis"; document.getElementById('statusText').classList.remove('busy');
        }
    }

    function openResourceModal() { document.getElementById('resourceModal').classList.add('active'); updateResourceUI(); }
    function cancelProjectLoad() { document.getElementById('resourceModal').classList.remove('active'); pendingProjectJSON = null; availableFiles.clear(); requiredAudio.clear(); requiredJS.clear(); }
    
    function updateResourceUI() {
        const listAudio = document.getElementById('resListAudio'); const listJs = document.getElementById('resListJs'); listAudio.innerHTML = ''; listJs.innerHTML = ''; let allAudioFound = true;
        requiredAudio.forEach(fName => { const isFound = availableFiles.has(fName); if(!isFound) allAudioFound = false; listAudio.innerHTML += `<div class="res-item"><span>${fName}</span><span class="res-status ${isFound ? 'res-found' : 'res-missing'}">${isFound ? 'OK' : 'Puuttuu'}</span></div>`; });
        requiredJS.forEach(fName => { const isOverridden = availableFiles.has(fName); listJs.innerHTML += `<div class="res-item"><span>${fName}</span><span class="res-status ${isOverridden ? 'res-found' : 'res-bundled'}">${isOverridden ? 'Korvattu uudemmalla' : 'Projektista'}</span></div>`; });
        if (requiredAudio.size === 0) { listAudio.innerHTML += '<div>(Ei audioraitoja)</div>'; } if (requiredJS.size === 0) { listJs.innerHTML += '<div>(Ei JS-liitännäisiä)</div>'; }
        document.getElementById('btnConfirmLoad').disabled = !allAudioFound;
    }

    document.getElementById('missingFilesInput').addEventListener('change', (e) => { Array.from(e.target.files).forEach(f => availableFiles.set(f.name, f)); updateResourceUI(); });
    document.getElementById('btnConfirmLoad').addEventListener('click', executeProjectLoad);

    async function getScriptTextForLoad(fxD) {
        let script = fxD.scriptText;
        if (availableFiles.has(fxD.fileName)) {
            script = await availableFiles.get(fxD.fileName).text();
        } else if (!script && global.localFxCache && global.localFxCache.has(fxD.fileName)) {
            script = global.localFxCache.get(fxD.fileName);
        }
        return script;
    }

    async function executeProjectLoad() {
        if(!pendingProjectJSON) return; 
        const proj = pendingProjectJSON; 
        document.getElementById('resourceModal').classList.remove('active');
        document.getElementById('statusText').innerText = "Avataan projektia..."; 
        document.getElementById('statusText').classList.add('busy');

        try {
            if (audioCtx.state === 'suspended') await audioCtx.resume();
            
            stop(); 
            global.tracks.forEach(t => { t.DOM.remove(); window.scBusses.delete(t.id); }); global.tracks = []; 
            global.groups.forEach(g => { g.DOM.remove(); window.scBusses.delete(g.id); }); global.groups = [];
            masterTrackPool.clear(); masterGroupPool.clear(); 
            undoStack = []; redoStack = []; updateUndoRedoButtons();
            
            global.bpm = proj.bpm || 120; window.bpm = global.bpm; document.getElementById('bpmInput').value = Math.round(global.bpm*10)/10; updateGrid();
            
            isRepeatEnabled = proj.isRepeatEnabled || false;
            repeatStart = proj.repeatStart !== undefined ? proj.repeatStart : 0;
            repeatEnd = proj.repeatEnd !== undefined ? proj.repeatEnd : 4;
            updateRepeatUI();
            
            markers = proj.markers || [];

            if(proj.masterFX) global.masterFX = proj.masterFX; 
            global.masterCustomFX.forEach(fx => { if(typeof fx.destroy === 'function') fx.destroy(); }); global.masterCustomFX = []; masterCustomFxDom.innerHTML = '';
            
            if(proj.masterCustomFX) { 
                for (let fxD of proj.masterCustomFX) { 
                    let script = await getScriptTextForLoad(fxD);
                    if (typeof global.instantiateCustomFX === 'function') {
                        global.instantiateCustomFX(script, fxD.fileName, fxD.state, global.masterCustomFX, masterCustomFxDom, global.rebuildMasterGraph); 
                    }
                } 
            }
            if (typeof global.rebuildMasterGraph === 'function') global.rebuildMasterGraph();
            
            if(proj.PIXELS_PER_SECOND) { global.PIXELS_PER_SECOND = proj.PIXELS_PER_SECOND; if(typeof zoomXKnob !== 'undefined') zoomXKnob.updateValue(global.PIXELS_PER_SECOND); }

            if(proj.groups) {
                for (let gData of proj.groups) {
                    const g = new global.TrackGroup(gData.id, gData.name); 
                    g.fx = gData.fx; g.isMuted = gData.isMuted; g.isSelected = gData.isSelected; g.isCollapsed = gData.isCollapsed; g.sidechainSource = gData.sidechainSource || "";
                    if(gData.customFX) { 
                        for (let fxD of gData.customFX) { 
                            let script = await getScriptTextForLoad(fxD);
                            if (typeof global.instantiateCustomFX === 'function') {
                                global.instantiateCustomFX(script, fxD.fileName, fxD.state, g.customFX, g.customFxDom, () => {if(isPlaying)play();}); 
                            }
                        } 
                    }
                    masterGroupPool.set(g.id, g); global.groups.push(g); masterArea.appendChild(g.DOM); g.DOM.querySelector(`#cb-${g.id}`).checked = g.isSelected; g.updateVisuals();
                }
            }

            for (let tData of proj.tracks) {
                let t;
                if(tData.isMidi) {
                    t = new global.MidiTrack(tData.id || 'm_'+Date.now(), tData.name); 
                    t.notes = tData.notes || []; 
                    t.automation = tData.automation || { pitch: [], mod: [], pan: [] };
                    t.startTimeOffset = tData.startTimeOffset || 0;
                    t.trimStart = tData.trimStart || 0; t.trimEnd = tData.trimEnd || 4; t.contentDuration = tData.contentDuration || 4;
                    if(tData.baseNote !== undefined) t.sampler.baseNote = tData.baseNote;
                    t.midiInputSource = tData.midiInputSource || ""; // Sidechain-tila
                } else {
                    const audioFile = availableFiles.get(tData.fileName || tData.name);
                    if (!audioFile) continue; 
                    const ab = await audioFile.arrayBuffer(); 
                    const buff = await audioCtx.decodeAudioData(ab);
                    t = new global.Track(tData.id || 't_'+Date.now(), audioFile, buff, tData.name);
                    t.startTimeOffset = tData.startTimeOffset; t.trimStart = tData.trimStart; t.trimEnd = tData.trimEnd; t.fadeIn = tData.fadeIn || 0; t.fadeOut = tData.fadeOut || 0;
                }
                
                t.fx = tData.fx; t.isMuted = tData.isMuted; t.isSelected = tData.isSelected; t.sidechainSource = tData.sidechainSource || "";
                if(tData.customFX) { 
                    for (let fxD of tData.customFX) { 
                        let script = await getScriptTextForLoad(fxD);
                        if (typeof global.instantiateCustomFX === 'function') {
                            global.instantiateCustomFX(script, fxD.fileName, fxD.state, t.customFX, t.customFxDom, () => {if(isPlaying)play();}); 
                        }
                    } 
                }
                masterTrackPool.set(t.id, t); 
                if(tData.groupId && masterGroupPool.has(tData.groupId)) { t.groupId = tData.groupId; document.getElementById(`group-tracks-${t.groupId}`).appendChild(t.DOM); } else { masterArea.appendChild(t.DOM); }
                t.DOM.querySelector(`#cb-${t.id}`).checked = t.isSelected; t.updateUIPlacements(); t.updateVisuals(); global.tracks.push(t);
            }
            updateBatchGroupSelect(); updateMuteVisuals(); syncTracksArrayOrder(); refreshTimeline(); updateSelectionCount(); saveState(); 
        } catch(err) { 
            alert("Virhe ladattaessa projektia: " + err.message); 
            console.error(err);
        } finally {
            pendingProjectJSON = null; availableFiles.clear(); requiredAudio.clear(); requiredJS.clear();
            document.getElementById('statusText').innerText = "Valmis"; document.getElementById('statusText').classList.remove('busy');
        }
    }

    function toggleSelectAll() { const state = !global.tracks.every(t => t.isSelected); global.tracks.forEach(t => { t.isSelected = state; t.DOM.querySelector(`#cb-${t.id}`).checked = state; }); global.groups.forEach(g => { g.isSelected = state; g.DOM.querySelector(`#cb-${g.id}`).checked = state; }); updateSelectionCount(); }
    function batchAssignGroup(groupId) { const target = groupId === "ROOT" ? null : groupId; global.tracks.filter(t => t.isSelected).forEach(t => { t.groupId = target; (target ? document.getElementById(`group-tracks-${target}`) : masterArea).appendChild(t.DOM); }); syncTracksArrayOrder(); updateMuteVisuals(); saveState(); }
    function batchMuteToggle() { const sel = [...global.tracks.filter(t=>t.isSelected), ...global.groups.filter(g=>g.isSelected)]; const anyMuted = sel.some(x => x.isMuted); sel.forEach(x => { x.isMuted = !anyMuted; x.updateVisuals(); }); updateMuteVisuals(); saveState(); }
    function batchDelete() { global.groups.filter(g=>g.isSelected).forEach(g => { global.tracks.filter(t => t.groupId === g.id && !t.isSelected).forEach(t => { t.groupId = null; masterArea.appendChild(t.DOM); }); g.customFX.forEach(fx => { if(typeof fx.destroy === 'function') fx.destroy(); }); g.DOM.remove(); window.scBusses.delete(g.id); }); global.tracks.filter(t=>t.isSelected).forEach(t => { t.customFX.forEach(fx => { if(typeof fx.destroy === 'function') fx.destroy(); }); t.DOM.remove(); window.scBusses.delete(t.id); }); syncTracksArrayOrder(); updateBatchGroupSelect(); updateSelectionCount(); refreshTimeline(); saveState(); }
    
    function batchMoveUp() { let moved=false; let items=Array.from(masterArea.children); for(let i=0;i<items.length;i++){const el=items[i]; const id=el.id.replace('track-','').replace('group-container-',''); const obj=masterTrackPool.get(id)||masterGroupPool.get(id); if(obj&&obj.isSelected){let prev=el.previousElementSibling; if(prev){const prevId=prev.id.replace('track-','').replace('group-container-',''); const prevObj=masterTrackPool.get(prevId)||masterGroupPool.get(prevId); if(!prevObj||!prevObj.isSelected){el.parentNode.insertBefore(el,prev);moved=true;}}}} if(moved){syncTracksArrayOrder();saveState();} }
    function batchMoveDown() { let moved=false; let items=Array.from(masterArea.children); for(let i=items.length-1;i>=0;i--){const el=items[i]; const id=el.id.replace('track-','').replace('group-container-',''); const obj=masterTrackPool.get(id)||masterGroupPool.get(id); if(obj&&obj.isSelected){let next=el.nextElementSibling; if(next){const nextId=next.id.replace('track-','').replace('group-container-',''); const nextObj=masterTrackPool.get(nextId)||masterGroupPool.get(nextId); if(!nextObj||!nextObj.isSelected){el.parentNode.insertBefore(next,el);moved=true;}}}} if(moved){syncTracksArrayOrder();saveState();} }
    
    function createGroup() { const id = 'g_' + Date.now(); const g = new global.TrackGroup(id, 'Ryhmä '+(global.groups.length+1)); masterGroupPool.set(g.id, g); global.groups.push(g); masterArea.appendChild(g.DOM); updateBatchGroupSelect(); syncTracksArrayOrder(); saveState(); }
    function createMidiTrack() { const id = 'm_' + Date.now(); const t = new global.MidiTrack(id, "MIDI " + (global.tracks.filter(tr=>tr.isMidi).length + 1)); masterTrackPool.set(t.id, t); global.tracks.push(t); masterArea.appendChild(t.DOM); syncTracksArrayOrder(); refreshTimeline(); saveState(); t.drawNotes(); }
    
    function duplicateTrack(trackId) {
        const org = masterTrackPool.get(trackId); if(!org) return;
        let t;
        if(org.isMidi) {
            t = new global.MidiTrack('m_'+Date.now(), org.name+" (Kopio)"); t.notes = JSON.parse(JSON.stringify(org.notes)); t.sampler.samples = org.sampler.samples; t.sampler.baseNote = org.sampler.baseNote;
            t.automation = JSON.parse(JSON.stringify(org.automation));
            t.startTimeOffset = org.startTimeOffset; t.trimStart = org.trimStart; t.trimEnd = org.trimEnd; t.contentDuration = org.contentDuration;
            t.midiInputSource = org.midiInputSource || ""; // Sidechain-tila
        } else {
            t = new global.Track('t_'+Date.now(), {name:org.fileName}, org.buffer, org.name+" (Kopio)"); t.startTimeOffset=org.startTimeOffset; t.trimStart=org.trimStart; t.trimEnd=org.trimEnd; t.fadeIn=org.fadeIn; t.fadeOut=org.fadeOut;
        }
        t.fx = JSON.parse(JSON.stringify(org.fx)); t.isMuted = org.isMuted; t.groupId = org.groupId; t.sidechainSource = org.sidechainSource;
        extractCustomFX(org.customFX).forEach(fxD => {
            if (typeof global.instantiateCustomFX === 'function') {
                global.instantiateCustomFX(fxD.scriptText, fxD.fileName, fxD.state, t.customFX, t.customFxDom, () => {if(isPlaying)play();});
            }
        });
        masterTrackPool.set(t.id, t); if(t.groupId) document.getElementById(`group-tracks-${t.groupId}`).appendChild(t.DOM); else masterArea.appendChild(t.DOM);
        global.tracks.push(t); t.updateUIPlacements(); t.updateVisuals(); syncTracksArrayOrder(); refreshTimeline(); saveState();
    }

    function updateBatchGroupSelect() { const sel = document.getElementById('batchGroupSelect'); sel.innerHTML = '<option value="">-- Siirrä ryhmään --</option><option value="ROOT">Poista ryhmästä (Juuri)</option>'; global.groups.forEach(g => sel.innerHTML += `<option value="${g.id}">${g.name}</option>`); }
    
    function syncTracksArrayOrder() { 
        const nt = [], ng = []; 
        Array.from(masterArea.children).forEach(c => { 
            if(c.classList.contains('track')) nt.push(masterTrackPool.get(c.id.replace('track-',''))); 
            else if(c.classList.contains('group-container')) { 
                ng.push(masterGroupPool.get(c.id.replace('group-container-',''))); 
                Array.from(c.querySelector('.group-tracks-area').children).forEach(tc => { 
                    if(tc.id.startsWith('track-')) nt.push(masterTrackPool.get(tc.id.replace('track-',''))); 
                }); 
            } 
        }); 
        global.tracks = nt.filter(t=>t); 
        global.groups = ng.filter(g=>g); 
    }
    
    function updateMuteVisuals() { 
        global.tracks.forEach(t => { let m = t.isMuted; if(t.groupId && global.groups.find(x=>x.id===t.groupId)?.isMuted) m = true; if(m) t.DOM.classList.add('muted'); else t.DOM.classList.remove('muted'); t.updateVisuals(); }); 
        global.groups.forEach(g => { if(g.isMuted) g.header.classList.add('muted'); else g.header.classList.remove('muted'); g.updateVisuals(); }); 
    }
    global.updateMuteVisuals = updateMuteVisuals;
    
    function changeZoomX(val) { 
        global.PIXELS_PER_SECOND = parseInt(val); 
        refreshTimeline(); 
        global.tracks.forEach(t => { 
            t.updateUIPlacements(); 
            if(t.isMidi) {
                t.drawNotes(); 
            } else {
                t.canvas.width = Math.min(t.buffer.duration * global.PIXELS_PER_SECOND, 32000);
                t.drawWaveform(t.canvas);
            }
        }); 
        global.groups.forEach(g => g.drawCombinedWaveform()); 
        updateGrid(); updateLoopPositions(); 
    }
    
    function changeZoomY(val) { document.documentElement.style.setProperty('--track-height', parseInt(val) + 'px'); global.tracks.forEach(t => { if(t.isMidi) t.drawNotes(); }); }

    function drawMeter(analyser, canvasId) { const canvas = document.getElementById(canvasId); if (!canvas) return; const ctx = canvas.getContext('2d'); const w = canvas.width; const h = canvas.height; const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data); let sum = 0; for(let i=0;i<data.length;i++) sum+=data[i]*data[i]; let pct = (20*Math.log10(Math.sqrt(sum/data.length)) + 60) / 60; if(pct<0)pct=0; if(pct>1)pct=1; ctx.fillStyle = '#111'; ctx.fillRect(0,0,w,h); const grad = ctx.createLinearGradient(0,0,w,0); grad.addColorStop(0, '#00ff00'); grad.addColorStop(0.75, '#ffff00'); grad.addColorStop(0.95, '#ff0000'); ctx.fillStyle = grad; ctx.fillRect(0,0,w*pct,h); }

    function exportAllMidi() {
        const midiTracks = global.tracks.filter(t => t.isMidi && t.notes && t.notes.length > 0);
        if (midiTracks.length === 0) return alert("Ei MIDI-raitoja, joissa olisi nuotteja vietäväksi.");

        const PPQ = 480; 
        const BPM = global.bpm;

        const writeString = str => Array.from(str).map(c => c.charCodeAt(0));
        const write32 = val => [(val >> 24) & 0xFF, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF];
        const write16 = val => [(val >> 8) & 0xFF, val & 0xFF];
        const writeVLQ = value => {
            let buffer = [value & 0x7F];
            while (value >>= 7) buffer.unshift((value & 0x7F) | 0x80);
            return buffer;
        };

        let midiFile = [];
        
        midiFile.push(...writeString("MThd"));
        midiFile.push(...write32(6));
        midiFile.push(...write16(1)); 
        midiFile.push(...write16(midiTracks.length + 1)); 
        midiFile.push(...write16(PPQ));

        let tempoTrack = [];
        const mpqn = Math.round(60000000 / BPM);
        tempoTrack.push(0x00, 0xFF, 0x51, 0x03, (mpqn >> 16) & 0xFF, (mpqn >> 8) & 0xFF, mpqn & 0xFF);
        tempoTrack.push(0x00, 0xFF, 0x2F, 0x00);
        midiFile.push(...writeString("MTrk"));
        midiFile.push(...write32(tempoTrack.length));
        midiFile.push(...tempoTrack);

        midiTracks.forEach((t, index) => {
            let trackData = [];
            trackData.push(0x00, 0xFF, 0x03);
            let nameBytes = writeString(t.name);
            trackData.push(...writeVLQ(nameBytes.length));
            trackData.push(...nameBytes);

            let events = [];
            t.notes.forEach(n => {
                events.push({ time: n.start + t.startTimeOffset, type: 'on', pitch: n.pitch, vel: n.velocity });
                events.push({ time: n.start + t.startTimeOffset + n.duration, type: 'off', pitch: n.pitch, vel: 0 });
            });
            
            events.sort((a, b) => {
                if (a.time === b.time) return a.type === 'off' ? -1 : 1;
                return a.time - b.time;
            });

            let lastTicks = 0;
            const channel = index % 16; 
            events.forEach(ev => {
                let ticks = Math.round(ev.time * (BPM / 60) * PPQ);
                let delta = ticks - lastTicks;
                if (delta < 0) delta = 0;
                lastTicks = ticks;

                trackData.push(...writeVLQ(delta));
                if (ev.type === 'on') {
                    trackData.push(0x90 | channel, ev.pitch, ev.vel);
                } else {
                    trackData.push(0x80 | channel, ev.pitch, 0x00);
                }
            });

            trackData.push(0x00, 0xFF, 0x2F, 0x00);

            midiFile.push(...writeString("MTrk"));
            midiFile.push(...write32(trackData.length));
            midiFile.push(...trackData);
        });

        const blob = new Blob([new Uint8Array(midiFile)], { type: "audio/midi" });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = "Kaikki_Raidat.mid";
        a.click();
    }

    // --- Marker / Tempo Logic ---
    let currentEditingMarkerIndex = -1;
    let pendingMarkerTime = 0;

    function addMarker() {
        pendingMarkerTime = currentPlayTime;
        currentEditingMarkerIndex = -1;
        document.getElementById('markerModalTitle').innerText = "Uusi Merkki";
        document.getElementById('markerName').value = "Merkki";
        document.getElementById('markerTempo').value = "";
        document.getElementById('markerTempoFade').value = "0";
        document.getElementById('btnDeleteMarker').style.display = 'none';
        document.getElementById('markerModal').classList.add('active');
    }

    function editMarker(index) {
        currentEditingMarkerIndex = index;
        const m = markers[index];
        document.getElementById('markerModalTitle').innerText = "Muokkaa Merkkiä";
        document.getElementById('markerName').value = m.name || "";
        document.getElementById('markerTempo').value = m.tempo || "";
        document.getElementById('markerTempoFade').value = m.tempoFade || "0";
        document.getElementById('btnDeleteMarker').style.display = 'block';
        document.getElementById('markerModal').classList.add('active');
    }

    function closeMarkerModal() {
        document.getElementById('markerModal').classList.remove('active');
    }

    function saveMarker() {
        const name = document.getElementById('markerName').value || "Merkki";
        const tempoStr = document.getElementById('markerTempo').value;
        const tempo = tempoStr ? parseFloat(tempoStr) : null;
        const tempoFade = parseFloat(document.getElementById('markerTempoFade').value) || 0;

        if (currentEditingMarkerIndex >= 0) {
            markers[currentEditingMarkerIndex].name = name;
            markers[currentEditingMarkerIndex].tempo = tempo;
            markers[currentEditingMarkerIndex].tempoFade = tempoFade;
        } else {
            markers.push({ time: pendingMarkerTime, name: name, tempo: tempo, tempoFade: tempoFade });
        }
        
        markers.sort((a,b) => a.time - b.time);
        renderMarkers();
        saveState();
        closeMarkerModal();
        updateBPMFromMarkers();
    }

    function deleteCurrentMarker() {
        if (currentEditingMarkerIndex >= 0) {
            if(confirm("Poistetaanko merkki: " + markers[currentEditingMarkerIndex].name + "?")) {
                markers.splice(currentEditingMarkerIndex, 1);
                renderMarkers();
                saveState();
                closeMarkerModal();
                updateBPMFromMarkers();
            }
        }
    }

    function renderMarkers() {
        const container = document.getElementById('marker-container');
        container.innerHTML = '';
        markers.forEach((m, i) => {
            const px = (m.time * global.PIXELS_PER_SECOND) + CONTROL_WIDTH;
            const flag = document.createElement('div');
            flag.className = 'marker-flag';
            flag.style.left = px + 'px';
            
            let tempoInd = '';
            if (m.tempo) tempoInd = ` <span style="font-size:0.6rem; color:#fff; font-weight:normal;">(${m.tempo} BPM)</span>`;
            
            flag.innerHTML = `
                <div class="marker-label" title="Tuplaklikkaa muokataksesi">${m.name}${tempoInd}</div>
                <div class="marker-line"></div>
            `;
            flag.querySelector('.marker-label').ondblclick = (e) => { e.stopPropagation(); editMarker(i); };
            flag.querySelector('.marker-label').onclick = (e) => { e.stopPropagation(); seekAbsolute(m.time); };
            container.appendChild(flag);
        });
    }
    
    function goToPreviousMarker() {
        const time = currentPlayTime;
        const prev = [...markers].sort((a,b) => b.time - a.time).find(m => m.time < time - 0.05);
        if (prev) seekAbsolute(prev.time);
        else seekAbsolute(0);
    }
    function goToNextMarker() {
        const time = currentPlayTime;
        const next = [...markers].sort((a,b) => a.time - b.time).find(m => m.time > time + 0.05);
        if (next) seekAbsolute(next.time);
    }

    function updateBPMFromMarkers() {
        const newBpm = getCurrentBPM(currentPlayTime);
        if (Math.abs(global.bpm - newBpm) > 0.01) {
            global.bpm = newBpm;
            window.bpm = global.bpm;
            if (document.activeElement !== document.getElementById('bpmInput')) {
                document.getElementById('bpmInput').value = Math.round(global.bpm * 10) / 10;
            }
        }
    }

    function getCurrentBPM(time) {
        let baseBPM = parseFloat(document.getElementById('bpmInput').value) || 120;
        let applicableMarkers = markers.filter(m => m.tempo).sort((a,b) => a.time - b.time);
        if (applicableMarkers.length === 0) return baseBPM;
        
        let currentBPM = applicableMarkers[0].time > 0 ? baseBPM : applicableMarkers[0].tempo;
        
        for (let i = 0; i < applicableMarkers.length; i++) {
            let m = applicableMarkers[i];
            if (time >= m.time) {
                if (m.tempoFade > 0 && time < m.time + m.tempoFade) {
                    let progress = (time - m.time) / m.tempoFade;
                    currentBPM = currentBPM + (m.tempo - currentBPM) * progress;
                } else {
                    currentBPM = m.tempo;
                }
            } else {
                break;
            }
        }
        return currentBPM;
    }

    function setupLoopMarkers() {
        let initStartPx, initEndPx;
        const loopStartEl = document.getElementById('loop-start');
        const loopEndEl = document.getElementById('loop-end');

        addDragListener(loopStartEl, {
            onStart: () => { initStartPx = repeatStart * global.PIXELS_PER_SECOND; },
            onMove: (x, dx) => {
                let px = initStartPx + dx;
                if (global.snapEnabled) {
                    const beatDur = 60 / global.bpm;
                    px = Math.round((px / global.PIXELS_PER_SECOND) / beatDur) * beatDur * global.PIXELS_PER_SECOND;
                }
                let t = px / global.PIXELS_PER_SECOND;
                if (t < 0) t = 0;
                if (t >= repeatEnd - 0.1) t = repeatEnd - 0.1;
                repeatStart = t;
                updateLoopPositions();
            },
            onEnd: () => saveState()
        });

        addDragListener(loopEndEl, {
            onStart: () => { initEndPx = repeatEnd * global.PIXELS_PER_SECOND; },
            onMove: (x, dx) => {
                let px = initEndPx + dx;
                if (global.snapEnabled) {
                    const beatDur = 60 / global.bpm;
                    px = Math.round((px / global.PIXELS_PER_SECOND) / beatDur) * beatDur * global.PIXELS_PER_SECOND;
                }
                let t = px / global.PIXELS_PER_SECOND;
                if (t <= repeatStart + 0.1) t = repeatStart + 0.1;
                repeatEnd = t;
                updateLoopPositions();
            },
            onEnd: () => saveState()
        });
    }

    function updateLoopPositions() {
        const startPx = (repeatStart * global.PIXELS_PER_SECOND) + CONTROL_WIDTH;
        const endPx = (repeatEnd * global.PIXELS_PER_SECOND) + CONTROL_WIDTH;
        document.getElementById('loop-start').style.left = startPx + 'px';
        document.getElementById('loop-end').style.left = endPx + 'px';
        const overlay = document.getElementById('loop-overlay');
        overlay.style.left = startPx + 'px';
        overlay.style.width = (endPx - startPx) + 'px';
    }

    function updateRepeatUI() {
        const btn = document.getElementById('repeatBtn');
        btn.innerText = isRepeatEnabled ? "Repeat: ON" : "Repeat: OFF";
        btn.classList.toggle('active', isRepeatEnabled);
        
        const displayStyle = isRepeatEnabled ? 'block' : 'none';
        document.getElementById('loop-start').style.display = displayStyle;
        document.getElementById('loop-end').style.display = displayStyle;
        document.getElementById('loop-overlay').style.display = displayStyle;
        
        if(isRepeatEnabled) updateLoopPositions();
    }

    function toggleRepeat() {
        isRepeatEnabled = !isRepeatEnabled;
        updateRepeatUI();
        saveState();
    }

    function goToEnd() {
        const end = getMaxDOMEnd();
        seekAbsolute(end);
    }
    global.goToEnd = goToEnd;

    window.addEventListener('keydown', (e) => {
        if (!hotkeysEnabled) return; 
        
        const tag = e.target.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        
        if (window.pianoRollUI && window.pianoRollUI.isKeysOpen) {
            const blockedKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR'];
            if (blockedKeys.includes(e.code)) return;
        }

        switch (e.code) {
            case 'Space': e.preventDefault(); togglePlay(); break;
            case 'KeyW': e.preventDefault(); toBeginning(); break;
            case 'KeyA': e.preventDefault(); seek(-5); break;
            case 'KeyD': e.preventDefault(); seek(5); break;
            case 'KeyR': e.preventDefault(); toggleRecord(); break;
            case 'KeyM': e.preventDefault(); toggleMetronome(); break;
            case 'KeyZ': if(e.ctrlKey) { e.preventDefault(); undo(); } break;
            case 'KeyY': if(e.ctrlKey) { e.preventDefault(); redo(); } break;
            case 'Delete': case 'Backspace': e.preventDefault(); batchDelete(); break;
            case 'ArrowLeft': e.preventDefault(); goToPreviousMarker(); break;
            case 'ArrowRight': e.preventDefault(); goToNextMarker(); break;
            case 'End': e.preventDefault(); goToEnd(); break;
        }
    });
    
    function seek(delta) { 
        let target = currentPlayTime + delta;
        if (target < 0) target = 0;
        seekAbsolute(target);
    }

    function seekAbsolute(time) {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        currentPlayTime = time;
        if (currentPlayTime < 0) currentPlayTime = 0;
        window.currentPlayTime = currentPlayTime;
        updatePlayheadVisual();
        updateTimeDisplay();
        updateBPMFromMarkers();
        if (isPlaying) {
            stop(true);
            play();
        }
    }

    function addDragListener(e,o){const{onStart:n,onMove:t,onEnd:a,stopProp:l=!0}=o;let c=0,i=!1;const r=(e,o)=>{l&&e.stopPropagation(),i=!0,c=o,n&&n(o,e)},s=(e,o)=>{i&&(e.cancelable&&e.preventDefault(),t&&t(o,o-c,e))},d=e=>{i&&(i=!1,a&&a(e))};e.addEventListener("mousedown",e=>r(e,e.clientX)),window.addEventListener("mousemove",e=>s(e,e.clientX)),window.addEventListener("mouseup",d),e.addEventListener("touchstart",e=>r(e,e.touches[0].clientX),{passive:!1}),window.addEventListener("touchmove",e=>s(e,e.touches[0].clientX),{passive:!1}),window.addEventListener("touchend",d)}
    global.addDragListener = addDragListener;

    setupTimelineSeek(); function setupTimelineSeek(){const e=t=>{let o=t-timelineContainer.getBoundingClientRect().left+timelineContainer.scrollLeft-CONTROL_WIDTH;o<0&&(o=0);seekAbsolute(o/global.PIXELS_PER_SECOND);};addDragListener(rulerCanvas,{onStart:(t,o)=>e(t),onMove:(t,o,n)=>e(t),stopProp:!1});timelineContainer.addEventListener("mousedown",t=>{if(t.target.id==='timeline-container'||t.target.id==='tracks-area'||t.target.id==='loop-container')e(t.clientX);});}

    function updateLiveRecFX() {
        if (isRecording && micStreamSource && typeof global.buildFXChain === 'function') {
            if (liveRecNodes && liveRecNodes.outGain) { try { liveRecNodes.outGain.disconnect(); } catch(e){} }
            liveRecNodes = global.buildFXChain(audioCtx, micStreamSource, audioCtx.destination, recFX, null, recCustomFX, 'rec', null);
        }
    }

    async function toggleRecord() { if (isRecording) stopRecording(); else await startRecording(); }
    async function startRecording() {
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if(micStreamSource) micStreamSource.disconnect(); 
            micStreamSource = audioCtx.createMediaStreamSource(stream); 
            micStreamSource.connect(micAnalyser);
            
            updateLiveRecFX();

            mediaRecorder = new MediaRecorder(stream); recordedChunks = []; recordStartTime = currentPlayTime;
            mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
            mediaRecorder.onstop = async () => {
                if (liveRecNodes) { try { liveRecNodes.outGain.disconnect(); } catch(e){} liveRecNodes = null; }
                micStreamSource.disconnect(); micStreamSource = null; 
                
                const arrayBuffer = await (new Blob(recordedChunks)).arrayBuffer();
                try { 
                    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer); 
                    const tName = `Äänitys ${new Date().toLocaleTimeString('fi-FI')}`;
                    const t = new global.Track('t_'+Date.now(), {name: tName}, audioBuffer, tName); 
                    t.startTimeOffset = recordStartTime; 
                    
                    t.fx = JSON.parse(JSON.stringify(recFX));
                    extractCustomFX(recCustomFX).forEach(fxD => {
                        if (typeof global.instantiateCustomFX === 'function') {
                            global.instantiateCustomFX(fxD.scriptText, fxD.fileName, fxD.state, t.customFX, t.customFxDom, () => {if(isPlaying)play();});
                        }
                    });
                    
                    masterTrackPool.set(t.id, t); 
                    global.tracks.push(t); masterArea.appendChild(t.DOM); t.updateUIPlacements(); 
                    syncTracksArrayOrder(); refreshTimeline(); saveState(); 
                } catch(e) {}
            }; 
            mediaRecorder.start(); isRecording = true; document.getElementById('recBtn').classList.add('recording'); if (!isPlaying) play();
        } catch(err) { alert("Mikrofonilupa evätty."); }
    }
    function stopRecording() { if (!mediaRecorder || mediaRecorder.state === "inactive") return; mediaRecorder.stop(); mediaRecorder.stream.getTracks().forEach(t => t.stop()); isRecording = false; document.getElementById('recBtn').classList.remove('recording'); }

    function togglePlay() { isPlaying ? stop(false) : play(); }
    
    function play() {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        stop(true); playStartTime = audioCtx.currentTime; playStartOffset = currentPlayTime; 
        isPlaying = true; window.isPlaying = true; 
        
        const playBtn = document.getElementById('playBtn');
        playBtn.innerText = "Pause";
        playBtn.style.backgroundColor = "#ff9800";
        playBtn.style.borderColor = "#f57c00";
        
        const beatDur = 60 / global.bpm; let startBeat = Math.ceil(currentPlayTime / beatDur); if (Math.abs((currentPlayTime / beatDur) - Math.round(currentPlayTime / beatDur)) < 0.01) startBeat = Math.round(currentPlayTime / beatDur);
        nextMetroTime = audioCtx.currentTime + (startBeat * beatDur - currentPlayTime); currentBeat = startBeat % 4;
        
        if (typeof global.rebuildMasterGraph === 'function') global.rebuildMasterGraph();
        
        const groupNodes = {};
        global.groups.forEach(g => { 
            const inNode = audioCtx.createGain(); 
            const nodes = global.buildFXChain(audioCtx, inNode, global.masterBusInput, g.fx, {split: true, nodeL: g.analyserL, nodeR: g.analyserR}, g.customFX, g.id, g.sidechainSource); 
            nodes.outGain.gain.setValueAtTime(g.isMuted ? 0 : g.fx.vol, audioCtx.currentTime); 
            g.liveNodes = { inNode, ...nodes }; 
            groupNodes[g.id] = inNode; 
        });

        global.tracks.forEach(t => {
            const dest = t.groupId && groupNodes[t.groupId] ? groupNodes[t.groupId] : global.masterBusInput;
            
            if (t.isMidi) {
                t.activeSources = []; const trackIn = audioCtx.createGain(); const nodes = global.buildFXChain(audioCtx, trackIn, dest, t.fx, {split: true, nodeL: t.analyserL, nodeR: t.analyserR}, t.customFX, t.id, t.sidechainSource);
                nodes.outGain.gain.setValueAtTime(t.isMuted ? 0 : t.fx.vol, audioCtx.currentTime); t.liveNodes = { inNode: trackIn, ...nodes }; 
                const regionAbsStart = t.startTimeOffset + t.trimStart; const regionAbsEnd = t.startTimeOffset + t.trimEnd;

                t.scheduledMidiEvents = [];

                t.notes.forEach(note => {
                    const noteAbsStart = t.startTimeOffset + note.start; const noteAbsEnd = noteAbsStart + note.duration;
                    const playAbsStart = Math.max(noteAbsStart, regionAbsStart); const playAbsEnd = Math.min(noteAbsEnd, regionAbsEnd);

                    if (playAbsStart < playAbsEnd && playAbsEnd > currentPlayTime) {
                        let when, offsetTimeline, dur;
                        if (currentPlayTime < playAbsStart) { 
                            when = audioCtx.currentTime + (playAbsStart - currentPlayTime); 
                            offsetTimeline = playAbsStart - noteAbsStart; 
                            dur = playAbsEnd - playAbsStart; 
                        } else { 
                            when = audioCtx.currentTime; 
                            offsetTimeline = currentPlayTime - noteAbsStart; 
                            dur = playAbsEnd - currentPlayTime; 
                        }
                        
                        if(!t.isMuted) {
                            t.scheduledMidiEvents.push({ time: when, msg: [0x90, note.pitch, note.velocity] });
                            t.scheduledMidiEvents.push({ time: when + dur, msg: [0x80, note.pitch, 0] });
                        }

                        if (!t.isMuted && dur > 0) { 
                            const srcInfo = t.sampler.playNote(audioCtx, trackIn, note.pitch, note.velocity, when, offsetTimeline, dur); 
                            if(srcInfo) t.activeSources.push(srcInfo); 
                        }
                    }
                });

                if (!t.isMuted && t.automation) {
                    if (t.automation.pitch) {
                        t.automation.pitch.forEach(pt => {
                            const ptAbsTime = t.startTimeOffset + pt.time;
                            if (ptAbsTime >= currentPlayTime && ptAbsTime <= regionAbsEnd) {
                                const when = audioCtx.currentTime + (ptAbsTime - currentPlayTime);
                                const val = Math.round((pt.value * 8192) + 8192); 
                                const lsb = val & 0x7F;
                                const msb = (val >> 7) & 0x7F;
                                t.scheduledMidiEvents.push({ time: when, msg: [0xE0, lsb, msb] });
                            }
                        });
                    }
                    if (t.automation.mod) {
                        t.automation.mod.forEach(pt => {
                            const ptAbsTime = t.startTimeOffset + pt.time;
                            if (ptAbsTime >= currentPlayTime && ptAbsTime <= regionAbsEnd) {
                                const when = audioCtx.currentTime + (ptAbsTime - currentPlayTime);
                                const val = Math.round(pt.value * 127);
                                t.scheduledMidiEvents.push({ time: when, msg: [0xB0, 1, val] });
                            }
                        });
                    }
                    if (t.automation.pan) {
                        t.automation.pan.forEach(pt => {
                            const ptAbsTime = t.startTimeOffset + pt.time;
                            if (ptAbsTime >= currentPlayTime && ptAbsTime <= regionAbsEnd) {
                                const when = audioCtx.currentTime + (ptAbsTime - currentPlayTime);
                                const val = Math.round((pt.value * 64) + 64);
                                t.scheduledMidiEvents.push({ time: when, msg: [0xB0, 10, val] });
                            }
                        });
                    }
                }

                t.scheduledMidiEvents.sort((a,b) => a.time - b.time);

            } else {
                const rate = (t.fx && t.fx.playbackRate) ? t.fx.playbackRate : 1.0;
                const aStart = t.startTimeOffset + (t.trimStart / rate); 
                const aEnd = t.startTimeOffset + (t.trimEnd / rate);
                
                if (currentPlayTime >= aEnd) return;
                
                let when, offset, dur;
                if (currentPlayTime < aStart) { 
                    when = audioCtx.currentTime + (aStart - currentPlayTime); 
                    offset = t.trimStart; 
                    dur = aEnd - aStart; 
                } else { 
                    when = audioCtx.currentTime; 
                    offset = t.trimStart + ((currentPlayTime - aStart) * rate); 
                    dur = aEnd - currentPlayTime; 
                }
                if (dur > 0) t.play(audioCtx, dest, when, offset, dur);
            }
        });
        requestAnimationFrame(animationLoop);
    }
    
    function stop(seeking = false) {
        if (isRecording && !seeking) stopRecording();
        global.tracks.forEach(t => { 
            if (t.source) { try{t.source.stop();}catch(e){} try{t.source.disconnect();}catch(e){} t.source = null; }
            if (t.isMidi) {
                if(t.activeSources) { 
                    t.activeSources.forEach(s => { if (t.sampler && typeof t.sampler.stopNote === 'function') { t.sampler.stopNote(s, audioCtx); } else { try{s.src.stop();}catch(e){} try{s.src.disconnect(); s.gain.disconnect();}catch(e){} } }); 
                    t.activeSources = []; 
                }
                
                t.scheduledMidiEvents = []; 
                t.customFX.forEach(fx => {
                    if(typeof fx.onMidi === 'function') {
                        for(let i=0; i<128; i++) fx.onMidi([0x80, i, 0]);
                    }
                });
            }
        });
        isPlaying = false; global.isPlaying = false; window.isPlaying = false; 
        if (!seeking) { 
            const playBtn = document.getElementById('playBtn');
            playBtn.innerText = "Play";
            playBtn.style.backgroundColor = "#4caf50";
            playBtn.style.borderColor = "#388e3c"; 
            cancelAnimationFrame(animationId); 
        }
    }
    
    function toBeginning() { currentPlayTime = 0; global.currentPlayTime = 0; window.currentPlayTime = 0; updatePlayheadVisual(); updateTimeDisplay(); if (isPlaying) { stop(true); play(); } }
    
    function animationLoop() {
        if (!isPlaying) return; 
        currentPlayTime = playStartOffset + (audioCtx.currentTime - playStartTime);
        global.currentPlayTime = currentPlayTime;
        window.currentPlayTime = currentPlayTime;
        
        updateBPMFromMarkers();
        
        if (isRepeatEnabled && currentPlayTime >= repeatEnd) {
            let overshoot = currentPlayTime - repeatEnd;
            if (overshoot > 1.0) overshoot = 0; 
            seekAbsolute(repeatStart + overshoot);
            return;
        }
        
        if (global.metronomeEnabled) { const beatDur = 60 / global.bpm; while (nextMetroTime < audioCtx.currentTime + 0.1) { const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain(); osc.connect(gain); gain.connect(audioCtx.destination); osc.frequency.value = (currentBeat === 0) ? 1000 : 800; gain.gain.setValueAtTime(0, nextMetroTime); gain.gain.linearRampToValueAtTime(0.5, nextMetroTime + 0.005); gain.gain.exponentialRampToValueAtTime(0.001, nextMetroTime + 0.1); osc.start(nextMetroTime); osc.stop(nextMetroTime + 0.1); nextMetroTime += beatDur; currentBeat = (currentBeat + 1) % 4; } }
        
        global.tracks.forEach(t => {
            if (t.isMidi && t.scheduledMidiEvents) {
                while (t.scheduledMidiEvents.length > 0 && t.scheduledMidiEvents[0].time <= audioCtx.currentTime + 0.05) {
                    let ev = t.scheduledMidiEvents.shift();
                    let delayMs = (ev.time - audioCtx.currentTime) * 1000;
                    if (delayMs < 0) delayMs = 0;
                    setTimeout(() => {
                        if (!isPlaying) return;
                        
                        // UUSI LISÄYS: Varmistetaan FX-reititys aina ennen viestin käsittelyä!
                        if (typeof t.patchFxChain === 'function') t.patchFxChain();

                        let midiHandled = false;
                        if (t.customFX.length > 0) {
                            for (let i = 0; i < t.customFX.length; i++) {
                                if (typeof t.customFX[i].onMidi === 'function') {
                                    t.customFX[i].onMidi(ev.msg);
                                    midiHandled = true;
                                    break;
                                }
                            }
                        }
                        
                        // Jos MIDIä ei napattu yhdellekään efektille (tai efektejä ei ole), lähetetään se suoraan ulos sidechainia varten
                        if (!midiHandled) {
                            if (typeof t.broadcastMidi === 'function') {
                                t.broadcastMidi(ev.msg);
                            }
                        }
                    }, delayMs);
                }
            }
        });

        updatePlayheadVisual(); updateTimeDisplay();
        drawMeter(global.masterAnalyserL, 'masterMeterL'); drawMeter(global.masterAnalyserR, 'masterMeterR'); drawMeter(micAnalyser, 'micMeter');
        global.tracks.forEach(t => { drawMeter(t.analyserL, `meterL-${t.id}`); drawMeter(t.analyserR, `meterR-${t.id}`); }); 
        global.groups.forEach(g => { drawMeter(g.analyserL, `meterL-${g.id}`); drawMeter(g.analyserR, `meterR-${g.id}`); });
        animationId = requestAnimationFrame(animationLoop);
    }

    function toggleSnap() { global.snapEnabled = !global.snapEnabled; document.getElementById('snapBtn').innerText = global.snapEnabled ? "Snap: ON" : "Snap: OFF"; document.getElementById('snapBtn').classList.toggle('active', global.snapEnabled); updateGrid(); }
    
    function toggleMetronome() { 
        global.metronomeEnabled = !global.metronomeEnabled; 
        window.metronomeEnabled = global.metronomeEnabled; 
        document.getElementById('metroBtn').innerText = global.metronomeEnabled ? "Metro: ON" : "Metro: OFF"; 
        document.getElementById('metroBtn').classList.toggle('active', global.metronomeEnabled); 
        if(window.pianoRollUI) window.pianoRollUI.updateMetroBtnUI();
    }
    
    function updateGrid() { 
        global.bpm = parseInt(document.getElementById('bpmInput').value) || 120; 
        window.bpm = global.bpm; 
        const beatsPerMeasure = parseInt(document.getElementById('tsInput').value) || 4;
        const tArea = document.getElementById('tracks-area'); 
        
        if (!global.snapEnabled) { 
            tArea.style.backgroundImage = 'none'; 
            return; 
        } 
        
        const beatWidth = (60 / global.bpm) * global.PIXELS_PER_SECOND;
        const measureWidth = beatWidth * beatsPerMeasure;
        
        tArea.style.backgroundImage = `
            linear-gradient(to right, rgba(255,255,255,0.15) 1px, transparent 1px),
            linear-gradient(to right, rgba(255,255,255,0.03) ${measureWidth}px, transparent ${measureWidth}px)
        `; 
        
        tArea.style.backgroundSize = `${beatWidth}px 100%, ${measureWidth * 2}px 100%`; 
        tArea.style.backgroundPosition = `${CONTROL_WIDTH}px 0, ${CONTROL_WIDTH}px 0`; 
    }

    function getProjectDuration() { 
        let max = 0; 
        global.tracks.forEach(t => { 
            if(t.isMidi) { 
                const end = t.startTimeOffset + t.trimEnd; 
                if(end > max) max = end; 
            } else { 
                const rate = (t.fx && t.fx.playbackRate) ? t.fx.playbackRate : 1.0;
                const end = t.startTimeOffset + (t.trimEnd / rate); 
                if(end > max) max = end; 
            } 
        }); 
        return max; 
    }
    
    function getMaxDOMEnd() { 
        let max = 0; 
        global.tracks.forEach(t => { 
            if(t.isMidi) { 
                const end = t.startTimeOffset + t.contentDuration; 
                if(end > max) max = end; 
            } else { 
                const rate = (t.fx && t.fx.playbackRate) ? t.fx.playbackRate : 1.0;
                const end = t.startTimeOffset + (t.buffer.duration / rate); 
                if(end > max) max = end; 
            } 
        }); 
        return max; 
    }
    global.getMaxDOMEnd = getMaxDOMEnd;
    
    function refreshTimeline() { 
        const s = Math.max(getMaxDOMEnd() + 10, 60); 
        const w = (s * global.PIXELS_PER_SECOND) + CONTROL_WIDTH; 
        document.getElementById('tracks-area').style.width = w + 'px'; 
        
        const cw = Math.min(w, 32000);
        rulerCanvas.width = cw; 
        rulerCanvas.style.width = w + 'px';
        
        const ctx = rulerCanvas.getContext('2d'); 
        ctx.clearRect(0,0, cw, 24); 
        ctx.fillStyle = '#222'; ctx.fillRect(0,0, cw, 24); 
        ctx.font = '10px sans-serif'; ctx.fillStyle = '#888'; ctx.strokeStyle = '#555'; ctx.lineWidth = 1; 
        
        const scaleX = cw / w;

        // Dynaaminen skaalaus zoomin perusteella
        let step = 1;
        let subStep = 0.5;

        if (global.PIXELS_PER_SECOND <= 3) {
            step = 60; // 1 minuutti
            subStep = 15;
        } else if (global.PIXELS_PER_SECOND <= 8) {
            step = 30; // 30 sekuntia
            subStep = 10;
        } else if (global.PIXELS_PER_SECOND <= 15) {
            step = 10; // 10 sekuntia
            subStep = 5;
        } else if (global.PIXELS_PER_SECOND <= 30) {
            step = 5;  // 5 sekuntia
            subStep = 1;
        } else {
            step = 1;  // 1 sekunti
            subStep = 0.5;
        }

        for(let i=0; i<=s; i+=step) { 
            const realX = CONTROL_WIDTH + (i*global.PIXELS_PER_SECOND);
            const x = realX * scaleX;
            ctx.beginPath(); ctx.moveTo(x, 12); ctx.lineTo(x, 24); ctx.stroke(); 
            
            // Muodostetaan aikanäyttö sekunteina tai minuutteina
            let timeStr = i + 's';
            if (step >= 30) {
                const mins = Math.floor(i / 60);
                const secs = i % 60;
                timeStr = mins + ':' + (secs < 10 ? '0' + secs : secs);
            }
            
            ctx.fillText(timeStr, x+3, 22); 
            
            for (let j = i + subStep; j < i + step && j <= s; j += subStep) {
                const subRealX = CONTROL_WIDTH + (j * global.PIXELS_PER_SECOND);
                const subX = subRealX * scaleX;
                ctx.beginPath(); ctx.moveTo(subX, 18); ctx.lineTo(subX, 24); ctx.stroke(); 
            }
        } 
        updateLoopPositions(); renderMarkers(); 
    }
    global.refreshTimeline = refreshTimeline;
    
    function updatePlayheadVisual() { const px = (currentPlayTime * global.PIXELS_PER_SECOND) + CONTROL_WIDTH; playheadContainer.style.transform = `translateX(${px}px)`; const cw = timelineContainer.clientWidth; const sl = timelineContainer.scrollLeft; if(px > sl + cw - 50) timelineContainer.scrollLeft = px - 50; }
    function updateTimeDisplay() { let t = currentPlayTime < 0 ? 0 : currentPlayTime; let s = Math.floor(t); let ms = Math.floor((t - s)*100); let m = Math.floor(s/60); s = s%60; const f = n => n.toString().padStart(2, '0'); timeDisplay.innerText = `${f(m)}:${f(s)}:${f(ms)}`; }

    function openMasterFX() { 
        if (typeof global.rebuildMasterGraph === 'function') {
            window.FXMenu.build('genericFxContent', null, global.masterFX, 'Master FX', () => global.rebuildMasterGraph(), { customArr: global.masterCustomFX, customDom: masterCustomFxDom }); 
        }
        document.getElementById('fxModal').classList.add('active'); 
    }
    function openRecFX() { 
        window.FXMenu.build('genericFxContent', null, recFX, 'Rec FX', () => updateLiveRecFX(), { customArr: recCustomFX, customDom: recCustomFxDom, isRec: true }); 
        document.getElementById('fxModal').classList.add('active'); 
    }
    function openEQ(id, isGroup = false) {
        if(isGroup) { 
            const g = masterGroupPool.get(id); if(!g) return; 
            window.FXMenu.build('trackFxContent', g, g.fx, 'Ryhmä: ' + g.name, () => { if (g.liveNodes && !g.isMuted) { g.liveNodes.outGain.gain.setValueAtTime(g.fx.vol, audioCtx.currentTime); g.liveNodes.panner.pan.setValueAtTime(g.fx.pan, audioCtx.currentTime); } if (isPlaying) play(); }, { customArr: g.customFX, customDom: g.customFxDom, globalTracks: global.tracks, globalGroups: global.groups }); 
        } else { 
            const t = masterTrackPool.get(id); if(!t) return; 
            window.FXMenu.build('trackFxContent', t, t.fx, 'Raita: ' + t.name, () => { if (t.liveNodes && !t.isMuted) { t.liveNodes.outGain.gain.setValueAtTime(t.fx.vol, audioCtx.currentTime); t.liveNodes.panner.pan.setValueAtTime(t.fx.pan, audioCtx.currentTime); } t.updateUIPlacements(); if (isPlaying) play(); }, { customArr: t.customFX, customDom: t.customFxDom, globalTracks: global.tracks, globalGroups: global.groups }); 
        }
        document.getElementById('eqModal').classList.add('active');
    }

    function openExportModal() { if (!global.tracks.length) return alert("Ei raitoja."); document.getElementById('exportStart').value = 0; document.getElementById('exportEnd').value = getProjectDuration().toFixed(2); document.getElementById('exportModal').classList.add('active'); }
    function closeExportModal() { document.getElementById('exportModal').classList.remove('active'); }
    global.closeExportModal = closeExportModal;
    
    function setFullExportRange() { document.getElementById('exportStart').value = 0; document.getElementById('exportEnd').value = getProjectDuration().toFixed(2); }
    
    setupLoopMarkers();
    updateRepeatUI();
    saveState();
    refreshTimeline();

    // Luodaan UI-nupit zoomeille yläpalkkiin
    let zoomXKnob = createUIKnob('zoomXContainer', 'Zoom X', 1, 300, global.PIXELS_PER_SECOND, 1, v => Math.round(v) + 'x', val => changeZoomX(val));
    let zoomYKnob = createUIKnob('zoomYContainer', 'Zoom Y', 30, 300, 110, 1, v => Math.round(v) + 'px', val => changeZoomY(val));

    // Paljastetaan globaalille window-oliolle HTML:n suorat viittaukset (onclick).
    global.toggleHotkeys = toggleHotkeys;
    global.undo = undo;
    global.redo = redo;
    global.openInfoModal = openInfoModal;
    global.togglePlay = togglePlay;
    global.stop = stop;
    global.toBeginning = toBeginning;
    global.addMarker = addMarker;
    global.toggleRepeat = toggleRepeat;
    global.toggleRecord = toggleRecord;
    global.openRecFX = openRecFX;
    global.createMidiTrack = createMidiTrack;
    global.createGroup = createGroup;
    global.updateGrid = updateGrid;
    global.tapTempo = tapTempo;
    global.toggleSnap = toggleSnap;
    global.toggleMetronome = toggleMetronome;
    global.changeZoomX = changeZoomX;
    global.changeZoomY = changeZoomY;
    global.toggleSelectAll = toggleSelectAll;
    global.batchAssignGroup = batchAssignGroup;
    global.batchMoveUp = batchMoveUp;
    global.batchMoveDown = batchMoveDown;
    global.batchMuteToggle = batchMuteToggle;
    global.batchDelete = batchDelete;
    global.openMasterFX = openMasterFX;
    global.openExportModal = openExportModal;
    global.exportAllMidi = exportAllMidi;
    global.saveProject = saveProject;
    global.initiateProjectLoad = initiateProjectLoad;
    global.deleteCurrentMarker = deleteCurrentMarker;
    global.closeMarkerModal = closeMarkerModal;
    global.saveMarker = saveMarker;
    global.setFullExportRange = setFullExportRange;
    global.cancelProjectLoad = cancelProjectLoad;
    global.openEQ = openEQ;
    global.duplicateTrack = duplicateTrack;
    global.masterTrackPool = masterTrackPool;
    global.masterGroupPool = masterGroupPool;
    global.seekAbsolute = seekAbsolute;

})(typeof window !== 'undefined' ? window : this);