// midi-drums.js
// Laajennettu MIDI/Graafinen Rumpusetti - Panorointi, Round Robin, Palvelinhaku, Kansiolataus, Edit Mode (Pikanäppäimet), Kompressori, MIDI Out ja Keys-tila.

window.CustomAudioEffect = class AudioDrumsEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        
        // Efektiketjun solmut
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        
        // Rumpujen pää-äänenvoimakkuus (Master Volume)
        this.drumMaster = audioCtx.createGain();
        this.drumMaster.gain.value = 1.0;

        // Master Kompressori
        this.compressor = audioCtx.createDynamicsCompressor();
        this.compBypass = audioCtx.createGain();
        this.compActive = audioCtx.createGain();
        
        // Kompressorin oletusasetukset
        this.compressor.threshold.value = -20;
        this.compressor.ratio.value = 4;
        this.compressor.attack.value = 0.01;
        this.compressor.release.value = 0.1;

        this.isCompOn = false;
        this.compBypass.gain.value = 1.0;
        this.compActive.gain.value = 0.0;

        // Reititys: 
        // 1. Päästetään FX.html:n ulkoinen ääni puhtaana suoraan läpi
        this.input.connect(this.output);
        
        // 2. Kytketään rummut rinnakkaisesti kompressorille ja ohitukseen
        this.drumMaster.connect(this.compBypass);
        this.compBypass.connect(this.output);

        this.drumMaster.connect(this.compressor);
        this.compressor.connect(this.compActive);
        this.compActive.connect(this.output);

        // 3. Varmistetaan, että ääni kuuluu masteriin
        this.output.connect(audioCtx.destination);
        
        // Apufunktio luomaan yksilölliset taulukot jokaiselle rummulle
        const baseProps = () => ({
            buffers: [], assignedFiles: [], rrIndex: 0, vol: 1.0, pitch: 1.0, pan: 0.0,
            zIndex: 10, imgSrc: '', imgScale: 100, imgX: 0, imgY: 0, hotkey: ''
        });

        // Rumpujen tila, metadata ja oletuspikanäppäimet
        this.drums = {
            36: { id: 'kick',        name: 'KICK',    fileMatch: 'kick',          ...baseProps(), x: 200, y: 150, w: 100, h: 100, shape: 'circle', hotkey: 'z' },
            38: { id: 'snare',       name: 'SNARE',   fileMatch: 'snare',         ...baseProps(), x: 100, y: 130, w: 70,  h: 70,  shape: 'circle', hotkey: 'x' },
            39: { id: 'clap',        name: 'CLAP',    fileMatch: 'clap',          ...baseProps(), x: 20,  y: 200, w: 50,  h: 40,  shape: 'rect', hotkey: '' },
            41: { id: 'tom4',        name: 'TOM 4',   fileMatch: 'tom4',          ...baseProps(), x: 280, y: 150, w: 85,  h: 85,  shape: 'circle', hotkey: '' },
            42: { id: 'hihat_c',     name: 'HH CL',   fileMatch: 'hi-hat-closed', ...baseProps(), x: 40,  y: 80,  w: 65,  h: 65,  shape: 'circle', hotkey: 'c' },
            46: { id: 'hihat_o',     name: 'HH OP',   fileMatch: 'hi-hat-open',   ...baseProps(), x: 60,  y: 50,  w: 65,  h: 65,  shape: 'circle', hotkey: 'v' },
            43: { id: 'tom3',        name: 'TOM 3',   fileMatch: 'tom3',          ...baseProps(), x: 250, y: 80,  w: 75,  h: 75,  shape: 'circle', hotkey: '' },
            45: { id: 'tom2',        name: 'TOM 2',   fileMatch: 'tom2',          ...baseProps(), x: 200, y: 40,  w: 65,  h: 65,  shape: 'circle', hotkey: '' },
            47: { id: 'tom1',        name: 'TOM 1',   fileMatch: 'tom1',          ...baseProps(), x: 130, y: 40,  w: 60,  h: 60,  shape: 'circle', hotkey: '' },
            49: { id: 'crash1',      name: 'CY 1',    fileMatch: 'crash1',        ...baseProps(), x: 50,  y: 10,  w: 80,  h: 80,  shape: 'circle', hotkey: 'b' },
            57: { id: 'crash2',      name: 'CY 2',    fileMatch: 'crash2',        ...baseProps(), x: 350, y: 10,  w: 85,  h: 85,  shape: 'circle', hotkey: '' },
            51: { id: 'ride',        name: 'RIDE',    fileMatch: 'ride',          ...baseProps(), x: 380, y: 80,  w: 100, h: 100, shape: 'circle', hotkey: 'n' },
            52: { id: 'cymbal3',     name: 'CY 3',    fileMatch: 'cymbal3',       ...baseProps(), x: 400, y: 160, w: 90,  h: 90,  shape: 'circle', hotkey: '' },
            56: { id: 'cowbell',     name: 'BELL',    fileMatch: 'cowbell',       ...baseProps(), x: 180, y: 100, w: 40,  h: 30,  shape: 'rect', hotkey: '' },
            62: { id: 'perc3',       name: 'PERC 3',  fileMatch: 'perc3',         ...baseProps(), x: 340, y: 200, w: 55,  h: 55,  shape: 'circle', hotkey: '' },
            60: { id: 'perc1',       name: 'PERC 1',  fileMatch: 'perc1',         ...baseProps(), x: 80,  y: 210, w: 45,  h: 45,  shape: 'circle', hotkey: '' },
            61: { id: 'perc2',       name: 'PERC 2',  fileMatch: 'perc2',         ...baseProps(), x: 130, y: 215, w: 50,  h: 50,  shape: 'circle', hotkey: '' },
            63: { id: 'perc4',       name: 'PERC 4',  fileMatch: 'perc4',         ...baseProps(), x: 300, y: 240, w: 45,  h: 45,  shape: 'circle', hotkey: '' }
        };

        this.bgConfig = { src: '', scale: 100, x: 0, y: 0 };
        this.isEditMode = false;
        this.keysEnabled = false; // Uusi tila hotkey-näppäimille
        this.activeEditMidi = null; 
        
        this.drumElements = {};
        this.containerElement = null; 
    }

    onMidi(msg) {
        if (typeof this.onMidiOut === 'function') this.onMidiOut(msg);

        const status = msg[0] & 0xF0;
        const note = msg[1];
        const velocity = msg[2];
        if (status === 0x90 && velocity > 0) {
            if (this.ctx.state === 'suspended') this.ctx.resume();
            this.triggerDrum(note, velocity, true);
        }
    }

    triggerDrum(midiNote, velocity = 100, isExternalMidi = false) {
        const drum = this.drums[midiNote];
        
        if (!isExternalMidi && typeof this.sendMidi === 'function') {
            this.sendMidi([0x90, midiNote, velocity]);
            setTimeout(() => {
                if (typeof this.sendMidi === 'function') {
                    this.sendMidi([0x80, midiNote, 0]);
                }
            }, 80);
        }

        if (!drum || drum.buffers.length === 0) return;

        this.animateDrumUI(midiNote);

        const now = this.ctx.currentTime;
        const source = this.ctx.createBufferSource();
        
        // Round Robin
        const bufferIndex = drum.rrIndex % drum.buffers.length;
        source.buffer = drum.buffers[bufferIndex];
        drum.rrIndex++;

        source.playbackRate.value = drum.pitch;

        const gainNode = this.ctx.createGain();
        const velGain = Math.pow(velocity / 127, 1.5);
        gainNode.gain.setValueAtTime(drum.vol * velGain, now);

        const panner = this.ctx.createStereoPanner();
        panner.pan.setValueAtTime(drum.pan, now);

        source.connect(gainNode);
        gainNode.connect(panner);
        panner.connect(this.drumMaster);
        
        source.start(now);
    }

    animateDrumUI(midiNote) {
        const el = this.drumElements[midiNote];
        if (el && !this.isEditMode) {
            el.classList.add('hit');
            setTimeout(() => el.classList.remove('hit'), 80);
        }
    }

    // --- TIEDOSTOJEN KÄSITTELY ---
    async fetchSet(setName) {
        if (!setName) return;
        
        for (const midi in this.drums) {
            this.drums[midi].buffers = [];
            this.drums[midi].assignedFiles = [];
            this.updateVisualState(midi);
        }

        let presetLoaded = false;
        
        try {
            const res = await fetch(`${setName}/preset.json`);
            if (res.ok) {
                const preset = await res.json();
                this.applyPresetData(preset);
                
                for (const [midi, data] of Object.entries(preset.drums)) {
                    if (data.assignedFiles && data.assignedFiles.length > 0) {
                        for (const fname of data.assignedFiles) {
                            try {
                                const aRes = await fetch(`${setName}/${fname}`);
                                if (aRes.ok) {
                                    const ab = await aRes.arrayBuffer();
                                    const audioBuf = await this.ctx.decodeAudioData(ab);
                                    if(this.drums[midi]) {
                                        this.drums[midi].buffers.push(audioBuf);
                                        this.drums[midi].assignedFiles.push(fname);
                                        this.updateVisualState(midi);
                                    }
                                }
                            } catch(e) {}
                        }
                    }
                }
                presetLoaded = true;
            }
        } catch(e) { }

        if (!presetLoaded) {
            for (const [midi, data] of Object.entries(this.drums)) {
                try {
                    const response = await fetch(`${setName}/${data.fileMatch}.wav`);
                    if (response.ok) {
                        const arrayBuffer = await response.arrayBuffer();
                        const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
                        this.drums[midi].buffers.push(audioBuffer);
                        this.drums[midi].assignedFiles.push(`${data.fileMatch}.wav`);
                        this.updateVisualState(midi);
                    }
                } catch (e) { }
            }
        }
    }

    async handleFolderUpload(files) {
        let presetData = null;
        const audioFiles = [];

        for (const midi in this.drums) {
            this.drums[midi].buffers = [];
            this.drums[midi].assignedFiles = [];
            this.updateVisualState(midi);
        }

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const name = file.name.toLowerCase();
            if (name.endsWith('.json')) {
                const text = await file.text();
                try { presetData = JSON.parse(text); } catch(e) { console.error("Invalid JSON"); }
            } else if (name.endsWith('.wav') || name.endsWith('.mp3')) {
                audioFiles.push(file);
            }
        }

        if (presetData) {
            this.applyPresetData(presetData);
        }

        for (const file of audioFiles) {
            let targetMidi = null;
            
            if (presetData && presetData.drums) {
                for (const [midi, data] of Object.entries(presetData.drums)) {
                    if (data.assignedFiles && data.assignedFiles.includes(file.name)) {
                        targetMidi = midi;
                        break;
                    }
                }
            }
            
            if (!targetMidi) {
                for (const [midi, data] of Object.entries(this.drums)) {
                    if (file.name.toLowerCase().includes(data.fileMatch)) {
                        targetMidi = midi;
                        break;
                    }
                }
            }

            if (targetMidi && this.drums[targetMidi]) {
                await this.processSingleFileForDrum(targetMidi, file, true);
                if (!this.drums[targetMidi].assignedFiles.includes(file.name)) {
                    this.drums[targetMidi].assignedFiles.push(file.name);
                }
            }
        }
    }

    async processSingleFileForDrum(midi, file, append = false) {
        if(!this.drums[midi]) return;
        try {
            const arrayBuffer = await file.arrayBuffer();
            const clone = arrayBuffer.slice(0); 
            const audioBuffer = await this.ctx.decodeAudioData(clone);
            
            if (!append) {
                this.drums[midi].buffers = [];
                this.drums[midi].assignedFiles = [];
            }
            this.drums[midi].buffers.push(audioBuffer);
            this.updateVisualState(midi);
        } catch (e) { 
            console.error("Virhe tiedostossa:", file.name, e); 
        }
    }

    audioBufferToWav(buffer) {
        const numOfChan = buffer.numberOfChannels;
        const length = buffer.length * numOfChan * 2 + 44;
        const out = new ArrayBuffer(length);
        const view = new DataView(out);
        const channels = [];
        let sample;
        let offset = 0;
        let pos = 0;

        const setUint16 = (data) => { view.setUint16(pos, data, true); pos += 2; };
        const setUint32 = (data) => { view.setUint32(pos, data, true); pos += 4; };

        setUint32(0x46464952); // "RIFF"
        setUint32(length - 8); // file length - 8
        setUint32(0x45564157); // "WAVE"
        setUint32(0x20746d66); // "fmt " chunk
        setUint32(16); // length = 16
        setUint16(1); // PCM
        setUint16(numOfChan);
        setUint32(buffer.sampleRate);
        setUint32(buffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
        setUint16(numOfChan * 2); // block-align
        setUint16(16); // 16-bit
        setUint32(0x61746164); // "data" chunk
        setUint32(length - pos - 4); // chunk length

        for (let i = 0; i < numOfChan; i++) channels.push(buffer.getChannelData(i));

        while (pos < length) {
            for (let i = 0; i < numOfChan; i++) {
                sample = Math.max(-1, Math.min(1, channels[i][offset]));
                sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
                setUint16(sample);
            }
            offset++;
        }
        return new Blob([out], { type: "audio/wav" });
    }

    updateVisualState(midi) {
        if(!this.drums[midi]) return;
        const data = this.drums[midi];
        const statusDot = document.getElementById(`status-${midi}`);
        const el = this.drumElements[midi];
        
        if (data.buffers.length > 0) {
            if(statusDot) { statusDot.style.backgroundColor = '#00ff00'; statusDot.style.boxShadow = '0 0 5px #00ff00'; }
            if(el) { el.classList.remove('unloaded'); }
        } else {
            if(statusDot) { statusDot.style.backgroundColor = '#ff0000'; statusDot.style.boxShadow = 'none'; }
            if(el) { el.classList.add('unloaded'); }
        }
    }

    // --- TALLENNUS FILE SYSTEM ACCESS API:LLA ---
    async exportPreset() {
        const preset = { 
            bgConfig: this.bgConfig, 
            drumMasterVol: this.drumMaster.gain.value, 
            compState: {
                isOn: this.isCompOn,
                threshold: this.compressor.threshold.value,
                ratio: this.compressor.ratio.value,
                attack: this.compressor.attack.value,
                release: this.compressor.release.value
            },
            drums: {} 
        };
        
        for (const [midi, data] of Object.entries(this.drums)) {
            preset.drums[midi] = {
                id: data.id, name: data.name, fileMatch: data.fileMatch,
                vol: data.vol, pitch: data.pitch, pan: data.pan,
                x: data.x, y: data.y, w: data.w, h: data.h, shape: data.shape,
                zIndex: data.zIndex || 10, imgSrc: data.imgSrc || '', 
                imgScale: data.imgScale || 100, imgX: data.imgX || 0, imgY: data.imgY || 0,
                hotkey: data.hotkey || '',
                assignedFiles: []
            };

            for (let i = 0; i < data.buffers.length; i++) {
                const originalName = data.assignedFiles[i] || `${data.id}_${i}.wav`;
                preset.drums[midi].assignedFiles.push(originalName);
            }
        }

        try {
            if (window.showDirectoryPicker) {
                const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
                const exportedFiles = new Set();

                for (const [midi, data] of Object.entries(this.drums)) {
                    for (let i = 0; i < data.buffers.length; i++) {
                        const originalName = preset.drums[midi].assignedFiles[i];
                        if (!exportedFiles.has(originalName)) {
                            const wavBlob = this.audioBufferToWav(data.buffers[i]);
                            const fileHandle = await dirHandle.getFileHandle(originalName, { create: true });
                            const writable = await fileHandle.createWritable();
                            await writable.write(wavBlob);
                            await writable.close();
                            exportedFiles.add(originalName);
                        }
                    }
                }

                const jsonStr = JSON.stringify(preset, null, 2);
                const jsonHandle = await dirHandle.getFileHandle("preset.json", { create: true });
                const jsonWritable = await jsonHandle.createWritable();
                await jsonWritable.write(jsonStr);
                await jsonWritable.close();

                alert("Preset ja WAV-tiedostot tallennettu onnistuneesti valittuun kansioon!");
            } else {
                alert("Selaimesi ei tue kansiotallennusta. Lataamme vain preset.json -tiedoston.");
                const jsonStr = JSON.stringify(preset, null, 2);
                const blob = new Blob([jsonStr], { type: "application/json" });
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = "preset.json";
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            }
        } catch (err) {
            console.error("Tallennus peruutettiin tai siinä tapahtui virhe:", err);
        }
    }

    applyPresetData(preset) {
        if (preset.bgConfig) this.bgConfig = preset.bgConfig;
        
        if (preset.drumMasterVol !== undefined) {
            this.drumMaster.gain.value = preset.drumMasterVol;
            const volSlider = document.getElementById('drum-master-vol');
            const volLbl = document.getElementById('lbl-drum-master-vol');
            if (volSlider) volSlider.value = preset.drumMasterVol;
            if (volLbl) volLbl.innerText = preset.drumMasterVol.toFixed(2);
        }

        if (preset.compState) {
            this.isCompOn = preset.compState.isOn;
            this.compActive.gain.value = this.isCompOn ? 1.0 : 0.0;
            this.compBypass.gain.value = this.isCompOn ? 0.0 : 1.0;
            this.compressor.threshold.value = preset.compState.threshold;
            this.compressor.ratio.value = preset.compState.ratio;
            this.compressor.attack.value = preset.compState.attack;
            this.compressor.release.value = preset.compState.release;
            
            this.updateCompressorUI();
        }
        
        this.drums = {};
        for (const [midi, presetData] of Object.entries(preset.drums)) {
            this.drums[midi] = {
                id: presetData.id || `drum_${midi}`,
                name: presetData.name || `Drum ${midi}`,
                fileMatch: presetData.fileMatch || '',
                vol: presetData.vol !== undefined ? presetData.vol : 1.0,
                pitch: presetData.pitch !== undefined ? presetData.pitch : 1.0,
                pan: presetData.pan !== undefined ? presetData.pan : 0.0,
                x: presetData.x !== undefined ? presetData.x : 150, 
                y: presetData.y !== undefined ? presetData.y : 150, 
                w: presetData.w !== undefined ? presetData.w : 60, 
                h: presetData.h !== undefined ? presetData.h : 60, 
                shape: presetData.shape || 'circle',
                zIndex: presetData.zIndex || 10,
                imgSrc: presetData.imgSrc || '', imgScale: presetData.imgScale || 100, 
                imgX: presetData.imgX || 0, imgY: presetData.imgY || 0,
                hotkey: presetData.hotkey || '',
                buffers: [], rrIndex: 0,
                assignedFiles: presetData.assignedFiles ? [...presetData.assignedFiles] : []
            };
        }
        
        if (this.containerElement) {
            this.renderStage();
            this.renderMixer();
            this.populateEditDrumSelect();
        }
        this.updateBgImageUI();
    }

    applyVisualsToDrum(midi) {
        if (!this.drums[midi]) return;
        const data = this.drums[midi];
        const el = this.drumElements[midi];
        if (!el) return;
        
        el.style.left = `${data.x}px`;
        el.style.top = `${data.y}px`;
        el.style.width = `${data.w}px`;
        el.style.height = `${data.h}px`;
        el.style.zIndex = data.zIndex || 10;
        el.className = `drum-piece ${data.id} shape-${data.shape}`;
        
        const hotkeyHTML = data.hotkey ? `<div class="hotkey-label">[${data.hotkey.toUpperCase()}]</div>` : '';
        el.innerHTML = `<span>${data.name}</span>${hotkeyHTML}`; 
        
        if (data.imgSrc) {
            el.style.backgroundImage = `url(${data.imgSrc})`;
            el.style.backgroundSize = `${data.imgScale}%`;
            el.style.backgroundPosition = `${data.imgX}px ${data.imgY}px`;
            el.style.backgroundRepeat = 'no-repeat';
        } else {
            el.style.backgroundImage = 'none';
        }

        if(data.buffers.length === 0) el.classList.add('unloaded');
        
        if (this.isEditMode && String(this.activeEditMidi) === String(midi)) {
            el.classList.add('active-edit-target');
        } else {
            el.classList.remove('active-edit-target');
        }
    }

    updateBgImageUI() {
        const stage = document.getElementById('drum-stage-bg');
        if (stage) {
            if (this.bgConfig.src) {
                stage.style.backgroundImage = `url(${this.bgConfig.src})`;
                stage.style.backgroundSize = `${this.bgConfig.scale}%`;
                stage.style.backgroundPosition = `${this.bgConfig.x}px ${this.bgConfig.y}px`;
                stage.style.backgroundRepeat = 'no-repeat';
            } else {
                stage.style.backgroundImage = 'none';
            }
        }
    }

    updateCompressorUI() {
        if(!this.containerElement) return;
        const btnToggle = this.containerElement.querySelector('#btn-comp-toggle');
        if (btnToggle) {
            btnToggle.innerText = this.isCompOn ? "ON" : "OFF";
            btnToggle.className = this.isCompOn ? "btn-drum active-edit" : "btn-drum";
        }
        
        const setVal = (id, val, dp=2) => {
            const el = this.containerElement.querySelector(`#${id}`);
            const lbl = this.containerElement.querySelector(`#lbl-${id}`);
            if(el) el.value = val;
            if(lbl) lbl.innerText = val.toFixed(dp);
        };
        
        setVal('comp-thresh', this.compressor.threshold.value, 1);
        setVal('comp-ratio', this.compressor.ratio.value, 1);
        setVal('comp-att', this.compressor.attack.value, 2);
        setVal('comp-rel', this.compressor.release.value, 2);
    }

    getNodes() { return { input: this.input, output: this.output }; }
    
    getState() { 
        return { 
            drumMasterVol: this.drumMaster.gain.value,
            compOn: this.isCompOn,
            compThreshold: this.compressor.threshold.value,
            compRatio: this.compressor.ratio.value,
            compAttack: this.compressor.attack.value,
            compRelease: this.compressor.release.value
        }; 
    }
    
    setState(state) { 
        if (!state) return;
        if (state.drumMasterVol !== undefined) { 
            this.drumMaster.gain.value = state.drumMasterVol; 
            if (this.containerElement) {
                const volSlider = this.containerElement.querySelector('#drum-master-vol');
                const volLbl = this.containerElement.querySelector('#lbl-drum-master-vol');
                if (volSlider) volSlider.value = state.drumMasterVol;
                if (volLbl) volLbl.innerText = state.drumMasterVol.toFixed(2);
            }
        }
        if (state.compOn !== undefined) {
            this.isCompOn = state.compOn;
            this.compActive.gain.value = this.isCompOn ? 1.0 : 0.0;
            this.compBypass.gain.value = this.isCompOn ? 0.0 : 1.0;
        }
        if (state.compThreshold !== undefined) this.compressor.threshold.value = state.compThreshold;
        if (state.compRatio !== undefined) this.compressor.ratio.value = state.compRatio;
        if (state.compAttack !== undefined) this.compressor.attack.value = state.compAttack;
        if (state.compRelease !== undefined) this.compressor.release.value = state.compRelease;

        this.updateCompressorUI();
    }

    renderUI(containerElement) {
        this.containerElement = containerElement;
        const color = '#00ffff'; 
        containerElement.style.setProperty('--drum-color', color);

        const styleId = 'fx-drums-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .drum-panel { background: #111; padding: 15px; border-radius: 8px; border: 1px solid #333; display: flex; flex-direction: column; gap: 15px; font-family: monospace; }
                .drum-header-row { display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; padding-bottom: 10px;}
                
                .btn-drum { background: #0a0a0a; border: 1px solid var(--drum-color); color: var(--drum-color); cursor: pointer; padding: 5px 10px; border-radius: 4px; font-family: monospace; font-size: 11px; transition: all 0.1s; }
                .btn-drum:hover { background: rgba(0, 255, 255, 0.1); box-shadow: inset 0 0 10px rgba(0, 255, 255, 0.3); }
                .btn-drum.active-edit { background: #ff00ff; color: #fff; border-color: #ff00ff; box-shadow: 0 0 15px #ff00ff; }
                .btn-drum.active-keys { background: #00ff00; color: #000; border-color: #00ff00; box-shadow: 0 0 15px #00ff00; }
                .btn-drum.red { border-color: #ff4444; color: #ff4444; }
                .btn-drum.red:hover { background: rgba(255,0,0,0.1); box-shadow: inset 0 0 10px rgba(255,0,0,0.3); }

                .drum-select-styled { background: #000; color: #0f0; border: 1px solid #0f0; padding: 5px; font-family: monospace; border-radius: 4px; cursor: pointer;}
                
                .drum-kit-stage-container { position: relative; width: 100%; height: 350px; background: #000; border: 2px solid #222; border-radius: 8px; overflow: hidden; box-shadow: inset 0 10px 30px rgba(0,0,0,0.8); }
                #drum-stage-bg { position: absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; opacity: 0.5;}
                #drum-pads-container { position: absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; }
                
                .drum-piece {
                    position: absolute; cursor: pointer; display: flex; flex-direction: column; justify-content: center; align-items: center; pointer-events:auto;
                    color: rgba(255,255,255,0.9); font-size: 11px; font-weight: bold; user-select: none; text-shadow: 1px 1px 2px #000, 0 0 5px #000;
                    box-sizing: border-box; background-color: transparent; border: 1px solid rgba(255,255,255,0.3);
                    box-shadow: 0 5px 15px rgba(0,0,0,0.8), inset 0 0 15px rgba(0,0,0,0.5);
                    transition: filter 0.05s, transform 0.05s, background-color 0.2s; overflow: hidden;
                }
                .drum-piece:hover { background-color: rgba(255,255,255,0.1); }
                .drum-piece span { z-index: 2; pointer-events:none; } 
                .drum-piece.unloaded { opacity: 0.4; filter: grayscale(100%); border-style: dashed; background-color: rgba(50,50,50,0.4); }
                .drum-piece.hit { transform: scale(0.92); filter: brightness(1.5) drop-shadow(0 0 10px var(--drum-color)); }
                
                .hotkey-label { font-size: 9px; color: #00ff00; margin-top: 2px; display: none; pointer-events: none; z-index: 2; text-shadow: 1px 1px 2px #000, 0 0 5px #000;}
                .show-keys .hotkey-label { display: block; }

                .shape-circle { border-radius: 50%; }
                .shape-rect { border-radius: 5px; }
                
                .edit-mode .drum-piece { border: 1px dashed #ff00ff !important; cursor: move; }
                .edit-mode .drum-piece:hover { background-color: rgba(255,0,255,0.2); }
                .edit-mode .drum-piece.active-edit-target { border: 2px solid #00ffff !important; box-shadow: 0 0 15px #00ffff !important; }
                .edit-mode #drum-stage-bg { opacity: 0.8; }

                .edit-tools-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
                .edit-section { background: rgba(255,255,255,0.05); padding: 8px; border-radius: 4px; display:flex; flex-direction:column; gap:6px; }
                .edit-row { display: flex; align-items: center; justify-content: space-between; gap: 5px; font-size: 10px;}
                .edit-row label { width: 60px; color:#aaa; }
                .edit-row input[type="text"], .edit-row input[type="number"] { background:#000; color:#fff; border:1px solid #555; padding:3px; border-radius:3px; width:60px; font-family:monospace; font-size:10px; }
                .edit-row select { background:#000; color:#fff; border:1px solid #555; padding:3px; border-radius:3px; width:70px; font-family:monospace; font-size:10px; }
                
                .drum-mixer { display: grid; grid-template-columns: repeat(auto-fit, minmax(65px, 1fr)); gap: 8px; margin-top: 10px;}
                .mixer-channel { background: #0a0a0a; border: 1px solid #222; padding: 5px; border-radius: 4px; display: flex; flex-direction: column; align-items: center; }
                .ch-title { font-size: 9px; color: #888; margin-bottom: 5px; text-align: center; white-space: nowrap; width:100%; overflow:hidden; text-overflow:ellipsis;}
                .ch-status { width: 6px; height: 6px; border-radius: 50%; background: #ff0000; display: inline-block; margin-right:3px;}
                
                .slider-group { display: flex; flex-direction: column; width: 100%; gap: 2px; margin-bottom: 5px;}
                .slider-label { font-size: 8px; color: #555; display:flex; justify-content:space-between; }
                input[type=range].drum-slider { -webkit-appearance: none; width: 100%; background: transparent; height: 8px; }
                input[type=range].drum-slider::-webkit-slider-runnable-track { width: 100%; height: 2px; background: #333; }
                input[type=range].drum-slider::-webkit-slider-thumb { -webkit-appearance: none; height: 8px; width: 5px; background: var(--drum-color); cursor: pointer; margin-top: -3px; }
                .pan-track::-webkit-slider-thumb { background: #ffff00 !important; }

                .drum-compressor-panel { margin-top: 15px; border-top: 1px solid #333; padding-top: 15px; }
                .comp-header { display:flex; justify-content:space-between; align-items:center; }
                .comp-controls { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-top: 10px; }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div class="drum-panel">
                <div class="drum-header-row drum-controls-top">
                    <div style="display:flex; gap:10px;">
                        <select id="select-set" class="drum-select-styled">
                            <option value="">-- Select Set --</option>
                            <option value="Set1">Set 1</option>
                            <option value="Set2">Set 2</option>
                        </select>
                        <button class="btn-drum" id="btn-load-folder" title="Load local folder with JSON and WAVs">LOAD SET</button>
                    </div>
                    
                    <div style="display:flex; align-items:center; gap: 8px; background: rgba(0,255,255,0.1); border: 1px solid var(--drum-color); padding: 5px 10px; border-radius: 4px;">
                        <label for="drum-master-vol" style="font-size: 10px; color: var(--drum-color); font-weight: bold; white-space: nowrap;">MASTER VOL: <span id="lbl-drum-master-vol">${this.drumMaster.gain.value.toFixed(2)}</span></label>
                        <input type="range" id="drum-master-vol" class="drum-slider" min="0" max="2" step="0.05" value="${this.drumMaster.gain.value}" style="width: 80px;">
                    </div>

                    <div style="display:flex; gap:10px;">
                        <button class="btn-drum" id="btn-save-preset" title="Save Layout, WAVs & Settings directly to a folder">SAVE PRESET</button>
                        <button class="btn-drum" id="btn-toggle-keys">KEYS OFF</button>
                        <button class="btn-drum" id="btn-edit-mode">EDIT OFF</button>
                    </div>
                </div>

                <div id="edit-tools" style="display:none; background:#222; padding:10px; font-size:10px; color:#ccc; border-radius:4px; border: 1px dashed #ff00ff;">
                    <div style="margin-bottom: 8px; color:#ff00ff;"><b>EDIT MODE ON:</b> Select a drum to edit its properties, hotkey, or modify layout.</div>
                    
                    <div class="edit-tools-grid">
                        <div style="display:flex; flex-direction:column; gap:8px;">
                            <div class="edit-section">
                                <div class="edit-row">
                                    <label>SELECT:</label>
                                    <select id="select-edit-drum" style="width:120px;"></select>
                                </div>
                                <div style="display:flex; gap:5px; margin-top:5px;">
                                    <button class="btn-drum" id="btn-add-drum" style="flex:1; font-size:9px;">+ ADD DRUM</button>
                                    <button class="btn-drum red" id="btn-del-drum" style="flex:1; font-size:9px;">- DELETE</button>
                                </div>
                            </div>

                            <div class="edit-section">
                                <div class="edit-row"><label>NAME:</label><input type="text" id="edit-name"></div>
                                <div class="edit-row"><label>MIDI NOTE:</label><input type="number" id="edit-midi" min="0" max="127"></div>
                                <div class="edit-row"><label>HOTKEY:</label><input type="text" id="edit-hotkey" maxlength="1" style="width:30px; text-transform:lowercase;"></div>
                                <div class="edit-row">
                                    <label>SHAPE:</label>
                                    <select id="edit-shape">
                                        <option value="circle">Circle</option>
                                        <option value="rect">Rectangle</option>
                                    </select>
                                </div>
                                <div class="edit-row"><label>Z-INDEX:</label><input type="number" id="edit-zindex" min="0" max="100"></div>
                            </div>
                        </div>

                        <div style="display:flex; flex-direction:column; gap:8px;">
                            <div class="edit-section">
                                <div class="edit-row">
                                    <label>WIDTH:</label>
                                    <input type="range" class="drum-slider" id="edit-w" min="20" max="250" style="width:80px;">
                                    <span id="lbl-edit-w" style="width:25px; text-align:right;"></span>
                                </div>
                                <div class="edit-row">
                                    <label>HEIGHT:</label>
                                    <input type="range" class="drum-slider" id="edit-h" min="20" max="250" style="width:80px;">
                                    <span id="lbl-edit-h" style="width:25px; text-align:right;"></span>
                                </div>
                                <button class="btn-drum" id="btn-load-wav" style="margin-top:5px; width:100%;">LOAD WAV (ROUND ROBIN)</button>
                            </div>

                            <div class="edit-section">
                                <div style="display:flex; justify-content:space-between; align-items:center;">
                                    <span style="color:#aaa;">CUSTOM PAD IMAGE:</span>
                                    <div>
                                        <button class="btn-drum" id="btn-load-pad-img" style="font-size:9px;">LOAD</button>
                                        <button class="btn-drum red" id="btn-remove-pad-img" style="font-size:9px;">REMOVE</button>
                                    </div>
                                </div>
                                <div class="edit-row">
                                    <label>SCALE:</label>
                                    <input type="range" class="drum-slider" id="edit-img-scale" min="10" max="300" style="width:80px;">
                                </div>
                                <div class="edit-row">
                                    <label>OFFSET X:</label>
                                    <input type="range" class="drum-slider" id="edit-img-x" min="-100" max="100" style="width:80px;">
                                </div>
                                <div class="edit-row">
                                    <label>OFFSET Y:</label>
                                    <input type="range" class="drum-slider" id="edit-img-y" min="-100" max="100" style="width:80px;">
                                </div>
                            </div>
                        </div>
                    </div>

                    <div style="display:flex; gap:10px; align-items:center; border-top: 1px solid #444; padding-top: 8px; margin-top:8px;">
                        <span style="color:#aaa;">STAGE BACKGROUND:</span>
                        <button class="btn-drum" id="btn-load-bg" style="font-size:9px;">LOAD BG</button>
                        <button class="btn-drum red" id="btn-remove-bg" style="font-size:9px;">REMOVE BG</button>
                        <div style="display:flex; align-items:center; gap: 5px; margin-left: 10px;">
                            <span>Scale:</span>
                            <input type="range" id="bg-scale" min="10" max="300" value="100" style="width:60px;" class="drum-slider">
                        </div>
                    </div>
                </div>

                <div class="drum-kit-stage-container" id="stage-container">
                    <div id="drum-stage-bg"></div>
                    <div id="drum-pads-container"></div>
                </div>

                <div class="drum-mixer" id="drum-mixer-container"></div>

                <div class="drum-compressor-panel">
                    <div class="comp-header">
                        <span style="color:var(--drum-color); font-weight:bold; font-size:11px;">MASTER COMPRESSOR</span>
                        <button class="btn-drum" id="btn-comp-toggle" style="font-size:9px;">OFF</button>
                    </div>
                    <div class="comp-controls">
                        <div class="slider-group">
                            <div class="slider-label"><span>THR</span><span id="lbl-comp-thresh">-20.0</span></div>
                            <input type="range" class="drum-slider" id="comp-thresh" min="-60" max="0" step="1" value="-20">
                        </div>
                        <div class="slider-group">
                            <div class="slider-label"><span>RATIO</span><span id="lbl-comp-ratio">4.0</span></div>
                            <input type="range" class="drum-slider" id="comp-ratio" min="1" max="20" step="0.5" value="4">
                        </div>
                        <div class="slider-group">
                            <div class="slider-label"><span>ATT</span><span id="lbl-comp-att">0.01</span></div>
                            <input type="range" class="drum-slider" id="comp-att" min="0" max="1" step="0.01" value="0.01">
                        </div>
                        <div class="slider-group">
                            <div class="slider-label"><span>REL</span><span id="lbl-comp-rel">0.10</span></div>
                            <input type="range" class="drum-slider" id="comp-rel" min="0.01" max="2" step="0.01" value="0.1">
                        </div>
                    </div>
                </div>
            </div>
            
            <input type="file" id="drum-folder-upload" webkitdirectory directory multiple style="display:none;">
            <input type="file" id="drum-single-upload" accept="audio/*" multiple style="display:none;">
            <input type="file" id="bg-img-upload" accept="image/*" style="display:none;">
            <input type="file" id="pad-img-upload" accept="image/*" style="display:none;">
        `;

        this.bindGlobalEvents();
        this.renderStage();
        this.renderMixer();
        this.populateEditDrumSelect();
        this.updateBgImageUI();
        this.updateCompressorUI();
    }

    bindGlobalEvents() {
        const c = this.containerElement;
        
        c.querySelector('#drum-master-vol').addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            this.drumMaster.gain.setTargetAtTime(val, this.ctx.currentTime, 0.05);
            c.querySelector('#lbl-drum-master-vol').innerText = val.toFixed(2);
        });

        c.querySelector('#select-set').addEventListener('change', (e) => { if (e.target.value) this.fetchSet(e.target.value); });
        const folderUpload = c.querySelector('#drum-folder-upload');
        c.querySelector('#btn-load-folder').addEventListener('click', () => folderUpload.click());
        folderUpload.addEventListener('change', (e) => this.handleFolderUpload(e.target.files));

        c.querySelector('#btn-save-preset').addEventListener('click', () => this.exportPreset());

        const btnEdit = c.querySelector('#btn-edit-mode');
        const btnKeys = c.querySelector('#btn-toggle-keys');
        const editTools = c.querySelector('#edit-tools');
        const stageContainer = c.querySelector('#stage-container');
        const padsContainer = c.querySelector('#drum-pads-container');

        // Edit Mode Toggle
        btnEdit.addEventListener('click', () => {
            this.isEditMode = !this.isEditMode;
            btnEdit.innerText = this.isEditMode ? "EDIT ON" : "EDIT OFF";
            btnEdit.className = this.isEditMode ? "btn-drum active-edit" : "btn-drum";
            editTools.style.display = this.isEditMode ? "block" : "none";
            stageContainer.classList.toggle('edit-mode', this.isEditMode);
            
            if(!this.isEditMode) this.activeEditMidi = null; 
            this.updateEditPanel();
            for(let m in this.drums) this.applyVisualsToDrum(m);
        });

        // Keys Mode Toggle
        btnKeys.addEventListener('click', () => {
            this.keysEnabled = !this.keysEnabled;
            btnKeys.innerText = this.keysEnabled ? "KEYS ON" : "KEYS OFF";
            btnKeys.className = this.keysEnabled ? "btn-drum active-keys" : "btn-drum";
            stageContainer.classList.toggle('show-keys', this.keysEnabled);
        });

        c.querySelector('#select-edit-drum').addEventListener('change', (e) => {
            this.activeEditMidi = e.target.value;
            this.updateEditPanel();
            for(let m in this.drums) this.applyVisualsToDrum(m);
        });

        c.querySelector('#btn-add-drum').addEventListener('click', () => {
            let newMidi = 35;
            while(this.drums[newMidi]) newMidi++;
            
            this.drums[newMidi] = {
                id: `new_${newMidi}`, name: `NEW ${newMidi}`, fileMatch: '',
                buffers: [], assignedFiles: [], rrIndex: 0, vol: 1.0, pitch: 1.0, pan: 0.0,
                x: 150, y: 150, w: 60, h: 60, shape: 'circle', zIndex: 10,
                imgSrc: '', imgScale: 100, imgX: 0, imgY: 0, hotkey: ''
            };
            this.activeEditMidi = newMidi;
            this.renderStage();
            this.renderMixer();
            this.populateEditDrumSelect();
            this.updateEditPanel();
        });

        c.querySelector('#btn-del-drum').addEventListener('click', () => {
            if(this.activeEditMidi && this.drums[this.activeEditMidi]) {
                delete this.drums[this.activeEditMidi];
                this.activeEditMidi = null;
                this.renderStage();
                this.renderMixer();
                this.populateEditDrumSelect();
                this.updateEditPanel();
            }
        });

        const updateActiveProp = (prop, val, parseFunc = (x)=>x) => {
            if(this.activeEditMidi && this.drums[this.activeEditMidi]) {
                this.drums[this.activeEditMidi][prop] = parseFunc(val);
                this.applyVisualsToDrum(this.activeEditMidi);
                if(prop === 'name') { this.populateEditDrumSelect(); this.renderMixer(); }
            }
        };

        c.querySelector('#edit-name').addEventListener('input', (e) => updateActiveProp('name', e.target.value));
        c.querySelector('#edit-shape').addEventListener('change', (e) => updateActiveProp('shape', e.target.value));
        c.querySelector('#edit-zindex').addEventListener('input', (e) => updateActiveProp('zIndex', e.target.value, parseInt));
        
        c.querySelector('#edit-hotkey').addEventListener('input', (e) => {
            updateActiveProp('hotkey', e.target.value.toLowerCase());
        });

        const wSlider = c.querySelector('#edit-w');
        wSlider.addEventListener('input', (e) => { updateActiveProp('w', e.target.value, parseInt); c.querySelector('#lbl-edit-w').innerText = e.target.value; });
        const hSlider = c.querySelector('#edit-h');
        hSlider.addEventListener('input', (e) => { updateActiveProp('h', e.target.value, parseInt); c.querySelector('#lbl-edit-h').innerText = e.target.value; });

        c.querySelector('#edit-img-scale').addEventListener('input', (e) => updateActiveProp('imgScale', e.target.value, parseInt));
        c.querySelector('#edit-img-x').addEventListener('input', (e) => updateActiveProp('imgX', e.target.value, parseInt));
        c.querySelector('#edit-img-y').addEventListener('input', (e) => updateActiveProp('imgY', e.target.value, parseInt));

        c.querySelector('#edit-midi').addEventListener('change', (e) => {
            if(!this.activeEditMidi) return;
            const newMidi = parseInt(e.target.value);
            const oldMidi = this.activeEditMidi;
            
            if(newMidi == oldMidi) return;
            if(this.drums[newMidi]) {
                alert(`MIDI note ${newMidi} is already in use by ${this.drums[newMidi].name}!`);
                e.target.value = oldMidi;
                return;
            }

            this.drums[newMidi] = this.drums[oldMidi];
            delete this.drums[oldMidi];
            this.activeEditMidi = newMidi;
            
            this.renderStage();
            this.renderMixer();
            this.populateEditDrumSelect();
            this.updateEditPanel();
        });

        const singleUpload = c.querySelector('#drum-single-upload');
        c.querySelector('#btn-load-wav').addEventListener('click', () => { if(this.activeEditMidi) singleUpload.click(); });
        singleUpload.addEventListener('change', async (e) => {
            if (this.activeEditMidi && e.target.files.length > 0) {
                this.drums[this.activeEditMidi].buffers = [];
                this.drums[this.activeEditMidi].assignedFiles = [];
                for (let i = 0; i < e.target.files.length; i++) {
                    await this.processSingleFileForDrum(this.activeEditMidi, e.target.files[i], true);
                    this.drums[this.activeEditMidi].assignedFiles.push(e.target.files[i].name);
                }
            }
            e.target.value = '';
        });

        const padImgUpload = c.querySelector('#pad-img-upload');
        c.querySelector('#btn-load-pad-img').addEventListener('click', () => { if(this.activeEditMidi) padImgUpload.click(); });
        padImgUpload.addEventListener('change', (e) => {
            if(this.activeEditMidi && e.target.files[0]) {
                const reader = new FileReader();
                reader.onload = (ev) => { 
                    this.drums[this.activeEditMidi].imgSrc = ev.target.result;
                    this.applyVisualsToDrum(this.activeEditMidi);
                };
                reader.readAsDataURL(e.target.files[0]);
            }
            e.target.value = '';
        });
        c.querySelector('#btn-remove-pad-img').addEventListener('click', () => {
            if(this.activeEditMidi && this.drums[this.activeEditMidi]) {
                this.drums[this.activeEditMidi].imgSrc = '';
                this.applyVisualsToDrum(this.activeEditMidi);
            }
        });

        const bgUploadInput = c.querySelector('#bg-img-upload');
        c.querySelector('#btn-load-bg').addEventListener('click', () => bgUploadInput.click());
        bgUploadInput.addEventListener('change', (e) => {
            if(e.target.files[0]) {
                const reader = new FileReader();
                reader.onload = (ev) => { 
                    this.bgConfig.src = ev.target.result; this.bgConfig.x = 0; this.bgConfig.y = 0; 
                    this.updateBgImageUI(); 
                };
                reader.readAsDataURL(e.target.files[0]);
            }
            e.target.value = '';
        });
        c.querySelector('#btn-remove-bg').addEventListener('click', () => {
            this.bgConfig.src = '';
            this.updateBgImageUI();
        });

        c.querySelector('#bg-scale').addEventListener('input', (e) => { this.bgConfig.scale = e.target.value; this.updateBgImageUI(); });

        // Compressor Events
        c.querySelector('#btn-comp-toggle').addEventListener('click', () => {
            this.isCompOn = !this.isCompOn;
            this.compActive.gain.value = this.isCompOn ? 1.0 : 0.0;
            this.compBypass.gain.value = this.isCompOn ? 0.0 : 1.0;
            this.updateCompressorUI();
        });

        const bindCompParam = (id, nodeParam, isFloat=false) => {
            c.querySelector(`#comp-${id}`).addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                nodeParam.value = val;
                c.querySelector(`#lbl-comp-${id}`).innerText = val.toFixed(isFloat ? 2 : 1);
            });
        };
        
        bindCompParam('thresh', this.compressor.threshold, false);
        bindCompParam('ratio', this.compressor.ratio, false);
        bindCompParam('att', this.compressor.attack, true);
        bindCompParam('rel', this.compressor.release, true);

        // Näppäimistösoitto (Toimii vain jos keysEnabled on tosi)
        window.addEventListener('keydown', (e) => {
            if (!this.keysEnabled) return;
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.repeat) return;
            const key = e.key.toLowerCase();
            for (const midi in this.drums) {
                if (this.drums[midi].hotkey === key) {
                    if (this.ctx.state === 'suspended') this.ctx.resume();
                    this.triggerDrum(midi, 100, false);
                }
            }
        });

        // Drag logic
        let draggingEl = null, draggingBg = false;
        let startX = 0, startY = 0, startLeft, startTop, startBgX = 0, startBgY = 0;
        let wasDragging = false; 

        stageContainer.addEventListener('mousedown', (e) => {
            if (!this.isEditMode) return;
            if (e.target === stageContainer || e.target.id === 'drum-stage-bg' || e.target.id === 'drum-pads-container') {
                draggingBg = true;
                startX = e.clientX; startY = e.clientY;
                startBgX = this.bgConfig.x; startBgY = this.bgConfig.y;
                e.preventDefault();
            }
        });

        padsContainer.addEventListener('mousedown', (e) => {
            const piece = e.target.closest('.drum-piece');
            if(piece && this.isEditMode) {
                wasDragging = false;
                draggingEl = piece;
                startX = e.clientX; startY = e.clientY;
                startLeft = piece.offsetLeft; startTop = piece.offsetTop;
                e.preventDefault();
                e.stopPropagation();
            }
        });

        padsContainer.addEventListener('click', (e) => {
            const piece = e.target.closest('.drum-piece');
            if(!piece) return;
            const midi = piece.getAttribute('data-midi');
            
            if (this.isEditMode) {
                if(!wasDragging) {
                    this.activeEditMidi = midi;
                    this.updateEditPanel();
                    for(let m in this.drums) this.applyVisualsToDrum(m); 
                }
            } else {
                if (this.ctx.state === 'suspended') this.ctx.resume();
                this.triggerDrum(midi, 100, false);
            }
        });

        window.addEventListener('mousemove', (e) => {
            if(!this.isEditMode) return;
            if (draggingBg) {
                this.bgConfig.x = startBgX + (e.clientX - startX);
                this.bgConfig.y = startBgY + (e.clientY - startY);
                this.updateBgImageUI();
            } else if (draggingEl) {
                wasDragging = true;
                const dx = e.clientX - startX; const dy = e.clientY - startY;
                draggingEl.style.left = `${startLeft + dx}px`;
                draggingEl.style.top = `${startTop + dy}px`;
            }
        });

        window.addEventListener('mouseup', () => {
            if (draggingBg) draggingBg = false;
            if (draggingEl) { 
                const midi = draggingEl.getAttribute('data-midi');
                if(this.drums[midi]) {
                    this.drums[midi].x = parseInt(draggingEl.style.left) || 0;
                    this.drums[midi].y = parseInt(draggingEl.style.top) || 0;
                }
                draggingEl = null; 
            }
        });
    }

    populateEditDrumSelect() {
        const sel = this.containerElement.querySelector('#select-edit-drum');
        if(!sel) return;
        sel.innerHTML = '<option value="">-- None --</option>';
        
        const sortedMidis = Object.keys(this.drums).sort((a,b) => parseInt(a) - parseInt(b));
        
        for(let midi of sortedMidis) {
            const opt = document.createElement('option');
            opt.value = midi;
            opt.innerText = `[${midi}] ${this.drums[midi].name}`;
            sel.appendChild(opt);
        }
        if(this.activeEditMidi && this.drums[this.activeEditMidi]) sel.value = this.activeEditMidi;
    }

    updateEditPanel() {
        const c = this.containerElement;
        if(!c) return;
        
        if(!this.activeEditMidi || !this.drums[this.activeEditMidi]) {
            c.querySelector('#select-edit-drum').value = "";
            c.querySelectorAll('#edit-tools input, #edit-tools select:not(#select-edit-drum)').forEach(el => el.disabled = true);
            c.querySelectorAll('#edit-tools button:not(#btn-add-drum):not(#btn-load-bg):not(#btn-remove-bg)').forEach(el => el.disabled = true);
            return;
        }

        c.querySelectorAll('#edit-tools input, #edit-tools select, #edit-tools button').forEach(el => el.disabled = false);
        
        const d = this.drums[this.activeEditMidi];
        c.querySelector('#select-edit-drum').value = this.activeEditMidi;
        c.querySelector('#edit-name').value = d.name;
        c.querySelector('#edit-midi').value = this.activeEditMidi;
        c.querySelector('#edit-shape').value = d.shape;
        c.querySelector('#edit-zindex').value = d.zIndex || 10;
        c.querySelector('#edit-hotkey').value = d.hotkey || '';
        
        c.querySelector('#edit-w').value = d.w; c.querySelector('#lbl-edit-w').innerText = d.w;
        c.querySelector('#edit-h').value = d.h; c.querySelector('#lbl-edit-h').innerText = d.h;
        
        c.querySelector('#edit-img-scale').value = d.imgScale || 100;
        c.querySelector('#edit-img-x').value = d.imgX || 0;
        c.querySelector('#edit-img-y').value = d.imgY || 0;
    }

    renderStage() {
        if(!this.containerElement) return;
        const padsContainer = this.containerElement.querySelector('#drum-pads-container');
        padsContainer.innerHTML = '';
        this.drumElements = {};

        for (const [midi, data] of Object.entries(this.drums)) {
            const el = document.createElement('div');
            el.setAttribute('data-midi', midi);
            padsContainer.appendChild(el);
            this.drumElements[midi] = el;
            this.applyVisualsToDrum(midi);
        }
    }

    renderMixer() {
        if(!this.containerElement) return;
        const mixerContainer = this.containerElement.querySelector('#drum-mixer-container');
        mixerContainer.innerHTML = '';
        
        const sortedMidis = Object.keys(this.drums).sort((a,b) => parseInt(a) - parseInt(b));

        for(const midi of sortedMidis) {
            const data = this.drums[midi];
            const chDiv = document.createElement('div');
            chDiv.className = 'mixer-channel';
            
            chDiv.innerHTML = `
                <div class="ch-title" title="${data.name}"><div class="ch-status" id="status-${midi}"></div>${data.name}</div>
                <div class="slider-group"><div class="slider-label"><span>V</span><span id="lbl-vol-${midi}">${data.vol.toFixed(1)}</span></div><input type="range" class="drum-slider vol-track" id="vol-${midi}" min="0" max="2" step="0.05" value="${data.vol}"></div>
                <div class="slider-group"><div class="slider-label"><span>P</span><span id="lbl-pitch-${midi}">${data.pitch.toFixed(2)}</span></div><input type="range" class="drum-slider pitch-track" id="pitch-${midi}" min="0.5" max="2" step="0.01" value="${data.pitch}"></div>
                <div class="slider-group"><div class="slider-label"><span>L/R</span><span id="lbl-pan-${midi}">${data.pan.toFixed(1)}</span></div><input type="range" class="drum-slider pan-track" id="pan-${midi}" min="-1" max="1" step="0.1" value="${data.pan}"></div>
            `;
            mixerContainer.appendChild(chDiv);

            chDiv.querySelector(`#vol-${midi}`).addEventListener('input', (e) => {
                const val = parseFloat(e.target.value); this.drums[midi].vol = val;
                chDiv.querySelector(`#lbl-vol-${midi}`).innerText = val.toFixed(1);
            });
            chDiv.querySelector(`#pitch-${midi}`).addEventListener('input', (e) => {
                const val = parseFloat(e.target.value); this.drums[midi].pitch = val;
                chDiv.querySelector(`#lbl-pitch-${midi}`).innerText = val.toFixed(2);
            });
            chDiv.querySelector(`#pan-${midi}`).addEventListener('input', (e) => {
                const val = parseFloat(e.target.value); this.drums[midi].pan = val;
                chDiv.querySelector(`#lbl-pan-${midi}`).innerText = val.toFixed(1);
            });
            
            this.updateVisualState(midi);
        }
    }
};
