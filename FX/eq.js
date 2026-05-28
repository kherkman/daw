// eq.js
// Visual Dynamic Equalizer - Graafinen taajuuskorjain reaaliaikaisella analysaattorilla, sidechainilla, preseteillä ja tallennuksella

window.CustomAudioEffect = class GraphicEQ {
    constructor(audioCtx) {
        this.ctx = audioCtx;

        // Pääsignaalin reititys
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        
        this.analyser = audioCtx.createAnalyser();
        this.analyser.fftSize = 2048;
        // Pienennetään smoothausta, jotta Attack/Release ehtivät tarttua nopeisiin transientteihin (esim. S-äänet)
        this.analyser.smoothingTimeConstant = 0.2; 
        this.analyser.minDecibels = -100;
        this.analyser.maxDecibels = 0;
        this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

        // Sidechain signaalin reititys
        this.sidechainInput = audioCtx.createGain();
        this.sidechainAnalyser = audioCtx.createAnalyser();
        this.sidechainAnalyser.fftSize = 2048;
        this.sidechainAnalyser.smoothingTimeConstant = 0.2;
        this.sidechainAnalyser.minDecibels = -100;
        this.sidechainAnalyser.maxDecibels = 0;
        this.sidechainDataArray = new Uint8Array(this.sidechainAnalyser.frequencyBinCount);
        this.sidechainInput.connect(this.sidechainAnalyser);

        this.hpf = audioCtx.createBiquadFilter();
        this.hpf.type = 'highpass';
        this.hpf.frequency.value = 20;
        this.hpf.Q.value = 0; 

        this.lpf = audioCtx.createBiquadFilter();
        this.lpf.type = 'lowpass';
        this.lpf.frequency.value = 20000;
        this.lpf.Q.value = 0;

        this.bands =[];

        this.input.connect(this.analyser);
        this.analyser.connect(this.hpf);
        this.hpf.connect(this.lpf);
        this.lpf.connect(this.output);

        this.selectedBand = null;
        this.knobControllers = {}; 
        
        // Apufunktiot taajuuksien logaritmiseen laskentaan nupeille
        this.getFreqExponential = (val) => 20 * Math.pow(1000, val); 
        this.getValFromFreq = (freq) => Math.log(freq / 20) / Math.log(1000);
        
        this.presets = this.getPresets();
    }

    addBand(freq, gain, q = 1.0, dyn = 0, useSidechain = false, threshold = -30, attack = 20, release = 100) {
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'peaking';
        filter.frequency.value = freq;
        filter.gain.value = gain;
        filter.Q.value = q;

        const band = { 
            id: Date.now() + Math.random(), 
            filter: filter, 
            freq: freq,        
            baseGain: gain,    
            dynamicAmount: dyn,
            threshold: threshold,
            attack: attack,
            release: release,
            useSidechain: useSidechain
        };

        this.bands.push(band);
        this.rebuildGraph();
        if(this.refreshBandDropdown) this.refreshBandDropdown();
        return band;
    }

    removeBand(bandId) {
        this.bands = this.bands.filter(b => b.id !== bandId);
        if (this.selectedBand && this.selectedBand.id === bandId) {
            this.selectedBand = null;
            this.updateKnobsUI();
        }
        this.rebuildGraph();
        if(this.refreshBandDropdown) this.refreshBandDropdown();
    }

    clearAllBands() {
        this.bands =[];
        this.selectedBand = null;
        this.rebuildGraph();
        if(this.refreshBandDropdown) this.refreshBandDropdown();
        if(this.updateKnobsUI) this.updateKnobsUI();
    }

    rebuildGraph() {
        try { this.hpf.disconnect(); } catch(e){}
        try { this.lpf.disconnect(); } catch(e){}
        this.bands.forEach(b => {
            try { b.filter.disconnect(); } catch(e){}
        });

        let currentNode = this.hpf;
        this.bands.forEach(band => {
            currentNode.connect(band.filter);
            currentNode = band.filter;
        });

        currentNode.connect(this.lpf);
        this.lpf.connect(this.output); 
    }

    getNodes() {
        return { input: this.input, output: this.output, sidechain: this.sidechainInput };
    }

    exportConfig() {
        const config = {
            hpf: this.hpf.frequency.value,
            hpfQ: this.hpf.Q.value,
            lpf: this.lpf.frequency.value,
            lpfQ: this.lpf.Q.value,
            bands: this.bands.map(b => ({
                freq: b.freq,
                gain: b.baseGain,
                q: b.filter.Q.value,
                dyn: b.dynamicAmount,
                thr: b.threshold,
                att: b.attack,
                rel: b.release,
                sc: b.useSidechain
            }))
        };
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(config));
        const dlAnchorElem = document.createElement('a');
        dlAnchorElem.setAttribute("href", dataStr);
        dlAnchorElem.setAttribute("download", "eq_preset.json");
        dlAnchorElem.click();
    }

    importConfig(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const config = JSON.parse(e.target.result);
                this.applyConfig(config);
            } catch (err) {
                alert("Virheellinen preset-tiedosto!");
            }
        };
        reader.readAsText(file);
    }

    applyConfig(config) {
        this.clearAllBands();
        this.hpf.frequency.value = config.hpf || 20;
        this.hpf.Q.value = config.hpfQ || 0;
        this.lpf.frequency.value = config.lpf || 20000;
        this.lpf.Q.value = config.lpfQ || 0;
        
        if(this.knobControllers.globalHpf) this.knobControllers.globalHpf.setValue(this.getValFromFreq(config.hpf || 20));
        if(this.knobControllers.globalLpf) this.knobControllers.globalLpf.setValue(this.getValFromFreq(config.lpf || 20000));

        if(config.bands) {
            config.bands.forEach(b => {
                const thr = b.thr !== undefined ? b.thr : -30;
                const att = b.att !== undefined ? b.att : 20;
                const rel = b.rel !== undefined ? b.rel : 100;
                this.addBand(b.freq, b.gain, b.q, b.dyn, b.sc || false, thr, att, rel);
            });
        }
    }

    getState() {
        return {
            hpf: this.hpf.frequency.value,
            hpfQ: this.hpf.Q.value,
            lpf: this.lpf.frequency.value,
            lpfQ: this.lpf.Q.value,
            bands: this.bands.map(b => ({
                freq: b.freq,
                gain: b.baseGain,
                q: b.filter.Q.value,
                dyn: b.dynamicAmount,
                thr: b.threshold,
                att: b.attack,
                rel: b.release,
                sc: b.useSidechain
            }))
        };
    }

    setState(state) {
        if (state) {
            this.applyConfig(state);
        }
    }

    getPresets() {
        return {
            "Default": { hpf: 20, lpf: 20000, bands:[] },
            "De-esser": { hpf: 80, lpf: 20000, bands: [{freq: 7000, gain: 0, q: 2.0, dyn: 0.8, thr: -35, att: 2, rel: 50}] },
            "vocals lead": { hpf: 100, lpf: 18000, bands: [{freq: 250, gain: -2, q: 1.5}, {freq: 3500, gain: 3, q: 1.0}, {freq: 10000, gain: 2, q: 0.7}] },
            "vocals backing": { hpf: 150, lpf: 14000, bands: [{freq: 400, gain: -3, q: 1.5}, {freq: 5000, gain: 2, q: 1.0}] },
            "vocals bus": { hpf: 80, lpf: 19000, bands: [{freq: 300, gain: -1.5, q: 1.2}, {freq: 8000, gain: 1.5, q: 0.8}] },
            "guitar rhythm": { hpf: 100, lpf: 10000, bands: [{freq: 200, gain: -2, q: 1.0}, {freq: 2500, gain: 3, q: 1.5}] },
            "guitar solo": { hpf: 120, lpf: 12000, bands: [{freq: 800, gain: 2, q: 1.0}, {freq: 3500, gain: 4, q: 1.5}] },
            "guitar acoustic": { hpf: 80, lpf: 16000, bands: [{freq: 200, gain: -3, q: 1.5}, {freq: 5000, gain: 3, q: 1.0}, {freq: 12000, gain: 2, q: 0.7}] },
            "bass": { hpf: 40, lpf: 8000, bands: [{freq: 80, gain: 3, q: 1.0}, {freq: 250, gain: -3, q: 1.5}, {freq: 800, gain: 2, q: 1.5}] },
            "bass (ducking)": { hpf: 40, lpf: 8000, bands: [{freq: 80, gain: 3, q: 1.0}, {freq: 250, gain: -3, q: 1.5}, {freq: 800, gain: 2, q: 1.5}, {freq: 60, gain: 0, q: 1.0, dyn: 0.9, thr: -65, att: 2, rel: 60, sc: true}]},
            "synth bass": { hpf: 30, lpf: 10000, bands: [{freq: 60, gain: 4, q: 1.0}, {freq: 300, gain: -4, q: 2.0}, {freq: 2000, gain: 2, q: 1.0}] },
            "synth pad": { hpf: 150, lpf: 12000, bands: [{freq: 400, gain: -2, q: 1.0}, {freq: 1000, gain: 2, q: 0.5}] },
            "synth lead": { hpf: 120, lpf: 15000, bands: [{freq: 2000, gain: 3, q: 1.5}, {freq: 6000, gain: 2, q: 1.0}] },
            "kick": { hpf: 30, lpf: 16000, bands: [{freq: 60, gain: 5, q: 1.5}, {freq: 400, gain: -6, q: 2.0}, {freq: 5000, gain: 4, q: 1.5}] },
            "snare": { hpf: 80, lpf: 16000, bands: [{freq: 200, gain: 3, q: 1.5}, {freq: 600, gain: -2, q: 1.5}, {freq: 4000, gain: 4, q: 1.0}] },
            "toms": { hpf: 60, lpf: 14000, bands: [{freq: 100, gain: 3, q: 1.5}, {freq: 500, gain: -5, q: 2.0}, {freq: 3500, gain: 3, q: 1.5}] },
            "hi-hat": { hpf: 400, lpf: 20000, bands: [{freq: 8000, gain: 3, q: 1.0}] },
            "cymbals": { hpf: 300, lpf: 20000, bands: [{freq: 10000, gain: 2, q: 0.7}] },
            "overheads": { hpf: 150, lpf: 20000, bands: [{freq: 400, gain: -3, q: 1.5}, {freq: 8000, gain: 2, q: 0.7}] },
            "drum bus": { hpf: 30, lpf: 18000, bands: [{freq: 60, gain: 2, q: 1.0}, {freq: 400, gain: -2, q: 1.5}, {freq: 5000, gain: 2, q: 1.0}] },
            "piano": { hpf: 60, lpf: 18000, bands: [{freq: 250, gain: -2, q: 1.5}, {freq: 3000, gain: 2, q: 1.0}] },
            "strings": { hpf: 100, lpf: 18000, bands: [{freq: 300, gain: -1.5, q: 1.0}, {freq: 6000, gain: 2, q: 0.8}] },
            "brass": { hpf: 120, lpf: 16000, bands: [{freq: 400, gain: -2, q: 1.5}, {freq: 4000, gain: 3, q: 1.0}] },
            "woodwinds": { hpf: 150, lpf: 15000, bands: [{freq: 350, gain: -1, q: 1.0}, {freq: 3000, gain: 2, q: 1.0}] },
            "instruments bus (excl.drum&vox)": { hpf: 80, lpf: 18000, bands: [{freq: 300, gain: -2, q: 1.0}, {freq: 4000, gain: 1.5, q: 1.0}] },
            "mix bus": { hpf: 25, lpf: 20000, bands: [{freq: 300, gain: -1, q: 1.0}, {freq: 2000, gain: 1, q: 1.0}, {freq: 10000, gain: 1.5, q: 0.7}] },
            "master pop": { hpf: 25, lpf: 20000, bands: [{freq: 60, gain: 1.5, q: 1.0}, {freq: 250, gain: -1, q: 1.2}, {freq: 10000, gain: 2, q: 0.6}] },
            "master rock": { hpf: 30, lpf: 19000, bands: [{freq: 80, gain: 1, q: 1.0}, {freq: 400, gain: -1.5, q: 1.5}, {freq: 4000, gain: 1.5, q: 1.0}] },
            "master synthwave": { hpf: 25, lpf: 20000, bands: [{freq: 50, gain: 2, q: 1.0}, {freq: 200, gain: -1, q: 1.5}, {freq: 8000, gain: 2.5, q: 0.8}] },
            "master jazz": { hpf: 35, lpf: 18000, bands: [{freq: 300, gain: -0.5, q: 1.0}, {freq: 5000, gain: 1, q: 1.0}] }
        };
    }

    renderUI(containerElement) {
        const styleId = 'fx-eq-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .eq-container { display: flex; flex-direction: column; gap: 15px; font-family: sans-serif; }
                .eq-top-bar { display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.3); padding: 8px 15px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); }
                .eq-header { color: #00f0ff; font-weight: bold; letter-spacing: 3px; font-size: 14px; }
                .eq-top-controls { display: flex; gap: 10px; }
                .eq-btn { background: rgba(0, 240, 255, 0.1); border: 1px solid #00f0ff; color: #00f0ff; padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; text-transform: uppercase; }
                .eq-btn:hover { background: #00f0ff; color: #000; transition: background 0.2s, color 0.2s; }
                .eq-select { background: #1a1a24; color: #fff; border: 1px solid rgba(255,255,255,0.2); padding: 4px 8px; border-radius: 4px; font-size: 11px; outline: none; cursor: pointer; }
                .eq-canvas-wrapper { width: 100%; height: 250px; background: #0a0a0f; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); position: relative; overflow: hidden; box-shadow: inset 0 0 20px #000; cursor: crosshair; touch-action: none;}
                .eq-canvas-wrapper canvas { width: 100%; height: 100%; display: block; }
                .eq-hint { position: absolute; top: 10px; left: 10px; font-size: 10px; color: rgba(255,255,255,0.4); pointer-events: none;}
                .eq-controls { display: flex; gap: 20px; flex-wrap: wrap; justify-content: center; background: rgba(0,0,0,0.3); padding: 15px; border-radius: 8px; border: 1px dashed rgba(255,255,255,0.05); min-height: 120px;}
                .eq-section { display: flex; flex-direction: column; align-items: center; border-right: 1px solid rgba(255,255,255,0.1); padding-right: 20px; }
                .eq-section:last-child { border-right: none; padding-right: 0; }
                .eq-section-title { font-size: 11px; color: #8b8b9f; margin-bottom: 10px; text-transform: uppercase; width:100%; text-align:center; }
                .eq-knob-row { display: flex; gap: 15px; flex-wrap: wrap; justify-content: center; }
                .knob-container { display: flex; flex-direction: column; align-items: center; user-select: none; width: 60px; }
                .knob-wrapper { position: relative; width: 50px; height: 50px; cursor: ns-resize; margin-bottom: 8px; touch-action: none; }
                .knob-svg { width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 3px rgba(0,240,255,0.5)); }
                .knob-track { fill: none; stroke: #2a2a3b; stroke-width: 8; stroke-linecap: round; }
                .knob-value-path { fill: none; stroke: #00f0ff; stroke-width: 8; stroke-linecap: round; transition: stroke 0.2s; }
                .knob-center { fill: #1a1a24; stroke: #333; stroke-width: 2; }
                .knob-indicator { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
                .knob-dot { position: absolute; width: 4px; height: 4px; background: #00f0ff; border-radius: 50%; top: 6px; left: 50%; transform: translateX(-50%); transition: background 0.2s;}
                .knob-label { font-size: 10px; color: #8b8b9f; margin-bottom: 5px; }
                .knob-value-display { font-size: 10px; font-family: monospace; color: #fff; background: rgba(0,0,0,0.5); padding: 2px 4px; border-radius: 3px; min-width: 35px; text-align: center;}
                .btn-delete-band { margin-top: 10px; background: rgba(255,0,60,0.1); border: 1px solid #ff003c; color: #ff003c; padding: 4px 8px; border-radius: 4px; font-size: 10px; cursor: pointer; text-transform: uppercase;}
                .btn-delete-band:hover { background: #ff003c; color: #fff; }
                .empty-state { color: rgba(255,255,255,0.3); font-size: 12px; margin-top: 30px; }
                .band-select-wrapper { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; margin-left: 10px;}
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div class="eq-container">
                <div class="eq-top-bar">
                    <div class="eq-header">DYNAMIC PRO EQ</div>
                    <div class="eq-top-controls">
                        <select id="eq-preset-select" class="eq-select">
                            <option value="" disabled selected>Load Preset...</option>
                            ${Object.keys(this.presets).map(p => `<option value="${p}">${p}</option>`).join('')}
                        </select>
                        <button id="eq-btn-load" class="eq-btn">Load File</button>
                        <button id="eq-btn-save" class="eq-btn">Save File</button>
                    </div>
                </div>
                <div class="eq-canvas-wrapper"><canvas id="eq-canvas"></canvas><div class="eq-hint">Tuplaklikkaa lisätäksesi alueen. Raahaa pisteitä säätääksesi.</div></div>
                <div class="eq-controls">
                    <div class="eq-section">
                        <div class="eq-section-title">Global Filters</div>
                        <div class="eq-knob-row" id="global-knobs"></div>
                    </div>
                    <div class="eq-section" style="flex: 1;">
                        <div class="eq-section-title">Selected Band</div>
                        <div class="eq-knob-row" id="band-knobs">
                            <div class="empty-state">Klikkaa pistettä valitaksesi alueen</div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const canvas = containerElement.querySelector('#eq-canvas');
        const ctx2d = canvas.getContext('2d');
        const globalKnobs = containerElement.querySelector('#global-knobs');
        const bandKnobs = containerElement.querySelector('#band-knobs');

        containerElement.querySelector('#eq-btn-save').addEventListener('click', () => this.exportConfig());
        containerElement.querySelector('#eq-btn-load').addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.json';
            fileInput.onchange = (e) => {
                if(e.target.files.length > 0) this.importConfig(e.target.files[0]);
            };
            fileInput.click();
        });

        const presetSelect = containerElement.querySelector('#eq-preset-select');
        presetSelect.addEventListener('change', (e) => {
            const p = this.presets[e.target.value];
            if(p) this.applyConfig(p);
            presetSelect.value = ""; 
        });

        const createKnob = (container, label, min, max, defaultValue, formatValue, onChange, color = '#00f0ff') => {
            const div = document.createElement('div');
            div.className = 'knob-container';
            const radius = 20, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 

            div.innerHTML = `
                <div class="knob-label">${label}</div>
                <div class="knob-wrapper">
                    <svg class="knob-svg" viewBox="0 0 50 50"><circle class="knob-track" cx="25" cy="25" r="${radius}" stroke-dasharray="${maxDash} ${circumference}" /><circle class="knob-value-path" cx="25" cy="25" r="${radius}" stroke-dasharray="0 ${circumference}" style="stroke: ${color}" /><circle class="knob-center" cx="25" cy="25" r="14" /></svg>
                    <div class="knob-indicator"><div class="knob-dot" style="background: ${color}"></div></div>
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
            updateUI(currentValue);
            container.appendChild(div);

            let isDragging = false, startY = 0, startValue = 0;
            const startDrag = (y) => { isDragging = true; startY = y; startValue = currentValue; document.body.style.cursor = 'ns-resize'; };
            const doDrag = (y) => {
                if (!isDragging) return;
                let newVal = startValue + (((startY - y) / 100) * (max - min));
                newVal = Math.max(min, Math.min(max, newVal));
                if (newVal !== currentValue) { 
                    currentValue = newVal; 
                    updateUI(currentValue);
                    onChange(currentValue); 
                }
            };
            const endDrag = () => { if (isDragging) { isDragging = false; document.body.style.cursor = 'default'; } };

            wrapper.addEventListener('mousedown', (e) => startDrag(e.clientY));
            window.addEventListener('mousemove', (e) => doDrag(e.clientY));
            window.addEventListener('mouseup', endDrag);
            wrapper.addEventListener('touchstart', (e) => startDrag(e.touches[0].clientY), { passive: false });
            window.addEventListener('touchmove', (e) => { if (isDragging) { e.preventDefault(); doDrag(e.touches[0].clientY); } }, { passive: false });
            window.addEventListener('touchend', endDrag);

            return { 
                setValue: (v) => { currentValue = v; updateUI(v); },
                get currentValue() { return currentValue; },
                setColor: (c) => { valuePath.style.stroke = c; indicator.querySelector('.knob-dot').style.background = c; }
            };
        };

        const MIN_F = 20, MAX_F = 20000, MIN_DB = -24, MAX_DB = 24;
        
        const freqToX = (f, w) => w * (Math.log(f / MIN_F) / Math.log(MAX_F / MIN_F));
        const xToFreq = (x, w) => MIN_F * Math.pow(MAX_F / MIN_F, x / w);
        
        const dbToY = (db, h) => (h / 2) - (db * (h / (MAX_DB - MIN_DB)));
        const yToDb = (y, h) => (h / 2 - y) * ((MAX_DB - MIN_DB) / h);
        const formatHz = (f) => f >= 1000 ? (f/1000).toFixed(1) + 'k' : Math.round(f) + 'Hz';

        // Välitön asetus (.value) pakottaa käyrän piirtymään heti, riippumatta Audiocontextin tilasta
        this.knobControllers.globalHpf = createKnob(globalKnobs, 'HPF', 0.0, 1.0, this.getValFromFreq(this.hpf.frequency.value), 
            v => formatHz(this.getFreqExponential(v)), 
            v => { this.hpf.frequency.value = this.getFreqExponential(v); }, '#ff003c');
            
        this.knobControllers.globalLpf = createKnob(globalKnobs, 'LPF', 0.0, 1.0, this.getValFromFreq(this.lpf.frequency.value), 
            v => formatHz(this.getFreqExponential(v)), 
            v => { this.lpf.frequency.value = this.getFreqExponential(v); }, '#ff003c');

        this.refreshBandDropdown = () => {
            if(!this.selectedBand) return;
            const selectEl = document.getElementById('eq-band-select');
            if(selectEl) {
                selectEl.innerHTML = this.bands.map((b, i) => `<option value="${b.id}" ${b.id === this.selectedBand.id ? 'selected' : ''}>Band ${i+1}</option>`).join('');
            }
        };

        this.updateKnobsUI = () => {
            bandKnobs.innerHTML = '';
            if (!this.selectedBand) {
                bandKnobs.innerHTML = '<div class="empty-state">Klikkaa pistettä graafissa valitaksesi alueen</div>';
                return;
            }
            const b = this.selectedBand;
            const baseColor = b.useSidechain ? '#9c27b0' : '#00f0ff';
            const dynColor = b.useSidechain ? '#e1bee7' : '#ff8800';
            
            this.knobControllers.bandFreq = createKnob(bandKnobs, 'Freq', 0.0, 1.0, this.getValFromFreq(b.freq), 
                v => formatHz(this.getFreqExponential(v)), 
                v => { 
                    const newF = this.getFreqExponential(v);
                    b.freq = newF;
                    b.filter.frequency.value = newF; // Välitön päivitys UI:lle
                }, baseColor);

            this.knobControllers.bandGain = createKnob(bandKnobs, 'Gain', MIN_DB, MAX_DB, b.baseGain, 
                v => (v > 0 ? '+' : '') + v.toFixed(1) + 'dB', 
                v => { 
                    b.baseGain = v;
                    if (b.dynamicAmount === 0) b.filter.gain.value = v; 
                }, baseColor);

            this.knobControllers.q = createKnob(bandKnobs, 'Q', 0.1, 10.0, b.filter.Q.value, 
                v => v.toFixed(1), 
                v => { b.filter.Q.value = v; });
                
            this.knobControllers.dyn = createKnob(bandKnobs, 'Dyn', 0.0, 1.0, b.dynamicAmount, 
                v => Math.round(v*100)+'%', 
                v => { b.dynamicAmount = v; }, dynColor); 

            // Uudet dynaamisen EQ:n ohjaimet:
            this.knobControllers.thr = createKnob(bandKnobs, 'Thr', -80, 0, b.threshold, 
                v => v.toFixed(1)+'dB', 
                v => { b.threshold = v; }, dynColor);
            
            this.knobControllers.att = createKnob(bandKnobs, 'Att', 1, 200, b.attack, 
                v => Math.round(v)+'ms', 
                v => { b.attack = v; }, dynColor);

            this.knobControllers.rel = createKnob(bandKnobs, 'Rel', 10, 1000, b.release, 
                v => Math.round(v)+'ms', 
                v => { b.release = v; }, dynColor);
            
            // Oikea reuna: Kaistan valinta, Poisto ja Sidechain-kytkin
            const btnWrap = document.createElement('div');
            btnWrap.className = 'band-select-wrapper';
            
            const bandSelect = document.createElement('select');
            bandSelect.id = 'eq-band-select';
            bandSelect.className = 'eq-select';
            bandSelect.style.width = '100%';
            bandSelect.innerHTML = this.bands.map((bandItem, i) => `<option value="${bandItem.id}" ${bandItem.id === b.id ? 'selected' : ''}>Band ${i+1}</option>`).join('');
            bandSelect.addEventListener('change', (e) => {
                const found = this.bands.find(x => x.id.toString() === e.target.value);
                if(found) {
                    this.selectedBand = found;
                    this.updateKnobsUI();
                }
            });

            // Sidechain painike
            const scBtnWrap = document.createElement('div');
            scBtnWrap.style.width = '100%';
            scBtnWrap.innerHTML = `
                <div style="font-size:9px; color:#8b8b9f; text-align:center; margin-bottom:2px;">Source</div>
                <button class="eq-btn" style="width:100%; background:${b.useSidechain ? '#9c27b0' : '#1a1a24'}; border-color:${b.useSidechain ? '#e1bee7' : 'rgba(255,255,255,0.2)'}; color:white;">
                    ${b.useSidechain ? 'Sidechain' : 'Main'}
                </button>
            `;
            scBtnWrap.querySelector('button').onclick = () => {
                b.useSidechain = !b.useSidechain;
                this.updateKnobsUI(); // Päivittää värit ja napin tilan
            };

            const delBtn = document.createElement('button');
            delBtn.className = 'btn-delete-band'; delBtn.innerText = 'Poista';
            delBtn.style.width = '100%';
            delBtn.onclick = () => this.removeBand(b.id);
            
            btnWrap.appendChild(bandSelect);
            btnWrap.appendChild(scBtnWrap);
            btnWrap.appendChild(delBtn);
            bandKnobs.appendChild(btnWrap);
        };

        let draggingBand = null;

        canvas.addEventListener('mousedown', (e) => {
            if(!canvas.width || !canvas.height) return;
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left, y = e.clientY - rect.top;
            let clicked = null;

            for (let b of this.bands) {
                if (Math.hypot(x - freqToX(b.freq, canvas.width), y - dbToY(b.baseGain, canvas.height)) < 20) { 
                    clicked = b; break; 
                }
            }

            if (!clicked) {
                if (Math.hypot(x - freqToX(this.hpf.frequency.value, canvas.width), y - dbToY(this.hpf.Q.value, canvas.height)) < 20) {
                    clicked = { isHPF: true };
                } else if (Math.hypot(x - freqToX(this.lpf.frequency.value, canvas.width), y - dbToY(this.lpf.Q.value, canvas.height)) < 20) {
                    clicked = { isLPF: true };
                }
            }

            if (clicked) {
                if (clicked.isHPF || clicked.isLPF) {
                    this.selectedBand = null;
                    this.updateKnobsUI();
                } else {
                    this.selectedBand = clicked;
                    this.updateKnobsUI();
                }
                draggingBand = clicked;
            }
        });

        canvas.addEventListener('mousemove', (e) => {
            if (!draggingBand || !canvas.width || !canvas.height) return;
            const rect = canvas.getBoundingClientRect();
            const x = Math.max(0, Math.min(canvas.width, e.clientX - rect.left));
            const y = Math.max(0, Math.min(canvas.height, e.clientY - rect.top));
            
            const newFreq = xToFreq(x, canvas.width);
            const newGain = yToDb(y, canvas.height);
            
            if (draggingBand.isHPF) {
                const qVal = Math.max(0, Math.min(MAX_DB, newGain));
                this.hpf.frequency.value = newFreq;
                this.hpf.Q.value = qVal;
                if(this.knobControllers.globalHpf) this.knobControllers.globalHpf.setValue(this.getValFromFreq(newFreq));
            } else if (draggingBand.isLPF) {
                const qVal = Math.max(0, Math.min(MAX_DB, newGain));
                this.lpf.frequency.value = newFreq;
                this.lpf.Q.value = qVal;
                if(this.knobControllers.globalLpf) this.knobControllers.globalLpf.setValue(this.getValFromFreq(newFreq));
            } else {
                draggingBand.freq = newFreq;
                draggingBand.baseGain = newGain;
                
                draggingBand.filter.frequency.value = newFreq;
                if (draggingBand.dynamicAmount === 0) {
                    draggingBand.filter.gain.value = newGain;
                }

                if (draggingBand === this.selectedBand) {
                    if(this.knobControllers.bandFreq) this.knobControllers.bandFreq.setValue(this.getValFromFreq(newFreq));
                    if(this.knobControllers.bandGain) this.knobControllers.bandGain.setValue(newGain);
                }
            }
        });

        canvas.addEventListener('mouseup', () => { draggingBand = null; });
        canvas.addEventListener('mouseleave', () => { draggingBand = null; });

        canvas.addEventListener('dblclick', (e) => {
            if(!canvas.width || !canvas.height) {
                canvas.width = canvas.parentElement.clientWidth || 800;
                canvas.height = canvas.parentElement.clientHeight || 250;
            }
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left, y = e.clientY - rect.top;
            const freq = xToFreq(x, canvas.width);
            const gain = yToDb(y, canvas.height);
            this.selectedBand = this.addBand(freq, gain);
            this.updateKnobsUI();
        });

        canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if(!canvas.width || !canvas.height) return;
            const rect = canvas.getBoundingClientRect();
            const x = e.touches[0].clientX - rect.left, y = e.touches[0].clientY - rect.top;
            let clicked = null;

            for (let b of this.bands) {
                if (Math.hypot(x - freqToX(b.freq, canvas.width), y - dbToY(b.baseGain, canvas.height)) < 30) {
                    clicked = b; break;
                }
            }

            if (!clicked) {
                if (Math.hypot(x - freqToX(this.hpf.frequency.value, canvas.width), y - dbToY(this.hpf.Q.value, canvas.height)) < 30) {
                    clicked = { isHPF: true };
                } else if (Math.hypot(x - freqToX(this.lpf.frequency.value, canvas.width), y - dbToY(this.lpf.Q.value, canvas.height)) < 30) {
                    clicked = { isLPF: true };
                }
            }

            if (clicked) {
                if (clicked.isHPF || clicked.isLPF) {
                    this.selectedBand = null;
                    this.updateKnobsUI();
                } else {
                    this.selectedBand = clicked;
                    this.updateKnobsUI();
                }
                draggingBand = clicked;
            }
        }, {passive: false});

        canvas.addEventListener('touchmove', (e) => {
            if (!draggingBand || !canvas.width || !canvas.height) return;
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const x = Math.max(0, Math.min(canvas.width, e.touches[0].clientX - rect.left));
            const y = Math.max(0, Math.min(canvas.height, e.touches[0].clientY - rect.top));
            
            const newFreq = xToFreq(x, canvas.width);
            const newGain = yToDb(y, canvas.height);

            if (draggingBand.isHPF) {
                const qVal = Math.max(0, Math.min(MAX_DB, newGain));
                this.hpf.frequency.value = newFreq;
                this.hpf.Q.value = qVal;
                if(this.knobControllers.globalHpf) this.knobControllers.globalHpf.setValue(this.getValFromFreq(newFreq));
            } else if (draggingBand.isLPF) {
                const qVal = Math.max(0, Math.min(MAX_DB, newGain));
                this.lpf.frequency.value = newFreq;
                this.lpf.Q.value = qVal;
                if(this.knobControllers.globalLpf) this.knobControllers.globalLpf.setValue(this.getValFromFreq(newFreq));
            } else {
                draggingBand.freq = newFreq;
                draggingBand.baseGain = newGain;
                draggingBand.filter.frequency.value = newFreq;
                if (draggingBand.dynamicAmount === 0) {
                    draggingBand.filter.gain.value = newGain;
                }

                if (draggingBand === this.selectedBand) {
                    if(this.knobControllers.bandFreq) this.knobControllers.bandFreq.setValue(this.getValFromFreq(newFreq));
                    if(this.knobControllers.bandGain) this.knobControllers.bandGain.setValue(newGain);
                }
            }
        }, {passive: false});
        canvas.addEventListener('touchend', () => { draggingBand = null; });

        let freqsArray, tempMagArray, tempPhaseArray, totalMagArray;
        
        const draw = () => {
            const parent = canvas.parentElement;
            if (parent && (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight)) {
                if (parent.clientWidth > 0 && parent.clientHeight > 0) {
                    canvas.width = parent.clientWidth;
                    canvas.height = parent.clientHeight;
                }
            }

            const w = canvas.width, h = canvas.height;
            if (!w || !h) return requestAnimationFrame(draw);

            ctx2d.clearRect(0, 0, w, h);
            ctx2d.strokeStyle = 'rgba(255,255,255,0.1)'; ctx2d.lineWidth = 1;
            ctx2d.beginPath(); ctx2d.moveTo(0, h/2); ctx2d.lineTo(w, h/2); ctx2d.stroke();

            // Lue sekä Main että Sidechain analysaattorit
            this.analyser.getByteFrequencyData(this.dataArray);
            this.sidechainAnalyser.getByteFrequencyData(this.sidechainDataArray);
            
            const binCount = this.analyser.frequencyBinCount;
            const minDbRange = this.analyser.minDecibels;
            const maxDbRange = this.analyser.maxDecibels;
            const dbRange = maxDbRange - minDbRange;
            
            // Dynaaminen EQ logiikka
            this.bands.forEach(b => {
                if (b.dynamicAmount > 0) {
                    const activeDataArray = b.useSidechain ? this.sidechainDataArray : this.dataArray;
                    
                    let maxByteVal = 0;
                    // Kuunnellaan taajuusaluetta
                    for (let i = 0; i < binCount; i++) {
                        const binF = i * (this.ctx.sampleRate / 2) / binCount;
                        if (binF > b.freq * 0.8 && binF < b.freq * 1.2) {
                            if (activeDataArray[i] > maxByteVal) maxByteVal = activeDataArray[i];
                        }
                    }
                    
                    // Muunnetaan byte value (0-255) aidoksi dB arvoksi
                    const currentDb = minDbRange + (maxByteVal / 255) * dbRange;
                    let duckDbターゲット = b.baseGain;

                    // Jos ylitetään kynnys (Threshold)
                    if (currentDb > b.threshold) {
                        const excessDb = currentDb - b.threshold;
                        // Vaimentaa ylitystä b.dynamicAmount suhteen mukaan
                        duckDbターゲット = b.baseGain - (excessDb * b.dynamicAmount);
                    }

                    if (this.ctx.state === 'running') {
                        const currentAudioGain = b.filter.gain.value;
                        // Valitse timeConstant sen mukaan ollaanko hyökkäämässä (vaimenee) vai palautumassa
                        const timeConstant = (duckDbターゲット < currentAudioGain) ? (b.attack / 1000) : (b.release / 1000);
                        // Suojataan 0 vialta, pienin sallittu aikavakio 1ms
                        b.filter.gain.setTargetAtTime(duckDbターゲット, this.ctx.currentTime, Math.max(timeConstant, 0.001));
                    } else {
                        b.filter.gain.value = duckDbターゲット;
                    }
                } else {
                    // Palauta gain hitaasti, jos dyn kytketään pois
                    if (b.filter.gain.value !== b.baseGain && this.ctx.state === 'running') {
                        b.filter.gain.setTargetAtTime(b.baseGain, this.ctx.currentTime, 0.05);
                    } else if (this.ctx.state !== 'running') {
                        b.filter.gain.value = b.baseGain;
                    }
                }
            });

            // Piirrä analysaattorin tausta (Aina Main inputin data)
            ctx2d.fillStyle = 'rgba(138, 43, 226, 0.3)';
            ctx2d.beginPath(); ctx2d.moveTo(0, h);
            for (let i = 0; i < binCount; i++) {
                const f = i * (this.ctx.sampleRate / 2) / binCount;
                if (f < MIN_F) continue;
                if (f > MAX_F) break;
                const x = freqToX(f, w), val = this.dataArray[i], y = h - (val / 255) * h;
                ctx2d.lineTo(x, y);
            }
            ctx2d.lineTo(w, h); ctx2d.fill();

            if (!freqsArray || freqsArray.length !== w) {
                freqsArray = new Float32Array(w); 
                tempMagArray = new Float32Array(w); 
                tempPhaseArray = new Float32Array(w); 
                totalMagArray = new Float32Array(w);
                for(let i=0; i<w; i++) freqsArray[i] = xToFreq(i, w);
            }
            
            totalMagArray.fill(1.0); 

            const allFilters = [this.hpf, ...this.bands.map(b => b.filter), this.lpf];
            allFilters.forEach(f => {
                f.getFrequencyResponse(freqsArray, tempMagArray, tempPhaseArray);
                for(let i=0; i<w; i++) totalMagArray[i] *= tempMagArray[i];
            });

            ctx2d.strokeStyle = '#00f0ff'; ctx2d.lineWidth = 3; ctx2d.beginPath();
            let hasFirstPoint = false;
            
            for(let i = 0; i < w; i++) {
                let mag = totalMagArray[i];
                if (isNaN(mag) || !isFinite(mag) || mag <= 0) mag = 0.0001; 
                
                let db = 20 * Math.log10(mag);
                db = Math.max(MIN_DB, Math.min(MAX_DB, db)); 
                const y = dbToY(db, h);
                
                if (!hasFirstPoint) {
                    ctx2d.moveTo(i, y);
                    hasFirstPoint = true;
                } else {
                    ctx2d.lineTo(i, y);
                }
            }
            ctx2d.stroke();

            const drawPoint = (x, y, isSelected, label, color) => {
                ctx2d.beginPath(); ctx2d.arc(x, y, isSelected ? 8 : 5, 0, Math.PI * 2);
                ctx2d.fillStyle = color; ctx2d.fill();
                ctx2d.strokeStyle = '#fff'; ctx2d.lineWidth = 2; ctx2d.stroke();
                if (label) {
                    ctx2d.fillStyle = 'rgba(255,255,255,0.7)';
                    ctx2d.font = '10px sans-serif';
                    ctx2d.fillText(label, x - 10, y + 15);
                }
            };

            drawPoint(freqToX(this.hpf.frequency.value, w), dbToY(this.hpf.Q.value, h), draggingBand && draggingBand.isHPF, 'HPF', '#ff003c');
            drawPoint(freqToX(this.lpf.frequency.value, w), dbToY(this.lpf.Q.value, h), draggingBand && draggingBand.isLPF, 'LPF', '#ff003c');

            this.bands.forEach(b => {
                const x = freqToX(b.freq, w);
                const y = dbToY(b.baseGain, h); 
                
                const dotColor = this.selectedBand === b ? '#ff003c' : (b.useSidechain ? '#9c27b0' : '#00f0ff');
                drawPoint(x, y, this.selectedBand === b, null, dotColor);
                
                if (b.dynamicAmount > 0) {
                     const actualAudioGain = b.filter.gain.value; 
                     const actualY = dbToY(actualAudioGain, h);
                     
                     const lineCol = b.useSidechain ? '#e1bee7' : '#ff8800';
                     const circCol = b.useSidechain ? 'rgba(156, 39, 176, 0.5)' : 'rgba(255, 136, 0, 0.5)';

                     ctx2d.beginPath(); ctx2d.arc(x, actualY, 12, 0, Math.PI * 2);
                     ctx2d.strokeStyle = circCol; ctx2d.lineWidth = 1; ctx2d.stroke();
                     
                     ctx2d.beginPath(); ctx2d.moveTo(x, y); ctx2d.lineTo(x, actualY);
                     ctx2d.strokeStyle = lineCol; ctx2d.stroke();
                }
            });

            requestAnimationFrame(draw);
        };
        draw();
    }
}