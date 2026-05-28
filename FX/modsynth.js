// modsynth.js
// Modulaarinen Syntetisaattori - Audio-to-MIDI, suora MIDI-ohjaus, Draw LFO, ARP, Velocity jne.

window.CustomAudioEffect = class ModSynthEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        
        this.modules = {};
        this.cables =[];
        this.moduleIdCounter = 1;

        this.isWiring = false;
        this.wireStart = null;
        
        this.heldNotes =[];

        // Moduulikohtaiset värit
        this.modColors = {
            'MIDI_IN': '#555555', 'AUDIO_OUT': '#333333',
            'VCO': '#e67e22', 'VCA': '#e74c3c', 'VCF': '#2ecc71',
            'LPF': '#27ae60', 'HPF': '#1abc9c', 'LFO': '#9b59b6',
            'ADSR': '#f1c40f', 'ARP': '#e84393', 'DRAW': '#c0392b',
            'WAV': '#ff00ff', 'WAVE': '#3498db', 'TGATE': '#d35400',
            'AM': '#7f8c8d', 'VOL': '#bdc3c7', 'PAN': '#16a085', 'DELAY': '#2980b9',
            'EQ': '#f39c12'
        };

        this.addModule('MIDI_IN', 20, 150);
        this.addModule('AUDIO_OUT', 800, 150);

        this._initWorklet();

        this.initTimer = setTimeout(() => {
            this.loadPreset(0); 
        }, 500);

        this.ledTimer = requestAnimationFrame(() => this.updateLEDs());
    }

    onMidi(msg) {
        const status = msg[0] & 0xf0;
        const note = msg[1];
        const vel = msg[2];

        if (status === 0x90 && vel > 0) { 
            if (!this.heldNotes.includes(note)) this.heldNotes.push(note);
            this.heldNotes.sort((a, b) => a - b);
            this.playNote(note, vel);
        } else if (status === 0x80 || (status === 0x90 && vel === 0)) { 
            this.heldNotes = this.heldNotes.filter(n => n !== note);
            if (this.heldNotes.length > 0) {
                this.playNote(this.heldNotes[this.heldNotes.length - 1], 100);
            } else {
                this.stopNote();
            }
        }
    }

    playNote(note, vel) {
        const hz = 440 * Math.pow(2, (note - 69) / 12);
        const midiMod = this.modules['MIDI_IN'];
        if (midiMod) {
            midiMod.nodes.pitchCV.offset.setTargetAtTime(hz, this.ctx.currentTime, 0.01);
            midiMod.nodes.velCV.offset.setTargetAtTime(vel / 127.0, this.ctx.currentTime, 0.01); 
            midiMod.ledActive = true;
        }

        this.cables.forEach(c => {
            if (c.from === 'MIDI_IN' && c.port === 'outGate') {
                const targetMod = this.modules[c.to];
                if (targetMod && typeof targetMod.trigger === 'function') targetMod.trigger();
            }
        });

        if (this.uiDisplay) {
            this.uiDisplay.innerText = `${Math.round(hz)} Hz`;
            this.uiDisplay.style.color = '#00ffcc';
        }
    }

    stopNote() {
        const midiMod = this.modules['MIDI_IN'];
        if (midiMod) midiMod.ledActive = false;

        this.cables.forEach(c => {
            if (c.from === 'MIDI_IN' && c.port === 'outGate') {
                const targetMod = this.modules[c.to];
                if (targetMod && typeof targetMod.release === 'function') targetMod.release();
            }
        });
        if (this.uiDisplay) this.uiDisplay.style.color = '#555';
    }

    updateLEDs() {
        const anyNoteHeld = this.heldNotes.length > 0;

        Object.values(this.modules).forEach(m => {
            if (!m.domNode) return;
            const led = m.domNode.querySelector('.ms-led');
            if (!led) return;

            let isActive = false;

            if (m.type === 'LFO') {
                const phase = (this.ctx.currentTime * parseFloat(m.params.rate)) % 1;
                isActive = phase < 0.5;
            } else if (m.type === 'ARP' || m.type === 'TGATE' || m.type === 'DRAW') {
                isActive = !!m.ledActive;
            } else if (m.type === 'ADSR' || m.type === 'MIDI_IN') {
                isActive = !!m.ledActive;
            } else if (['VCO', 'VCA', 'VCF', 'LPF', 'HPF', 'DELAY', 'AM', 'PAN', 'VOL', 'WAVE', 'WAV', 'EQ'].includes(m.type)) {
                isActive = anyNoteHeld;
            }

            if (isActive) {
                led.classList.add('active');
            } else {
                led.classList.remove('active');
            }
        });

        this.ledTimer = requestAnimationFrame(() => this.updateLEDs());
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
                    this.sensitivityThreshold = 3;

                    this.port.onmessage = (e) => {
                        if (e.data.action === 'setSensitivity') this.sensitivityThreshold = e.data.value;
                    };
                }

                process(inputs, outputs) {
                    const sr = sampleRate; 
                    const input = inputs[0];
                    if (!input || !input.length || !input[0]) {
                        if (this.currentNote !== -1) { this.port.postMessage({ action: 'noteOff' }); this.currentNote = -1; }
                        return true;
                    }

                    const inChannel = input[0];
                    let isCompletelySilent = true;

                    for (let i = 0; i < inChannel.length; i++) {
                        this.buffer[this.writePos] = inChannel[i];
                        if (inChannel[i] !== 0) isCompletelySilent = false;
                        this.writePos = (this.writePos + 1) % this.bufferSize;
                    }

                    if (isCompletelySilent) { this.silenceFrames++; } else {
                        let sumSq = 0;
                        for(let i=0; i<1024; i++) {
                            let idx = (this.writePos - 1 - i + this.bufferSize) % this.bufferSize;
                            sumSq += this.buffer[idx] * this.buffer[idx];
                        }
                        const rms = Math.sqrt(sumSq / 1024);
                        if (rms < 0.005) this.silenceFrames++; else this.silenceFrames = 0;
                    }

                    if (this.silenceFrames >= 5) {
                        this.stableFrames = 0;
                        if (this.currentNote !== -1) { this.port.postMessage({ action: 'noteOff' }); this.currentNote = -1; }
                        return true; 
                    }

                    let minDiff = Infinity, bestPeriod = 0;
                    const minP = Math.floor(sr/1000), maxP = Math.floor(sr/60);

                    for (let p = minP; p < maxP; p++) {
                        let diff = 0;
                        for (let i = 0; i < 512; i++) {
                            let idx1 = (this.writePos - 1 - i + this.bufferSize) % this.bufferSize;
                            let idx2 = (this.writePos - 1 - i - p + this.bufferSize) % this.bufferSize;
                            diff += Math.abs(this.buffer[idx1] - this.buffer[idx2]);
                        }
                        if (diff < minDiff) { minDiff = diff; bestPeriod = p; }
                    }

                    let sSq = 0;
                    for(let i=0; i<1024; i++) {
                        let idx = (this.writePos - 1 - i + this.bufferSize) % this.bufferSize;
                        sSq += this.buffer[idx] * this.buffer[idx];
                    }
                    const trueRms = Math.sqrt(sSq / 1024);
                    const hz = sr / bestPeriod;

                    if (1.0 - ((minDiff/512) / (trueRms*2.0)) > 0.4) {
                        const targetMidi = Math.round(69 + 12 * Math.log2(hz / 440));
                        if (targetMidi !== this.currentNote) {
                            this.stableFrames++;
                            if (this.stableFrames >= this.sensitivityThreshold) { 
                                this.port.postMessage({ action: 'noteOn', note: targetMidi, hz: hz, vel: trueRms*10 });
                                this.currentNote = targetMidi;
                                this.stableFrames = 0;
                            }
                        } else this.stableFrames = 0;
                    }
                    return true;
                }
            }
            registerProcessor('modsynth-processor', AudioSynthProcessor);
        `;

        const dataUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(workletCode);
        
        try {
            this.worklet = new AudioWorkletNode(this.ctx, 'modsynth-processor');
            this._setupWorkletPort();
        } catch(e) {
            try {
                await this.ctx.audioWorklet.addModule(dataUrl);
                this.worklet = new AudioWorkletNode(this.ctx, 'modsynth-processor');
                this._setupWorkletPort();
            } catch (err) {
                console.error("Worklet load failed:", err);
            }
        }
    }

    _setupWorkletPort() {
        if (!this.worklet) return;
        this.worklet.port.onmessage = (e) => {
            if (e.data.action === 'noteOn') this.playNote(e.data.note, e.data.vel);
            else if (e.data.action === 'noteOff') this.stopNote();
        };
        this.input.connect(this.worklet);
    }

    addModule(type, x, y, forceId = null) {
        const id = forceId ? forceId : (type === 'MIDI_IN' || type === 'AUDIO_OUT' ? type : `mod_${type}_${this.moduleIdCounter++}`);
        const mod = { id, type, x, y, nodes: {}, ports: {}, params: {}, domNode: null, ledActive: false };
        
        this.modules[id] = mod;

        switch(type) {
            case 'MIDI_IN':
                mod.nodes.pitchCV = this.ctx.createConstantSource();
                mod.nodes.pitchCV.offset.value = 440; 
                mod.nodes.pitchCV.start();

                mod.nodes.velCV = this.ctx.createConstantSource();
                mod.nodes.velCV.offset.value = 0.8;
                mod.nodes.velCV.start();

                mod.params.sens = 3; 
                mod.ports = { 
                    outPitch: { type: 'out', node: mod.nodes.pitchCV }, 
                    outVel: { type: 'out', node: mod.nodes.velCV },
                    outGate: { type: 'out', logical: true } 
                };
                break;
            
            case 'AUDIO_OUT':
                mod.ports = { inLeft: { type: 'in', dest: this.output }, inRight: { type: 'in', dest: this.output } };
                break;

            case 'VCO':
                mod.nodes.osc = this.ctx.createOscillator();
                mod.nodes.osc.type = 'sawtooth';
                mod.params = { tune: 440, wave: 'sawtooth' };
                mod.nodes.osc.frequency.value = mod.params.tune; 
                mod.nodes.osc.start();
                mod.ports = { inPitch: { type: 'in', dest: mod.nodes.osc.frequency }, inFM: { type: 'in', dest: mod.nodes.osc.frequency }, out: { type: 'out', node: mod.nodes.osc } };
                break;

            case 'WAV':
                mod.params = { fileName: "No File", tune: 261.63 };
                mod.nodes.rateScaler = this.ctx.createGain();
                mod.nodes.rateScaler.gain.value = 1 / 261.63; 
                mod.nodes.outGain = this.ctx.createGain();
                mod.nodes.outGain.gain.value = 1.0;
                mod.nodes.source = null;

                mod.loadBuffer = async (file) => {
                    mod.params.fileName = file.name;
                    if(mod.params.fileName.length > 12) mod.params.fileName = mod.params.fileName.substring(0, 10) + '...';
                    try {
                        const arrayBuffer = await file.arrayBuffer();
                        const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
                        if (mod.nodes.source) { try { mod.nodes.source.stop(); mod.nodes.source.disconnect(); } catch(e){} }
                        mod.nodes.source = this.ctx.createBufferSource();
                        mod.nodes.source.buffer = audioBuffer;
                        mod.nodes.source.loop = true;
                        mod.nodes.source.playbackRate.value = 0; 
                        mod.nodes.rateScaler.connect(mod.nodes.source.playbackRate);
                        mod.nodes.source.connect(mod.nodes.outGain);
                        mod.nodes.source.start();
                        this.rebuildInternalRouting();
                        this.renderModuleUI(mod);
                    } catch(err) { alert("Virhe ladattaessa WAV: " + err.message); }
                };

                mod.ports = { inPitch: { type: 'in', dest: mod.nodes.rateScaler }, out: { type: 'out', node: mod.nodes.outGain } };
                break;

            case 'VCF':
            case 'LPF':
                mod.params = { freq: 1000, res: 1 };
                mod.nodes.filter = this.ctx.createBiquadFilter();
                mod.nodes.filter.type = 'lowpass';
                mod.nodes.filter.frequency.value = mod.params.freq;
                mod.nodes.filter.Q.value = mod.params.res;
                
                mod.nodes.cvScaler = this.ctx.createGain();
                mod.nodes.cvScaler.gain.value = 5000;
                mod.nodes.cvScaler.connect(mod.nodes.filter.frequency);

                mod.nodes.resScaler = this.ctx.createGain();
                mod.nodes.resScaler.gain.value = 20;
                mod.nodes.resScaler.connect(mod.nodes.filter.Q);

                mod.ports = { inAudio: { type: 'in', dest: mod.nodes.filter }, inCV: { type: 'in', dest: mod.nodes.cvScaler }, inRes: { type: 'in', dest: mod.nodes.resScaler }, out: { type: 'out', node: mod.nodes.filter } };
                break;

            case 'HPF':
                mod.params = { freq: 500, res: 1 };
                mod.nodes.filter = this.ctx.createBiquadFilter();
                mod.nodes.filter.type = 'highpass';
                mod.nodes.filter.frequency.value = mod.params.freq;
                mod.nodes.filter.Q.value = mod.params.res;
                
                mod.nodes.cvScaler = this.ctx.createGain();
                mod.nodes.cvScaler.gain.value = 5000;
                mod.nodes.cvScaler.connect(mod.nodes.filter.frequency);

                mod.nodes.resScaler = this.ctx.createGain();
                mod.nodes.resScaler.gain.value = 20;
                mod.nodes.resScaler.connect(mod.nodes.filter.Q);

                mod.ports = { inAudio: { type: 'in', dest: mod.nodes.filter }, inCV: { type: 'in', dest: mod.nodes.cvScaler }, inRes: { type: 'in', dest: mod.nodes.resScaler }, out: { type: 'out', node: mod.nodes.filter } };
                break;

            case 'VCA':
                mod.nodes.gain = this.ctx.createGain();
                mod.nodes.gain.gain.value = 0; 
                mod.ports = { inAudio: { type: 'in', dest: mod.nodes.gain }, inCV: { type: 'in', dest: mod.nodes.gain.gain }, out: { type: 'out', node: mod.nodes.gain } };
                break;

            case 'LFO':
                mod.params = { rate: 2, amp: 100 };
                mod.nodes.osc = this.ctx.createOscillator();
                mod.nodes.amp = this.ctx.createGain();
                mod.nodes.osc.type = 'sine';
                mod.nodes.osc.frequency.value = mod.params.rate; 
                mod.nodes.amp.gain.value = mod.params.amp; 
                mod.nodes.osc.connect(mod.nodes.amp);
                mod.nodes.osc.start();

                mod.nodes.rateScaler = this.ctx.createGain();
                mod.nodes.rateScaler.gain.value = 20; 
                mod.nodes.rateScaler.connect(mod.nodes.osc.frequency);

                mod.nodes.ampScaler = this.ctx.createGain();
                mod.nodes.ampScaler.gain.value = 1000;
                mod.nodes.ampScaler.connect(mod.nodes.amp.gain);

                mod.ports = { inRate: { type: 'in', dest: mod.nodes.rateScaler }, inAmp: { type: 'in', dest: mod.nodes.ampScaler }, out: { type: 'out', node: mod.nodes.amp } };
                break;

            case 'ADSR':
                mod.nodes.cvOut = this.ctx.createConstantSource();
                mod.nodes.cvOut.offset.value = 0;
                mod.nodes.cvOut.start();
                mod.params = { a: 0.1, d: 0.2, s: 0.5, r: 0.5 };
                
                mod.envState = 'idle';
                mod.startTime = 0;
                mod.releaseTime = 0;

                mod.trigger = () => {
                    mod.ledActive = true;
                    mod.envState = 'attack';
                    const now = this.ctx.currentTime;
                    mod.startTime = now;
                    const p = mod.nodes.cvOut.offset;
                    p.cancelScheduledValues(now);
                    p.setTargetAtTime(0, now, 0.001); 
                    p.linearRampToValueAtTime(1.0, now + 0.005 + parseFloat(mod.params.a));
                    p.linearRampToValueAtTime(parseFloat(mod.params.s), now + 0.005 + parseFloat(mod.params.a) + parseFloat(mod.params.d));
                };
                mod.release = () => {
                    mod.ledActive = false;
                    mod.envState = 'release';
                    const now = this.ctx.currentTime;
                    mod.releaseTime = now;
                    const p = mod.nodes.cvOut.offset;
                    p.cancelScheduledValues(now);
                    p.setTargetAtTime(0.0, now, parseFloat(mod.params.r) / 3 || 0.01);
                };
                mod.ports = { inGate: { type: 'in', logical: true }, outEnv: { type: 'out', node: mod.nodes.cvOut } };

                mod.step = () => {
                    if (!this.modules[mod.id]) return;
                    const cvs = mod.domNode?.querySelector(`#adsr-cvs-${mod.id}`);
                    if (cvs) {
                        const ctx = cvs.getContext('2d');
                        ctx.clearRect(0, 0, cvs.width, cvs.height);
                        
                        const W = cvs.width;
                        const H = cvs.height;
                        const wPart = W * 0.25;

                        const A = parseFloat(mod.params.a);
                        const D = parseFloat(mod.params.d);
                        const S = parseFloat(mod.params.s);
                        const R = parseFloat(mod.params.r);

                        // Skaalataan osiot graafisesti keston perusteella
                        const W_a = Math.max(5, (A / 2.0) * wPart * 2);
                        const W_d = Math.max(5, (D / 2.0) * wPart * 2);
                        const W_s = wPart; // staattinen leveys sustainille visualisointia varten
                        const W_r = Math.max(5, (R / 3.0) * wPart * 2);
                        const H_s = H - (S * H);

                        // Piirrä pohjakäyrä
                        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.moveTo(0, H);
                        ctx.lineTo(W_a, 0);
                        ctx.lineTo(W_a + W_d, H_s);
                        ctx.lineTo(W_a + W_d + W_s, H_s);
                        ctx.lineTo(W_a + W_d + W_s + W_r, H);
                        ctx.stroke();

                        // Laske playhead-sijainti ja vaihe
                        const now = this.ctx.currentTime;
                        let playX = 0;
                        let playY = H;
                        let isActive = false;

                        if (mod.envState === 'attack' || mod.envState === 'decay' || mod.envState === 'sustain') {
                            isActive = true;
                            const elapsed = now - mod.startTime;
                            if (elapsed <= A && A > 0) {
                                playX = (elapsed / A) * W_a;
                                playY = H - ((elapsed / A) * H);
                                mod.envState = 'attack';
                            } else if (elapsed <= A + D && D > 0) {
                                const dPhase = (elapsed - A) / D;
                                playX = W_a + (dPhase * W_d);
                                playY = 0 + (dPhase * H_s);
                                mod.envState = 'decay';
                            } else {
                                const sPhase = Math.min(1, (elapsed - A - D) / 1.0);
                                playX = Math.min(W_a + W_d + W_s, W_a + W_d + (sPhase * W_s));
                                playY = H_s;
                                mod.envState = 'sustain';
                            }
                        } else if (mod.envState === 'release') {
                            isActive = true;
                            const elapsed = now - mod.releaseTime;
                            if (elapsed <= R && R > 0) {
                                const rPhase = elapsed / R;
                                playX = W_a + W_d + W_s + (rPhase * W_r);
                                playY = H_s + (rPhase * (H - H_s));
                            } else {
                                mod.envState = 'idle';
                                isActive = false;
                            }
                        }

                        if (isActive) {
                            ctx.fillStyle = '#ff00ff';
                            ctx.beginPath();
                            ctx.arc(playX, playY, 3, 0, Math.PI*2);
                            ctx.fill();
                            
                            ctx.strokeStyle = '#ff00ff';
                            ctx.lineWidth = 2;
                            ctx.shadowBlur = 5;
                            ctx.shadowColor = '#ff00ff';
                            ctx.beginPath();
                            ctx.moveTo(0, H);
                            if (mod.envState === 'attack') { ctx.lineTo(playX, playY); }
                            else {
                                ctx.lineTo(W_a, 0);
                                if (mod.envState === 'decay') { ctx.lineTo(playX, playY); }
                                else {
                                    ctx.lineTo(W_a + W_d, H_s);
                                    if (mod.envState === 'sustain') { ctx.lineTo(playX, playY); }
                                    else {
                                        ctx.lineTo(W_a + W_d + W_s, H_s);
                                        ctx.lineTo(playX, playY);
                                    }
                                }
                            }
                            ctx.stroke();
                            ctx.shadowBlur = 0;
                        }
                    }
                    mod.timer = requestAnimationFrame(mod.step);
                };
                mod.step();
                break;

            case 'ARP':
                mod.params = { rate: 8, mode: 'up', octaves: 1, chord: 'octaves' };
                mod.nodes.cvOut = this.ctx.createConstantSource();
                mod.nodes.cvOut.offset.value = 440;
                mod.nodes.cvOut.start();
                mod.nodes.rateAnalyser = this.ctx.createAnalyser();
                mod.nodes.rateAnalyser.fftSize = 32;
                mod.nodes.pitchAnalyser = this.ctx.createAnalyser(); 
                mod.nodes.pitchAnalyser.fftSize = 32;

                mod.ports = { 
                    inPitch: { type: 'in', dest: mod.nodes.pitchAnalyser }, 
                    inRate: { type: 'in', dest: mod.nodes.rateAnalyser }, 
                    inGate: { type: 'in', logical: true }, 
                    outPitch: { type: 'out', node: mod.nodes.cvOut }, 
                    outGate: { type: 'out', logical: true } 
                };
                mod.stepIndex = 0;
                mod.gateActive = false;

                mod.trigger = () => { mod.gateActive = true; mod.stepIndex = 0; };
                mod.release = () => { mod.gateActive = false; };
                
                mod.step = () => {
                    if (!this.modules[mod.id]) return;

                    const isGateConnected = this.cables.some(c => c.to === mod.id && c.target === 'inGate');

                    if (isGateConnected && !mod.gateActive) {
                        mod.ledActive = false;
                        mod.stepIndex = 0;
                        this.cables.forEach(c => { if (c.from === mod.id && c.port === 'outGate') { const t = this.modules[c.to]; if (t && t.release) t.release(); } });
                        mod.timer = setTimeout(mod.step, 50);
                        return;
                    }

                    let cvRateOffset = 0;
                    if (this.cables.some(c => c.to === mod.id && c.target === 'inRate')) {
                        const data = new Float32Array(mod.nodes.rateAnalyser.fftSize);
                        mod.nodes.rateAnalyser.getFloatTimeDomainData(data);
                        cvRateOffset = data[0] * 20; 
                    }
                    let finalRate = Math.max(1, mod.params.rate + cvRateOffset);

                    let incomingHz = 440;
                    const isPitchConnected = this.cables.some(c => c.to === mod.id && c.target === 'inPitch');
                    if (isPitchConnected) {
                        const pData = new Float32Array(mod.nodes.pitchAnalyser.fftSize);
                        mod.nodes.pitchAnalyser.getFloatTimeDomainData(pData);
                        if (pData[0] > 10) incomingHz = pData[0];
                    }

                    mod.ledActive = true;
                    setTimeout(() => { if(this.modules[mod.id]) mod.ledActive = false; }, 50);

                    const baseNote = Math.round(69 + 12 * Math.log2(incomingHz / 440));
                    let arpNotes = [];
                    
                    let intervals = [0];
                    if(mod.params.chord === 'major') intervals = [0, 4, 7];
                    if(mod.params.chord === 'minor') intervals = [0, 3, 7];
                    if(mod.params.chord === 'sus4') intervals = [0, 5, 7];

                    for(let oct = 0; oct < mod.params.octaves; oct++) {
                        intervals.forEach(inv => arpNotes.push(baseNote + inv + (oct * 12)));
                    }

                    if (mod.params.mode === 'down') arpNotes.reverse();
                    else if (mod.params.mode === 'updown') { let down = [...arpNotes].reverse(); arpNotes = arpNotes.concat(down.slice(1, -1)); } 
                    else if (mod.params.mode === 'random') arpNotes.sort(() => Math.random() - 0.5);

                    if (mod.stepIndex >= arpNotes.length) mod.stepIndex = 0;
                    const hzOut = 440 * Math.pow(2, (arpNotes[mod.stepIndex] - 69) / 12);
                    mod.nodes.cvOut.offset.setTargetAtTime(hzOut, this.ctx.currentTime, 0.005);

                    this.cables.forEach(c => { if (c.from === mod.id && c.port === 'outGate') { const t = this.modules[c.to]; if (t && t.trigger) t.trigger(); } });

                    const stepTimeMs = 1000 / finalRate;
                    setTimeout(() => {
                        if (!this.modules[mod.id]) return;
                        this.cables.forEach(c => { if (c.from === mod.id && c.port === 'outGate') { const t = this.modules[c.to]; if (t && t.release) t.release(); } });
                    }, stepTimeMs * 0.5);

                    mod.stepIndex++;
                    mod.timer = setTimeout(mod.step, 1000 / finalRate);
                };
                mod.step();
                break;

            case 'DRAW':
                mod.params = { speed: 1.0, points:[] };
                for(let i = 0; i <= 110; i += 5) {
                    mod.params.points.push({x: i, y: 40 + Math.sin(i * 0.1) * 30});
                }
                
                mod.nodes.cvOut = this.ctx.createConstantSource();
                mod.nodes.cvOut.offset.value = 0;
                mod.nodes.cvOut.start();
                
                mod.nodes.speedAnalyser = this.ctx.createAnalyser();
                mod.nodes.speedAnalyser.fftSize = 32;

                mod.playhead = 0;
                mod.ports = { inSpeed: { type: 'in', dest: mod.nodes.speedAnalyser }, outCV: { type: 'out', node: mod.nodes.cvOut } };

                mod.step = () => {
                    if (!this.modules[mod.id]) return;
                    let pt = null;
                    if (mod.params.points.length > 0) {
                        let speedOffset = 0;
                        if (this.cables.some(c => c.to === mod.id && c.target === 'inSpeed')) {
                            const sData = new Float32Array(mod.nodes.speedAnalyser.fftSize);
                            mod.nodes.speedAnalyser.getFloatTimeDomainData(sData);
                            speedOffset = sData[0] * 5.0; // Esim. 1.0 CV tuo +5 askelta nopeuteen
                        }

                        mod.playhead = (mod.playhead + parseFloat(mod.params.speed) + speedOffset) % mod.params.points.length;
                        if (mod.playhead < 0) mod.playhead += mod.params.points.length;
                        
                        const safeIdx = Math.floor(mod.playhead) % mod.params.points.length;
                        pt = mod.params.points[safeIdx];
                        if (pt) {
                            let val = 1.0 - (pt.y / 80); 
                            val = Math.max(0, Math.min(1, val));
                            mod.nodes.cvOut.offset.setTargetAtTime(val, this.ctx.currentTime, 0.01);
                            mod.ledActive = val > 0.1;
                        }
                    } else {
                        mod.ledActive = false;
                    }

                    if (mod.domNode) {
                        const cvs = mod.domNode.querySelector(`#draw-cvs-${mod.id}`);
                        if (cvs) {
                            const c = cvs.getContext('2d');
                            c.clearRect(0,0, cvs.width, cvs.height);
                            if (mod.params.points.length > 0) {
                                c.strokeStyle = '#fff';
                                c.lineWidth = 2;
                                c.beginPath();
                                mod.params.points.forEach((p, i) => { if (i===0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y); });
                                c.stroke();
                                if (pt) { c.fillStyle = '#ff0000'; c.beginPath(); c.arc(pt.x, pt.y, 4, 0, Math.PI*2); c.fill(); }
                            }
                        }
                    }
                    mod.timer = requestAnimationFrame(mod.step);
                };
                mod.step();
                break;
                
            case 'WAVE': 
                mod.nodes.inGain = this.ctx.createGain();
                mod.nodes.outGain = this.ctx.createGain();
                mod.nodes.splitter = this.ctx.createChannelSplitter(2);
                mod.nodes.analyserL = this.ctx.createAnalyser();
                mod.nodes.analyserR = this.ctx.createAnalyser();
                mod.nodes.analyserWave = this.ctx.createAnalyser();
                
                mod.nodes.analyserL.fftSize = 256;
                mod.nodes.analyserR.fftSize = 256;
                mod.nodes.analyserWave.fftSize = 512;

                mod.nodes.inGain.connect(mod.nodes.splitter);
                mod.nodes.inGain.connect(mod.nodes.analyserWave);
                mod.nodes.splitter.connect(mod.nodes.analyserL, 0);
                mod.nodes.splitter.connect(mod.nodes.analyserR, 1);
                
                mod.nodes.inGain.connect(mod.nodes.outGain); 

                mod.ports = { inAudio: { type: 'in', dest: mod.nodes.inGain }, out: { type: 'out', node: mod.nodes.outGain } };
                
                mod.step = () => {
                    if (!this.modules[mod.id]) return;
                    if (mod.domNode) {
                        const cvs = mod.domNode.querySelector(`#wave-cvs-${mod.id}`);
                        const barL = mod.domNode.querySelector(`#wave-l-${mod.id}`);
                        const barR = mod.domNode.querySelector(`#wave-r-${mod.id}`);
                        
                        if (cvs && barL && barR) {
                            const data = new Uint8Array(mod.nodes.analyserWave.fftSize);
                            mod.nodes.analyserWave.getByteTimeDomainData(data);
                            const c = cvs.getContext('2d');
                            c.clearRect(0, 0, cvs.width, cvs.height);
                            c.strokeStyle = '#fff';
                            c.lineWidth = 1;
                            c.beginPath();
                            const sliceWidth = cvs.width * 1.0 / data.length;
                            let xPos = 0;
                            for(let i = 0; i < data.length; i++) {
                                const v = data[i] / 128.0;
                                const yPos = v * (cvs.height / 2);
                                if(i === 0) c.moveTo(xPos, yPos); else c.lineTo(xPos, yPos);
                                xPos += sliceWidth;
                            }
                            c.stroke();

                            const getRms = (analyser) => {
                                const arr = new Float32Array(analyser.fftSize);
                                analyser.getFloatTimeDomainData(arr);
                                let sum = 0;
                                for(let i=0; i<arr.length; i++) sum += arr[i] * arr[i];
                                return Math.sqrt(sum / arr.length);
                            };

                            const rmsL = Math.min(1.0, getRms(mod.nodes.analyserL) * 3);
                            const rmsR = Math.min(1.0, getRms(mod.nodes.analyserR) * 3);
                            
                            barL.style.height = `${rmsL * 100}%`;
                            barR.style.height = `${rmsR * 100}%`;
                        }
                    }
                    mod.timer = requestAnimationFrame(mod.step);
                };
                mod.step();
                break;

            case 'TGATE': 
                mod.nodes.inGain = this.ctx.createGain();
                mod.nodes.gateGain = this.ctx.createGain();
                mod.nodes.inGain.connect(mod.nodes.gateGain);
                
                mod.nodes.rateAnalyser = this.ctx.createAnalyser();
                mod.nodes.rateAnalyser.fftSize = 32;

                mod.params = { steps: Array(16).fill(1), rate: 8, sync: true };
                mod.params.steps[3] = 0; mod.params.steps[7] = 0; mod.params.steps[11] = 0; mod.params.steps[15] = 0;

                mod.stepIndex = 0;
                mod.ports = { inAudio: { type: 'in', dest: mod.nodes.inGain }, inRate: { type: 'in', dest: mod.nodes.rateAnalyser }, out: { type: 'out', node: mod.nodes.gateGain } };

                mod.step = () => {
                    if (!this.modules[mod.id]) return;
                    let stepTimeMs = 125; 
                    
                    let rateOffset = 0;
                    if (this.cables.some(c => c.to === mod.id && c.target === 'inRate')) {
                        const rData = new Float32Array(mod.nodes.rateAnalyser.fftSize);
                        mod.nodes.rateAnalyser.getFloatTimeDomainData(rData);
                        rateOffset = rData[0] * 20; 
                    }
                    let finalRate = Math.max(1, mod.params.rate + rateOffset);

                    if (mod.params.sync && window.globalTempo) {
                        stepTimeMs = (60000 / window.globalTempo) / 4; 
                    } else {
                        stepTimeMs = 1000 / finalRate;
                    }

                    const isActive = mod.params.steps[mod.stepIndex];
                    mod.nodes.gateGain.gain.setTargetAtTime(isActive ? 1.0 : 0.0, this.ctx.currentTime, 0.01);
                    mod.ledActive = !!isActive;

                    if (mod.domNode) {
                        const stepEls = mod.domNode.querySelectorAll('.tg-step');
                        stepEls.forEach((el, i) => {
                            if (i === mod.stepIndex) {
                                el.style.boxShadow = '0 0 10px #fff';
                                el.style.borderColor = '#fff';
                            } else {
                                el.style.boxShadow = 'none';
                                el.style.borderColor = '#444';
                            }
                        });
                    }

                    mod.stepIndex = (mod.stepIndex + 1) % 16;
                    mod.timer = setTimeout(mod.step, stepTimeMs);
                };
                mod.step();
                break;

            case 'EQ':
                mod.params = { low: 0, mid: 0, high: 0 };
                
                mod.nodes.low = this.ctx.createBiquadFilter();
                mod.nodes.low.type = 'lowshelf';
                mod.nodes.low.frequency.value = 250;
                
                mod.nodes.mid = this.ctx.createBiquadFilter();
                mod.nodes.mid.type = 'peaking';
                mod.nodes.mid.frequency.value = 1000;
                mod.nodes.mid.Q.value = 1;
                
                mod.nodes.high = this.ctx.createBiquadFilter();
                mod.nodes.high.type = 'highshelf';
                mod.nodes.high.frequency.value = 4000;

                mod.nodes.low.connect(mod.nodes.mid);
                mod.nodes.mid.connect(mod.nodes.high);

                mod.ports = { 
                    inAudio: { type: 'in', dest: mod.nodes.low }, 
                    out: { type: 'out', node: mod.nodes.high } 
                };

                mod.step = () => {
                    if (!this.modules[mod.id]) return;
                    const cvs = mod.domNode?.querySelector(`#eq-cvs-${mod.id}`);
                    if (cvs) {
                        const ctx = cvs.getContext('2d');
                        const w = cvs.width;
                        const h = cvs.height;
                        
                        ctx.clearRect(0, 0, w, h);
                        
                        const freqs = new Float32Array(w);
                        const magLow = new Float32Array(w);
                        const phaseLow = new Float32Array(w);
                        const magMid = new Float32Array(w);
                        const phaseMid = new Float32Array(w);
                        const magHigh = new Float32Array(w);
                        const phaseHigh = new Float32Array(w);
                        
                        for (let i = 0; i < w; i++) {
                            freqs[i] = 20 * Math.pow(1000, i / w);
                        }
                        
                        mod.nodes.low.getFrequencyResponse(freqs, magLow, phaseLow);
                        mod.nodes.mid.getFrequencyResponse(freqs, magMid, phaseMid);
                        mod.nodes.high.getFrequencyResponse(freqs, magHigh, phaseHigh);

                        ctx.strokeStyle = '#00ffcc';
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        
                        for (let i = 0; i < w; i++) {
                            const totalMag = magLow[i] * magMid[i] * magHigh[i];
                            const db = 20 * Math.log10(totalMag || 1e-6);
                            let y = h/2 - (db / 20) * (h/2);
                            if (i === 0) ctx.moveTo(i, y);
                            else ctx.lineTo(i, y);
                        }
                        ctx.stroke();

                        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
                        ctx.lineWidth = 1;
                        ctx.setLineDash([2, 2]);
                        ctx.beginPath();
                        ctx.moveTo(0, h/2);
                        ctx.lineTo(w, h/2);
                        ctx.stroke();
                        ctx.setLineDash([]);
                    }
                    mod.timer = requestAnimationFrame(mod.step);
                };
                mod.step();
                break;

            case 'AM':
                mod.nodes.gain = this.ctx.createGain();
                mod.nodes.gain.gain.value = 0; 
                mod.nodes.modScaler = this.ctx.createGain();
                mod.nodes.modScaler.gain.value = 1; 
                mod.nodes.modScaler.connect(mod.nodes.gain.gain);
                
                mod.params = { depth: 1.0 };
                mod.ports = { inAudio: { type: 'in', dest: mod.nodes.gain }, inMod: { type: 'in', dest: mod.nodes.modScaler }, out: { type: 'out', node: mod.nodes.gain } };
                break;

            case 'VOL':
                mod.nodes.gain = this.ctx.createGain();
                mod.nodes.gain.gain.value = 1.0;
                mod.params = { vol: 1.0 };
                mod.ports = { inAudio: { type: 'in', dest: mod.nodes.gain }, inCV: { type: 'in', dest: mod.nodes.gain.gain }, out: { type: 'out', node: mod.nodes.gain } };
                break;

            case 'PAN':
                mod.nodes.panner = this.ctx.createStereoPanner();
                mod.nodes.panner.pan.value = 0;
                mod.params = { pan: 0 };
                mod.nodes.cvScaler = this.ctx.createGain();
                mod.nodes.cvScaler.gain.value = 2; 
                mod.nodes.cvScaler.connect(mod.nodes.panner.pan);
                mod.ports = { inAudio: { type: 'in', dest: mod.nodes.panner }, inCV: { type: 'in', dest: mod.nodes.panner.pan }, out: { type: 'out', node: mod.nodes.panner } };
                break;

            case 'DELAY':
                mod.nodes.delay = this.ctx.createDelay(5.0);
                mod.nodes.delay.delayTime.value = 0.3;
                mod.nodes.fdbk = this.ctx.createGain();
                mod.nodes.fdbk.gain.value = 0.5;
                mod.nodes.delay.connect(mod.nodes.fdbk);
                mod.nodes.fdbk.connect(mod.nodes.delay);
                mod.params = { time: 0.3, fdbk: 0.5 };
                mod.ports = { inAudio: { type: 'in', dest: mod.nodes.delay }, inTime: { type: 'in', dest: mod.nodes.delay.delayTime }, inFdbk: { type: 'in', dest: mod.nodes.fdbk.gain }, out: { type: 'out', node: mod.nodes.delay } };
                break;
        }

        this.renderModuleUI(mod);
        return id;
    }

    removeModule(id) {
        if(id === 'MIDI_IN' || id === 'AUDIO_OUT') return;
        const mod = this.modules[id];
        if(!mod) return;
        
        if(mod.nodes.osc) { try{ mod.nodes.osc.stop(); }catch(e){} }
        if(mod.nodes.cvOut) { try{ mod.nodes.cvOut.stop(); }catch(e){} }
        if(mod.nodes.source) { try{ mod.nodes.source.stop(); mod.nodes.source.disconnect(); }catch(e){} }
        if(mod.timer) { clearTimeout(mod.timer); cancelAnimationFrame(mod.timer); }
        
        if(mod.domNode) mod.domNode.remove();
        
        this.cables = this.cables.filter(c => c.from !== id && c.to !== id);
        delete this.modules[id];
        
        this.rebuildInternalRouting();
        this.drawCables();
    }

    rebuildInternalRouting() {
        Object.values(this.modules).forEach(m => {
            if(m.type === 'VCO') m.nodes.osc.frequency.value = m.params.tune;
            if(m.type === 'WAV' && m.nodes.source) m.nodes.source.playbackRate.value = m.params.tune / 261.63;
            Object.values(m.ports).forEach(p => { if(p.type === 'out' && p.node) { try { p.node.disconnect(); } catch(e){} } });
        });

        this.cables.forEach(c => {
            const mFrom = this.modules[c.from];
            const mTo = this.modules[c.to];
            if(mFrom && mTo) {
                const pFrom = mFrom.ports[c.port];
                const pTo = mTo.ports[c.target];
                if(pFrom && pTo && !pFrom.logical && !pTo.logical && pFrom.node && pTo.dest) {
                    pFrom.node.connect(pTo.dest);
                    if(mTo.type === 'VCO' && c.target === 'inPitch') mTo.nodes.osc.frequency.value = 0;
                    if(mTo.type === 'WAV' && c.target === 'inPitch' && mTo.nodes.source) mTo.nodes.source.playbackRate.value = 0;
                }
            }
        });
    }

    applyParamsToNodes(mod) {
        if(mod.type === 'MIDI_IN') { if(this.worklet) this.worklet.port.postMessage({ action: 'setSensitivity', value: mod.params.sens }); } 
        else if(mod.type === 'VCO') { mod.nodes.osc.type = mod.params.wave; mod.nodes.osc.frequency.value = mod.params.tune; } 
        else if(mod.type === 'VCF' || mod.type === 'LPF' || mod.type === 'HPF') { mod.nodes.filter.frequency.value = mod.params.freq; mod.nodes.filter.Q.value = mod.params.res; } 
        else if(mod.type === 'EQ') { mod.nodes.low.gain.value = mod.params.low; mod.nodes.mid.gain.value = mod.params.mid; mod.nodes.high.gain.value = mod.params.high; }
        else if(mod.type === 'LFO') { mod.nodes.osc.frequency.value = mod.params.rate; mod.nodes.amp.gain.value = mod.params.amp; } 
        else if (mod.type === 'VOL') { mod.nodes.gain.gain.value = mod.params.vol; } 
        else if (mod.type === 'PAN') { mod.nodes.panner.pan.value = mod.params.pan; } 
        else if (mod.type === 'DELAY') { mod.nodes.delay.delayTime.value = mod.params.time; mod.nodes.fdbk.gain.value = mod.params.fdbk; }
    }

    savePatch() {
        const patch = { modules: Object.values(this.modules).map(m => ({ id: m.id, type: m.type, x: m.x, y: m.y, params: { ...m.params } })), cables: this.cables };
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(patch));
        const anchor = document.createElement('a'); anchor.setAttribute("href", dataStr); anchor.setAttribute("download", "modsynth_patch.json");
        document.body.appendChild(anchor); anchor.click(); anchor.remove();
    }

    loadPatch(jsonString) {
        try {
            const patch = JSON.parse(jsonString);
            if (this.initTimer) clearTimeout(this.initTimer);

            Object.keys(this.modules).forEach(id => { if (id !== 'MIDI_IN' && id !== 'AUDIO_OUT') this.removeModule(id); });
            this.cables =[];

            let maxIdCounter = 1;
            patch.modules.forEach(mData => {
                let modId = mData.id;
                if (mData.type !== 'MIDI_IN' && mData.type !== 'AUDIO_OUT') {
                    modId = this.addModule(mData.type, mData.x, mData.y, mData.id);
                    const num = parseInt(mData.id.split('_').pop());
                    if (!isNaN(num) && num >= maxIdCounter) maxIdCounter = num + 1;
                } else { this.modules[mData.id].x = mData.x; this.modules[mData.id].y = mData.y; }

                const mod = this.modules[modId];
                if (mod && mData.params) {
                    mod.params = { ...mod.params, ...mData.params };
                    this.applyParamsToNodes(mod);
                    this.renderModuleUI(mod);
                }
            });

            this.moduleIdCounter = maxIdCounter;
            this.cables = patch.cables;
            this.rebuildInternalRouting();
            this.drawCables();
        } catch(e) { alert("Virheellinen Patch-tiedosto!"); }
    }

    loadPreset(index) {
        const presets =[
            // 0: Basic Synth
            { modules:[{ id: "MIDI_IN", type: "MIDI_IN", x: 20, y: 150 }, { id: "AUDIO_OUT", type: "AUDIO_OUT", x: 800, y: 150 }, { id: "mod_VCO_1", type: "VCO", x: 200, y: 50 }, { id: "mod_VCA_2", type: "VCA", x: 500, y: 50 }, { id: "mod_ADSR_3", type: "ADSR", x: 200, y: 250 }], cables:[{ id: 1, from: "MIDI_IN", port: "outPitch", to: "mod_VCO_1", target: "inPitch" }, { id: 2, from: "MIDI_IN", port: "outGate", to: "mod_ADSR_3", target: "inGate" }, { id: 3, from: "mod_VCO_1", port: "out", to: "mod_VCA_2", target: "inAudio" }, { id: 4, from: "mod_ADSR_3", port: "outEnv", to: "mod_VCA_2", target: "inCV" }, { id: 5, from: "mod_VCA_2", port: "out", to: "AUDIO_OUT", target: "inLeft" }, { id: 6, from: "mod_VCA_2", port: "out", to: "AUDIO_OUT", target: "inRight" }] },
            // 1: Basic with Filter
            { modules:[{ id: "MIDI_IN", type: "MIDI_IN", x: 20, y: 150 }, { id: "AUDIO_OUT", type: "AUDIO_OUT", x: 800, y: 150 }, { id: "vco", type: "VCO", x: 200, y: 50, params: {wave:"square"} }, { id: "vcf", type: "VCF", x: 380, y: 50, params: {freq: 200, res: 5} }, { id: "vca", type: "VCA", x: 560, y: 50 }, { id: "env", type: "ADSR", x: 200, y: 250, params: {d: 0.5, s: 0} }], cables:[{ from: "MIDI_IN", port: "outPitch", to: "vco", target: "inPitch" }, { from: "MIDI_IN", port: "outGate", to: "env", target: "inGate" }, { from: "vco", port: "out", to: "vcf", target: "inAudio" }, { from: "vcf", port: "out", to: "vca", target: "inAudio" }, { from: "env", port: "outEnv", to: "vcf", target: "inCV" }, { from: "env", port: "outEnv", to: "vca", target: "inCV" }, { from: "vca", port: "out", to: "AUDIO_OUT", target: "inLeft" }, { from: "vca", port: "out", to: "AUDIO_OUT", target: "inRight" }] },
            // 2: LFO FM Madness
            { modules:[{ id: "MIDI_IN", type: "MIDI_IN", x: 20, y: 150 }, { id: "AUDIO_OUT", type: "AUDIO_OUT", x: 800, y: 150 }, { id: "vco", type: "VCO", x: 200, y: 50 }, { id: "lfo", type: "LFO", x: 200, y: 250, params: {rate: 15, amp: 500} }, { id: "vca", type: "VCA", x: 450, y: 50 }, { id: "env", type: "ADSR", x: 450, y: 250 }], cables:[{ from: "MIDI_IN", port: "outPitch", to: "vco", target: "inPitch" }, { from: "MIDI_IN", port: "outGate", to: "env", target: "inGate" }, { from: "lfo", port: "out", to: "vco", target: "inFM" }, { from: "vco", port: "out", to: "vca", target: "inAudio" }, { from: "env", port: "outEnv", to: "vca", target: "inCV" }, { from: "vca", port: "out", to: "AUDIO_OUT", target: "inLeft" }, { from: "vca", port: "out", to: "AUDIO_OUT", target: "inRight" }] },
            // 3: Arpeggiator Delay
            { modules:[{ id: "MIDI_IN", type: "MIDI_IN", x: 20, y: 150 }, { id: "AUDIO_OUT", type: "AUDIO_OUT", x: 900, y: 150 }, { id: "arp", type: "ARP", x: 180, y: 50, params: {rate: 10, octaves: 2} }, { id: "vco", type: "VCO", x: 350, y: 50 }, { id: "vca", type: "VCA", x: 520, y: 50 }, { id: "env", type: "ADSR", x: 350, y: 250, params: {a: 0.01, d: 0.1, s: 0, r: 0.1} }, { id: "del", type: "DELAY", x: 700, y: 50 }], cables:[{ from: "MIDI_IN", port: "outPitch", to: "arp", target: "inPitch" }, { from: "MIDI_IN", port: "outGate", to: "arp", target: "inGate" }, { from: "arp", port: "outPitch", to: "vco", target: "inPitch" }, { from: "arp", port: "outGate", to: "env", target: "inGate" }, { from: "vco", port: "out", to: "vca", target: "inAudio" }, { from: "env", port: "outEnv", to: "vca", target: "inCV" }, { from: "vca", port: "out", to: "del", target: "inAudio" }, { from: "del", port: "out", to: "AUDIO_OUT", target: "inLeft" }, { from: "del", port: "out", to: "AUDIO_OUT", target: "inRight" }] },
            // 4: Trance Gate Chords
            { modules:[{ id: "MIDI_IN", type: "MIDI_IN", x: 20, y: 150 }, { id: "AUDIO_OUT", type: "AUDIO_OUT", x: 900, y: 150 }, { id: "vco", type: "VCO", x: 180, y: 50, params: {wave: "sawtooth"} }, { id: "tg", type: "TGATE", x: 350, y: 50 }, { id: "vca", type: "VCA", x: 520, y: 50 }, { id: "env", type: "ADSR", x: 520, y: 250 }, { id: "del", type: "DELAY", x: 700, y: 50, params: {time: 0.4, fdbk: 0.6} }], cables:[{ from: "MIDI_IN", port: "outPitch", to: "vco", target: "inPitch" }, { from: "MIDI_IN", port: "outGate", to: "env", target: "inGate" }, { from: "vco", port: "out", to: "tg", target: "inAudio" }, { from: "tg", port: "out", to: "vca", target: "inAudio" }, { from: "env", port: "outEnv", to: "vca", target: "inCV" }, { from: "vca", port: "out", to: "del", target: "inAudio" }, { from: "del", port: "out", to: "AUDIO_OUT", target: "inLeft" }, { from: "del", port: "out", to: "AUDIO_OUT", target: "inRight" }] },
            // 5: Draw Modulator Filter
            { modules:[{ id: "MIDI_IN", type: "MIDI_IN", x: 20, y: 150 }, { id: "AUDIO_OUT", type: "AUDIO_OUT", x: 800, y: 150 }, { id: "vco", type: "VCO", x: 200, y: 50 }, { id: "vcf", type: "VCF", x: 400, y: 50, params: {freq: 100} }, { id: "draw", type: "DRAW", x: 200, y: 250, params: {speed: 1.5} }, { id: "vca", type: "VCA", x: 600, y: 50 }, { id: "env", type: "ADSR", x: 600, y: 250 }], cables:[{ from: "MIDI_IN", port: "outPitch", to: "vco", target: "inPitch" }, { from: "MIDI_IN", port: "outGate", to: "env", target: "inGate" }, { from: "vco", port: "out", to: "vcf", target: "inAudio" }, { from: "draw", port: "outCV", to: "vcf", target: "inCV" }, { from: "vcf", port: "out", to: "vca", target: "inAudio" }, { from: "env", port: "outEnv", to: "vca", target: "inCV" }, { from: "vca", port: "out", to: "AUDIO_OUT", target: "inLeft" }, { from: "vca", port: "out", to: "AUDIO_OUT", target: "inRight" }] },
            // 6: Stereo Panning LFO
            { modules:[{ id: "MIDI_IN", type: "MIDI_IN", x: 20, y: 150 }, { id: "AUDIO_OUT", type: "AUDIO_OUT", x: 800, y: 150 }, { id: "vco", type: "VCO", x: 200, y: 50 }, { id: "vca", type: "VCA", x: 400, y: 50 }, { id: "env", type: "ADSR", x: 200, y: 250 }, { id: "pan", type: "PAN", x: 600, y: 50 }, { id: "lfo", type: "LFO", x: 600, y: 250, params: {rate: 0.5, amp: 1} }], cables:[{ from: "MIDI_IN", port: "outPitch", to: "vco", target: "inPitch" }, { from: "MIDI_IN", port: "outGate", to: "env", target: "inGate" }, { from: "vco", port: "out", to: "vca", target: "inAudio" }, { from: "env", port: "outEnv", to: "vca", target: "inCV" }, { from: "vca", port: "out", to: "pan", target: "inAudio" }, { from: "lfo", port: "out", to: "pan", target: "inCV" }, { from: "pan", port: "out", to: "AUDIO_OUT", target: "inLeft" }, { from: "pan", port: "out", to: "AUDIO_OUT", target: "inRight" }] },
            // 7: Dual Osc Fat Synth
            { modules:[{ id: "MIDI_IN", type: "MIDI_IN", x: 20, y: 150 }, { id: "AUDIO_OUT", type: "AUDIO_OUT", x: 800, y: 150 }, { id: "vco1", type: "VCO", x: 200, y: 50 }, { id: "vco2", type: "VCO", x: 200, y: 250, params: {tune: 445} }, { id: "vca", type: "VCA", x: 500, y: 150 }, { id: "env", type: "ADSR", x: 500, y: 350 }], cables:[{ from: "MIDI_IN", port: "outPitch", to: "vco1", target: "inPitch" }, { from: "MIDI_IN", port: "outPitch", to: "vco2", target: "inPitch" }, { from: "MIDI_IN", port: "outGate", to: "env", target: "inGate" }, { from: "vco1", port: "out", to: "vca", target: "inAudio" }, { from: "vco2", port: "out", to: "vca", target: "inAudio" }, { from: "env", port: "outEnv", to: "vca", target: "inCV" }, { from: "vca", port: "out", to: "AUDIO_OUT", target: "inLeft" }, { from: "vca", port: "out", to: "AUDIO_OUT", target: "inRight" }] },
            // 8: AM Tremolo
            { modules:[{ id: "MIDI_IN", type: "MIDI_IN", x: 20, y: 150 }, { id: "AUDIO_OUT", type: "AUDIO_OUT", x: 800, y: 150 }, { id: "vco", type: "VCO", x: 200, y: 50 }, { id: "am", type: "AM", x: 400, y: 50 }, { id: "lfo", type: "LFO", x: 400, y: 250, params: {rate: 5, amp: 1} }, { id: "vca", type: "VCA", x: 600, y: 50 }, { id: "env", type: "ADSR", x: 600, y: 250 }], cables:[{ from: "MIDI_IN", port: "outPitch", to: "vco", target: "inPitch" }, { from: "MIDI_IN", port: "outGate", to: "env", target: "inGate" }, { from: "vco", port: "out", to: "am", target: "inAudio" }, { from: "lfo", port: "out", to: "am", target: "inMod" }, { from: "am", port: "out", to: "vca", target: "inAudio" }, { from: "env", port: "outEnv", to: "vca", target: "inCV" }, { from: "vca", port: "out", to: "AUDIO_OUT", target: "inLeft" }, { from: "vca", port: "out", to: "AUDIO_OUT", target: "inRight" }] },
            // 9: Generative Random (ARP vapaana)
            { modules:[{ id: "MIDI_IN", type: "MIDI_IN", x: 20, y: 150 }, { id: "AUDIO_OUT", type: "AUDIO_OUT", x: 900, y: 150 }, { id: "lfo", type: "LFO", x: 180, y: 250, params: {rate: 0.2, amp: 20} }, { id: "arp", type: "ARP", x: 180, y: 50, params: {mode: "random"} }, { id: "vco", type: "VCO", x: 350, y: 50 }, { id: "vcf", type: "VCF", x: 520, y: 50 }, { id: "vca", type: "VCA", x: 700, y: 50 }, { id: "env", type: "ADSR", x: 700, y: 250 }], cables:[{ from: "MIDI_IN", port: "outPitch", to: "arp", target: "inPitch" }, { from: "lfo", port: "out", to: "arp", target: "inRate" }, { from: "arp", port: "outPitch", to: "vco", target: "inPitch" }, { from: "arp", port: "outGate", to: "env", target: "inGate" }, { from: "vco", port: "out", to: "vcf", target: "inAudio" }, { from: "vcf", port: "out", to: "vca", target: "inAudio" }, { from: "env", port: "outEnv", to: "vca", target: "inCV" }, { from: "vca", port: "out", to: "AUDIO_OUT", target: "inLeft" }, { from: "vca", port: "out", to: "AUDIO_OUT", target: "inRight" }] }
        ];

        const p = JSON.parse(JSON.stringify(presets[index]));
        p.cables.forEach((c, i) => c.id = i + 100);
        this.loadPatch(JSON.stringify(p));
    }

    getState() { return { modules: Object.values(this.modules).map(m => ({ id: m.id, type: m.type, x: m.x, y: m.y, params: { ...m.params } })), cables: this.cables }; }
    setState(state) { if (state && state.modules) this.loadPatch(JSON.stringify(state)); }
    getNodes() { return { input: this.input, output: this.output }; }

    renderUI(containerElement) {
        containerElement.style.setProperty('--ms-color', '#00ffcc');
        
        if(!document.getElementById('ms-styles')) {
            const style = document.createElement('style');
            style.id = 'ms-styles';
            style.textContent = `
                .ms-panel { position:relative; background:#111; border-radius:8px; border:1px solid #333; height: 500px; overflow: hidden; display:flex; flex-direction:column; transition: all 0.2s ease;}
                .ms-panel.fullscreen { position: fixed !important; top: 0; left: 0; right: 0; bottom: 0; width: 100vw; height: 100vh; z-index: 10000; margin: 0; border-radius: 0; border: none; }
                .ms-toolbar { padding: 10px; background: #0a0a0a; border-bottom: 1px solid #333; display: flex; gap: 6px; flex-shrink:0; align-items:center; flex-wrap:wrap;}
                .ms-btn { background:#222; border:1px solid var(--ms-color); color:var(--ms-color); cursor:pointer; padding:4px 8px; border-radius:4px; font-family:monospace; font-size:10px; font-weight:bold; transition:all 0.2s; box-shadow: 0 0 5px rgba(0,255,204,0.1); }
                .ms-btn:hover { background:var(--ms-color); color:#000; box-shadow: 0 0 15px var(--ms-color); }
                .ms-btn-fs { border-color:#fff; color:#fff; background: #333; } .ms-btn-fs:hover { background:#fff; color:#000; box-shadow: 0 0 15px #fff; }
                .ms-btn-small { background:#222; border:1px solid #fff; color:#fff; cursor:pointer; padding:3px 6px; border-radius:3px; font-size:9px; font-family:monospace; transition:all 0.2s; }
                .ms-btn-small:hover { background:#fff; color:#000; }
                
                .ms-select { background:#000; border:1px solid #fff; color:#fff; padding:4px; font-family:monospace; font-size:10px; border-radius:4px; outline:none; }
                
                .ms-canvas { position:relative; flex-grow:1; background-image: radial-gradient(#222 1px, transparent 1px); background-size: 20px 20px; overflow:auto; user-select:none; }
                .ms-canvas-inner { position: relative; width: 2000px; height: 2000px; }
                
                .ms-module { 
                    position:absolute; 
                    border:2px solid #555; 
                    border-radius:6px; 
                    box-shadow: inset 1px 1px 2px rgba(255,255,255,0.2), inset -1px -1px 2px rgba(0,0,0,0.5), 0 5px 15px rgba(0,0,0,0.5);
                    width:130px; 
                    display:flex; 
                    flex-direction:column; 
                    z-index:10; 
                    background-image: linear-gradient(135deg, rgba(255,255,255,0.15) 0%, rgba(0,0,0,0.4) 100%),
                                      repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(0,0,0,0.05) 2px, rgba(0,0,0,0.05) 4px);
                    background-blend-mode: overlay;
                }
                
                .ms-module canvas { max-width: 100%; box-sizing: border-box; display: inline-block !important; }
                
                .ms-mod-header { background: rgba(0,0,0,0.6); padding:5px; text-align:center; font-family:monospace; font-size:11px; font-weight:bold; border-bottom:1px solid rgba(255,255,255,0.1); border-radius:4px 4px 0 0; cursor:grab; text-shadow: 1px 1px 2px #000; position:relative;}
                .ms-mod-body { padding: 10px; display:flex; flex-direction:column; gap:8px; background: rgba(0,0,0,0.5); border-radius: 0 0 4px 4px;}
                .ms-mod-del { position:absolute; top:-6px; right:-6px; width:16px; height:16px; background:#ff003c; border-radius:50%; font-size:9px; color:#fff; border:none; cursor:pointer; box-shadow: 0 0 5px #ff003c; z-index: 25;}
                
                .ms-led { width: 8px; height: 8px; border-radius: 50%; background: #330000; border: 1px solid #111; box-shadow: inset 0 1px 3px rgba(0,0,0,0.8); position: absolute; right: 5px; top: 7px; transition: background 0.05s, box-shadow 0.05s; }
                .ms-led.active { background: #ff3333; box-shadow: 0 0 10px #ff0000, inset 0 1px 2px rgba(255,255,255,0.5); }

                .ms-port-row { display:flex; justify-content:space-between; align-items:center; position:relative; height:12px; }
                .ms-port { width:12px; height:12px; background:#111; border:2px solid #aaa; border-radius:50%; position:absolute; cursor:crosshair; transition:all 0.2s; z-index:20; box-shadow:inset 0 0 5px #000;}
                .ms-port:hover { background:#fff; transform:scale(1.2); box-shadow: 0 0 10px #fff; }
                .ms-port.in { left: -18px; } .ms-port.out { right: -18px; }
                .ms-port-label { font-family:monospace; font-size:9px; color:#ddd; width:100%; text-align:center; pointer-events:none; text-shadow: 1px 1px 1px #000;}
                
                /* KNOB STYLES */
                .ms-controls-grid { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 5px; }
                .ms-knob-container { display: flex; flex-direction: column; align-items: center; width: 30px; }
                .ms-knob { width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(145deg, #444, #111); border: 1px solid #000; position: relative; cursor: ns-resize; box-shadow: 0 3px 5px rgba(0,0,0,0.6), inset 0 1px 2px rgba(255,255,255,0.2); }
                .ms-knob-indicator { position: absolute; top: 3px; left: 12.5px; width: 2px; height: 8px; background: #fff; transform-origin: 1px 11px; box-shadow: 0 0 4px #fff; border-radius: 1px; pointer-events:none;}
                .ms-knob-label { font-size: 9px; font-family: monospace; color: #ddd; margin-top: 4px; text-shadow: 1px 1px 1px #000; font-weight:bold; }
                
                .ms-wire-layer { position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:15; }
                .ms-wire { stroke-width: 4; fill: none; stroke-linecap: round; pointer-events: stroke; cursor: pointer; transition: stroke-width 0.1s; }
                .ms-wire:hover { stroke-width: 7; filter: brightness(1.5) !important; }
                
                .ms-control { display:flex; justify-content:space-between; align-items:center; }
                .ms-control label { font-family:monospace; font-size:9px; color:#ddd; text-shadow: 1px 1px 1px #000;}
                .ms-control select { width:60px; background:#000; border:1px solid #555; color:#fff; font-size:9px; padding:2px; font-family:monospace; }
                
                .tg-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; margin-top: 5px; }
                .tg-step { height: 12px; background: #000; border: 1px solid #444; border-radius: 2px; cursor: pointer; }
                .tg-step.active { background: #fff; box-shadow: 0 0 5px #fff;}
                
                .wave-container { display: flex; gap: 4px; height: 50px; background: #000; border: 1px solid #444; border-radius: 2px; padding: 2px; }
                .wave-canvas { flex-grow: 1; background: #000; height: 100%; }
                .wave-meter { width: 4px; background: #222; position: relative; height: 100%; border-radius: 1px; overflow: hidden; }
                .wave-meter-fill { position: absolute; bottom: 0; left: 0; width: 100%; background: #fff; transition: height 0.1s; }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div style="margin-bottom: 10px; color: var(--ms-color); font-weight: bold; text-align: center; letter-spacing: 4px; font-size: 14px; text-shadow: 0 0 10px rgba(0,255,204,0.5);">MODULAR SYNTHESIZER</div>
            <div class="ms-panel">
                <div class="ms-toolbar">
                    <button class="ms-btn" id="ms-add-vco">VCO</button>
                    <button class="ms-btn" id="ms-add-vcf">VCF</button>
                    <button class="ms-btn" id="ms-add-vca">VCA</button>
                    <button class="ms-btn" id="ms-add-lfo">LFO</button>
                    <button class="ms-btn" id="ms-add-adsr">ADSR</button>
                    <button class="ms-btn" id="ms-add-arp">ARP</button>
                    <button class="ms-btn" id="ms-add-draw">DRAW</button>
                    <button class="ms-btn" id="ms-add-wav">WAV</button>
                    
                    <div style="display:flex; gap:2px; border-left:1px solid #444; padding-left:6px;">
                        <button class="ms-btn" id="ms-add-am">AM</button>
                        <button class="ms-btn" id="ms-add-eq">EQ</button>
                        <button class="ms-btn" id="ms-add-lpf">LPF</button>
                        <button class="ms-btn" id="ms-add-hpf">HPF</button>
                        <button class="ms-btn" id="ms-add-vol">VOL</button>
                        <button class="ms-btn" id="ms-add-pan">PAN</button>
                        <button class="ms-btn" id="ms-add-delay">DELAY</button>
                        <button class="ms-btn" id="ms-add-wave">W-FORM</button>
                        <button class="ms-btn" id="ms-add-tgate">T-GATE</button>
                    </div>
                    
                    <div style="margin-left:auto; display:flex; align-items:center; gap:10px;">
                        <select class="ms-select" id="ms-presets">
                            <option value="0">01 Basic Synth</option>
                            <option value="1">02 Filtered Pluck</option>
                            <option value="2">03 FM Madness</option>
                            <option value="3">04 Arp Delay</option>
                            <option value="4">05 Trance Gate</option>
                            <option value="5">06 Draw Filter</option>
                            <option value="6">07 Panning LFO</option>
                            <option value="7">08 Dual Osc Fat</option>
                            <option value="8">09 AM Tremolo</option>
                            <option value="9">10 Generative Rand</option>
                        </select>
                        <button class="ms-btn" id="ms-save-patch" style="border-color:#0088ff; color:#0088ff;">Save</button>
                        <button class="ms-btn" id="ms-load-patch" style="border-color:#0088ff; color:#0088ff;">Load</button>
                        <input type="file" id="ms-file-input" accept=".json" style="display:none;">
                        <div id="ms-display" style="font-family:monospace; font-size:12px; color:#555; font-weight:bold; background:#000; padding:2px 6px; border:1px solid #333; border-radius:4px; min-width:50px; text-align:center;">-</div>
                        <button class="ms-btn" id="ms-clear-wires" style="border-color:#ff003c; color:#ff003c;">Clear</button>
                        <button class="ms-btn ms-btn-fs" id="ms-fullscreen">⛶ Fullscreen</button>
                    </div>
                </div>
                <div class="ms-canvas" id="ms-scroll-area">
                    <div class="ms-canvas-inner" id="ms-canvas">
                        <svg class="ms-wire-layer" id="ms-svg"></svg>
                    </div>
                </div>
            </div>
        `;

        this.canvas = containerElement.querySelector('#ms-canvas');
        this.svg = containerElement.querySelector('#ms-svg');
        this.uiDisplay = containerElement.querySelector('#ms-display');
        this.scrollArea = containerElement.querySelector('#ms-scroll-area');

        containerElement.querySelectorAll('.ms-btn').forEach(btn => {
            const type = btn.innerText.replace('W-FORM','WAVE').replace('T-GATE','TGATE');
            if(this.modColors[type]) {
                btn.style.borderColor = this.modColors[type];
                btn.style.color = this.modColors[type];
                btn.onmouseenter = () => { btn.style.background = this.modColors[type]; btn.style.color = '#000'; };
                btn.onmouseleave = () => { btn.style.background = '#222'; btn.style.color = this.modColors[type]; };
            }
        });

        const panel = containerElement.querySelector('.ms-panel');
        const fsBtn = containerElement.querySelector('#ms-fullscreen');
        fsBtn.onclick = () => {
            panel.classList.toggle('fullscreen');
            fsBtn.innerText = panel.classList.contains('fullscreen') ? '✖ Exit FS' : '⛶ Fullscreen';
            setTimeout(() => this.drawCables(), 50);
        };

        const addM = (id, type) => containerElement.querySelector(id).onclick = () => this.addModule(type, this.scrollArea.scrollLeft + 150, this.scrollArea.scrollTop + 100);
        addM('#ms-add-vco', 'VCO'); addM('#ms-add-wav', 'WAV'); addM('#ms-add-vcf', 'VCF'); addM('#ms-add-vca', 'VCA'); addM('#ms-add-lfo', 'LFO'); addM('#ms-add-adsr', 'ADSR'); addM('#ms-add-arp', 'ARP'); addM('#ms-add-draw', 'DRAW');
        addM('#ms-add-am', 'AM'); addM('#ms-add-eq', 'EQ'); addM('#ms-add-lpf', 'LPF'); addM('#ms-add-hpf', 'HPF'); addM('#ms-add-vol', 'VOL'); addM('#ms-add-pan', 'PAN'); addM('#ms-add-delay', 'DELAY');
        addM('#ms-add-wave', 'WAVE'); addM('#ms-add-tgate', 'TGATE');
        
        containerElement.querySelector('#ms-clear-wires').onclick = () => { this.cables =[]; this.rebuildInternalRouting(); this.drawCables(); };

        containerElement.querySelector('#ms-presets').onchange = (e) => this.loadPreset(parseInt(e.target.value));

        containerElement.querySelector('#ms-save-patch').onclick = () => this.savePatch();
        const fileInput = containerElement.querySelector('#ms-file-input');
        containerElement.querySelector('#ms-load-patch').onclick = () => fileInput.click();
        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => { this.loadPatch(ev.target.result); fileInput.value = ''; };
            reader.readAsText(file);
        };

        this.setupInteractions();
        Object.values(this.modules).forEach(m => this.renderModuleUI(m));
        setTimeout(() => this.drawCables(), 100);
    }

    makeKnobHTML(id, label, min, max, val, step) {
        return `
            <div class="ms-knob-container">
                <div class="ms-knob" data-id="${id}" data-min="${min}" data-max="${max}" data-step="${step}" data-val="${val}" title="${val}">
                    <div class="ms-knob-indicator"></div>
                </div>
                <div class="ms-knob-label">${label}</div>
            </div>
        `;
    }

    handleKnobChange(mod, id, val) {
        if (id === 'sens') { mod.params.sens = val; if(this.worklet) this.worklet.port.postMessage({action:'setSensitivity', value:val}); }
        else if (id === 'tune') { mod.params.tune = val; if(mod.nodes.osc) mod.nodes.osc.frequency.value = val; this.rebuildInternalRouting(); }
        else if (id === 'freq') { mod.params.freq = val; mod.nodes.filter.frequency.value = val; }
        else if (id === 'res') { mod.params.res = val; mod.nodes.filter.Q.value = val; }
        else if (id === 'rate') { mod.params.rate = val; if(mod.nodes.osc) mod.nodes.osc.frequency.value = val; }
        else if (id === 'amp') { mod.params.amp = val; mod.nodes.amp.gain.value = val; }
        else if (['a','d','s','r'].includes(id)) { mod.params[id] = val; }
        else if (id === 'octs') { mod.params.octaves = val; }
        else if (id === 'speed') { mod.params.speed = val; }
        else if (id === 'depth') { mod.params.depth = val; }
        else if (id === 'vol') { mod.params.vol = val; mod.nodes.gain.gain.value = val; }
        else if (id === 'pan') { mod.params.pan = val; mod.nodes.panner.pan.value = val; }
        else if (id === 'time') { mod.params.time = val; mod.nodes.delay.delayTime.value = val; }
        else if (id === 'fdbk') { mod.params.fdbk = val; mod.nodes.fdbk.gain.value = val; }
        else if (id === 'low') { mod.params.low = val; if(mod.nodes.low) mod.nodes.low.gain.value = val; }
        else if (id === 'mid') { mod.params.mid = val; if(mod.nodes.mid) mod.nodes.mid.gain.value = val; }
        else if (id === 'high') { mod.params.high = val; if(mod.nodes.high) mod.nodes.high.gain.value = val; }
    }

    attachKnobEvents(mod) {
        if(!mod.domNode) return;
        mod.domNode.querySelectorAll('.ms-knob').forEach(knobEl => {
            const min = parseFloat(knobEl.dataset.min);
            const max = parseFloat(knobEl.dataset.max);
            const step = parseFloat(knobEl.dataset.step);
            const id = knobEl.dataset.id;
            let currentVal = parseFloat(knobEl.dataset.val);

            const updateVisual = (v) => {
                const pct = (v - min) / (max - min);
                const deg = -135 + (pct * 270);
                knobEl.querySelector('.ms-knob-indicator').style.transform = `rotate(${deg}deg)`;
                knobEl.title = v.toFixed(step < 1 ? 2 : 0);
            };
            updateVisual(currentVal);

            let startY = 0, startVal = 0;
            const onMove = (e) => {
                const deltaY = startY - e.clientY; 
                let newVal = startVal + (deltaY * (max - min) / 150); 
                newVal = Math.max(min, Math.min(max, newVal));
                if(step > 0) newVal = Math.round(newVal / step) * step;
                currentVal = newVal;
                knobEl.dataset.val = currentVal;
                updateVisual(currentVal);
                this.handleKnobChange(mod, id, currentVal);
            };
            const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            };

            knobEl.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                startY = e.clientY;
                startVal = currentVal;
                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
            });
        });
    }

    renderModuleUI(mod) {
        if (!this.canvas) return;
        if (mod.domNode) mod.domNode.remove();

        const el = document.createElement('div');
        el.className = 'ms-module';
        el.dataset.id = mod.id;
        el.style.left = mod.x + 'px';
        el.style.top = mod.y + 'px';
        
        const bgColor = this.modColors[mod.type] || '#555555';
        el.style.backgroundColor = bgColor;

        let portsHTML = '';
        Object.keys(mod.ports).forEach(pKey => {
            const p = mod.ports[pKey];
            const align = p.type === 'in' ? 'left' : 'right';
            portsHTML += `
                <div class="ms-port-row">
                    ${p.type==='in' ? `<div class="ms-port in" data-port="${pKey}"></div>` : ''}
                    <span class="ms-port-label" style="text-align:${align}">${pKey.replace('in','').replace('out','')}</span>
                    ${p.type==='out' ? `<div class="ms-port out" data-port="${pKey}"></div>` : ''}
                </div>
            `;
        });

        let controlsHTML = '';
        if (mod.type === 'MIDI_IN') { controlsHTML = `<div class="ms-controls-grid">${this.makeKnobHTML('sens', 'SENS', 1, 10, mod.params.sens, 1)}</div>`; } 
        else if(mod.type === 'VCO') { controlsHTML = `<div class="ms-control"><select id="vco-wave-${mod.id}" style="width:100%; margin-bottom:5px;"><option value="sawtooth" ${mod.params.wave==='sawtooth'?'selected':''}>Sawtooth</option><option value="square" ${mod.params.wave==='square'?'selected':''}>Square</option><option value="sine" ${mod.params.wave==='sine'?'selected':''}>Sine</option></select></div><div class="ms-controls-grid">${this.makeKnobHTML('tune', 'TUNE', 20, 2000, mod.params.tune, 1)}</div>`; } 
        else if(mod.type === 'WAV') { controlsHTML = `<div class="ms-control" style="margin-bottom: 5px; flex-direction: column;"><button class="ms-btn-small" id="wav-btn-${mod.id}">Load WAV...</button><input type="file" id="wav-file-${mod.id}" accept="audio/*" style="display:none;"><div style="font-size:9px; color:#fff; text-align:center; margin-top: 3px;">${mod.params.fileName}</div></div><div class="ms-controls-grid">${this.makeKnobHTML('tune', 'TUNE', 20, 2000, mod.params.tune, 1)}</div>`; } 
        else if (['VCF', 'LPF', 'HPF'].includes(mod.type)) { controlsHTML = `<div class="ms-controls-grid">${this.makeKnobHTML('freq', 'FREQ', 20, 5000, mod.params.freq, 1)}${this.makeKnobHTML('res', 'RES', 0, 20, mod.params.res, 0.1)}</div>`; } 
        else if (mod.type === 'LFO') { controlsHTML = `<div class="ms-controls-grid">${this.makeKnobHTML('rate', 'RATE', 0.1, 20, mod.params.rate, 0.1)}${this.makeKnobHTML('amp', 'AMP', 0, 1000, mod.params.amp, 1)}</div>`; } 
        else if (mod.type === 'ADSR') { controlsHTML = `<canvas id="adsr-cvs-${mod.id}" width="110" height="40" style="background:#000; border:1px solid #444; margin-bottom:5px; border-radius:2px;"></canvas><div class="ms-controls-grid">${this.makeKnobHTML('a', 'A', 0, 2, mod.params.a, 0.01)}${this.makeKnobHTML('d', 'D', 0, 2, mod.params.d, 0.01)}${this.makeKnobHTML('s', 'S', 0, 1, mod.params.s, 0.01)}${this.makeKnobHTML('r', 'R', 0, 3, mod.params.r, 0.01)}</div>`; } 
        else if (mod.type === 'ARP') { 
            controlsHTML = `
                <div class="ms-control"><select id="arp-m-${mod.id}" style="width:48%;"><option value="up" ${mod.params.mode==='up'?'selected':''}>Up</option><option value="down" ${mod.params.mode==='down'?'selected':''}>Down</option><option value="updown" ${mod.params.mode==='updown'?'selected':''}>Up/Dn</option><option value="random" ${mod.params.mode==='random'?'selected':''}>Rand</option></select><select id="arp-c-${mod.id}" style="width:48%;"><option value="octaves" ${mod.params.chord==='octaves'?'selected':''}>Oct</option><option value="major" ${mod.params.chord==='major'?'selected':''}>Maj</option><option value="minor" ${mod.params.chord==='minor'?'selected':''}>Min</option><option value="sus4" ${mod.params.chord==='sus4'?'selected':''}>Sus4</option></select></div>
                <div class="ms-controls-grid">${this.makeKnobHTML('rate', 'RATE', 1, 30, mod.params.rate, 1)}${this.makeKnobHTML('octs', 'OCTS', 1, 4, mod.params.octaves, 1)}</div>
            `; 
        } 
        else if (mod.type === 'DRAW') {
            controlsHTML = `
                <div class="ms-control" style="margin-bottom:4px;">
                    <button class="ms-btn-small" id="draw-clr-${mod.id}" style="width:100%;">CLEAR</button>
                </div>
                <canvas id="draw-cvs-${mod.id}" width="110" height="60" style="background:#000; border:1px solid #444; cursor:crosshair; touch-action:none; margin-bottom:5px; border-radius:2px;"></canvas>
                <div class="ms-controls-grid">${this.makeKnobHTML('speed', 'SPEED', 0.1, 10, mod.params.speed, 0.1)}</div>
            `;
        }
        else if (mod.type === 'AM') { controlsHTML = `<div class="ms-controls-grid">${this.makeKnobHTML('depth', 'DEPTH', 0, 1, mod.params.depth, 0.05)}</div>`; }
        else if (mod.type === 'EQ') { 
            controlsHTML = `
                <canvas id="eq-cvs-${mod.id}" width="110" height="40" style="background:#000; border:1px solid #444; margin-bottom:5px; border-radius:2px;"></canvas>
                <div class="ms-controls-grid">
                    ${this.makeKnobHTML('low', 'LOW', -15, 15, mod.params.low, 0.5)}
                    ${this.makeKnobHTML('mid', 'MID', -15, 15, mod.params.mid, 0.5)}
                    ${this.makeKnobHTML('high', 'HIGH', -15, 15, mod.params.high, 0.5)}
                </div>
            `; 
        }
        else if (mod.type === 'VOL') { controlsHTML = `<div class="ms-controls-grid">${this.makeKnobHTML('vol', 'VOL', 0, 2, mod.params.vol, 0.01)}</div>`; } 
        else if (mod.type === 'PAN') { controlsHTML = `<div class="ms-controls-grid">${this.makeKnobHTML('pan', 'PAN', -1, 1, mod.params.pan, 0.05)}</div>`; } 
        else if (mod.type === 'DELAY') { controlsHTML = `<div class="ms-controls-grid">${this.makeKnobHTML('time', 'TIME', 0, 2, mod.params.time, 0.01)}${this.makeKnobHTML('fdbk', 'FDBK', 0, 0.95, mod.params.fdbk, 0.05)}</div>`; }
        else if (mod.type === 'WAVE') {
            controlsHTML = `
                <div class="wave-container">
                    <canvas id="wave-cvs-${mod.id}" class="wave-canvas" width="90" height="46"></canvas>
                    <div class="wave-meter"><div class="wave-meter-fill" id="wave-l-${mod.id}"></div></div>
                    <div class="wave-meter"><div class="wave-meter-fill" id="wave-r-${mod.id}"></div></div>
                </div>
            `;
        }
        else if (mod.type === 'TGATE') {
            let stepsHTML = '';
            for(let i=0; i<16; i++) stepsHTML += `<div class="tg-step ${mod.params.steps[i] ? 'active' : ''}" data-idx="${i}"></div>`;
            controlsHTML = `
                <div class="tg-grid" id="tg-grid-${mod.id}">${stepsHTML}</div>
                <div class="ms-control" style="margin-top:5px; justify-content:center;"><label style="margin-right:5px;">Sync</label><input type="checkbox" id="tg-s-${mod.id}" ${mod.params.sync ? 'checked' : ''}></div>
                <div class="ms-controls-grid">${this.makeKnobHTML('rate', 'RATE', 1, 30, mod.params.rate, 1)}</div>
            `;
        }

        const delBtn = (mod.id !== 'MIDI_IN' && mod.id !== 'AUDIO_OUT') ? `<button class="ms-mod-del">X</button>` : '';

        el.innerHTML = `
            <div class="ms-mod-header" style="color:#fff;">
                ${mod.type}
                <div class="ms-led"></div>
            </div>
            <div class="ms-mod-body">${portsHTML}<hr style="border:0; border-top:1px solid rgba(255,255,255,0.2); margin: 4px 0;">${controlsHTML}</div>
            ${delBtn}
        `;

        this.canvas.appendChild(el);
        mod.domNode = el;

        this.attachKnobEvents(mod);

        if(mod.type === 'VCO') { el.querySelector(`#vco-wave-${mod.id}`).onchange = (e) => { mod.params.wave = e.target.value; mod.nodes.osc.type = e.target.value; }; } 
        else if(mod.type === 'WAV') { const btn = el.querySelector(`#wav-btn-${mod.id}`); const input = el.querySelector(`#wav-file-${mod.id}`); btn.onclick = () => input.click(); input.onchange = (e) => { if(e.target.files.length > 0) mod.loadBuffer(e.target.files[0]); }; } 
        else if (mod.type === 'ARP') { 
            el.querySelector(`#arp-m-${mod.id}`).onchange = (e) => mod.params.mode = e.target.value; 
            el.querySelector(`#arp-c-${mod.id}`).onchange = (e) => mod.params.chord = e.target.value; 
        } 
        else if (mod.type === 'DRAW') {
            const btnClr = el.querySelector(`#draw-clr-${mod.id}`);
            const cvs = el.querySelector(`#draw-cvs-${mod.id}`);

            btnClr.onclick = () => { mod.params.points =[]; };
            
            let isPointerDown = false;
            const addPoint = (e) => {
                const rect = cvs.getBoundingClientRect();
                const clientX = e.clientX || (e.touches && e.touches[0].clientX);
                const clientY = e.clientY || (e.touches && e.touches[0].clientY);
                const scaleX = rect.width ? (cvs.width / rect.width) : 1;
                const scaleY = rect.height ? (cvs.height / rect.height) : 1;
                const x = (clientX - rect.left) * scaleX;
                const y = (clientY - rect.top) * scaleY;
                mod.params.points.push({x, y});
            };

            cvs.addEventListener('mousedown', (e) => { isPointerDown = true; mod.params.points =[]; addPoint(e); });
            cvs.addEventListener('mousemove', (e) => { if(isPointerDown) addPoint(e); });
            cvs.addEventListener('mouseup', () => { isPointerDown = false; });
            cvs.addEventListener('mouseleave', () => { isPointerDown = false; });
            
            cvs.addEventListener('touchstart', (e) => { e.preventDefault(); isPointerDown = true; mod.params.points =[]; addPoint(e); }, {passive:false});
            cvs.addEventListener('touchmove', (e) => { e.preventDefault(); if(isPointerDown) addPoint(e); }, {passive:false});
            cvs.addEventListener('touchend', (e) => { e.preventDefault(); isPointerDown = false; }, {passive:false});
        }
        else if (mod.type === 'TGATE') {
            const grid = el.querySelector(`#tg-grid-${mod.id}`);
            grid.addEventListener('click', (e) => {
                if(e.target.classList.contains('tg-step')) {
                    const idx = parseInt(e.target.dataset.idx);
                    mod.params.steps[idx] = mod.params.steps[idx] ? 0 : 1;
                    e.target.classList.toggle('active');
                }
            });
            el.querySelector(`#tg-s-${mod.id}`).onchange = (e) => mod.params.sync = e.target.checked;
        }

        if(delBtn) el.querySelector('.ms-mod-del').onclick = () => this.removeModule(mod.id);
    }

    setupInteractions() {
        let draggedModId = null;
        let dragOffset = {x:0, y:0};

        const getPortPos = (modId, portId) => {
            const m = this.modules[modId];
            if(!m || !m.domNode) return null;
            const p = m.domNode.querySelector(`[data-port="${portId}"]`);
            if(!p) return null;
            const rect = p.getBoundingClientRect();
            const cRect = this.canvas.getBoundingClientRect();
            return { x: rect.left - cRect.left + rect.width/2, y: rect.top - cRect.top + rect.height/2 };
        };

        this.canvas.addEventListener('pointerdown', (e) => {
            if(e.target.classList.contains('ms-port')) {
                e.preventDefault();
                this.isWiring = true;
                this.wireStart = { mod: e.target.closest('.ms-module').dataset.id, port: e.target.dataset.port, type: e.target.classList.contains('out') ? 'out' : 'in' };
            } else if(e.target.classList.contains('ms-mod-header')) {
                e.preventDefault();
                const modEl = e.target.closest('.ms-module');
                draggedModId = modEl.dataset.id;
                const rect = modEl.getBoundingClientRect();
                dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                modEl.style.zIndex = 100;
            }
        });

        window.addEventListener('pointermove', (e) => {
            if(draggedModId) {
                const cRect = this.canvas.getBoundingClientRect();
                let x = e.clientX - cRect.left - dragOffset.x;
                let y = e.clientY - cRect.top - dragOffset.y;
                this.modules[draggedModId].x = x;
                this.modules[draggedModId].y = y;
                this.modules[draggedModId].domNode.style.left = x + 'px';
                this.modules[draggedModId].domNode.style.top = y + 'px';
                this.drawCables();
            }
            if(this.isWiring) {
                const cRect = this.canvas.getBoundingClientRect();
                this.drawCables(getPortPos(this.wireStart.mod, this.wireStart.port), { x: e.clientX - cRect.left, y: e.clientY - cRect.top });
            }
        });

        window.addEventListener('pointerup', (e) => {
            if(draggedModId) {
                if(this.modules[draggedModId]) this.modules[draggedModId].domNode.style.zIndex = 10;
                draggedModId = null;
            }

            if(this.isWiring) {
                this.isWiring = false;
                const dropTarget = document.elementFromPoint(e.clientX, e.clientY);
                if(dropTarget && dropTarget.classList.contains('ms-port')) {
                    const toMod = dropTarget.closest('.ms-module').dataset.id;
                    const toPort = dropTarget.dataset.port;
                    const toType = dropTarget.classList.contains('out') ? 'out' : 'in';

                    if(this.wireStart.type !== toType && this.wireStart.mod !== toMod) {
                        const fromMod = this.wireStart.type === 'out' ? this.wireStart.mod : toMod;
                        const fromP = this.wireStart.type === 'out' ? this.wireStart.port : toPort;
                        const toM = this.wireStart.type === 'in' ? this.wireStart.mod : toMod;
                        const toP = this.wireStart.type === 'in' ? this.wireStart.port : toPort;

                        this.cables = this.cables.filter(c => !(c.to === toM && c.target === toP));
                        this.cables.push({ id: Date.now(), from: fromMod, port: fromP, to: toM, target: toP });
                        this.rebuildInternalRouting();
                    }
                }
                this.drawCables();
            }
        });

        this.svg.addEventListener('click', (e) => {
            if(e.target.classList.contains('ms-wire')) {
                const cid = parseInt(e.target.dataset.id);
                this.cables = this.cables.filter(c => c.id !== cid);
                this.rebuildInternalRouting();
                this.drawCables();
            }
        });
    }

    drawCables(tempStart = null, tempEnd = null) {
        if(!this.svg) return;
        this.svg.innerHTML = '';

        const getPos = (modId, portId) => {
            const m = this.modules[modId];
            if(!m || !m.domNode) return null;
            const p = m.domNode.querySelector(`[data-port="${portId}"]`);
            if(!p) return null;
            const rect = p.getBoundingClientRect();
            const cRect = this.canvas.getBoundingClientRect();
            return { x: rect.left - cRect.left + rect.width/2, y: rect.top - cRect.top + rect.height/2 };
        };

        const drawCurve = (x1, y1, x2, y2, id, sourceModId = null) => {
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            const cp = Math.max(Math.abs(x2 - x1) / 2, 50);
            path.setAttribute("d", `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`);
            path.setAttribute("class", "ms-wire");
            
            let strokeColor = '#ffffff';
            if (sourceModId && this.modules[sourceModId]) {
                const t = this.modules[sourceModId].type;
                if (this.modColors[t]) strokeColor = this.modColors[t];
            }
            path.style.stroke = strokeColor;
            path.style.filter = `drop-shadow(0 0 3px ${strokeColor})`;

            if(id) path.setAttribute("data-id", id);
            else path.style.pointerEvents = 'none';
            this.svg.appendChild(path);
        };

        this.cables.forEach(c => {
            const s = getPos(c.from, c.port);
            const e = getPos(c.to, c.target);
            if(s && e) drawCurve(s.x, s.y, e.x, e.y, c.id, c.from);
        });

        if(tempStart && tempEnd) {
            const sourceId = this.wireStart.type === 'out' ? this.wireStart.mod : null;
            if(this.wireStart.type === 'out') drawCurve(tempStart.x, tempStart.y, tempEnd.x, tempEnd.y, null, sourceId);
            else drawCurve(tempEnd.x, tempEnd.y, tempStart.x, tempStart.y, null, sourceId);
        }
    }
}