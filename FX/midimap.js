// midimap.js
// Graafinen MIDI Sampler / Mapper ADSR:llä, Crossfade Loopilla ja korjatulla graafisella editoinnilla.
// Sisältää aaltomuoto-ikkunan (Start/End trim), Fade In/Out, Gain -säädöt sekä per-sample FX Insert -ketjun.

window.CustomAudioEffect = class AudioMidiMapEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        
        // --- AUDIO REIKITYS ---
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.input.connect(this.output); // Audio Pass-through
        
        this.instrumentGain = audioCtx.createGain();
        this.instrumentGain.gain.value = 1.0;
        this.instrumentGain.connect(this.output);

        // --- DATA RAKENTEET ---
        this.regions = [];
        this.activeVoices = new Map();
        this.rrState = {};
        this.selectedRegionId = null;
        
        // Tila muuttujat graafiseen editointiin
        this.isDragModeEnabled = false;
        this.activeDragState = null; 

        this.ui = { container: null, grid: null, inspector: null };
        
        // Globaalit hiirikuuntelijat nupin kääntöä, alueen raahausta ja aaltomuodon trimmausta varten
        window.addEventListener('mousemove', (e) => this.handleGlobalMouseMove(e));
        window.addEventListener('mouseup', () => this.handleGlobalMouseUp());

        this.waveformDragState = null; // Aaltomuodon alun ja lopun muokkausta varten
    }

    // --- MIDI-OHJAUS ---
    onMidi(msg) {
        const status = msg[0] & 0xF0;
        const note = msg[1];
        const velocity = msg[2];

        if (status === 0x90 && velocity > 0) {
            this.noteOn(note, velocity);
        } else if (status === 0x80 || (status === 0x90 && velocity === 0)) {
            this.noteOff(note);
        }
    }

    noteOn(note, velocity) {
        const matches = this.regions.filter(r => 
            note >= r.minNote && note <= r.maxNote &&
            velocity >= r.minVel && velocity <= r.maxVel
        );

        if (matches.length === 0) return;

        // ROUND ROBIN
        const groupHash = matches.map(r => r.id).sort().join('_');
        if (this.rrState[groupHash] === undefined) this.rrState[groupHash] = 0;
        
        const regionToPlay = matches[this.rrState[groupHash] % matches.length];
        this.rrState[groupHash]++;

        const bufferToPlay = regionToPlay.processedBuffer || regionToPlay.audioBuffer;
        if (!bufferToPlay) return;

        // PITCH SHIFT
        const semitoneDiff = (note - regionToPlay.rootNote) + regionToPlay.tune;
        const playbackRate = Math.pow(2, semitoneDiff / 12);

        // AUDIO SOURCE
        const source = this.ctx.createBufferSource();
        source.buffer = bufferToPlay;
        source.playbackRate.value = playbackRate;

        // LOOPING
        if (regionToPlay.loopStart < regionToPlay.loopEnd && regionToPlay.loopEnd <= bufferToPlay.duration) {
            source.loop = true;
            source.loopStart = regionToPlay.loopStart;
            source.loopEnd = regionToPlay.loopEnd;
        }

        // VCA & FADES
        const now = this.ctx.currentTime;
        const playDuration = (regionToPlay.sampleEnd - regionToPlay.sampleStart) / playbackRate;
        const stopTime = now + playDuration;

        const vca = this.ctx.createGain();
        const baseGain = Math.pow(velocity / 127, 2) * regionToPlay.gain;
        vca.gain.setValueAtTime(0, now);

        // ADSR
        if (regionToPlay.adsrEnabled) {
            vca.gain.linearRampToValueAtTime(baseGain, now + regionToPlay.attack);
            vca.gain.linearRampToValueAtTime(baseGain * regionToPlay.sustain, now + regionToPlay.attack + regionToPlay.decay);
        } else {
            vca.gain.setTargetAtTime(baseGain, now, 0.001); 
        }

        // Erillinen Fade In / Fade Out ohjaus alueelle asetetun Trimmin perusteella
        const fadeNode = this.ctx.createGain();
        fadeNode.gain.setValueAtTime(0, now);
        fadeNode.gain.linearRampToValueAtTime(1, now + regionToPlay.fadeIn);
        
        if (!source.loop && regionToPlay.fadeOut > 0) {
            fadeNode.gain.setValueAtTime(1, stopTime - regionToPlay.fadeOut);
            fadeNode.gain.linearRampToValueAtTime(0, stopTime);
        } else if (!source.loop) {
            fadeNode.gain.setValueAtTime(1, stopTime);
        }

        // Reititys: Source -> Fades -> VCA -> Region FX Input
        source.connect(fadeNode);
        fadeNode.connect(vca);
        vca.connect(regionToPlay.fxInput);

        source.start(now, regionToPlay.sampleStart);
        if (!source.loop) {
            source.stop(stopTime + regionToPlay.release); // Pieni bufferi release-ajalle
        }

        if (!this.activeVoices.has(note)) this.activeVoices.set(note, new Set());
        this.activeVoices.get(note).add({ source, vca, fadeNode, region: regionToPlay, stopTime });
        this.updateKeyUI(note, true);
    }

    noteOff(note) {
        if (!this.activeVoices.has(note)) return;

        const voices = this.activeVoices.get(note);
        const now = this.ctx.currentTime;
        
        voices.forEach(voice => {
            voice.vca.gain.cancelScheduledValues(now);
            
            if (voice.region.adsrEnabled) {
                voice.vca.gain.setTargetAtTime(0, now, Math.max(0.01, voice.region.release / 4)); 
                voice.source.stop(now + voice.region.release);
            } else {
                voice.vca.gain.setTargetAtTime(0, now, 0.001);
                voice.source.stop(now + 0.01);
            }
        });
        
        this.activeVoices.delete(note);
        this.updateKeyUI(note, false);
    }

    killAllNotes() {
        const now = this.ctx.currentTime;
        this.activeVoices.forEach((voices, note) => {
            voices.forEach(voice => {
                voice.vca.gain.cancelScheduledValues(now);
                voice.vca.gain.setTargetAtTime(0, now, 0.01);
                voice.source.stop(now + 0.1);
            });
            this.updateKeyUI(note, false);
        });
        this.activeVoices.clear();
        this.rrState = {};
    }

    // --- APUFUNKTIOT JA ÄÄNEN KÄSITTELY ---
    getNodes() { return { input: this.input, output: this.output }; }
    generateId() { return Math.random().toString(36).substring(2, 9); }
    midiToNoteName(midi) {
        const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
        return `${notes[midi % 12]}${Math.floor(midi / 12) - 1}`;
    }

    processCrossfade(region) {
        if (!region.audioBuffer) return;
        const orig = region.audioBuffer;
        let lStart = region.loopStart;
        let lEnd = region.loopEnd;
        let xfade = region.crossfade;
        
        if (lStart >= lEnd || lEnd > orig.duration || xfade <= 0) {
            region.processedBuffer = orig;
            return;
        }

        const newBuf = this.ctx.createBuffer(orig.numberOfChannels, orig.length, orig.sampleRate);
        const endIdx = Math.floor(lEnd * orig.sampleRate);
        const startIdx = Math.floor(lStart * orig.sampleRate);
        const xSamples = Math.floor(Math.min(xfade * orig.sampleRate, orig.length - endIdx));

        for (let c = 0; c < orig.numberOfChannels; c++) {
            const inData = orig.getChannelData(c);
            const outData = newBuf.getChannelData(c);
            outData.set(inData); 
            
            for (let i = 0; i < xSamples; i++) {
                const ratio = i / xSamples;
                const fadeIn = Math.sin(ratio * Math.PI / 2);
                const fadeOut = Math.cos(ratio * Math.PI / 2);
                outData[startIdx + i] = (inData[startIdx + i] * fadeIn) + (inData[endIdx + i] * fadeOut);
            }
        }
        region.processedBuffer = newBuf;
    }

    // --- FX INSERT LOGIIKKA (PER-REGION) ---
    reconnectRegionInserts(region) {
        try { region.fxInput.disconnect(); } catch(e){}
        region.insertEffects.forEach(fx => {
            try { fx.instance.getNodes().output.disconnect(); } catch(e){}
        });

        let currentNode = region.fxInput;
        if (region.insertEffects.length === 0) {
            currentNode.connect(region.fxOutput);
        } else {
            region.insertEffects.forEach(fx => {
                currentNode.connect(fx.instance.getNodes().input);
                currentNode = fx.instance.getNodes().output;
            });
            currentNode.connect(region.fxOutput);
        }
    }

    // --- TIEDOSTOJEN KÄSITTELY ---
    async loadAudioFile(file, droppedNote, droppedVel) {
        try {
            const arrayBuffer = await file.arrayBuffer();
            const bufferCopy = arrayBuffer.slice(0); 
            const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
            
            const defaultLoopEnd = Math.min(1.4, audioBuffer.duration * 0.9);
            const defaultLoopStart = Math.min(0.4, defaultLoopEnd * 0.2);
            
            const region = {
                id: this.generateId(),
                fileName: file.name,
                audioBuffer: audioBuffer,
                rawArrayBuffer: bufferCopy,
                processedBuffer: null,
                minNote: Math.max(21, droppedNote - 2),
                maxNote: Math.min(108, droppedNote + 2),
                minVel: Math.max(1, droppedVel - 30),
                maxVel: Math.min(127, droppedVel + 30),
                rootNote: droppedNote,
                tune: 0,
                adsrEnabled: true,
                attack: 0.05, decay: 0.2, sustain: 1.0, release: 0.4,
                loopStart: parseFloat(defaultLoopStart.toFixed(3)),
                loopEnd: parseFloat(defaultLoopEnd.toFixed(3)),
                crossfade: 0.4,
                // Uudet Sampler Ominaisuudet
                sampleStart: 0,
                sampleEnd: audioBuffer.duration,
                fadeIn: 0.0,
                fadeOut: 0.0,
                gain: 1.0,
                // Uudet FX Reititykset
                fxInput: this.ctx.createGain(),
                fxOutput: this.ctx.createGain(),
                insertEffects: []
            };

            region.fxInput.connect(region.fxOutput);
            region.fxOutput.connect(this.instrumentGain);

            this.processCrossfade(region);
            this.regions.push(region);
            this.selectedRegionId = region.id;
            this.renderGridRegions();
            this.updateInspector();
        } catch (e) { console.error(e); }
    }

    async saveMappingToFolder() {
        if (!window.showDirectoryPicker) return alert("Selaimesi ei tue File System API:a.");
        try {
            const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            const mappingData = this.regions.map(r => ({
                id: r.id, fileName: r.fileName, minNote: r.minNote, maxNote: r.maxNote, 
                minVel: r.minVel, maxVel: r.maxVel, rootNote: r.rootNote, tune: r.tune,
                adsrEnabled: r.adsrEnabled, attack: r.attack, decay: r.decay, sustain: r.sustain, release: r.release,
                loopStart: r.loopStart, loopEnd: r.loopEnd, crossfade: r.crossfade,
                sampleStart: r.sampleStart, sampleEnd: r.sampleEnd, fadeIn: r.fadeIn, fadeOut: r.fadeOut, gain: r.gain,
                insertEffects: r.insertEffects.map(fx => ({ scriptText: fx.instance._scriptText, fileName: fx.instance._fileName }))
            }));

            const jsonFileHandle = await dirHandle.getFileHandle('mapping.json', { create: true });
            const writableJson = await jsonFileHandle.createWritable();
            await writableJson.write(JSON.stringify({ regions: mappingData }, null, 2));
            await writableJson.close();

            for (const region of this.regions) {
                if (region.rawArrayBuffer) {
                    const audioFileHandle = await dirHandle.getFileHandle(region.fileName, { create: true });
                    const writableAudio = await audioFileHandle.createWritable();
                    await writableAudio.write(region.rawArrayBuffer);
                    await writableAudio.close();
                }
            }
            alert("Tallennettu!");
        } catch (e) { console.error(e); }
    }

    async loadMappingFromFolder() {
        if (!window.showDirectoryPicker) return alert("Selaimesi ei tue File System API:a.");
        try {
            const dirHandle = await window.showDirectoryPicker();
            const jsonFileHandle = await dirHandle.getFileHandle('mapping.json');
            const jsonFile = await jsonFileHandle.getFile();
            const data = JSON.parse(await jsonFile.text());

            this.killAllNotes();
            
            // Clean up old region FX
            this.regions.forEach(r => {
                r.insertEffects.forEach(fx => { if(fx.instance.destroy) fx.instance.destroy(); });
                r.fxInput.disconnect(); r.fxOutput.disconnect();
            });
            this.regions = [];

            let loaded = 0;
            for (const rData of data.regions) {
                try {
                    const audioFileHandle = await dirHandle.getFileHandle(rData.fileName);
                    const arrayBuffer = await (await audioFileHandle.getFile()).arrayBuffer();
                    const bufferCopy = arrayBuffer.slice(0);
                    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);

                    const region = {
                        ...rData,
                        audioBuffer: audioBuffer,
                        rawArrayBuffer: bufferCopy,
                        adsrEnabled: rData.adsrEnabled ?? true,
                        attack: rData.attack ?? 0.05, decay: rData.decay ?? 0.2, sustain: rData.sustain ?? 1.0, release: rData.release ?? 0.4,
                        loopStart: rData.loopStart ?? 0.4, loopEnd: rData.loopEnd ?? 1.4, crossfade: rData.crossfade ?? 0.4,
                        sampleStart: rData.sampleStart ?? 0, sampleEnd: rData.sampleEnd ?? audioBuffer.duration,
                        fadeIn: rData.fadeIn ?? 0, fadeOut: rData.fadeOut ?? 0, gain: rData.gain ?? 1.0,
                        fxInput: this.ctx.createGain(),
                        fxOutput: this.ctx.createGain(),
                        insertEffects: []
                    };
                    
                    region.fxInput.connect(region.fxOutput);
                    region.fxOutput.connect(this.instrumentGain);
                    this.processCrossfade(region);
                    
                    // Lataa tallennetut efektit alueelle
                    if (rData.insertEffects) {
                        for (const fxD of rData.insertEffects) {
                            try {
                                const oldEffectClass = window.CustomAudioEffect;
                                window.CustomAudioEffect = null;
                                const scriptTag = document.createElement('script');
                                scriptTag.textContent = fxD.scriptText;
                                document.head.appendChild(scriptTag); 
                                const NewFXClass = window.CustomAudioEffect;
                                window.CustomAudioEffect = oldEffectClass;
                                scriptTag.remove();

                                if (NewFXClass) {
                                    const newInstance = new NewFXClass(this.ctx);
                                    newInstance._scriptText = fxD.scriptText;
                                    newInstance._fileName = fxD.fileName;
                                    region.insertEffects.push({ id: Date.now() + Math.random(), instance: newInstance });
                                }
                            } catch(e){}
                        }
                        this.reconnectRegionInserts(region);
                    }

                    this.regions.push(region);
                    loaded++;
                } catch (e) { console.error("Virhe ladattaessa:", rData.fileName); }
            }
            this.selectedRegionId = null;
            this.renderGridRegions();
            this.updateInspector();
            alert(`Ladattiin ${loaded}/${data.regions.length} samplea.`);
        } catch (e) { console.error(e); }
    }

    // --- KÄYTTÖLIITTYMÄ ---
    updateKeyUI(note, isActive) {
        if (!this.ui.container) return;
        const key = this.ui.container.querySelector(`.map-key[data-note="${note}"]`);
        if (key) isActive ? key.classList.add('active') : key.classList.remove('active');
    }

    // --- DRAG / RESIZE / MOVE LOGIIKKA ---
    handleGlobalMouseMove(e) {
        if (this.waveformDragState && this.ui.inspector) {
            const state = this.waveformDragState;
            const region = state.region;
            const canvas = document.getElementById('sampler-waveform');
            if(!canvas) return;
            const rect = canvas.getBoundingClientRect();
            let x = e.clientX - rect.left;
            x = Math.max(0, Math.min(rect.width, x));
            
            const bufferToUse = region.processedBuffer || region.audioBuffer;
            let time = (x / rect.width) * bufferToUse.duration;

            if (state.type === 'start') {
                region.sampleStart = Math.min(time, region.sampleEnd - 0.01);
                if (this.samplerKnobs && this.samplerKnobs.start) this.samplerKnobs.start.setValue(region.sampleStart);
            } else if (state.type === 'end') {
                region.sampleEnd = Math.max(time, region.sampleStart + 0.01);
                if (this.samplerKnobs && this.samplerKnobs.end) this.samplerKnobs.end.setValue(region.sampleEnd);
            }
            this.drawWaveform(region, canvas);
            return;
        }

        if (!this.activeDragState) return;
        
        const rect = this.ui.grid.getBoundingClientRect();
        const state = this.activeDragState;
        const region = state.region;

        const noteWidth = rect.width / (108 - 21 + 1);
        const velHeight = rect.height / 127;

        const deltaX = e.clientX - state.startX;
        const deltaY = e.clientY - state.startY;

        const deltaNotes = Math.round(deltaX / noteWidth);
        const deltaVels = Math.round(-deltaY / velHeight); 

        if (state.type === 'move') {
            let newMinNote = state.origMinNote + deltaNotes;
            let newMaxNote = state.origMaxNote + deltaNotes;
            let newMinVel = state.origMinVel + deltaVels;
            let newMaxVel = state.origMaxVel + deltaVels;

            if (newMinNote < 21) { newMaxNote += (21 - newMinNote); newMinNote = 21; }
            if (newMaxNote > 108) { newMinNote -= (newMaxNote - 108); newMaxNote = 108; }
            if (newMinVel < 1) { newMaxVel += (1 - newMinVel); newMinVel = 1; }
            if (newMaxVel > 127) { newMinVel -= (newMaxVel - 127); newMaxVel = 127; }

            region.minNote = newMinNote;
            region.maxNote = newMaxNote;
            region.minVel = newMinVel;
            region.maxVel = newMaxVel;
        } 
        else if (state.type === 'left') { region.minNote = Math.max(21, Math.min(state.origMinNote + deltaNotes, region.maxNote)); } 
        else if (state.type === 'right') { region.maxNote = Math.min(108, Math.max(state.origMaxNote + deltaNotes, region.minNote)); } 
        else if (state.type === 'bottom') { region.minVel = Math.max(1, Math.min(state.origMinVel + deltaVels, region.maxVel)); } 
        else if (state.type === 'top') { region.maxVel = Math.min(127, Math.max(state.origMaxVel + deltaVels, region.minVel)); }

        this.renderGridRegions();
        
        if (this.ui.inspector) {
            const minNoteInp = document.getElementById('i-minNote'); if(minNoteInp) minNoteInp.value = region.minNote;
            const maxNoteInp = document.getElementById('i-maxNote'); if(maxNoteInp) maxNoteInp.value = region.maxNote;
            const minVelInp = document.getElementById('i-minVel'); if(minVelInp) minVelInp.value = region.minVel;
            const maxVelInp = document.getElementById('i-maxVel'); if(maxVelInp) maxVelInp.value = region.maxVel;
        }
    }

    handleGlobalMouseUp() {
        if (this.activeDragState) {
            this.activeDragState = null;
            document.body.style.cursor = 'default';
        }
        if (this.waveformDragState) {
            this.waveformDragState = null;
            document.body.style.cursor = 'default';
        }
    }

    renderGridRegions() {
        if (!this.ui.grid) return;
        this.ui.grid.querySelectorAll('.map-region').forEach(el => el.remove());
        const TOTAL_NOTES = 108 - 21 + 1;

        this.regions.forEach(region => {
            const el = document.createElement('div');
            el.className = `map-region ${this.selectedRegionId === region.id ? 'selected' : ''}`;
            
            el.style.left = `${((region.minNote - 21) / TOTAL_NOTES) * 100}%`;
            el.style.width = `${((region.maxNote - region.minNote + 1) / TOTAL_NOTES) * 100}%`;
            el.style.top = `${((127 - region.maxVel) / 127) * 100}%`;
            el.style.height = `${((region.maxVel - region.minVel + 1) / 127) * 100}%`;

            el.innerHTML = `<div class="r-title" style="pointer-events:none;">${region.fileName}</div><div class="r-root" style="pointer-events:none;">R: ${this.midiToNoteName(region.rootNote)}</div>`;
            
            el.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                if (this.selectedRegionId !== region.id) {
                    this.selectedRegionId = region.id;
                    this.renderGridRegions();
                    this.updateInspector();
                }
            });

            if (this.isDragModeEnabled && this.selectedRegionId === region.id) {
                const createHandle = (type, cssClass) => {
                    const h = document.createElement('div');
                    h.className = `resize-handle ${cssClass}`;
                    h.addEventListener('mousedown', (e) => {
                        e.stopPropagation();
                        this.activeDragState = {
                            type: type, region: region, startX: e.clientX, startY: e.clientY,
                            origMinNote: region.minNote, origMaxNote: region.maxNote, origMinVel: region.minVel, origMaxVel: region.maxVel
                        };
                        document.body.style.cursor = window.getComputedStyle(h).cursor;
                    });
                    return h;
                };

                el.appendChild(createHandle('left', 'rh-left'));
                el.appendChild(createHandle('right', 'rh-right'));
                el.appendChild(createHandle('top', 'rh-top'));
                el.appendChild(createHandle('bottom', 'rh-bottom'));
                el.appendChild(createHandle('move', 'rh-move'));
            }

            this.ui.grid.appendChild(el);
        });
    }

    createKnob(container, label, min, max, val, isFloat, onChange) {
        const div = document.createElement('div');
        div.className = 'knob-container';
        div.innerHTML = `
            <div class="knob-label">${label}</div>
            <div class="knob-wrapper"><div class="knob-svg">
                <svg viewBox="0 0 30 30"><circle cx="15" cy="15" r="12" fill="none" stroke="#222" stroke-width="3" stroke-dasharray="56.5 75.4" transform="rotate(135 15 15)"></circle>
                <circle class="k-val" cx="15" cy="15" r="12" fill="none" stroke="#0ff" stroke-width="3" stroke-dasharray="0 75.4" transform="rotate(135 15 15)"></circle></svg>
            </div><div class="knob-dot-wrap"><div class="knob-dot"></div></div></div>
            <div class="knob-display">0</div>
        `;
        const valPath = div.querySelector('.k-val'), dotWrap = div.querySelector('.knob-dot-wrap'), disp = div.querySelector('.knob-display');
        let current = val;

        const updateUI = (v) => {
            const pct = (v - min) / (max - min);
            valPath.setAttribute('stroke-dasharray', `${pct * 56.5} 75.4`);
            dotWrap.style.transform = `rotate(${-135 + (pct * 270)}deg)`;
            disp.innerText = isFloat ? v.toFixed(2) : Math.round(v);
        };
        updateUI(current); container.appendChild(div);

        let dragging = false, startY = 0, startV = 0;
        const start = (y) => { dragging = true; startY = y; startV = current; document.body.style.cursor = 'ns-resize'; };
        const move = (y) => {
            if (!dragging) return;
            let nVal = startV + ((startY - y) / 100) * (max - min);
            nVal = Math.max(min, Math.min(max, nVal));
            if (nVal !== current) { current = nVal; updateUI(current); onChange(current); }
        };
        const end = () => { if(dragging){ dragging = false; document.body.style.cursor = 'default';} };

        div.querySelector('.knob-wrapper').addEventListener('mousedown', e => start(e.clientY));
        window.addEventListener('mousemove', e => move(e.clientY)); window.addEventListener('mouseup', end);
        
        return { setValue: (v) => { current = v; updateUI(v); } };
    }

    drawWaveform(region, canvas) {
        const ctx = canvas.getContext('2d');
        const bufferToUse = region.processedBuffer || region.audioBuffer;
        if (!bufferToUse) return;

        const data = bufferToUse.getChannelData(0);
        const w = canvas.width;
        const h = canvas.height;
        const step = Math.ceil(data.length / w);
        const amp = h / 2;
        
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, w, h);
        
        ctx.fillStyle = '#0ff';
        for(let i = 0; i < w; i++) {
            let min = 1.0, max = -1.0;
            for(let j = 0; j < step; j++) {
                const val = data[(i * step) + j];
                if(val < min) min = val;
                if(val > max) max = val;
            }
            ctx.fillRect(i, amp + (min * amp), 1, Math.max(1, (max - min) * amp));
        }
        
        // Draw overlays (trim out)
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        const startX = (region.sampleStart / bufferToUse.duration) * w;
        const endX = (region.sampleEnd / bufferToUse.duration) * w;
        ctx.fillRect(0, 0, startX, h); 
        ctx.fillRect(endX, 0, w - endX, h); 
        
        // Draw lines
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(startX, 0); ctx.lineTo(startX, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(endX, 0); ctx.lineTo(endX, h); ctx.stroke();
        
        // Draw handles to make it obvious
        ctx.fillStyle = '#fff';
        ctx.fillRect(startX - 4, 0, 8, 8); ctx.fillRect(startX - 4, h - 8, 8, 8);
        ctx.fillRect(endX - 4, 0, 8, 8); ctx.fillRect(endX - 4, h - 8, 8, 8);
    }

    updateADSRGraph(region) {
        if (!this.ui.inspector) return;
        const svg = this.ui.inspector.querySelector('#adsr-graph');
        if (!svg) return;
        
        const w = 150, h = 40;
        if (!region.adsrEnabled) {
            svg.innerHTML = `<text x="45" y="25" fill="#666" font-size="12" font-family="monospace">ADSR OFF</text>`;
            return;
        }

        const scale = w / 2.0; 
        const ax = Math.min(w*0.3, region.attack * scale);
        const dx = Math.min(w*0.3, region.decay * scale);
        const sy = h - (region.sustain * h);
        const rx = Math.min(w*0.3, region.release * scale);
        const susWidth = 30;

        const p0 = `0,${h}`;
        const p1 = `${ax},0`;
        const p2 = `${ax + dx},${sy}`;
        const p3 = `${ax + dx + susWidth},${sy}`;
        const p4 = `${Math.min(w, ax + dx + susWidth + rx)},${h}`;

        svg.innerHTML = `<polyline points="${p0} ${p1} ${p2} ${p3} ${p4}" fill="none" stroke="#0ff" stroke-width="2"/>
                         <polygon points="${p0} ${p1} ${p2} ${p3} ${p4}" fill="rgba(0,255,255,0.1)" />`;
    }

    updateInspector() {
        if (!this.ui.inspector) return;
        const region = this.regions.find(r => r.id === this.selectedRegionId);
        this.samplerKnobs = {};
        
        const dropdownOptions = this.regions.map(r => 
            `<option value="${r.id}" ${r.id === this.selectedRegionId ? 'selected' : ''}>${r.fileName} (R:${this.midiToNoteName(r.rootNote)})</option>`
        ).join('');
        
        const dropdownHTML = `
            <div style="margin-bottom: 10px; border-bottom: 1px solid #333; padding-bottom: 10px; display:flex; justify-content:space-between; align-items:center;">
                <select id="i-region-select" style="background:#000; color:#0ff; border:1px solid #444; padding:4px; outline:none; font-family:monospace; max-width:200px;">
                    <option value="">-- Valitse muokattava alue --</option>
                    ${dropdownOptions}
                </select>
                ${region ? `<button class="btn-delete" id="btn-del-region">POISTA ALUE</button>` : ''}
            </div>
        `;

        if (!region) {
            this.ui.inspector.innerHTML = dropdownHTML + `<div style="color:#666; font-style:italic;">Valitse alue yltä tai raahaa WAV ruudukkoon muokataksesi.</div>`;
            this.bindDropdown();
            return;
        }

        const bufferToUse = region.processedBuffer || region.audioBuffer;

        this.ui.inspector.innerHTML = dropdownHTML + `
            <div style="display:flex; gap:20px; flex-wrap:wrap;">
                
                <!-- Vasen sarake: Mapping & ADSR -->
                <div style="flex:1; min-width:250px;">
                    <div class="insp-header">MAPPING & TUNE</div>
                    <div class="insp-grid">
                        <div class="insp-col"><label>Min Note</label><input type="number" id="i-minNote" value="${region.minNote}"></div>
                        <div class="insp-col"><label>Max Note</label><input type="number" id="i-maxNote" value="${region.maxNote}"></div>
                        <div class="insp-col"><label>Min Vel</label><input type="number" id="i-minVel" value="${region.minVel}"></div>
                        <div class="insp-col"><label>Max Vel</label><input type="number" id="i-maxVel" value="${region.maxVel}"></div>
                        <div class="insp-col"><label>Root Pitch</label><input type="number" id="i-root" value="${region.rootNote}"></div>
                        <div class="insp-col"><label>Tune (St)</label><input type="number" step="0.1" id="i-tune" value="${region.tune}"></div>
                    </div>

                    <div class="insp-header" style="margin-top:15px;">LOOPING & XFADE</div>
                    <div class="insp-grid">
                        <div class="insp-col"><label>Loop Start</label><input type="number" step="0.1" id="i-ls" value="${region.loopStart}"></div>
                        <div class="insp-col"><label>Loop End</label><input type="number" step="0.1" id="i-le" value="${region.loopEnd}"></div>
                        <div class="insp-col"><label>Crossfade</label><input type="number" step="0.1" id="i-cf" value="${region.crossfade}"></div>
                    </div>

                    <div class="insp-header" style="margin-top:15px;">ENVELOPE</div>
                    <div class="insp-row">
                        <div style="display:flex; flex-direction:column; gap:5px;">
                            <button id="btn-adsr-toggle" class="btn ${region.adsrEnabled ? 'btn-active' : ''}" style="width:100px; font-size:10px;">
                                ADSR: ${region.adsrEnabled ? 'ON' : 'OFF'}
                            </button>
                            <div style="display:flex; gap:5px; opacity:${region.adsrEnabled ? 1 : 0.3}; pointer-events:${region.adsrEnabled ? 'auto' : 'none'};" id="adsr-knobs"></div>
                        </div>
                        <div class="adsr-svg-wrap"><svg id="adsr-graph" viewBox="0 0 150 40"></svg></div>
                    </div>
                </div>

                <!-- Oikea sarake: Sampler Waveform & Trim -->
                <div style="flex:2; min-width:300px;">
                    <div class="insp-header">SAMPLER TRIM & GAIN</div>
                    <div style="background:#0a0a0a; border:1px solid #333; border-radius:4px; padding:10px; margin-bottom:15px;">
                        <canvas id="sampler-waveform" width="400" height="80" style="width:100%; height:80px; cursor:ew-resize; background:#000; display:block;"></canvas>
                        <div id="sampler-knobs" style="display:flex; gap:15px; margin-top:10px; justify-content:center;"></div>
                    </div>

                    <div class="insp-header">SAMPLE INSERT FX</div>
                    <div style="background: rgba(0,0,0,0.5); border: 1px dashed rgba(0, 240, 255, 0.3); border-radius: 4px; padding: 10px;">
                        <div id="region-inserts-list" style="display:flex; flex-direction:column; gap:10px; margin-bottom:10px;"></div>
                        <div style="display:flex; gap:10px; align-items:center;">
                            <select id="region-fx-select" style="background: rgba(0,240,255,0.1); color: #0ff; border: 1px solid #0ff; padding: 4px; border-radius: 4px; font-family: monospace; font-size: 10px; outline: none;">
                                <option value="">-- Valitse FX --</option>
                            </select>
                            <label class="btn" style="padding: 4px 8px; font-size: 10px; border-color: #0ff; color: #0ff; cursor: pointer; background: transparent;">
                                + Lataa (.JS)
                                <input type="file" id="region-fx-upload" accept=".js" style="display: none;">
                            </label>
                        </div>
                    </div>
                </div>

            </div>
        `;

        this.bindDropdown();

        // Standard inputs bindings
        const bindInput = (id, prop, isFloat = false, needsRebuild = false) => {
            const el = document.getElementById(id);
            if(!el) return;
            el.addEventListener('change', (e) => {
                let val = isFloat ? parseFloat(e.target.value) : parseInt(e.target.value);
                if (isNaN(val)) return;
                region[prop] = val;
                if (region.minNote > region.maxNote) region.minNote = region.maxNote;
                if (region.minVel > region.maxVel) region.minVel = region.maxVel;
                if (needsRebuild) this.processCrossfade(region);
                this.renderGridRegions();
            });
        };

        bindInput('i-minNote', 'minNote'); bindInput('i-maxNote', 'maxNote');
        bindInput('i-minVel', 'minVel'); bindInput('i-maxVel', 'maxVel');
        bindInput('i-root', 'rootNote'); bindInput('i-tune', 'tune', true);
        bindInput('i-ls', 'loopStart', true, true);
        bindInput('i-le', 'loopEnd', true, true);
        bindInput('i-cf', 'crossfade', true, true);

        // ADSR
        document.getElementById('btn-adsr-toggle').addEventListener('click', () => {
            region.adsrEnabled = !region.adsrEnabled;
            this.updateInspector(); 
        });
        const knobsArea = document.getElementById('adsr-knobs');
        const updateGraph = () => this.updateADSRGraph(region);
        this.createKnob(knobsArea, 'A', 0, 2.0, region.attack, true, v => { region.attack = v; updateGraph(); });
        this.createKnob(knobsArea, 'D', 0, 2.0, region.decay, true, v => { region.decay = v; updateGraph(); });
        this.createKnob(knobsArea, 'S', 0, 1.0, region.sustain, true, v => { region.sustain = v; updateGraph(); });
        this.createKnob(knobsArea, 'R', 0.01, 5.0, region.release, true, v => { region.release = v; updateGraph(); });
        updateGraph();

        // Sampler Waveform & Knobs
        const canvas = document.getElementById('sampler-waveform');
        this.drawWaveform(region, canvas);

        canvas.addEventListener('mousedown', (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const startX = (region.sampleStart / bufferToUse.duration) * rect.width;
            const endX = (region.sampleEnd / bufferToUse.duration) * rect.width;
            
            if (Math.abs(x - startX) <= Math.abs(x - endX)) {
                this.waveformDragState = { type: 'start', region: region };
            } else {
                this.waveformDragState = { type: 'end', region: region };
            }
            document.body.style.cursor = 'ew-resize';
        });

        const sKnobsArea = document.getElementById('sampler-knobs');
        this.samplerKnobs.start = this.createKnob(sKnobsArea, 'Start', 0, bufferToUse.duration, region.sampleStart, true, v => { 
            region.sampleStart = Math.min(v, region.sampleEnd - 0.01); this.drawWaveform(region, canvas); 
        });
        this.samplerKnobs.end = this.createKnob(sKnobsArea, 'End', 0.01, bufferToUse.duration, region.sampleEnd, true, v => { 
            region.sampleEnd = Math.max(v, region.sampleStart + 0.01); this.drawWaveform(region, canvas); 
        });
        this.createKnob(sKnobsArea, 'FadeIn', 0, 2.0, region.fadeIn, true, v => { region.fadeIn = v; });
        this.createKnob(sKnobsArea, 'FadeOut', 0, 2.0, region.fadeOut, true, v => { region.fadeOut = v; });
        this.createKnob(sKnobsArea, 'Gain', 0, 3.0, region.gain, true, v => { region.gain = v; });

        // FX Chain UI
        const fxSelect = document.getElementById('region-fx-select');
        const fxUpload = document.getElementById('region-fx-upload');
        const insertsList = document.getElementById('region-inserts-list');

        if (window.FX_PLUGINS) {
            window.FX_PLUGINS.forEach(plugin => {
                fxSelect.innerHTML += `<option value="${plugin.file}">${plugin.name}</option>`;
            });
        }

        const addRegionInsert = (scriptText, fileName) => {
            try {
                const oldEffectClass = window.CustomAudioEffect;
                window.CustomAudioEffect = null;
                const scriptTag = document.createElement('script');
                scriptTag.textContent = scriptText;
                document.head.appendChild(scriptTag); 
                const NewFXClass = window.CustomAudioEffect;
                window.CustomAudioEffect = oldEffectClass;
                scriptTag.remove();

                if (NewFXClass) {
                    const newInstance = new NewFXClass(this.ctx);
                    newInstance._scriptText = scriptText;
                    newInstance._fileName = fileName;
                    const fxId = Date.now() + Math.random();
                    
                    const wrapper = document.createElement('div');
                    wrapper.style = "background: rgba(0,0,0,0.6); border: 1px solid rgba(0, 240, 255, 0.2); border-radius: 8px; padding: 10px; position: relative;";
                    
                    const removeBtn = document.createElement('button');
                    removeBtn.innerText = "X";
                    removeBtn.style = "position: absolute; top: 5px; right: 5px; background: transparent; border: 1px solid #ff003c; color: #ff003c; border-radius: 50%; width: 18px; height: 18px; font-size: 9px; cursor: pointer; z-index: 10;";
                    
                    const uiContainer = document.createElement('div');
                    uiContainer.style.transform = "scale(0.85)";
                    uiContainer.style.transformOrigin = "top left";
                    uiContainer.style.width = "117%"; 
                    if(typeof newInstance.renderUI === 'function') newInstance.renderUI(uiContainer);

                    removeBtn.onclick = () => {
                        if (typeof newInstance.destroy === 'function') newInstance.destroy();
                        region.insertEffects = region.insertEffects.filter(f => f.id !== fxId);
                        wrapper.remove();
                        this.reconnectRegionInserts(region);
                    };

                    wrapper.appendChild(removeBtn);
                    wrapper.appendChild(uiContainer);
                    insertsList.appendChild(wrapper);

                    region.insertEffects.push({ id: fxId, instance: newInstance, dom: wrapper });
                    this.reconnectRegionInserts(region);
                }
            } catch (err) { alert("Virhe Region FX:ssä: " + err.message); }
        };

        fxUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => addRegionInsert(event.target.result, file.name);
            reader.readAsText(file);
            e.target.value = ''; 
        });

        fxSelect.addEventListener('change', async (e) => {
            const fileName = e.target.value;
            if (!fileName) return;
            try {
                let scriptText;
                if (window.localFxCache && window.localFxCache.has(fileName)) {
                    scriptText = window.localFxCache.get(fileName);
                } else {
                    const response = await fetch('fx/' + fileName);
                    if (!response.ok) throw new Error("Tiedostoa ei löytynyt");
                    scriptText = await response.text();
                }
                addRegionInsert(scriptText, fileName);
            } catch (err) { alert("Virhe ladattaessa efektiä: " + err.message); }
            e.target.value = '';
        });

        // Piirrä olemassa olevat efektit (esim siirryttäessä toisesta regionista takaisin)
        region.insertEffects.forEach(fx => {
            if (fx.dom && !insertsList.contains(fx.dom)) insertsList.appendChild(fx.dom);
        });

        document.getElementById('btn-del-region').addEventListener('click', () => {
            region.insertEffects.forEach(fx => { if(fx.instance.destroy) fx.instance.destroy(); });
            region.fxInput.disconnect(); region.fxOutput.disconnect();
            this.regions = this.regions.filter(r => r.id !== region.id);
            this.selectedRegionId = null;
            this.renderGridRegions();
            this.updateInspector();
        });
    }

    bindDropdown() {
        const select = document.getElementById('i-region-select');
        if (select) {
            select.addEventListener('change', (e) => {
                this.selectedRegionId = e.target.value || null;
                this.renderGridRegions();
                this.updateInspector();
            });
        }
    }

    renderUI(containerElement) {
        this.ui.container = containerElement;
        const styleId = 'fx-midimap-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .mmap-panel { background: #111; padding: 15px; border-radius: 8px; border: 1px solid #333; font-family: monospace; color: #eee; }
                .mmap-topbar { display: flex; justify-content: space-between; flex-wrap:wrap; gap:10px; margin-bottom: 15px; border-bottom: 1px solid #333; padding-bottom: 10px; align-items:center;}
                .btn { background: #222; border: 1px solid #555; color: #ddd; padding: 5px 10px; cursor: pointer; border-radius: 4px; transition: 0.2s; font-family:monospace; font-size:11px;}
                .btn:hover { background: #333; border-color: #0ff; color: #0ff; }
                .btn-active { background: rgba(0,255,255,0.2); border-color: #0ff; color: #0ff; box-shadow: 0 0 5px rgba(0,255,255,0.5); }
                .btn-warn { border-color: #f05; color: #f05; }
                .btn-warn:hover { background: #301; border-color: #f05; color: #f05;}
                .btn-delete { background: #411; border: 1px solid #f05; color: #f05; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 11px;}
                
                .mmap-grid-container { position: relative; width: 100%; height: 200px; background: #0a0a0a; border: 1px solid #444; border-radius: 4px; overflow: hidden; background-image: linear-gradient(#1a1a1a 1px, transparent 1px); background-size: 100% 25%; }
                .mmap-grid-container.dragover { background-color: #1a2a2a; border-color: #0ff; }
                
                .map-region { position: absolute; background: rgba(0,255,255,0.2); border: 1px solid #0ff; border-radius: 3px; display:flex; flex-direction:column; justify-content:center; align-items:center; z-index:10;}
                .map-region.selected { background: rgba(255,0,85,0.4); border-color: #f05; z-index: 11; box-shadow: 0 0 10px rgba(255,0,85,0.5); }
                .r-title { font-size: 9px; font-weight: bold; }
                .r-root { font-size: 8px; color: #aaa; }

                .resize-handle { position: absolute; z-index: 20; background: transparent; }
                .resize-handle:hover { background: rgba(255,255,255,0.3); }
                .rh-left { top:0; bottom:0; left:-4px; width:8px; cursor: ew-resize; }
                .rh-right { top:0; bottom:0; right:-4px; width:8px; cursor: ew-resize; }
                .rh-top { top:-4px; left:0; right:0; height:8px; cursor: ns-resize; }
                .rh-bottom { bottom:-4px; left:0; right:0; height:8px; cursor: ns-resize; }
                .rh-move { top: 4px; bottom: 4px; left: 4px; right: 4px; cursor: grab; }
                .rh-move:active { cursor: grabbing; background: rgba(255,255,255,0.1); }

                .mmap-piano { display: flex; height: 40px; width: 100%; background: #000; border: 1px solid #333; border-radius: 0 0 4px 4px; position: relative; }
                .map-key { flex: 1; border-right: 1px solid #333; position: relative; }
                .map-key.white { background: #ddd; z-index: 1; border-bottom: 2px solid #aaa;}
                .map-key.white.active { background: #8ff; }
                .map-key.black { background: #111; z-index: 2; height: 60%; position: absolute; transform: translateX(-50%); width: calc(100% / 52 * 0.6); }
                .map-key.black.active { background: #0aa; }
                
                .mmap-inspector { background: #1a1a1a; border: 1px solid #333; padding: 10px; border-radius: 4px; margin-top: 10px; }
                .insp-header { font-size: 11px; margin-bottom: 8px; color: #0ff; font-weight:bold; }
                .insp-grid { display: flex; flex-wrap: wrap; gap: 10px; }
                .insp-row { display: flex; align-items: center; justify-content: space-between; gap:10px; flex-wrap:wrap;}
                .insp-col { display: flex; flex-direction: column; gap: 3px; }
                .insp-col label { font-size: 9px; color: #aaa; }
                .insp-col input { background: #000; border: 1px solid #444; color: #fff; padding: 3px; width: 50px; font-size: 11px; outline: none; font-family:monospace;}
                
                .knob-container { display:flex; flex-direction:column; align-items:center; width: 35px;}
                .knob-label { font-size: 9px; color: #888; margin-bottom:2px; }
                .knob-wrapper { position:relative; width:30px; height:30px; cursor: ns-resize; }
                .knob-svg { width:100%; height:100%; }
                .knob-dot-wrap { position:absolute; top:0; left:0; right:0; bottom:0; pointer-events:none; }
                .knob-dot { position:absolute; width:4px; height:4px; background:#0ff; border-radius:50%; top:4px; left:50%; transform:translateX(-50%);}
                .knob-display { font-size: 9px; color: #aaa; margin-top:2px; }
                .adsr-svg-wrap { width: 150px; height: 40px; background: #000; border: 1px solid #333; border-radius:3px; display:flex; align-items:center; justify-content:center;}
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div class="mmap-panel">
                <div class="mmap-topbar">
                    <div style="font-weight: bold; color: #0ff;">MULTI-SAMPLED INSTRUMENT</div>
                    <div style="display:flex; gap:8px; align-items:center;">
                        <input type="file" id="mmap-file-upload" accept="audio/wav,audio/mp3" style="display:none;">
                        <button class="btn" id="btn-load-wav" style="border-color:#fff; color:#fff;">+ LOAD WAV</button>
                        <div style="width:1px; height:20px; background:#444; margin: 0 5px;"></div>
                        <button class="btn" id="btn-drag-toggle">EDIT DRAG: OFF</button>
                        <div style="width:1px; height:20px; background:#444; margin: 0 5px;"></div>
                        <button class="btn" id="btn-load-folder">LOAD FOLDER</button>
                        <button class="btn" id="btn-save-folder">SAVE FOLDER</button>
                        <button class="btn btn-warn" id="btn-panic">PANIC</button>
                    </div>
                </div>
                <div class="mmap-grid-container" id="mmap-grid"><div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#555; pointer-events:none;">Drag & Drop .WAV files here</div></div>
                <div class="mmap-piano" id="mmap-piano"></div>
                <div class="mmap-inspector" id="mmap-inspector"></div>
            </div>
        `;

        this.ui.grid = containerElement.querySelector('#mmap-grid');
        this.ui.inspector = containerElement.querySelector('#mmap-inspector');
        const pianoRuler = containerElement.querySelector('#mmap-piano');

        const getClickVelocity = (e, element) => {
            const rect = element.getBoundingClientRect();
            const clientY = e.touches && e.touches.length > 0 ? e.touches[0].clientY : e.clientY;
            const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
            const ratio = y / rect.height; 
            return Math.floor(20 + ratio * 107); 
        };

        let whiteCount = 0;
        for (let i = 21; i <= 108; i++) {
            const isBlack = [1, 3, 6, 8, 10].includes(i % 12);
            const key = document.createElement('div');
            key.className = 'map-key ' + (isBlack ? 'black' : 'white');
            key.dataset.note = i;
            if (isBlack) key.style.left = `calc((100% / 52) * ${whiteCount})`;
            else whiteCount++;
            
            key.addEventListener('mousedown', async (e) => {
                e.preventDefault();
                if (this.ctx.state === 'suspended') await this.ctx.resume(); // TÄRKEÄ: Herättää audiomoottorin!
                this.noteOn(i, getClickVelocity(e, key));
            });
            key.addEventListener('mouseup', () => this.noteOff(i));
            key.addEventListener('mouseleave', () => this.noteOff(i));

            key.addEventListener('touchstart', async (e) => {
                e.preventDefault();
                if (this.ctx.state === 'suspended') await this.ctx.resume();
                this.noteOn(i, getClickVelocity(e, key));
            }, { passive: false });
            key.addEventListener('touchend', (e) => {
                e.preventDefault();
                this.noteOff(i);
            }, { passive: false });
            key.addEventListener('touchcancel', (e) => {
                e.preventDefault();
                this.noteOff(i);
            }, { passive: false });

            pianoRuler.appendChild(key);
        }

        this.ui.grid.addEventListener('dragover', e => { e.preventDefault(); this.ui.grid.classList.add('dragover'); });
        this.ui.grid.addEventListener('dragleave', () => this.ui.grid.classList.remove('dragover'));
        this.ui.grid.addEventListener('drop', e => {
            e.preventDefault(); this.ui.grid.classList.remove('dragover');
            const rect = this.ui.grid.getBoundingClientRect();
            const note = Math.round(21 + ((e.clientX - rect.left) / rect.width) * (108 - 21));
            const vel = Math.round(127 - ((e.clientY - rect.top) / rect.height) * 127);
            if (e.dataTransfer.files[0]?.type.includes('audio') || e.dataTransfer.files[0]?.name.endsWith('.wav')) {
                this.loadAudioFile(e.dataTransfer.files[0], note, Math.max(1, Math.min(127, vel)));
            }
        });

        const fileInput = containerElement.querySelector('#mmap-file-upload');
        containerElement.querySelector('#btn-load-wav').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) this.loadAudioFile(e.target.files[0], 60, 100);
        });

        const dragBtn = containerElement.querySelector('#btn-drag-toggle');
        dragBtn.addEventListener('click', () => {
            this.isDragModeEnabled = !this.isDragModeEnabled;
            dragBtn.innerText = `EDIT DRAG: ${this.isDragModeEnabled ? 'ON' : 'OFF'}`;
            if (this.isDragModeEnabled) dragBtn.classList.add('btn-active');
            else dragBtn.classList.remove('btn-active');
            this.renderGridRegions();
        });

        containerElement.querySelector('#btn-load-folder').addEventListener('click', () => this.loadMappingFromFolder());
        containerElement.querySelector('#btn-save-folder').addEventListener('click', () => this.saveMappingToFolder());
        containerElement.querySelector('#btn-panic').addEventListener('click', () => this.killAllNotes());

        this.ui.grid.addEventListener('mousedown', (e) => { 
            if(e.target === this.ui.grid) {
                this.selectedRegionId = null; 
                this.renderGridRegions(); 
                this.updateInspector(); 
            }
        });

        this.renderGridRegions(); this.updateInspector();
    }
}