// audiosynth.js
// Vokalistinen Syntetisaattori & Sampleri (WAV) graafisella ADSR-verhokäyrällä ja saumattomalla looppauksella.
// Päivitetty: Graafinen audion threshold (limit-comp-gate tyyliin) ja Legato Speed.

window.CustomAudioEffect = class AudioSynthEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        
        // Reititys
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.dry = audioCtx.createGain();
        this.wet = audioCtx.createGain();

        // Analysaattori graafista Thresholdia varten
        this.analyser = audioCtx.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyser.smoothingTimeConstant = 0.5;

        this.input.connect(this.analyser);
        this.input.connect(this.dry);
        this.dry.connect(this.output);
        this.wet.connect(this.output);

        // Yleisasetukset
        this.mix = 1.0; 
        
        // Äänilähteen asetukset
        this.mode = 'osc'; // 'osc' tai 'sampler'
        this.waveform = 'sawtooth';
        
        // Sampler asetukset
        this.originalBuffer = null;
        this.processedBuffer = null;
        this.loopStart = 0.4;
        this.loopEnd = 1.4;
        this.loopFade = 0.1; // sekuntia

        // ADSR & Synteesi
        this.adsr = {
            a: 0.05,
            d: 0.3, 
            s: 0.7, 
            r: 0.5  
        };
        
        // UUDET OMINAISUUDET
        this.legato = 0.05; // Portamento / Legato speed (sekuntia)
        this.thresholdDb = -40; // Pitch detectorin alaraja

        // Aktiiviset oskillaattorit / samplet (Yksittäinen ääni legatoa varten)
        this.activeVoices = new Map();

        // UI-referenssit
        this.knobs = {};
        this.uiElements = {};

        this.updateMix();
        this._initWorklet();
    }

    updateMix() {
        this.dry.gain.setTargetAtTime(Math.cos(this.mix * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
        this.wet.gain.setTargetAtTime(Math.sin(this.mix * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
    }

    killAllNotes() {
        this.activeVoices.forEach((voice, note) => {
            try {
                voice.vca.gain.cancelScheduledValues(this.ctx.currentTime);
                voice.vca.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
                voice.source.stop(this.ctx.currentTime + 0.1);
            } catch (e) { }
        });
        this.activeVoices.clear();
        this.updateUI({ action: 'noteOff' }); 
        
        if (this.worklet) {
            this.worklet.port.postMessage({ type: 'panic' });
        }
    }

    updateThreshold() {
        if (this.worklet) {
            // Muutetaan dB lineaariseksi
            const linearThresh = Math.pow(10, this.thresholdDb / 20);
            this.worklet.port.postMessage({ type: 'setThreshold', value: linearThresh });
        }
    }

    async _initWorklet() {
        const workletCode = `
            class AudioSynthProcessor extends AudioWorkletProcessor {
                constructor() {
                    super();
                    this.bufferSize = 8192;
                    this.buffer = new Float32Array(this.bufferSize);
                    this.writePos = 0;
                    
                    this.currentNote = -1;
                    this.stableFrames = 0;
                    this.silenceFrames = 0;
                    
                    this.confidenceThreshold = 0.4;
                    this.rmsThreshold = 0.01; // Oletus

                    this.port.onmessage = (e) => {
                        if (e.data.type === 'panic') {
                            this.currentNote = -1;
                            this.stableFrames = 0;
                            this.silenceFrames = 0;
                            this.buffer.fill(0);
                        } else if (e.data.type === 'setThreshold') {
                            this.rmsThreshold = e.data.value;
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
                    const minPeriod = Math.floor(sampleRate / 1000); 
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

                    if (confidence > this.confidenceThreshold) {
                        return { hz: sampleRate / bestPeriod, rms };
                    }
                    return { hz: 0, rms };
                }

                hzToMidi(hz) { return 69 + 12 * Math.log2(hz / 440); }

                process(inputs, outputs) {
                    const input = inputs[0];
                    
                    if (!input || !input.length || !input[0]) return true;

                    const inChannel = input[0];
                    for (let i = 0; i < inChannel.length; i++) {
                        this.buffer[this.writePos] = inChannel[i];
                        this.writePos = (this.writePos + 1) % this.bufferSize;
                    }

                    const { hz, rms } = this.detectPitch();

                    if (hz > 0) {
                        this.silenceFrames = 0;
                        const targetMidi = Math.round(this.hzToMidi(hz));
                        
                        if (targetMidi !== this.currentNote) {
                            this.stableFrames++;
                            if (this.stableFrames >= 3) { 
                                // HUOM: Emme lähetä noteOffia täällä, jotta Legato onnistuu!
                                const velocity = Math.min(127, Math.floor((rms * 10) * 127));
                                this.port.postMessage({ type: 'midi', action: 'noteOn', note: targetMidi, velocity: velocity || 100 });
                                this.currentNote = targetMidi;
                                this.stableFrames = 0;
                            }
                        } else {
                            this.stableFrames = 0;
                        }
                    } else {
                        this.silenceFrames++;
                        this.stableFrames = 0;
                        // Katkaistaan ääni vasta kun on täyttä hiljaisuutta tarpeeksi pitkään
                        if (this.silenceFrames >= 5 && this.currentNote !== -1) {
                            this.port.postMessage({ type: 'midi', action: 'noteOff', note: this.currentNote });
                            this.currentNote = -1;
                        }
                    }
                    return true;
                }
            }
            registerProcessor('audiosynth-processor', AudioSynthProcessor);
        `;

        const dataUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(workletCode);
        try {
            await this.ctx.audioWorklet.addModule(dataUrl);
            this.worklet = new AudioWorkletNode(this.ctx, 'audiosynth-processor');
            this.updateThreshold();
            this.worklet.port.onmessage = (e) => {
                if (e.data.type === 'midi') {
                    if (e.data.action === 'noteOn') this.noteOn(e.data.note, e.data.velocity);
                    else if (e.data.action === 'noteOff') this.noteOff(e.data.note);
                    this.updateUI(e.data);
                }
            };
            this.input.connect(this.worklet);
        } catch (e) {
            console.error("AudioSynth Worklet load failed:", e);
        }
    }

    // --- SAMPLER LOGIIKKA (Saumaton luuppi crossfadella) ---

    async loadWavFile(file) {
        try {
            const arrayBuffer = await file.arrayBuffer();
            this.originalBuffer = await this.ctx.decodeAudioData(arrayBuffer);
            this.mode = 'sampler';
            this.processLoopBuffer();
            this.updateWaveformUI();
        } catch (e) {
            console.error("Virhe ladattaessa WAV-tiedostoa:", e);
        }
    }

    processLoopBuffer() {
        if (!this.originalBuffer) return;
        
        const sr = this.originalBuffer.sampleRate;
        const startSample = Math.floor(this.loopStart * sr);
        const endSample = Math.floor(this.loopEnd * sr);
        let fadeSamples = Math.floor(this.loopFade * sr);

        if (endSample <= startSample || startSample >= this.originalBuffer.length) {
            this.processedBuffer = this.originalBuffer;
            return;
        }
        if (fadeSamples > startSample) fadeSamples = startSample;
        if (fadeSamples > (endSample - startSample)) fadeSamples = endSample - startSample;

        const newBuf = this.ctx.createBuffer(this.originalBuffer.numberOfChannels, this.originalBuffer.length, sr);

        for (let c = 0; c < this.originalBuffer.numberOfChannels; c++) {
            const inData = this.originalBuffer.getChannelData(c);
            const outData = newBuf.getChannelData(c);
            outData.set(inData);

            for (let i = 0; i < fadeSamples; i++) {
                const t = i / fadeSamples;
                const outIdx = endSample - fadeSamples + i;
                const inIdx = startSample - fadeSamples + i;
                outData[outIdx] = inData[outIdx] * (1 - t) + inData[inIdx] * t;
            }
        }
        this.processedBuffer = newBuf;
    }

    // --- SYNTETISAATTORI LOGIIKKA ---

    midiToHz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }
    
    noteOn(note, velocity) {
        const now = this.ctx.currentTime;

        // Etsi onko aiempi ääni jo soimassa (Legatoa varten)
        let activeVoice = null;
        let activeNote = null;
        for (const [n, v] of this.activeVoices.entries()) {
            activeVoice = v;
            activeNote = n;
            break; // Oletetaan monofoninen synteesi
        }

        if (activeVoice && this.legato > 0.001) {
            // LEGATO GLIDE
            if (this.mode === 'sampler' && this.processedBuffer) {
                const rootNote = 60; 
                activeVoice.source.playbackRate.setTargetAtTime(Math.pow(2, (note - rootNote) / 12), now, this.legato);
            } else {
                activeVoice.source.frequency.setTargetAtTime(this.midiToHz(note), now, this.legato);
            }
            
            // Päivitä Map vastaamaan uutta nuottia jotta noteOff löytää sen
            this.activeVoices.delete(activeNote);
            this.activeVoices.set(note, activeVoice);
            return; // Ei luoda uutta envelopea
        }

        // Ei Legatoa tai uusi ääni
        if (activeVoice) {
            this.noteOff(activeNote);
        }

        let source;
        if (this.mode === 'sampler' && this.processedBuffer) {
            source = this.ctx.createBufferSource();
            source.buffer = this.processedBuffer;
            source.loop = true;
            source.loopStart = this.loopStart;
            source.loopEnd = this.loopEnd;
            const rootNote = 60; 
            source.playbackRate.value = Math.pow(2, (note - rootNote) / 12);
        } else {
            source = this.ctx.createOscillator();
            source.type = this.waveform;
            source.frequency.setValueAtTime(this.midiToHz(note), now);
        }

        const vca = this.ctx.createGain();
        vca.gain.setValueAtTime(0, now);
        
        const peak = (velocity / 127) * 0.4;
        const sustainLevel = peak * this.adsr.s;
        
        vca.gain.linearRampToValueAtTime(peak, now + this.adsr.a);
        vca.gain.linearRampToValueAtTime(sustainLevel, now + this.adsr.a + this.adsr.d);
        
        source.connect(vca);
        vca.connect(this.wet); 
        
        source.start();
        this.activeVoices.set(note, { source, vca });
    }

    noteOff(note) {
        if (!this.activeVoices.has(note)) return;
        const voice = this.activeVoices.get(note);
        const now = this.ctx.currentTime;
        
        voice.vca.gain.cancelScheduledValues(now);
        voice.vca.gain.setTargetAtTime(0, now, this.adsr.r / 3); 
        
        voice.source.stop(now + this.adsr.r + 0.1);
        this.activeVoices.delete(note);
    }

    getNodes() { return { input: this.input, output: this.output }; }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            mix: this.mix, mode: this.mode, waveform: this.waveform,
            loopStart: this.loopStart, loopEnd: this.loopEnd, loopFade: this.loopFade,
            adsr: { ...this.adsr }, legato: this.legato, thresholdDb: this.thresholdDb
        };
    }

    setState(state) {
        if (!state) return;
        if (state.mix !== undefined) { this.mix = state.mix; this.updateMix(); if (this.knobs['mix']) this.knobs['mix'].setValue(this.mix); }
        if (state.mode !== undefined) this.mode = state.mode;
        if (state.waveform !== undefined) this.waveform = state.waveform;
        if (state.loopStart !== undefined) { this.loopStart = state.loopStart; if (this.uiElements.loopStart) this.uiElements.loopStart.value = this.loopStart; }
        if (state.loopEnd !== undefined) { this.loopEnd = state.loopEnd; if (this.uiElements.loopEnd) this.uiElements.loopEnd.value = this.loopEnd; }
        if (state.loopFade !== undefined) { this.loopFade = state.loopFade; if (this.knobs['loopFade']) this.knobs['loopFade'].setValue(this.loopFade); }
        if (state.legato !== undefined) { this.legato = state.legato; if (this.knobs['legato']) this.knobs['legato'].setValue(this.legato); }
        if (state.thresholdDb !== undefined) { this.thresholdDb = state.thresholdDb; this.updateThreshold(); if (this.knobs['thresh']) this.knobs['thresh'].setValue(this.thresholdDb); }
        
        if (state.adsr) {
            if (state.adsr.a !== undefined) { this.adsr.a = state.adsr.a; if(this.knobs['att']) this.knobs['att'].setValue(this.adsr.a); }
            if (state.adsr.d !== undefined) { this.adsr.d = state.adsr.d; if(this.knobs['dec']) this.knobs['dec'].setValue(this.adsr.d); }
            if (state.adsr.s !== undefined) { this.adsr.s = state.adsr.s; if(this.knobs['sus']) this.knobs['sus'].setValue(this.adsr.s); }
            if (state.adsr.r !== undefined) { this.adsr.r = state.adsr.r; if(this.knobs['rel']) this.knobs['rel'].setValue(this.adsr.r); }
            this.drawADSR();
        }
        if (this.mode === 'sampler') this.processLoopBuffer();
        this.updateWaveformUI();
    }

    // --- KÄYTTÖLIITTYMÄ ---

    midiToNoteName(midi) {
        const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
        return `${notes[midi % 12]}${Math.floor(midi / 12) - 1}`;
    }

    updateUI(midiData) {
        if (!this.displayElement) return;
        if (midiData.action === 'noteOn') {
            this.displayElement.innerText = this.midiToNoteName(midiData.note);
            this.displayElement.style.color = '#00ffff';
            this.displayElement.style.textShadow = '0 0 15px #00ffff';
        } else if (midiData.action === 'noteOff') {
            this.displayElement.innerText = "-";
            this.displayElement.style.color = '#555';
            this.displayElement.style.textShadow = 'none';
        }
    }

    updateWaveformUI() {
        if (!this.uiElements.waveBtns || !this.uiElements.loadWavBtn) return;
        this.uiElements.waveBtns.forEach(btn => btn.classList.remove('active'));
        this.uiElements.loadWavBtn.classList.remove('active');
        if (this.mode === 'osc') {
            this.uiElements.waveBtns.forEach(btn => {
                if (btn.getAttribute('data-wave') === this.waveform) btn.classList.add('active');
            });
        } else if (this.mode === 'sampler') {
            this.uiElements.loadWavBtn.classList.add('active');
        }
    }

    drawADSR() {
        if (!this.adsrCanvas) return;
        const ctx = this.adsrCanvas.getContext('2d');
        const w = this.adsrCanvas.width, h = this.adsrCanvas.height;
        ctx.clearRect(0, 0, w, h);
        const maxA = 2.0, maxD = 2.0, maxR = 3.0, susWidth = 1.0;
        const totalVisTime = maxA + maxD + susWidth + maxR;
        const pxPerSec = w / totalVisTime;
        
        const aX = this.adsr.a * pxPerSec;
        const dX = aX + (this.adsr.d * pxPerSec);
        const sX = dX + (susWidth * pxPerSec);
        const rX = sX + (this.adsr.r * pxPerSec);
        const sY = h - (this.adsr.s * h * 0.9); 
        const startY = h;

        ctx.strokeStyle = '#222'; ctx.lineWidth = 1; ctx.beginPath();
        for(let i=1; i<4; i++) { ctx.moveTo(0, h * (i/4)); ctx.lineTo(w, h * (i/4)); }
        ctx.stroke();

        ctx.strokeStyle = '#00ffff'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.beginPath();
        ctx.moveTo(0, startY); ctx.lineTo(aX, h * 0.1); ctx.lineTo(dX, sY); ctx.lineTo(sX, sY); ctx.lineTo(rX, startY);       
        ctx.lineTo(0, startY); ctx.fillStyle = 'rgba(0, 255, 255, 0.15)'; ctx.fill(); ctx.stroke();
    }

    renderUI(containerElement) {
        const color = '#00ffff';
        containerElement.style.setProperty('--fx-color', color);

        const styleId = 'fx-audiosynth-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .synth-panel { background: #111; padding: 15px; border-radius: 8px; border: 1px solid #333; display: flex; flex-direction: column; gap: 15px; box-shadow: inset 0 0 20px rgba(0,0,0,0.5);}
                .synth-row { display: flex; justify-content: space-between; align-items: center; gap: 15px; flex-wrap: wrap; }
                
                .synth-wave-btns { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 100px;}
                .btn-source { background: #0a0a0a; border: 1px solid var(--fx-color); color: var(--fx-color); cursor: pointer; padding: 8px; border-radius: 4px; font-family: monospace; font-weight: bold; font-size: 11px; letter-spacing: 1px; transition: all 0.2s; text-align: center; }
                .btn-source:hover { background: rgba(0, 255, 255, 0.1); }
                .btn-source.active { background: var(--fx-color); color: #000; box-shadow: 0 0 15px var(--fx-color); }
                
                .btn-panic { background: #1a0000; border: 1px solid #ff003c; color: #ff003c; cursor: pointer; padding: 10px 15px; border-radius: 6px; font-family: monospace; font-weight: bold; font-size: 13px; text-transform: uppercase; letter-spacing: 2px; }
                .btn-panic:active { background: #ff003c; color: #fff; }
                
                .synth-display-box { display: flex; flex-direction: column; align-items: center; justify-content: center; background: #050505; border: 1px solid rgba(0,255,255,0.3); border-radius: 8px; padding: 10px; min-width: 120px; height: 80px; box-shadow: inset 0 0 20px rgba(0,0,0,0.8);}
                
                .adsr-container { display: flex; flex-direction: column; gap: 15px; border: 1px solid #222; padding: 15px; border-radius: 8px; background: #0d0d0d; }
                .adsr-knobs { display: flex; flex-direction: row; flex-wrap: nowrap; justify-content: space-evenly; align-items: flex-end; gap: 10px; width: 100%; }
                
                .sampler-controls { display: flex; align-items: center; gap: 10px; border: 1px solid #333; padding: 10px; border-radius: 6px; background: #0d0d0d; flex-wrap: wrap;}
                .input-group { display: flex; flex-direction: column; gap: 4px;}
                .input-group label { font-size: 9px; color: #888; text-transform: uppercase; font-family: monospace;}
                .input-group input[type="number"] { width: 50px; background: #000; border: 1px solid #555; color: #fff; padding: 4px; border-radius: 3px; font-family: monospace; font-size: 11px; text-align: center;}
                
                .knob-container { display: flex; flex-direction: column; align-items: center; user-select: none; width: 50px; }
                .knob-wrapper { position: relative; width: 40px; height: 40px; cursor: ns-resize; margin-bottom: 5px; touch-action: none; }
                .knob-svg { width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 3px rgba(0,255,255,0.2));}
                .knob-track { fill: none; stroke: #222; stroke-width: 6; stroke-linecap: round; }
                .knob-value-path { fill: none; stroke: var(--fx-color); stroke-width: 6; stroke-linecap: round; transition: stroke 0.2s; }
                .knob-center { fill: #111; stroke: #333; stroke-width: 1.5; }
                .knob-indicator { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
                .knob-dot { position: absolute; width: 4px; height: 4px; background: var(--fx-color); border-radius: 50%; top: 4px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 5px var(--fx-color);}
                .knob-label { font-size: 9px; color: #8b8b9f; margin-bottom: 3px; text-align: center; font-family: monospace;}
                .knob-value-display { font-size: 9px; font-family: monospace; color: #ccc; background: #000; padding: 2px 5px; border-radius: 3px; border: 1px solid #333; }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div style="margin-bottom: 15px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 4px; font-size: 14px; text-shadow: 0 0 10px rgba(0,255,255,0.5);">AUDIO SYNTH / SAMPLER</div>
            
            <div class="synth-panel">
                <!-- Rivi 1: Input & Pitch Detect -->
                <div class="synth-row" style="align-items:stretch;">
                    <div style="flex:1; min-width: 250px; background:#050505; border: 1px solid #333; border-radius:4px; padding: 10px; position:relative;">
                        <div style="font-size: 9px; color: #8b8b9f; margin-bottom: 5px; font-family: monospace;">INPUT AUDIO DETECTOR</div>
                        <canvas id="synth-thresh-canvas" style="width:100%; height:60px; background:#000; display:block; border-radius:2px;"></canvas>
                    </div>
                    <div style="display:flex; gap:10px;">
                        <div id="thresh-knob-area"></div>
                        <div id="legato-knob-area"></div>
                    </div>
                    <div style="display:flex; flex-direction:column; align-items:center; gap: 5px;">
                        <div class="synth-display-box" style="height: 60px;">
                            <div style="font-size: 10px; color: #8b8b9f; margin-bottom: 2px; font-family: monospace;">PITCH</div>
                            <div id="synth-note-display" style="font-family: monospace; font-size: 30px; font-weight: bold; color: #555;">-</div>
                        </div>
                        <button class="btn-panic" id="synth-panic-btn" style="padding: 6px; font-size: 10px; width: 100%;">KILL</button>
                    </div>
                </div>

                <!-- Rivi 2: Lähteet -->
                <div class="synth-row" style="justify-content: flex-start; padding: 10px; background: #0a0a0a; border: 1px solid #222; border-radius: 6px;">
                    <div class="synth-wave-btns" style="flex-direction:row; flex:none;">
                        <button class="btn-source ${this.mode === 'osc' && this.waveform === 'sawtooth' ? 'active' : ''}" data-wave="sawtooth">SAW</button>
                        <button class="btn-source ${this.mode === 'osc' && this.waveform === 'square' ? 'active' : ''}" data-wave="square">SQUARE</button>
                    </div>
                    <div style="width:1px; background:#333; height: 30px; margin: 0 10px;"></div>
                    <input type="file" id="wav-upload" accept="audio/wav,audio/mp3" style="display:none;">
                    <button class="btn-source btn-wav ${this.mode === 'sampler' ? 'active' : ''}" id="btn-load-wav" style="border-color:#ff00ff; color:#ff00ff;">LOAD WAV...</button>
                    
                    <div style="flex:1;"></div>
                    <div id="mix-knob-area"></div>
                </div>

                <!-- Rivi 3: Envelope -->
                <div class="adsr-container">
                    <div style="font-size: 10px; color: var(--fx-color); font-weight: bold; letter-spacing: 1px; font-family: monospace;">ENVELOPE (ADSR)</div>
                    <canvas id="adsr-canvas" width="280" height="70" style="background:#050505; border-radius:4px; border:1px solid #333; width: 100%; box-shadow: inset 0 0 10px rgba(0,0,0,0.8);"></canvas>
                    <div class="adsr-knobs" id="adsr-knobs-area"></div>
                </div>

                <!-- Rivi 4: Sampler asetukset -->
                <div class="sampler-controls">
                    <div style="width: 100%; font-size: 10px; color: #ff00ff; font-weight: bold; letter-spacing: 1px; font-family: monospace;">SAMPLER LOOP (SUSTAIN)</div>
                    <div class="input-group">
                        <label>Start (s)</label>
                        <input type="number" id="loop-start-in" value="${this.loopStart}" step="0.1" min="0">
                    </div>
                    <div class="input-group">
                        <label>End (s)</label>
                        <input type="number" id="loop-end-in" value="${this.loopEnd}" step="0.1" min="0">
                    </div>
                    <div id="loop-fade-knob-area" style="margin-left: 10px;"></div>
                </div>
            </div>
        `;

        this.displayElement = containerElement.querySelector('#synth-note-display');
        this.adsrCanvas = containerElement.querySelector('#adsr-canvas');

        containerElement.querySelector('#synth-panic-btn').addEventListener('click', () => this.killAllNotes());

        const waveBtns = containerElement.querySelectorAll('.btn-source[data-wave]');
        const loadWavBtn = containerElement.querySelector('#btn-load-wav');
        const fileInput = containerElement.querySelector('#wav-upload');

        this.uiElements.waveBtns = waveBtns;
        this.uiElements.loadWavBtn = loadWavBtn;

        waveBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.mode = 'osc';
                this.waveform = e.target.getAttribute('data-wave');
                this.updateWaveformUI();
            });
        });

        loadWavBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                let name = e.target.files[0].name;
                if(name.length > 10) name = name.substring(0, 8) + '...';
                loadWavBtn.innerText = name;
                this.loadWavFile(e.target.files[0]);
            }
        });

        const inStart = containerElement.querySelector('#loop-start-in');
        const inEnd = containerElement.querySelector('#loop-end-in');
        this.uiElements.loopStart = inStart; this.uiElements.loopEnd = inEnd;
        inStart.addEventListener('change', (e) => { this.loopStart = parseFloat(e.target.value); this.processLoopBuffer(); });
        inEnd.addEventListener('change', (e) => { this.loopEnd = parseFloat(e.target.value); this.processLoopBuffer(); });

        const createKnob = (container, label, min, max, defaultValue, formatValue, onChange, customColor = null) => {
            const div = document.createElement('div');
            div.className = 'knob-container';
            const radius = 17, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            const strokeColor = customColor || 'var(--fx-color)';
            
            div.innerHTML = `
                <div class="knob-label">${label}</div>
                <div class="knob-wrapper">
                    <svg class="knob-svg" viewBox="0 0 40 40"><circle class="knob-track" cx="20" cy="20" r="${radius}" stroke-dasharray="${maxDash} ${circumference}" /><circle class="knob-value-path" cx="20" cy="20" r="${radius}" stroke-dasharray="0 ${circumference}" style="stroke: ${strokeColor};" /><circle class="knob-center" cx="20" cy="20" r="10" /></svg>
                    <div class="knob-indicator"><div class="knob-dot" style="background: ${strokeColor}; box-shadow: 0 0 5px ${strokeColor};"></div></div>
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

        this.knobs['thresh'] = createKnob(containerElement.querySelector('#thresh-knob-area'), 'THRESH', -60, 0, this.thresholdDb, v => Math.round(v)+'dB', v => { this.thresholdDb = v; this.updateThreshold(); }, '#ff003c');
        this.knobs['legato'] = createKnob(containerElement.querySelector('#legato-knob-area'), 'LEGATO', 0.0, 1.0, this.legato, v => v.toFixed(2)+'s', v => { this.legato = v; });
        this.knobs['mix'] = createKnob(containerElement.querySelector('#mix-knob-area'), 'MIX', 0, 1.0, this.mix, v => Math.round(v*100)+'%', v => { this.mix = v; this.updateMix(); });
        
        const adsrArea = containerElement.querySelector('#adsr-knobs-area');
        this.knobs['att'] = createKnob(adsrArea, 'ATT', 0.01, 2.0, this.adsr.a, v => v.toFixed(2)+'s', v => { this.adsr.a = v; this.drawADSR(); });
        this.knobs['dec'] = createKnob(adsrArea, 'DEC', 0.01, 2.0, this.adsr.d, v => v.toFixed(2)+'s', v => { this.adsr.d = v; this.drawADSR(); });
        this.knobs['sus'] = createKnob(adsrArea, 'SUS', 0.0, 1.0, this.adsr.s, v => Math.round(v*100)+'%', v => { this.adsr.s = v; this.drawADSR(); });
        this.knobs['rel'] = createKnob(adsrArea, 'REL', 0.01, 3.0, this.adsr.r, v => v.toFixed(2)+'s', v => { this.adsr.r = v; this.drawADSR(); });

        this.knobs['loopFade'] = createKnob(containerElement.querySelector('#loop-fade-knob-area'), 'X-FADE', 0.0, 0.5, this.loopFade, v => v.toFixed(2)+'s', v => { this.loopFade = v; this.processLoopBuffer(); }, '#ff00ff');

        this.drawADSR();

        // Audion graafinen piirtoluuppi Thresholdia varten
        const tCanvas = containerElement.querySelector('#synth-thresh-canvas');
        const tCtx = tCanvas.getContext('2d');
        const historySize = 80;
        const peakHistory = new Array(historySize).fill(0);
        let mountCheckCount = 0;

        const drawThresholdCanvas = () => {
            mountCheckCount++;
            if (!document.body.contains(tCanvas)) {
                if (mountCheckCount > 10) return;
                return requestAnimationFrame(drawThresholdCanvas);
            }
            
            if (tCanvas.width !== tCanvas.parentElement.clientWidth) {
                tCanvas.width = tCanvas.parentElement.clientWidth;
                tCanvas.height = tCanvas.parentElement.clientHeight - 15;
            }

            const w = tCanvas.width, h = tCanvas.height;
            tCtx.clearRect(0, 0, w, h);

            const timeData = new Uint8Array(this.analyser.frequencyBinCount);
            this.analyser.getByteTimeDomainData(timeData);
            let peak = 0;
            for(let i=0; i<timeData.length; i++) {
                const val = Math.abs((timeData[i] / 128.0) - 1.0);
                if (val > peak) peak = val;
            }
            let peakDb = 20 * Math.log10(Math.max(peak, 0.0001));
            if (peakDb < -60) peakDb = -60;

            peakHistory.push(peakDb);
            peakHistory.shift();

            const dbToY = (db) => h - ((db + 60) / 60) * h;

            // Kynnysviiva
            const threshY = dbToY(this.thresholdDb);
            tCtx.strokeStyle = 'rgba(255, 0, 60, 0.8)';
            tCtx.lineWidth = 1; tCtx.setLineDash([4, 4]);
            tCtx.beginPath(); tCtx.moveTo(0, threshY); tCtx.lineTo(w, threshY); tCtx.stroke(); tCtx.setLineDash([]);

            // Audiosignaali
            tCtx.fillStyle = 'rgba(0, 255, 255, 0.5)';
            tCtx.beginPath();
            tCtx.moveTo(0, h);
            for(let i=0; i<historySize; i++) {
                const x = (i / (historySize - 1)) * w;
                const y = dbToY(peakHistory[i]);
                tCtx.lineTo(x, y);
            }
            tCtx.lineTo(w, h);
            tCtx.fill();

            requestAnimationFrame(drawThresholdCanvas);
        };
        drawThresholdCanvas();
    }
}