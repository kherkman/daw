// distortion.js
// Monipuolinen säröpedaali skoopilla, preseteillä ja wave folderilla
window.CustomAudioEffect = class DistortionEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.dryGain = audioCtx.createGain();
        this.wetGain = audioCtx.createGain();
        
        this.hpf = audioCtx.createBiquadFilter(); 
        this.hpf.type = 'highpass';
        this.hpf.frequency.value = 80;
        
        this.transient = audioCtx.createBiquadFilter(); 
        this.transient.type = 'highshelf'; 
        this.transient.frequency.value = 3000;
        this.transient.gain.value = 0;

        this.inputGain = audioCtx.createGain(); 
        this.inputGain.gain.value = 5.0; 

        this.shaper = audioCtx.createWaveShaper();
        this.shaper.oversample = '4x'; 
        
        this.srrNode = audioCtx.createScriptProcessor(2048, 2, 2);
        this.srrHoldCounter = 0;
        this.srrCurrentSampleL = 0;
        this.srrCurrentSampleR = 0;
        
        this.srrNode.onaudioprocess = (e) => {
            const inL = e.inputBuffer.getChannelData(0);
            const inR = e.inputBuffer.getChannelData(1);
            const outL = e.outputBuffer.getChannelData(0);
            const outR = e.outputBuffer.getChannelData(1);
            const holdFactor = Math.floor(this.srrValue);
            
            for (let i = 0; i < inL.length; i++) {
                if (this.srrHoldCounter >= holdFactor) {
                    this.srrCurrentSampleL = inL[i];
                    this.srrCurrentSampleR = inR[i];
                    this.srrHoldCounter = 0;
                }
                outL[i] = this.srrCurrentSampleL;
                outR[i] = this.srrCurrentSampleR;
                this.srrHoldCounter++;
            }
        };

        this.tone = audioCtx.createBiquadFilter(); 
        this.tone.type = 'peaking'; 
        this.tone.frequency.value = 2000;
        this.tone.Q.value = 0.5;

        this.bass = audioCtx.createBiquadFilter(); 
        this.bass.type = 'lowshelf'; 
        this.bass.frequency.value = 250;

        this.mid = audioCtx.createBiquadFilter(); 
        this.mid.type = 'peaking'; 
        this.mid.frequency.value = 800;

        this.treble = audioCtx.createBiquadFilter(); 
        this.treble.type = 'highshelf'; 
        this.treble.frequency.value = 3000;

        this.lpf = audioCtx.createBiquadFilter(); 
        this.lpf.type = 'lowpass';
        this.lpf.frequency.value = 10000;

        this.wetLevel = audioCtx.createGain();
        this.wetLevel.gain.value = 0.5;
        
        this.analyser = audioCtx.createAnalyser();
        this.analyser.fftSize = 2048;

        this.shaperType = 'distortion';
        this.biasValue = 0.0;
        this.symmetryValue = 0.5;
        this.foldValue = 0.0;
        this.bitDepthValue = 16.0;
        this.srrValue = 1.0;
        
        this.dryGain.gain.value = 0.5;
        this.wetGain.gain.value = 0.5;

        // UI-referenssit
        this.knobs = {};
        this.uiElements = {};

        this.updateCurve();

        this.input.connect(this.dryGain);
        this.dryGain.connect(this.output);

        this.input.connect(this.hpf);
        this.hpf.connect(this.transient);
        this.transient.connect(this.inputGain);
        this.inputGain.connect(this.shaper);
        this.shaper.connect(this.srrNode);
        this.srrNode.connect(this.tone);
        this.tone.connect(this.bass);
        this.bass.connect(this.mid);
        this.mid.connect(this.treble);
        this.treble.connect(this.lpf);
        this.lpf.connect(this.wetLevel);
        
        this.wetLevel.connect(this.wetGain);
        this.wetLevel.connect(this.analyser); 
        this.wetGain.connect(this.output);
    }

    updateCurve() {
        const n_samples = 4096;
        const curve = new Float32Array(n_samples);
        const steps = Math.pow(2, this.bitDepthValue);
        const bias = this.biasValue;
        const sym = this.symmetryValue; 
        const fold = this.foldValue;
        const type = this.shaperType; 

        for (let i = 0; i < n_samples; ++i) {
            let x = i * 2 / n_samples - 1; 
            x += bias; 

            if (x > 0) x *= (sym * 2);
            else x *= ((1 - sym) * 2);

            let y = x;

            if (type === 'overdrive') y = Math.sign(x) * (1 - Math.exp(-Math.abs(x))); 
            else if (type === 'fuzz') y = Math.sign(x) * (1 - Math.pow(Math.E, -Math.abs(x) * 5)); 
            else if (type === 'rectifier') y = Math.abs(x) * 2 - 1; 
            else if (type === 'wave folder') y = Math.sin(x * Math.PI * 2); 
            else if (type === 'bit crusher') y = Math.round(x * steps) / steps; 
            else y = Math.tanh(x * 2);

            if (fold > 0) y = Math.sin(y * (1 + fold) * Math.PI);
            if (this.bitDepthValue < 16) y = Math.round(y * steps) / steps;

            if (y > 1) y = 1;
            if (y < -1) y = -1;

            curve[i] = y;
        }
        this.shaper.curve = curve;
    }

    getNodes() { return { input: this.input, output: this.output }; }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            shaperType: this.shaperType,
            biasValue: this.biasValue,
            symmetryValue: this.symmetryValue,
            foldValue: this.foldValue,
            bitDepthValue: this.bitDepthValue,
            srrValue: this.srrValue,
            gainValue: this.inputGain.gain.value * 10,
            levelValue: this.wetLevel.gain.value,
            mixValue: this.dryGain.gain.value === 0 ? 1.0 : (Math.acos(this.dryGain.gain.value) / (0.5 * Math.PI)), // Approksimaatio
            bassValue: this.bass.gain.value,
            midValue: this.mid.gain.value,
            trebleValue: this.treble.gain.value,
            toneValue: this.tone.gain.value,
            transientValue: this.transient.gain.value,
            hpfValue: this.hpf.frequency.value,
            lpfValue: this.lpf.frequency.value
        };
    }

    setState(state) {
        if (!state) return;

        if (state.shaperType !== undefined) {
            this.shaperType = state.shaperType;
            // Etsitään oikea preset, joka vastaa shaperTypeä
            if (this.uiElements.presetSelect) {
                const presetMap = {
                    'distortion': 'Distortion', 'overdrive': 'Overdrive', 'fuzz': 'Fuzz', 
                    'rectifier': 'Rectifier', 'bit crusher': 'Bit Crusher', 'wave folder': 'Wave Folder'
                };
                if (presetMap[this.shaperType]) this.uiElements.presetSelect.value = presetMap[this.shaperType];
            }
        }

        if (state.gainValue !== undefined) { this.inputGain.gain.value = state.gainValue / 10; if (this.knobs['Gain']) this.knobs['Gain'].setValue(state.gainValue); }
        if (state.levelValue !== undefined) { this.wetLevel.gain.setTargetAtTime(state.levelValue, this.ctx.currentTime, 0.05); if (this.knobs['Level']) this.knobs['Level'].setValue(state.levelValue); }
        if (state.mixValue !== undefined) {
            this.dryGain.gain.setTargetAtTime(Math.cos(state.mixValue * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
            this.wetGain.gain.setTargetAtTime(Math.sin(state.mixValue * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
            if (this.knobs['Mix']) this.knobs['Mix'].setValue(state.mixValue);
        }

        if (state.biasValue !== undefined) { this.biasValue = state.biasValue; if (this.knobs['Bias']) this.knobs['Bias'].setValue(this.biasValue); }
        if (state.symmetryValue !== undefined) { this.symmetryValue = state.symmetryValue; if (this.knobs['Symmetry']) this.knobs['Symmetry'].setValue(this.symmetryValue); }
        if (state.foldValue !== undefined) { this.foldValue = state.foldValue; if (this.knobs['Fold']) this.knobs['Fold'].setValue(this.foldValue); }
        if (state.bitDepthValue !== undefined) { this.bitDepthValue = state.bitDepthValue; if (this.knobs['BitDepth']) this.knobs['BitDepth'].setValue(this.bitDepthValue); }
        if (state.srrValue !== undefined) { this.srrValue = state.srrValue; if (this.knobs['SRR']) this.knobs['SRR'].setValue(this.srrValue); }

        if (state.bassValue !== undefined) { this.bass.gain.setTargetAtTime(state.bassValue, this.ctx.currentTime, 0.05); if (this.knobs['Bass']) this.knobs['Bass'].setValue(state.bassValue); }
        if (state.midValue !== undefined) { this.mid.gain.setTargetAtTime(state.midValue, this.ctx.currentTime, 0.05); if (this.knobs['Mid']) this.knobs['Mid'].setValue(state.midValue); }
        if (state.trebleValue !== undefined) { this.treble.gain.setTargetAtTime(state.trebleValue, this.ctx.currentTime, 0.05); if (this.knobs['Treble']) this.knobs['Treble'].setValue(state.trebleValue); }
        if (state.toneValue !== undefined) { this.tone.gain.setTargetAtTime(state.toneValue, this.ctx.currentTime, 0.05); if (this.knobs['Tone']) this.knobs['Tone'].setValue(state.toneValue); }
        if (state.transientValue !== undefined) { this.transient.gain.setTargetAtTime(state.transientValue, this.ctx.currentTime, 0.05); if (this.knobs['Transient']) this.knobs['Transient'].setValue(state.transientValue); }
        if (state.hpfValue !== undefined) { this.hpf.frequency.setTargetAtTime(state.hpfValue, this.ctx.currentTime, 0.05); if (this.knobs['HPF']) this.knobs['HPF'].setValue(state.hpfValue); }
        if (state.lpfValue !== undefined) { this.lpf.frequency.setTargetAtTime(state.lpfValue, this.ctx.currentTime, 0.05); if (this.knobs['LPF']) this.knobs['LPF'].setValue(state.lpfValue); }

        this.updateCurve();
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#ff3366';
        containerElement.style.setProperty('--fx-color', color);

        const styleId = 'fx-dist-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .dist-dashboard { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; padding: 10px 0; gap: 15px; }
                .knob-container-sm { display: flex; flex-direction: column; align-items: center; user-select: none; width: 65px; }
                .knob-wrapper-sm { position: relative; width: 50px; height: 50px; cursor: ns-resize; margin-bottom: 8px; touch-action: none; }
                .knob-svg-sm { width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 4px rgba(255,255,255,0.2)); }
                .knob-track-sm { fill: none; stroke: #2a2a3b; stroke-width: 6; stroke-linecap: round; }
                .knob-value-path-sm { fill: none; stroke: var(--fx-color); stroke-width: 6; stroke-linecap: round; transition: stroke 0.2s; }
                .knob-wrapper-sm:active .knob-value-path-sm, .knob-wrapper-sm:hover .knob-value-path-sm { stroke: #fff; filter: drop-shadow(0 0 8px var(--fx-color)); }
                .knob-center-sm { fill: #1a1a24; stroke: #333; stroke-width: 2; }
                .knob-indicator-sm { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
                .knob-dot-sm { position: absolute; width: 5px; height: 5px; background: var(--fx-color); border-radius: 50%; top: 5px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 6px var(--fx-color); }
                .knob-label-sm { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted); margin-bottom: 4px; text-align: center; }
                .knob-value-display-sm { font-size: 10px; font-family: monospace; color: var(--text-main); background: rgba(0,0,0,0.5); padding: 2px 4px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); text-align: center; min-width: 35px; }
                .dist-panel { background: rgba(0,0,0,0.4); border: 1px solid rgba(255, 51, 102, 0.2); border-radius: 8px; padding: 15px; margin-bottom: 15px; }
                .preset-select { background: #000; color: var(--fx-color); border: 1px solid var(--fx-color); padding: 5px 10px; border-radius: 4px; font-family: monospace; font-size: 12px; outline: none; cursor: pointer; text-transform: uppercase; }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div style="margin-bottom: 15px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">MUTATOR ENGINE</div>
            
            <div class="dist-panel" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 15px;">
                <label style="font-size: 11px; color: #8b8b9f; text-transform: uppercase;">Algorithm Setup:</label>
                <select id="dist-preset" class="preset-select">
                    <option value="Distortion">Distortion</option>
                    <option value="Overdrive">Overdrive</option>
                    <option value="Fuzz">Fuzz</option>
                    <option value="Scoop">Scoop</option>
                    <option value="Rectifier">Rectifier</option>
                    <option value="Bit Crusher">Bit Crusher</option>
                    <option value="Wave Folder">Wave Folder</option>
                    <option value="Custom">Custom</option>
                </select>
            </div>

            <div style="width: 100%; max-width: 500px; height: 80px; background: rgba(0,0,0,0.6); border: 1px solid rgba(255, 51, 102, 0.3); border-radius: 6px; margin: 0 auto 15px auto; overflow: hidden; box-shadow: inset 0 0 15px rgba(0,0,0,0.9);">
                <canvas id="dist-canvas" style="width: 100%; height: 100%; display: block;"></canvas>
            </div>

            <div class="dist-dashboard" id="dist-knobs-1"></div>
            <div class="dist-dashboard" id="dist-knobs-2"></div>
            <div class="dist-dashboard" id="dist-knobs-3"></div>
        `;

        const row1 = containerElement.querySelector('#dist-knobs-1');
        const row2 = containerElement.querySelector('#dist-knobs-2');
        const row3 = containerElement.querySelector('#dist-knobs-3');
        const canvas = containerElement.querySelector('#dist-canvas');
        const ctx2d = canvas.getContext('2d');
        const presetSelect = containerElement.querySelector('#dist-preset');
        
        this.uiElements.presetSelect = presetSelect;

        const createKnob = (container, label, min, max, defaultValue, formatValue, onChange) => {
            const div = document.createElement('div');
            div.className = 'knob-container-sm';
            const radius = 22, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            div.innerHTML = `
                <div class="knob-label-sm">${label}</div>
                <div class="knob-wrapper-sm">
                    <svg class="knob-svg-sm" viewBox="0 0 50 50">
                        <circle class="knob-track-sm" cx="25" cy="25" r="${radius}" stroke-dasharray="${maxDash} ${circumference}" />
                        <circle class="knob-value-path-sm" cx="25" cy="25" r="${radius}" stroke-dasharray="0 ${circumference}" />
                        <circle class="knob-center-sm" cx="25" cy="25" r="14" />
                    </svg>
                    <div class="knob-indicator-sm"><div class="knob-dot-sm"></div></div>
                </div>
                <div class="knob-value-display-sm">${formatValue(defaultValue)}</div>
            `;
            const wrapper = div.querySelector('.knob-wrapper-sm'), valuePath = div.querySelector('.knob-value-path-sm'), indicator = div.querySelector('.knob-indicator-sm'), display = div.querySelector('.knob-value-display-sm');
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
            
            return { setValue: (v) => { currentValue = v; updateUI(v, false); } };
        };

        const currentMix = this.dryGain.gain.value === 0 ? 1.0 : (Math.acos(this.dryGain.gain.value) / (0.5 * Math.PI));

        this.knobs['Gain'] = createKnob(row1, 'Gain', 1, 100, this.inputGain.gain.value * 10, v => Math.round(v), v => { this.inputGain.gain.value = v / 10; presetSelect.value = 'Custom'; });
        this.knobs['Level'] = createKnob(row1, 'Level', 0, 1.0, this.wetLevel.gain.value, v => Math.round(v*100)+'%', v => { this.wetLevel.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); presetSelect.value = 'Custom'; });
        this.knobs['Mix'] = createKnob(row1, 'Mix', 0, 1.0, currentMix, v => Math.round(v*100)+'%', v => {
            this.dryGain.gain.setTargetAtTime(Math.cos(v * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
            this.wetGain.gain.setTargetAtTime(Math.sin(v * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
            presetSelect.value = 'Custom';
        });
        this.knobs['Bias'] = createKnob(row1, 'Bias', -1, 1, this.biasValue, v => v.toFixed(2), v => { this.biasValue = v; this.updateCurve(); presetSelect.value = 'Custom'; });
        this.knobs['Symmetry'] = createKnob(row1, 'Symm', 0, 1, this.symmetryValue, v => v.toFixed(2), v => { this.symmetryValue = v; this.updateCurve(); presetSelect.value = 'Custom'; });
        this.knobs['Fold'] = createKnob(row1, 'Fold', 0, 10, this.foldValue, v => v.toFixed(1), v => { this.foldValue = v; this.updateCurve(); presetSelect.value = 'Custom'; });

        this.knobs['Bass'] = createKnob(row2, 'Bass', -20, 20, this.bass.gain.value, v => Math.round(v)+'dB', v => { this.bass.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); presetSelect.value = 'Custom'; });
        this.knobs['Mid'] = createKnob(row2, 'Mid', -20, 20, this.mid.gain.value, v => Math.round(v)+'dB', v => { this.mid.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); presetSelect.value = 'Custom'; });
        this.knobs['Treble'] = createKnob(row2, 'Treble', -20, 20, this.treble.gain.value, v => Math.round(v)+'dB', v => { this.treble.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); presetSelect.value = 'Custom'; });
        this.knobs['Tone'] = createKnob(row2, 'Tone', -15, 15, this.tone.gain.value, v => Math.round(v), v => { this.tone.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); presetSelect.value = 'Custom'; });
        this.knobs['Transient'] = createKnob(row2, 'Trans', -10, 10, this.transient.gain.value, v => Math.round(v), v => { this.transient.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); presetSelect.value = 'Custom'; });

        this.knobs['BitDepth'] = createKnob(row3, 'Bits', 2, 16, this.bitDepthValue, v => Math.round(v), v => { this.bitDepthValue = Math.round(v); this.updateCurve(); presetSelect.value = 'Custom'; });
        this.knobs['SRR'] = createKnob(row3, 'SRR', 1, 50, this.srrValue, v => Math.round(v), v => { this.srrValue = v; presetSelect.value = 'Custom'; });
        this.knobs['HPF'] = createKnob(row3, 'HPF', 20, 2000, this.hpf.frequency.value, v => Math.round(v)+'Hz', v => { this.hpf.frequency.setTargetAtTime(v, this.ctx.currentTime, 0.05); presetSelect.value = 'Custom'; });
        this.knobs['LPF'] = createKnob(row3, 'LPF', 200, 20000, this.lpf.frequency.value, v => Math.round(v)+'Hz', v => { this.lpf.frequency.setTargetAtTime(v, this.ctx.currentTime, 0.05); presetSelect.value = 'Custom'; });

        const applyPreset = (presetData) => {
            this.shaperType = presetData.type;
            for(let key in presetData.vals) {
                if(this.knobs[key]) {
                    this.knobs[key].setValue(presetData.vals[key]);
                    
                    // Trigger manually since setValue doesn't trigger callback
                    if (key === 'Gain') this.inputGain.gain.value = presetData.vals[key] / 10;
                    if (key === 'Level') this.wetLevel.gain.setTargetAtTime(presetData.vals[key], this.ctx.currentTime, 0.05);
                    if (key === 'Mix') {
                        this.dryGain.gain.setTargetAtTime(Math.cos(presetData.vals[key] * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
                        this.wetGain.gain.setTargetAtTime(Math.sin(presetData.vals[key] * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
                    }
                    if (key === 'Bias') this.biasValue = presetData.vals[key];
                    if (key === 'Symmetry') this.symmetryValue = presetData.vals[key];
                    if (key === 'Fold') this.foldValue = presetData.vals[key];
                    if (key === 'BitDepth') this.bitDepthValue = Math.round(presetData.vals[key]);
                    if (key === 'SRR') this.srrValue = presetData.vals[key];
                    if (key === 'Bass') this.bass.gain.setTargetAtTime(presetData.vals[key], this.ctx.currentTime, 0.05);
                    if (key === 'Mid') this.mid.gain.setTargetAtTime(presetData.vals[key], this.ctx.currentTime, 0.05);
                    if (key === 'Treble') this.treble.gain.setTargetAtTime(presetData.vals[key], this.ctx.currentTime, 0.05);
                    if (key === 'Tone') this.tone.gain.setTargetAtTime(presetData.vals[key], this.ctx.currentTime, 0.05);
                    if (key === 'Transient') this.transient.gain.setTargetAtTime(presetData.vals[key], this.ctx.currentTime, 0.05);
                    if (key === 'HPF') this.hpf.frequency.setTargetAtTime(presetData.vals[key], this.ctx.currentTime, 0.05);
                    if (key === 'LPF') this.lpf.frequency.setTargetAtTime(presetData.vals[key], this.ctx.currentTime, 0.05);
                }
            }
            this.updateCurve();
        };

        const presets = {
            'Distortion':  { type: 'distortion', vals: { Gain: 50, Level: 0.5, Bass: 0, Mid: 0, Treble: 0, Tone: 0, Bias: 0, Symmetry: 0.5, Fold: 0, Transient: 0, BitDepth: 16, SRR: 1, HPF: 80, LPF: 10000, Mix: 1.0 } },
            'Overdrive':   { type: 'overdrive',  vals: { Gain: 30, Level: 0.6, Bass: -2, Mid: 5, Treble: -2, Tone: 3, Bias: 0, Symmetry: 0.6, Fold: 0, Transient: 2, BitDepth: 16, SRR: 1, HPF: 120, LPF: 8000, Mix: 1.0 } },
            'Fuzz':        { type: 'fuzz',       vals: { Gain: 90, Level: 0.4, Bass: 5, Mid: -5, Treble: -4, Tone: -5, Bias: 0.3, Symmetry: 0.4, Fold: 0, Transient: -3, BitDepth: 16, SRR: 1, HPF: 40, LPF: 5000, Mix: 1.0 } },
            'Scoop':       { type: 'distortion', vals: { Gain: 70, Level: 0.5, Bass: 8, Mid: -15, Treble: 8, Tone: 5, Bias: 0, Symmetry: 0.5, Fold: 0, Transient: 5, BitDepth: 16, SRR: 1, HPF: 60, LPF: 12000, Mix: 1.0 } },
            'Rectifier':   { type: 'rectifier',  vals: { Gain: 60, Level: 0.5, Bass: 4, Mid: -2, Treble: 5, Tone: 4, Bias: 0, Symmetry: 0.5, Fold: 0.2, Transient: 4, BitDepth: 16, SRR: 1, HPF: 80, LPF: 15000, Mix: 1.0 } },
            'Bit Crusher': { type: 'bit crusher',vals: { Gain: 40, Level: 0.5, Bass: 0, Mid: 0, Treble: 0, Tone: 0, Bias: 0, Symmetry: 0.5, Fold: 0, Transient: 0, BitDepth: 4, SRR: 12, HPF: 20, LPF: 20000, Mix: 1.0 } },
            'Wave Folder': { type: 'wave folder',vals: { Gain: 60, Level: 0.5, Bass: 0, Mid: 0, Treble: 0, Tone: 0, Bias: 0, Symmetry: 0.5, Fold: 5.0, Transient: 0, BitDepth: 16, SRR: 1, HPF: 20, LPF: 10000, Mix: 1.0 } },
            'Custom':      { type: this.shaperType, vals: {} } // Dummy preset for manual tweaking
        };

        presetSelect.addEventListener('change', (e) => {
            const p = presets[e.target.value];
            if(p && e.target.value !== 'Custom') applyPreset(p);
        });

        // Set initial preset UI match
        let matchedPreset = 'Custom';
        for (const [key, preset] of Object.entries(presets)) {
            if (preset.type === this.shaperType && key !== 'Custom') matchedPreset = key;
        }
        presetSelect.value = matchedPreset;

        // KORJATTU OSKILLOSKOOPPI
        let mountCheckCount = 0;

        const drawCanvas = () => {
            mountCheckCount++;
            
            // Jos elementtiä ei ole liitetty DOMiin, kokeillaan muutaman kerran uudelleen ennen luovuttamista
            if (!document.body.contains(canvas)) {
                if (mountCheckCount > 10) return; // Luovutetaan jos efekti oikeasti poistettiin
                return requestAnimationFrame(drawCanvas);
            }

            const parent = canvas.parentElement;
            if (parent && (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight)) {
                canvas.width = parent.clientWidth || 500;
                canvas.height = parent.clientHeight || 80;
            }

            const w = canvas.width, h = canvas.height;
            if (!w || !h) return requestAnimationFrame(drawCanvas);

            ctx2d.fillStyle = 'rgba(0, 0, 0, 0.4)';
            ctx2d.fillRect(0, 0, w, h);

            ctx2d.strokeStyle = 'rgba(255,255,255,0.1)'; 
            ctx2d.lineWidth = 1; 
            ctx2d.beginPath();
            ctx2d.moveTo(0, h/2); 
            ctx2d.lineTo(w, h/2); 
            ctx2d.stroke();

            const data = new Uint8Array(this.analyser.frequencyBinCount);
            this.analyser.getByteTimeDomainData(data);

            ctx2d.lineWidth = 2;
            ctx2d.strokeStyle = color;
            ctx2d.beginPath();

            const sliceWidth = w * 1.0 / data.length;
            let x = 0;

            for (let i = 0; i < data.length; i++) {
                const v = data[i] / 128.0; 
                const y = (v * h) / 2;     

                if (i === 0) ctx2d.moveTo(x, y);
                else ctx2d.lineTo(x, y);

                x += sliceWidth;
            }

            ctx2d.stroke();
            requestAnimationFrame(drawCanvas);
        };
        drawCanvas();
    }
}