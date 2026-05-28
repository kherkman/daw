// limit-comp-gate.js
// Dynamiikkaprosessori (Kompressori, Limitteri, Noise Gate) visualisoinnilla ja Sidechainilla
window.CustomAudioEffect = class DynamicsEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        
        // Pääreititys
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        
        // Sidechain reititys
        this.sidechainInput = audioCtx.createGain();
        this.useSidechain = false; // Tila: kuunnellaanko Main vai Sidechain

        // Varsinainen vaimennus tehdään tällä GainNodella (korvaa native compressorin ja gaten)
        this.dynGain = audioCtx.createGain();
        this.outGain = audioCtx.createGain(); // Makeup gain

        // Analysaattorit visualisointia varten
        this.analyserIn = audioCtx.createAnalyser();
        this.analyserIn.fftSize = 512;
        this.analyserIn.smoothingTimeConstant = 0.8;

        this.sidechainAnalyser = audioCtx.createAnalyser();
        this.sidechainAnalyser.fftSize = 512;
        this.sidechainAnalyser.smoothingTimeConstant = 0.8;

        this.analyserOut = audioCtx.createAnalyser();
        this.analyserOut.fftSize = 512;

        // Oletusarvot ja tilat
        this.mode = 'Compression'; // 'Compression', 'Limiter', 'Noise Gate'
        this.gateThreshold = -24; 
        this.currentReduction = 0;

        // Sisäiset parametrit
        this.thresh = -24;
        this.ratio = 4;
        this.attack = 0.05;
        this.release = 0.25;
        this.knee = 30;
        this.gainDb = 0;

        // UI-referenssit
        this.knobs = {};
        this.uiElements = {};

        // Valmistellaan detektorin reititys: yhdistetään Main ja SC yhteen Nodeen analysointia varten
        this.mainMono = audioCtx.createGain(); this.mainMono.channelCount = 1; this.mainMono.channelCountMode = 'explicit';
        this.scMono = audioCtx.createGain(); this.scMono.channelCount = 1; this.scMono.channelCountMode = 'explicit';
        
        this.merger = audioCtx.createChannelMerger(2);
        this.input.connect(this.mainMono);
        this.sidechainInput.connect(this.scMono);
        this.mainMono.connect(this.merger, 0, 0); // Main -> kanava 0
        this.scMono.connect(this.merger, 0, 1);   // SC -> kanava 1

        // Käytetään pienempää puskuria (512) tiukempaa reagointia varten
        this.detectorProcessor = audioCtx.createScriptProcessor(512, 2, 1);
        this.merger.connect(this.detectorProcessor);
        this.detectorProcessor.connect(audioCtx.destination); // Täytyy kytkeä jonnekin

        // Signaaliketju: Input -> analyserIn -> dynGain -> outGain -> analyserOut -> Output
        this.input.connect(this.analyserIn);
        this.sidechainInput.connect(this.sidechainAnalyser);
        
        this.input.connect(this.dynGain);
        this.dynGain.connect(this.outGain);
        this.outGain.connect(this.analyserOut);
        this.outGain.connect(this.output);

        // Kustomoitu Dynamiikka-matematiikka (Korvaa alkuperäisen DynamicsCompressorNoden mahdollistaen sidechainin)
        this.detectorProcessor.onaudioprocess = (e) => {
            const mainData = e.inputBuffer.getChannelData(0);
            const scData = e.inputBuffer.getChannelData(1);
            
            // Valitaan kumman signaalin voimakkuutta kuunnellaan
            const activeData = this.useSidechain ? scData : mainData;

            let sumSquares = 0;
            for (let i = 0; i < activeData.length; i++) {
                sumSquares += activeData[i] * activeData[i];
            }
            const rms = Math.sqrt(sumSquares / activeData.length);
            const db = 20 * Math.log10(Math.max(rms, 0.0001));

            let targetReductionDb = 0;

            if (this.mode === 'Noise Gate') {
                // Noise Gate logiikka
                targetReductionDb = db > this.thresh ? 0 : -60;
            } else {
                // Kompressori / Limiter logiikka
                let overshoot = 0;
                
                // Knee laskenta
                if (this.knee > 0) {
                    if (db > this.thresh + this.knee / 2) {
                        overshoot = db - this.thresh;
                    } else if (db > this.thresh - this.knee / 2) {
                        overshoot = Math.pow(db - (this.thresh - this.knee / 2), 2) / (2 * this.knee);
                    }
                } else {
                    if (db > this.thresh) overshoot = db - this.thresh;
                }

                // Vaimennuksen laskenta
                if (overshoot > 0 && this.ratio > 1) {
                    targetReductionDb = -(overshoot - (overshoot / this.ratio));
                }
            }

            // Muutetaan desibelivaimennus lineaariseksi kertoimeksi
            const targetLinear = Math.pow(10, targetReductionDb / 20);
            const currentGain = this.dynGain.gain.value;

            // Attack on kun vaimennus kasvaa (gain laskee), Release kun vaimennus poistuu (gain nousee)
            const timeConstant = targetLinear < currentGain ? this.attack : this.release;

            // Sovelletaan vaimennus pehmeästi Web Audio API:n kautta
            if (this.ctx.state === 'running') {
                this.dynGain.gain.setTargetAtTime(targetLinear, this.ctx.currentTime, timeConstant);
            } else {
                this.dynGain.gain.value = targetLinear;
            }
            
            // Tallennetaan UI:ta varten
            this.currentReduction = targetReductionDb; 
        };

        this.applyInternalParams();
    }

    applyInternalParams() {
        this.gateThreshold = this.thresh;
        // Makeup gainin päivitys
        const factor = Math.pow(10, this.gainDb / 20);
        this.outGain.gain.setTargetAtTime(factor, this.ctx.currentTime, 0.05);
    }

    getNodes() { 
        return { input: this.input, output: this.output, sidechain: this.sidechainInput }; 
    }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            mode: this.mode,
            thresh: this.thresh,
            ratio: this.ratio,
            attack: this.attack,
            release: this.release,
            knee: this.knee,
            gainDb: this.gainDb,
            useSidechain: this.useSidechain
        };
    }

    setState(state) {
        if (!state) return;

        if (state.mode !== undefined) {
            this.mode = state.mode;
            if (this.uiElements.modeSelect) this.uiElements.modeSelect.value = this.mode;
        }

        if (state.thresh !== undefined) { this.thresh = state.thresh; if (this.knobs['Threshold']) this.knobs['Threshold'].setValue(this.thresh); }
        if (state.ratio !== undefined) { this.ratio = state.ratio; if (this.knobs['Ratio']) this.knobs['Ratio'].setValue(this.ratio); }
        if (state.attack !== undefined) { this.attack = state.attack; if (this.knobs['Attack']) this.knobs['Attack'].setValue(this.attack); }
        if (state.release !== undefined) { this.release = state.release; if (this.knobs['Release']) this.knobs['Release'].setValue(this.release); }
        if (state.knee !== undefined) { this.knee = state.knee; if (this.knobs['Knee']) this.knobs['Knee'].setValue(this.knee); }
        if (state.gainDb !== undefined) { this.gainDb = state.gainDb; if (this.knobs['Gain']) this.knobs['Gain'].setValue(this.gainDb); }
        
        if (state.useSidechain !== undefined) { 
            this.useSidechain = state.useSidechain; 
            if (this.uiElements.scBtn) {
                this.uiElements.scBtn.innerText = this.useSidechain ? 'SIDECHAIN' : 'MAIN';
                this.uiElements.scBtn.style.background = this.useSidechain ? '#9c27b0' : '#1a1a24';
                this.uiElements.scBtn.style.borderColor = this.useSidechain ? '#e1bee7' : 'rgba(255,255,255,0.2)';
            }
        }

        this.applyInternalParams();
        this._updateUIVisibility();
    }

    _updateUIVisibility() {
        if (this.mode === 'Noise Gate') {
            if (this.knobs['Ratio']) this.knobs['Ratio'].element.style.opacity = '0.3';
            if (this.knobs['Knee']) this.knobs['Knee'].element.style.opacity = '0.3';
        } else {
            if (this.knobs['Ratio']) this.knobs['Ratio'].element.style.opacity = '1';
            if (this.knobs['Knee']) this.knobs['Knee'].element.style.opacity = '1';
        }
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#00ffcc';
        containerElement.style.setProperty('--fx-color', color);

        const styleId = 'fx-dyn-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .dyn-dashboard { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; padding: 15px 0; gap: 20px; }
                .dyn-panel { background: rgba(0,0,0,0.4); border: 1px solid rgba(0, 255, 204, 0.2); border-radius: 8px; padding: 15px; margin-bottom: 15px; }
                .dyn-select { background: #000; color: var(--fx-color); border: 1px solid var(--fx-color); padding: 5px 10px; border-radius: 4px; font-family: monospace; font-size: 12px; outline: none; cursor: pointer; text-transform: uppercase; }
                .dyn-btn:hover { background: var(--fx-color); color: #000; transition: 0.2s; }
                .knob-container { display: flex; flex-direction: column; align-items: center; user-select: none; width: 70px; }
                .knob-wrapper { position: relative; width: 60px; height: 60px; cursor: ns-resize; margin-bottom: 8px; touch-action: none; }
                .knob-svg { width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 5px rgba(255,255,255,0.2)); }
                .knob-track { fill: none; stroke: #2a2a3b; stroke-width: 8; stroke-linecap: round; }
                .knob-value-path { fill: none; stroke: var(--fx-color); stroke-width: 8; stroke-linecap: round; transition: stroke 0.2s; }
                .knob-wrapper:active .knob-value-path, .knob-wrapper:hover .knob-value-path { stroke: #fff; filter: drop-shadow(0 0 8px var(--fx-color)); }
                .knob-center { fill: #1a1a24; stroke: #333; stroke-width: 2; }
                .knob-indicator { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
                .knob-dot { position: absolute; width: 6px; height: 6px; background: var(--fx-color); border-radius: 50%; top: 6px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 8px var(--fx-color); }
                .knob-label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #8b8b9f; margin-bottom: 5px; text-align: center; }
                .knob-value-display { font-size: 11px; font-family: monospace; color: #fff; background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); text-align: center; min-width: 40px; }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div style="margin-bottom: 15px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">DYNAMICS ENGINE</div>
            
            <div class="dyn-panel" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <label style="font-size: 11px; color: #8b8b9f; text-transform: uppercase;">Mode:</label>
                    <select id="dyn-preset" class="dyn-select">
                        <option value="Compression">Compression</option>
                        <option value="Limiter">Limiter</option>
                        <option value="Noise Gate">Noise Gate</option>
                    </select>
                </div>
                
                <div style="display: flex; align-items: center; gap: 10px;">
                    <label style="font-size: 11px; color: #8b8b9f; text-transform: uppercase;">Source:</label>
                    <button id="dyn-sc-btn" class="dyn-select" style="background: #1a1a24; border-color: rgba(255,255,255,0.2); color: white;">MAIN</button>
                </div>
            </div>

            <div style="width: 100%; max-width: 500px; height: 120px; background: rgba(0,0,0,0.8); border: 1px solid rgba(0, 255, 204, 0.3); border-radius: 6px; margin: 0 auto 15px auto; overflow: hidden; position: relative;">
                <canvas id="dyn-canvas" style="width: 100%; height: 100%; display: block;"></canvas>
                <div style="position: absolute; top: 5px; left: 5px; font-size: 9px; color: rgba(255,255,255,0.5); font-family: monospace;">GR / PEAK / THR</div>
            </div>

            <div class="dyn-dashboard" id="dyn-knobs"></div>
        `;

        const presetSelect = containerElement.querySelector('#dyn-preset');
        this.uiElements.modeSelect = presetSelect;
        presetSelect.value = this.mode;

        const scBtn = containerElement.querySelector('#dyn-sc-btn');
        this.uiElements.scBtn = scBtn;
        
        // Alustetaan sidechain-napin ulkoasu
        scBtn.innerText = this.useSidechain ? 'SIDECHAIN' : 'MAIN';
        scBtn.style.background = this.useSidechain ? '#9c27b0' : '#1a1a24';
        scBtn.style.borderColor = this.useSidechain ? '#e1bee7' : 'rgba(255,255,255,0.2)';

        scBtn.onclick = () => {
            this.useSidechain = !this.useSidechain;
            scBtn.innerText = this.useSidechain ? 'SIDECHAIN' : 'MAIN';
            scBtn.style.background = this.useSidechain ? '#9c27b0' : '#1a1a24';
            scBtn.style.borderColor = this.useSidechain ? '#e1bee7' : 'rgba(255,255,255,0.2)';
        };

        const knobsContainer = containerElement.querySelector('#dyn-knobs');
        const canvas = containerElement.querySelector('#dyn-canvas');
        const ctx2d = canvas.getContext('2d');

        const createKnob = (container, label, min, max, defaultValue, formatValue, onChange) => {
            const div = document.createElement('div');
            div.className = 'knob-container';
            const radius = 25, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            div.innerHTML = `
                <div class="knob-label">${label}</div>
                <div class="knob-wrapper">
                    <svg class="knob-svg" viewBox="0 0 60 60">
                        <circle class="knob-track" cx="30" cy="30" r="${radius}" stroke-dasharray="${maxDash} ${circumference}" />
                        <circle class="knob-value-path" cx="30" cy="30" r="${radius}" stroke-dasharray="0 ${circumference}" />
                        <circle class="knob-center" cx="30" cy="30" r="16" />
                    </svg>
                    <div class="knob-indicator"><div class="knob-dot"></div></div>
                </div>
                <div class="knob-value-display">${formatValue(defaultValue)}</div>
            `;
            const wrapper = div.querySelector('.knob-wrapper'), valuePath = div.querySelector('.knob-value-path'), indicator = div.querySelector('.knob-indicator'), display = div.querySelector('.knob-value-display');
            let currentValue = defaultValue;

            const updateUI = (value, triggerCallback = false) => {
                const normalized = (value - min) / (max - min);
                valuePath.setAttribute('stroke-dasharray', `${normalized * maxDash} ${circumference}`);
                indicator.style.transform = `rotate(${-135 + (normalized * 270)}deg)`;
                display.innerText = formatValue(value);
                if (triggerCallback) onChange(value);
            };
            
            updateUI(currentValue);
            container.appendChild(div);

            let isDragging = false, startY = 0, startValue = 0;
            const startDrag = (y) => { isDragging = true; startY = y; startValue = currentValue; document.body.style.cursor = 'ns-resize'; };
            const doDrag = (y) => {
                if (!isDragging) return;
                let newVal = startValue + (((startY - y) / 100) * (max - min));
                newVal = Math.max(min, Math.min(max, newVal));
                if (newVal !== currentValue) { currentValue = newVal; updateUI(currentValue, true); }
            };
            const endDrag = () => { if (isDragging) { isDragging = false; document.body.style.cursor = 'default'; } };

            wrapper.addEventListener('mousedown', (e) => startDrag(e.clientY)); window.addEventListener('mousemove', (e) => doDrag(e.clientY)); window.addEventListener('mouseup', endDrag);
            wrapper.addEventListener('touchstart', (e) => startDrag(e.touches[0].clientY), { passive: false }); window.addEventListener('touchmove', (e) => { if (isDragging) { e.preventDefault(); doDrag(e.touches[0].clientY); } }, { passive: false }); window.addEventListener('touchend', endDrag);
            
            return { setValue: (v) => { currentValue = v; updateUI(v, false); }, element: div };
        };

        // Nupit
        this.knobs['Threshold'] = createKnob(knobsContainer, 'Thresh', -60, 0, this.thresh, v => Math.round(v)+' dB', v => {
            this.thresh = v; this.applyInternalParams();
        });
        this.knobs['Ratio'] = createKnob(knobsContainer, 'Ratio', 1, 20, this.ratio, v => Math.round(v)+':1', v => {
            this.ratio = v; this.applyInternalParams();
        });
        this.knobs['Attack'] = createKnob(knobsContainer, 'Attack', 0.001, 1.0, this.attack, v => Math.round(v*1000)+' ms', v => {
            this.attack = v; this.applyInternalParams();
        });
        this.knobs['Release'] = createKnob(knobsContainer, 'Release', 0.01, 1.0, this.release, v => Math.round(v*1000)+' ms', v => {
            this.release = v; this.applyInternalParams();
        });
        this.knobs['Knee'] = createKnob(knobsContainer, 'Knee', 0, 40, this.knee, v => Math.round(v), v => {
            this.knee = v; this.applyInternalParams();
        });
        this.knobs['Gain'] = createKnob(knobsContainer, 'Gain', -20, 20, this.gainDb, v => Math.round(v)+' dB', v => {
            this.gainDb = v; this.applyInternalParams();
        });

        const presets = {
            'Compression': { Threshold: -24, Ratio: 4, Attack: 0.05, Release: 0.25, Knee: 30, Gain: 0 },
            'Limiter':     { Threshold: -5, Ratio: 20, Attack: 0.001, Release: 0.1, Knee: 0, Gain: 0 },
            'Noise Gate':  { Threshold: -40, Ratio: 1, Attack: 0.01, Release: 0.2, Knee: 0, Gain: 0 }
        };

        presetSelect.addEventListener('change', (e) => {
            this.mode = e.target.value;
            const p = presets[this.mode];
            for(let key in p) {
                if(this.knobs[key]) {
                    this.knobs[key].setValue(p[key]);
                    if (key === 'Threshold') this.thresh = p[key];
                    if (key === 'Ratio') this.ratio = p[key];
                    if (key === 'Attack') this.attack = p[key];
                    if (key === 'Release') this.release = p[key];
                    if (key === 'Knee') this.knee = p[key];
                    if (key === 'Gain') this.gainDb = p[key];
                }
            }
            this.applyInternalParams();
            this._updateUIVisibility();
        });

        this._updateUIVisibility();

        // Piirtoluuppi
        const historySize = 100;
        const peakHistory = new Array(historySize).fill(0);
        const grHistory = new Array(historySize).fill(0);

        let mountCheckCount = 0;

        const drawCanvas = () => {
            mountCheckCount++;
            if (!document.body.contains(canvas)) {
                if (mountCheckCount > 10) return; 
                return requestAnimationFrame(drawCanvas);
            }

            const parent = canvas.parentElement;
            if (parent && (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight)) {
                canvas.width = parent.clientWidth || 500;
                canvas.height = parent.clientHeight || 120;
            }

            const w = canvas.width, h = canvas.height;
            if (!w || !h) return requestAnimationFrame(drawCanvas);

            ctx2d.clearRect(0, 0, w, h);

            // Valitaan kumman signaalin dataa näytetään graafissa (Main vai Sidechain)
            const activeAnalyser = this.useSidechain ? this.sidechainAnalyser : this.analyserIn;
            
            // 1. Spektri taustalle
            const freqData = new Uint8Array(activeAnalyser.frequencyBinCount);
            activeAnalyser.getByteFrequencyData(freqData);
            
            // Väri muuttuu jos sidechain on aktiivinen
            ctx2d.fillStyle = this.useSidechain ? 'rgba(156, 39, 176, 0.2)' : 'rgba(0, 255, 204, 0.1)';
            const barWidth = w / freqData.length;
            for(let i=0; i<freqData.length; i++) {
                const barHeight = (freqData[i] / 255) * h;
                ctx2d.fillRect(i * barWidth, h - barHeight, barWidth, barHeight);
            }

            // 2. Tason laskenta (Peak)
            const timeData = new Uint8Array(activeAnalyser.frequencyBinCount);
            activeAnalyser.getByteTimeDomainData(timeData);
            let peak = 0;
            for(let i=0; i<timeData.length; i++) {
                const val = Math.abs((timeData[i] / 128.0) - 1.0);
                if (val > peak) peak = val;
            }
            let peakDb = 20 * Math.log10(Math.max(peak, 0.0001));
            if (peakDb < -60) peakDb = -60;

            // 3. Gain Reduction (saadaan ScriptProcessorin laskuista)
            let gr = this.currentReduction;

            // Päivitetään historia rullaamalla
            peakHistory.push(peakDb);
            peakHistory.shift();
            grHistory.push(gr);
            grHistory.shift();

            const dbToY = (db) => {
                const minDb = -60;
                return h - ((db - minDb) / (0 - minDb)) * h;
            };

            // 4. Piirretään Threshold linja
            const threshY = dbToY(this.gateThreshold);
            ctx2d.strokeStyle = 'rgba(255, 255, 255, 0.5)';
            ctx2d.lineWidth = 1;
            ctx2d.setLineDash([5, 5]);
            ctx2d.beginPath();
            ctx2d.moveTo(0, threshY);
            ctx2d.lineTo(w, threshY);
            ctx2d.stroke();
            ctx2d.setLineDash([]);

            // 5. Piirretään Peak historia (kuvaa analysoitavaa signaalia)
            ctx2d.strokeStyle = this.useSidechain ? '#e1bee7' : '#00ffcc';
            ctx2d.lineWidth = 2;
            ctx2d.beginPath();
            for(let i=0; i<historySize; i++) {
                const x = (i / (historySize - 1)) * w;
                const y = dbToY(peakHistory[i]);
                if(i===0) ctx2d.moveTo(x, y);
                else ctx2d.lineTo(x, y);
            }
            ctx2d.stroke();

            // 6. Piirretään Gain Reduction (Pudotetaan ylhäältä alaspäin)
            ctx2d.fillStyle = 'rgba(255, 0, 102, 0.4)';
            ctx2d.beginPath();
            ctx2d.moveTo(0, 0);
            for(let i=0; i<historySize; i++) {
                const x = (i / (historySize - 1)) * w;
                // Vaimennus on negatiivista, -60 on alin mahdollinen näytettävä arvo visualisoinnissa
                const grHeight = (Math.abs(grHistory[i]) / 60) * h; 
                ctx2d.lineTo(x, grHeight);
            }
            ctx2d.lineTo(w, 0);
            ctx2d.fill();

            requestAnimationFrame(drawCanvas);
        };
        drawCanvas();
    }
}