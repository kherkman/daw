// audiosampler.js
// Äänisignaalin perusteella MIDI-nuotteja ja Sampleja liipaiseva (Audio-to-MIDI / Sampler) efekti.
// Sisältää: LPF/HPF filtterit, Graafisen audion thresholdin, Velocity-mäppäyksen ja Sample editoinnin.

window.CustomAudioEffect = class AudioSamplerEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        
        // Reititys (Input -> LPF -> HPF -> Analyser -> Worklet(Trigger))
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain(); // Sekoitetaan ulostulevat samplet tänne
        
        // Annetaan alkuperäisen äänen mennä läpi, jos käyttäjä haluaa (Mix ohjaa)
        this.dry = audioCtx.createGain();
        this.wet = audioCtx.createGain();
        this.input.connect(this.dry);
        this.dry.connect(this.output);
        this.wet.connect(this.output);

        this.hpf = audioCtx.createBiquadFilter(); this.hpf.type = 'highpass'; this.hpf.frequency.value = 20;
        this.lpf = audioCtx.createBiquadFilter(); this.lpf.type = 'lowpass'; this.lpf.frequency.value = 20000;
        
        this.analyser = audioCtx.createAnalyser();
        this.analyser.fftSize = 512;

        this.input.connect(this.hpf);
        this.hpf.connect(this.lpf);
        this.lpf.connect(this.analyser);

        // Asetukset
        this.mix = 0.5;
        this.thresholdDb = -20;
        this.outputMidiNote = 60; // Keski-C
        
        this.samples = []; // Lista sample objekteista
        this.selectedSampleId = null;
        this.rrState = {}; // Round Robin seuranta

        this.knobs = {};
        this.ui = { container: null, grid: null, inspector: null };

        this.updateMix();
        this._initWorklet();
    }

    updateMix() {
        this.dry.gain.setTargetAtTime(Math.cos(this.mix * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
        this.wet.gain.setTargetAtTime(Math.sin(this.mix * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
    }

    updateThreshold() {
        if (this.worklet) {
            this.worklet.port.postMessage({ type: 'setThreshold', value: Math.pow(10, this.thresholdDb / 20) });
        }
    }

    async _initWorklet() {
        const code = `
            class AudioSamplerProcessor extends AudioWorkletProcessor {
                constructor() {
                    super();
                    this.threshold = 0.1;
                    this.triggered = false;
                    this.cooldown = 0;
                    this.port.onmessage = (e) => {
                        if (e.data.type === 'setThreshold') this.threshold = e.data.value;
                    };
                }
                process(inputs) {
                    const input = inputs[0];
                    if (!input || !input.length) return true;
                    
                    let peak = 0;
                    for (let i = 0; i < input[0].length; i++) {
                        const val = Math.abs(input[0][i]);
                        if (val > peak) peak = val;
                    }
                    
                    if (this.cooldown > 0) {
                        this.cooldown -= input[0].length;
                        if (this.cooldown <= 0 && peak < this.threshold * 0.5) {
                            this.triggered = false;
                        }
                    } else {
                        if (peak > this.threshold && !this.triggered) {
                            this.triggered = true;
                            this.cooldown = sampleRate * 0.08; // 80ms retrigger cooldown
                            
                            // Map peak to MIDI velocity (1-127)
                            let vel = Math.round((peak / 1.0) * 127);
                            vel = Math.max(1, Math.min(127, vel));
                            
                            this.port.postMessage({ type: 'trigger', velocity: vel });
                        } else if (peak < this.threshold * 0.5) {
                            this.triggered = false;
                        }
                    }
                    return true;
                }
            }
            registerProcessor('audiosampler-processor', AudioSamplerProcessor);
        `;
        const dataUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(code);
        try {
            await this.ctx.audioWorklet.addModule(dataUrl);
            this.worklet = new AudioWorkletNode(this.ctx, 'audiosampler-processor');
            this.updateThreshold();
            this.worklet.port.onmessage = (e) => {
                if (e.data.type === 'trigger') this.onTrigger(e.data.velocity);
            };
            this.lpf.connect(this.worklet);
        } catch (err) { console.error("AudioSampler Worklet error:", err); }
    }

    sendMidi(msg) {
        // Broadcastataan midi-tapahtuma ohjelmalle
        if (typeof this.onMidiOut === 'function') this.onMidiOut(msg);
        else window.dispatchEvent(new CustomEvent('midi-broadcast', { detail: { msg: msg } }));
    }

    onTrigger(velocity) {
        // Etsi kaikki velocityyn sopivat samplet
        const matches = this.samples.filter(s => velocity >= s.minVel && velocity <= s.maxVel);
        
        if (matches.length > 0) {
            // Round Robin
            const hash = matches.map(s => s.id).sort().join('_');
            if (this.rrState[hash] === undefined) this.rrState[hash] = 0;
            const sample = matches[this.rrState[hash] % matches.length];
            this.rrState[hash]++;
            this.playSample(sample, velocity);
        }

        // MIDI Output
        this.sendMidi([0x90, this.outputMidiNote, velocity]);
        
        // Pieni välähdys UI:hin
        if (this.ui.container) {
            const ind = this.ui.container.querySelector('#trig-indicator');
            if (ind) {
                ind.style.background = '#ff00ff'; ind.style.boxShadow = '0 0 15px #ff00ff';
                setTimeout(() => { ind.style.background = '#333'; ind.style.boxShadow = 'none'; }, 100);
            }
        }
    }

    playSample(sample, velocity) {
        const source = this.ctx.createBufferSource();
        source.buffer = sample.buffer;
        
        const vca = this.ctx.createGain();
        source.connect(vca);
        vca.connect(this.wet);

        const now = this.ctx.currentTime;
        const velGain = Math.pow(velocity / 127, 2); 
        const maxGain = velGain * sample.gain;
        
        const startOffset = sample.startCut;
        const playDur = Math.max(0.01, sample.endCut - sample.startCut);

        vca.gain.setValueAtTime(0, now);
        vca.gain.linearRampToValueAtTime(maxGain, now + sample.fadeIn);
        vca.gain.setValueAtTime(maxGain, now + playDur - sample.fadeOut);
        vca.gain.linearRampToValueAtTime(0, now + playDur);

        source.start(now, startOffset);
        source.stop(now + playDur + 0.1);
        
        // MIDI Note Off
        setTimeout(() => this.sendMidi([0x80, this.outputMidiNote, 0]), playDur * 1000);
    }

    getNodes() { return { input: this.input, output: this.output }; }

    generateId() { return Math.random().toString(36).substring(2, 9); }

    async loadAudioFile(file) {
        try {
            const arrayBuffer = await file.arrayBuffer();
            const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
            
            const sample = {
                id: this.generateId(), name: file.name, buffer: audioBuffer,
                minVel: 1, maxVel: 127,
                startCut: 0, endCut: audioBuffer.duration,
                fadeIn: 0.005, fadeOut: 0.05, gain: 1.0
            };
            this.samples.push(sample);
            this.selectedSampleId = sample.id;
            this.renderGrid();
            this.updateInspector();
        } catch (e) { console.error(e); }
    }

    // --- UI FUNKTIOT ---
    
    renderGrid() {
        if (!this.ui.grid) return;
        this.ui.grid.innerHTML = '';
        
        this.samples.forEach(s => {
            const el = document.createElement('div');
            el.className = `vel-region ${this.selectedSampleId === s.id ? 'selected' : ''}`;
            el.style.top = `${((127 - s.maxVel) / 127) * 100}%`;
            el.style.height = `${((s.maxVel - s.minVel) / 127) * 100}%`;
            el.innerHTML = `<div class="v-title">${s.name}</div>`;
            
            el.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                this.selectedSampleId = s.id;
                this.renderGrid(); this.updateInspector();
            });

            // Resizing handles (Top = maxVel, Bottom = minVel)
            if (this.selectedSampleId === s.id) {
                const addHandle = (isTop) => {
                    const h = document.createElement('div');
                    h.className = `v-resize-handle ${isTop ? 'top' : 'bottom'}`;
                    h.addEventListener('mousedown', (e) => {
                        e.stopPropagation();
                        let startY = e.clientY;
                        let startMax = s.maxVel;
                        let startMin = s.minVel;
                        const rect = this.ui.grid.getBoundingClientRect();
                        
                        const move = (ev) => {
                            const deltaVel = Math.round(-((ev.clientY - startY) / rect.height) * 127);
                            if (isTop) s.maxVel = Math.min(127, Math.max(s.minVel + 1, startMax + deltaVel));
                            else s.minVel = Math.max(1, Math.min(s.maxVel - 1, startMin + deltaVel));
                            this.renderGrid();
                        };
                        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
                        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
                    });
                    el.appendChild(h);
                };
                addHandle(true); addHandle(false);
            }
            this.ui.grid.appendChild(el);
        });
    }

    drawWaveform(sample, canvas) {
        if(!canvas || !sample.buffer) return;
        const ctx = canvas.getContext('2d');
        const data = sample.buffer.getChannelData(0);
        const w = canvas.width, h = canvas.height;
        const step = Math.ceil(data.length / w);
        const amp = h / 2;
        
        ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#ff00ff';
        for(let i=0; i<w; i++) {
            let min = 1.0, max = -1.0;
            for(let j=0; j<step; j++) {
                const val = data[(i*step)+j];
                if(val < min) min = val; if(val > max) max = val;
            }
            ctx.fillRect(i, amp + (min * amp), 1, Math.max(1, (max - min) * amp));
        }
        
        // Overlays
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        const sx = (sample.startCut / sample.buffer.duration) * w;
        const ex = (sample.endCut / sample.buffer.duration) * w;
        ctx.fillRect(0, 0, sx, h); ctx.fillRect(ex, 0, w - ex, h);
        
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(sx,0); ctx.lineTo(sx,h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(ex,0); ctx.lineTo(ex,h); ctx.stroke();
    }

    createKnob(container, label, min, max, val, isFloat, onChange) {
        const div = document.createElement('div');
        div.className = 's-knob-container';
        div.innerHTML = `
            <div class="s-knob-label">${label}</div>
            <div class="s-knob-wrapper"><svg viewBox="0 0 30 30"><circle cx="15" cy="15" r="12" fill="none" stroke="#222" stroke-width="3" stroke-dasharray="56.5 75.4" transform="rotate(135 15 15)"></circle><circle class="s-k-val" cx="15" cy="15" r="12" fill="none" stroke="#0ff" stroke-width="3" stroke-dasharray="0 75.4" transform="rotate(135 15 15)"></circle></svg><div class="s-knob-dot-wrap"><div class="s-knob-dot"></div></div></div>
            <div class="s-knob-display">0</div>
        `;
        const valPath = div.querySelector('.s-k-val'), dotWrap = div.querySelector('.s-knob-dot-wrap'), disp = div.querySelector('.s-knob-display');
        let current = val;

        const updateUI = (v) => {
            const pct = (v - min) / (max - min);
            valPath.setAttribute('stroke-dasharray', `${pct * 56.5} 75.4`);
            dotWrap.style.transform = `rotate(${-135 + (pct * 270)}deg)`;
            disp.innerText = isFloat ? v.toFixed(2) : Math.round(v);
        };
        updateUI(current); container.appendChild(div);

        let drag = false, sy = 0, sv = 0;
        div.querySelector('.s-knob-wrapper').addEventListener('mousedown', e => { drag = true; sy = e.clientY; sv = current; document.body.style.cursor = 'ns-resize'; });
        window.addEventListener('mousemove', e => { if(!drag) return; let nv = sv + ((sy - e.clientY)/100)*(max-min); nv = Math.max(min, Math.min(max, nv)); if(nv !== current){ current = nv; updateUI(nv); onChange(nv); }});
        window.addEventListener('mouseup', () => { if(drag){ drag = false; document.body.style.cursor = 'default';}});
        return { setValue: (v) => { current = v; updateUI(v); } };
    }

    updateInspector() {
        if (!this.ui.inspector) return;
        const sample = this.samples.find(s => s.id === this.selectedSampleId);
        
        if (!sample) {
            this.ui.inspector.innerHTML = `<div style="color:#666; font-style:italic; padding: 20px;">Lataa WAV-tiedosto ja valitse se listasta.</div>`;
            return;
        }

        this.ui.inspector.innerHTML = `
            <div style="display:flex; justify-content:space-between; margin-bottom:10px; border-bottom:1px solid #333; padding-bottom:10px;">
                <div style="font-size:12px; color:#ff00ff; font-weight:bold;">${sample.name}</div>
                <button class="s-btn" id="btn-del-samp" style="border-color:#f05; color:#f05;">POISTA</button>
            </div>
            <canvas id="samp-wave" width="400" height="80" style="width:100%; height:80px; background:#000; border:1px solid #333; border-radius:4px; margin-bottom:15px; cursor:ew-resize;"></canvas>
            <div id="samp-knobs" style="display:flex; gap:15px; justify-content:center; flex-wrap:wrap;"></div>
        `;

        const canvas = this.ui.inspector.querySelector('#samp-wave');
        this.drawWaveform(sample, canvas);

        canvas.addEventListener('mousedown', (e) => {
            const rect = canvas.getBoundingClientRect();
            let isStart = Math.abs((e.clientX - rect.left) - (sample.startCut/sample.buffer.duration)*rect.width) < Math.abs((e.clientX - rect.left) - (sample.endCut/sample.buffer.duration)*rect.width);
            
            const move = (ev) => {
                let x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
                let time = (x / rect.width) * sample.buffer.duration;
                if(isStart) { sample.startCut = Math.min(time, sample.endCut - 0.01); startK.setValue(sample.startCut); }
                else { sample.endCut = Math.max(time, sample.startCut + 0.01); endK.setValue(sample.endCut); }
                this.drawWaveform(sample, canvas);
            };
            const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.cursor='default'; };
            window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); document.body.style.cursor='ew-resize';
        });

        const kArea = this.ui.inspector.querySelector('#samp-knobs');
        const startK = this.createKnob(kArea, 'Start', 0, sample.buffer.duration, sample.startCut, true, v => { sample.startCut = Math.min(v, sample.endCut-0.01); this.drawWaveform(sample, canvas); });
        const endK = this.createKnob(kArea, 'End', 0, sample.buffer.duration, sample.endCut, true, v => { sample.endCut = Math.max(v, sample.startCut+0.01); this.drawWaveform(sample, canvas); });
        this.createKnob(kArea, 'FadeIn', 0, 1.0, sample.fadeIn, true, v => { sample.fadeIn = v; });
        this.createKnob(kArea, 'FadeOut', 0, 1.0, sample.fadeOut, true, v => { sample.fadeOut = v; });
        this.createKnob(kArea, 'Vol', 0, 3.0, sample.gain, true, v => { sample.gain = v; });

        this.ui.inspector.querySelector('#btn-del-samp').addEventListener('click', () => {
            this.samples = this.samples.filter(s => s.id !== sample.id);
            this.selectedSampleId = null;
            this.renderGrid(); this.updateInspector();
        });
    }

    renderUI(containerElement) {
        const styleId = 'fx-audiosampler-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .samp-panel { background: #111; padding: 15px; border-radius: 8px; border: 1px solid #333; font-family: monospace; color: #eee; }
                .s-btn { background: #222; border: 1px solid #0ff; color: #0ff; padding: 5px 10px; cursor: pointer; border-radius: 4px; transition: 0.2s; font-family:monospace; font-size:11px;}
                .s-btn:hover { background: rgba(0,255,255,0.2); }
                
                .samp-layout { display: flex; gap: 20px; flex-wrap: wrap; margin-top:15px; }
                
                /* Velocity Grid */
                .vel-grid-container { width: 120px; height: 250px; background: #0a0a0a; border: 1px solid #444; border-radius: 4px; position: relative; display:flex; flex-direction:column; }
                .vel-grid { position:absolute; top:0; left:30px; right:0; bottom:0; background-image: linear-gradient(#1a1a1a 1px, transparent 1px); background-size: 100% 12.5%; overflow:hidden;}
                .vel-ruler { position:absolute; top:0; left:0; bottom:0; width:30px; border-right:1px solid #333; display:flex; flex-direction:column; justify-content:space-between; font-size:9px; color:#666; padding:2px; box-sizing:border-box;}
                
                .vel-region { position: absolute; left:2px; right:2px; background: rgba(255,0,255,0.2); border: 1px solid #f0f; border-radius: 3px; display:flex; justify-content:center; align-items:center; z-index:10; cursor:pointer;}
                .vel-region.selected { background: rgba(0,255,255,0.4); border-color: #0ff; z-index: 11; box-shadow: 0 0 10px rgba(0,255,255,0.5); }
                .v-title { font-size: 9px; font-weight: bold; word-break:break-all; text-align:center; pointer-events:none;}
                .v-resize-handle { position: absolute; left:0; right:0; height:6px; cursor: ns-resize; background:transparent;}
                .v-resize-handle:hover { background: rgba(255,255,255,0.3); }
                .v-resize-handle.top { top:-3px; } .v-resize-handle.bottom { bottom:-3px; }

                /* Knobs */
                .s-knob-container { display:flex; flex-direction:column; align-items:center; width: 40px;}
                .s-knob-label { font-size: 9px; color: #888; margin-bottom:2px; text-transform:uppercase;}
                .s-knob-wrapper { position:relative; width:36px; height:36px; cursor: ns-resize; }
                .s-knob-dot-wrap { position:absolute; top:0; left:0; right:0; bottom:0; pointer-events:none; }
                .s-knob-dot { position:absolute; width:4px; height:4px; background:#0ff; border-radius:50%; top:4px; left:50%; transform:translateX(-50%);}
                .s-knob-display { font-size: 9px; color: #aaa; margin-top:2px; background:#000; padding:1px 3px; border-radius:2px; border:1px solid #333;}
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div class="samp-panel">
                <div style="font-weight: bold; color: #ff00ff; margin-bottom:15px; letter-spacing:2px;">AUDIO TRIGGER SAMPLER</div>
                
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #333; padding-bottom:10px; flex-wrap:wrap; gap:10px;">
                    <div style="display:flex; gap:10px; align-items:center;">
                        <input type="file" id="as-file-upload" accept="audio/wav,audio/mp3" style="display:none;">
                        <button class="s-btn" id="btn-load-samp">+ LOAD WAV</button>
                    </div>
                    <div style="display:flex; align-items:center; gap:5px;">
                        <label style="font-size:10px; color:#aaa;">MIDI OUT NOTE:</label>
                        <input type="number" id="midi-out-note" value="${this.outputMidiNote}" min="0" max="127" style="width:50px; background:#000; color:#0ff; border:1px solid #0ff; outline:none; font-family:monospace; padding:3px; text-align:center;">
                        <div id="trig-indicator" style="width:10px; height:10px; border-radius:50%; background:#333; margin-left:10px;"></div>
                    </div>
                    <div id="smix-knob"></div>
                </div>

                <div class="samp-layout">
                    <!-- Vasen: Filterit & Detektori -->
                    <div style="flex:1; min-width:200px; display:flex; flex-direction:column; gap:15px;">
                        <div style="display:flex; justify-content:space-around; background:#0a0a0a; padding:10px; border-radius:4px; border:1px solid #222;">
                            <div id="hpf-knob"></div>
                            <div id="lpf-knob"></div>
                            <div id="thr-knob"></div>
                        </div>
                        <div style="background:#000; border:1px solid #333; height:80px; position:relative; border-radius:4px;">
                            <div style="position:absolute; top:3px; left:5px; font-size:9px; color:#666;">TRIGGER INPUT</div>
                            <canvas id="samp-thresh-canvas" style="width:100%; height:100%; display:block;"></canvas>
                        </div>
                    </div>

                    <!-- Keski: Velocity Mapping -->
                    <div style="display:flex; flex-direction:column; align-items:center; gap:5px;">
                        <div style="font-size:10px; color:#ff00ff;">VELOCITY MAP</div>
                        <div class="vel-grid-container">
                            <div class="vel-ruler"><span>127</span><span>64</span><span>1</span></div>
                            <div class="vel-grid" id="vel-grid"></div>
                        </div>
                    </div>

                    <!-- Oikea: Inspector -->
                    <div style="flex:2; min-width:250px; background:#1a1a1a; border:1px solid #333; border-radius:4px; padding:10px;" id="samp-inspector">
                    </div>
                </div>
            </div>
        `;

        this.ui.grid = containerElement.querySelector('#vel-grid');
        this.ui.inspector = containerElement.querySelector('#samp-inspector');

        const fileInput = containerElement.querySelector('#as-file-upload');
        containerElement.querySelector('#btn-load-samp').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', e => { if (e.target.files.length > 0) this.loadAudioFile(e.target.files[0]); });

        containerElement.querySelector('#midi-out-note').addEventListener('change', e => this.outputMidiNote = parseInt(e.target.value));

        this.createKnob(containerElement.querySelector('#smix-knob'), 'MIX', 0, 1.0, this.mix, v => Math.round(v*100)+'%', v => { this.mix = v; this.updateMix(); });
        this.createKnob(containerElement.querySelector('#hpf-knob'), 'HPF', 20, 1000, this.hpf.frequency.value, v => Math.round(v)+'Hz', v => this.hpf.frequency.value = v);
        this.createKnob(containerElement.querySelector('#lpf-knob'), 'LPF', 200, 20000, this.lpf.frequency.value, v => Math.round(v)+'Hz', v => this.lpf.frequency.value = v);
        this.createKnob(containerElement.querySelector('#thr-knob'), 'THRESH', -60, 0, this.thresholdDb, v => Math.round(v)+'dB', v => { this.thresholdDb = v; this.updateThreshold(); });

        this.renderGrid(); this.updateInspector();

        // Audion graafinen piirtoluuppi Thresholdia varten
        const tCanvas = containerElement.querySelector('#samp-thresh-canvas');
        const tCtx = tCanvas.getContext('2d');
        const historySize = 100;
        const peakHistory = new Array(historySize).fill(-60);
        let checkCount = 0;

        const drawThresholdCanvas = () => {
            checkCount++;
            if (!document.body.contains(tCanvas)) {
                if (checkCount > 10) return;
                return requestAnimationFrame(drawThresholdCanvas);
            }
            if (tCanvas.width !== tCanvas.parentElement.clientWidth) {
                tCanvas.width = tCanvas.parentElement.clientWidth;
                tCanvas.height = tCanvas.parentElement.clientHeight;
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

            peakHistory.push(peakDb); peakHistory.shift();
            const dbToY = (db) => h - ((db + 60) / 60) * h;

            // Kynnysviiva
            const threshY = dbToY(this.thresholdDb);
            tCtx.strokeStyle = 'rgba(255, 0, 255, 0.8)';
            tCtx.lineWidth = 1; tCtx.setLineDash([4, 4]);
            tCtx.beginPath(); tCtx.moveTo(0, threshY); tCtx.lineTo(w, threshY); tCtx.stroke(); tCtx.setLineDash([]);

            // Audiosignaali
            tCtx.fillStyle = 'rgba(0, 255, 255, 0.4)';
            tCtx.beginPath(); tCtx.moveTo(0, h);
            for(let i=0; i<historySize; i++) {
                tCtx.lineTo((i / (historySize - 1)) * w, dbToY(peakHistory[i]));
            }
            tCtx.lineTo(w, h); tCtx.fill();

            requestAnimationFrame(drawThresholdCanvas);
        };
        drawThresholdCanvas();
    }
}