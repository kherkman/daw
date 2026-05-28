// cabinet.js
window.CustomAudioEffect = class CabinetSimulator {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();

        this.dryGain = audioCtx.createGain();
        this.wetGain = audioCtx.createGain();
        this.convolver = audioCtx.createConvolver();
        this.outGain = audioCtx.createGain();

        // Parametrit
        this.mix = 1.0;
        this.outVol = 1.0;
        this.model = '4x10';

        // UI-referenssit
        this.knobs = {};
        this.uiElements = {};

        // Reititys
        this.input.connect(this.dryGain);
        this.input.connect(this.convolver);
        
        this.dryGain.connect(this.outGain);
        this.convolver.connect(this.wetGain);
        this.wetGain.connect(this.outGain);
        
        this.outGain.connect(this.output);

        this.updateMix();
        this.outGain.gain.value = this.outVol;
        this.generateIR(this.model);
    }

    updateMix() {
        this.dryGain.gain.setTargetAtTime(Math.cos(this.mix * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
        this.wetGain.gain.setTargetAtTime(Math.sin(this.mix * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
    }

    generateIR(model) {
        const length = this.ctx.sampleRate * 0.1; // 100ms
        const impulse = this.ctx.createBuffer(2, length, this.ctx.sampleRate);
        const left = impulse.getChannelData(0);
        const right = impulse.getChannelData(1);

        let decayRate = 30;
        let resonanceFreq = 100;
        let lpfCutoff = 5000;

        if (model === '1x15') {
            decayRate = 20; resonanceFreq = 60; lpfCutoff = 3000;
        } else if (model === '4x10') {
            decayRate = 35; resonanceFreq = 120; lpfCutoff = 6000;
        } else if (model === '8x10') {
            decayRate = 45; resonanceFreq = 90; lpfCutoff = 4500;
        } else if (model === '1x12') {
            decayRate = 25; resonanceFreq = 150; lpfCutoff = 7000;
        } else if (model === '4x12') {
            decayRate = 40; resonanceFreq = 110; lpfCutoff = 5500;
        }

        const rc = 1.0 / (lpfCutoff * 2 * Math.PI);
        const dt = 1.0 / this.ctx.sampleRate;
        const alpha = dt / (rc + dt);
        let prevLeft = 0, prevRight = 0;

        for (let i = 0; i < length; i++) {
            const time = i / this.ctx.sampleRate;
            const envelope = Math.exp(-decayRate * time);
            
            // Perusresonanssi (kaapin "kumu") + satunnainen häiriö (heijastukset)
            let rawLeft = (Math.sin(2 * Math.PI * resonanceFreq * time) * 0.5 + (Math.random() * 2 - 1) * 0.5) * envelope;
            let rawRight = (Math.sin(2 * Math.PI * resonanceFreq * time) * 0.5 + (Math.random() * 2 - 1) * 0.5) * envelope;

            // Simple Low-Pass
            prevLeft = prevLeft + alpha * (rawLeft - prevLeft);
            prevRight = prevRight + alpha * (rawRight - prevRight);

            left[i] = prevLeft;
            right[i] = prevRight;
        }

        this.convolver.buffer = impulse;
    }

    getNodes() {
        return { input: this.input, output: this.output };
    }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            mix: this.mix,
            outVol: this.outVol,
            model: this.model
        };
    }

    setState(state) {
        if (!state) return;

        if (state.mix !== undefined) {
            this.mix = state.mix;
            this.updateMix();
            if (this.knobs['mix']) this.knobs['mix'].setValue(this.mix);
        }
        if (state.outVol !== undefined) {
            this.outVol = state.outVol;
            this.outGain.gain.setTargetAtTime(this.outVol, this.ctx.currentTime, 0.05);
            if (this.knobs['outVol']) this.knobs['outVol'].setValue(this.outVol);
        }
        if (state.model !== undefined && state.model !== this.model) {
            this.model = state.model;
            this.generateIR(this.model);
            if (this.uiElements.modelSelect) this.uiElements.modelSelect.value = this.model;
        }
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#ff8800';
        containerElement.style.setProperty('--fx-color', color);

        containerElement.innerHTML = `
            <div style="margin-bottom: 10px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">CABINET SIMULATOR</div>
            
            <div style="text-align: center; margin-bottom: 15px;">
                <label style="font-size: 10px; color: #8b8b9f; text-transform: uppercase; margin-right: 10px;">Cab Model</label>
                <select id="cab-model-select" style="background: #111; color: var(--fx-color); border: 1px solid var(--fx-color); padding: 5px 10px; border-radius: 4px; font-family: monospace; font-size: 12px; outline: none; cursor: pointer;">
                    <option value="1x12" ${this.model === '1x12' ? 'selected' : ''}>1x12 Vintage (Gtr)</option>
                    <option value="4x12" ${this.model === '4x12' ? 'selected' : ''}>4x12 Modern (Gtr)</option>
                    <option value="1x15" ${this.model === '1x15' ? 'selected' : ''}>1x15 Deep (Bass)</option>
                    <option value="4x10" ${this.model === '4x10' ? 'selected' : ''}>4x10 Punch (Bass)</option>
                    <option value="8x10" ${this.model === '8x10' ? 'selected' : ''}>8x10 Fridge (Bass)</option>
                </select>
            </div>

            <div style="display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 30px;" id="cab-dashboard"></div>
        `;
        
        this.uiElements.modelSelect = containerElement.querySelector('#cab-model-select');
        this.uiElements.modelSelect.addEventListener('change', (e) => {
            this.model = e.target.value;
            this.generateIR(this.model);
        });

        const dashboard = containerElement.querySelector('#cab-dashboard');

        const createKnob = (label, min, max, defaultValue, formatValue, onChange) => {
            const container = document.createElement('div');
            container.style = "display: flex; flex-direction: column; align-items: center; user-select: none; width: 70px;";
            const radius = 25, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            container.innerHTML = `
                <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #8b8b9f; margin-bottom: 5px; text-align: center;">${label}</div>
                <div class="knob-wrapper" style="position: relative; width: 60px; height: 60px; cursor: ns-resize; margin-bottom: 8px; touch-action: none;">
                    <svg viewBox="0 0 60 60" style="width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 5px rgba(255,255,255,0.2));">
                        <circle cx="30" cy="30" r="${radius}" fill="none" stroke="#2a2a3b" stroke-width="8" stroke-linecap="round" stroke-dasharray="${maxDash} ${circumference}" />
                        <circle class="knob-value-path" cx="30" cy="30" r="${radius}" fill="none" stroke="var(--fx-color)" stroke-width="8" stroke-linecap="round" stroke-dasharray="0 ${circumference}" style="transition: stroke 0.2s;" />
                        <circle cx="30" cy="30" r="16" fill="#1a1a24" stroke="#333" stroke-width="2" />
                    </svg>
                    <div class="knob-indicator" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none;">
                        <div style="position: absolute; width: 6px; height: 6px; background: var(--fx-color); border-radius: 50%; top: 6px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 8px var(--fx-color);"></div>
                    </div>
                </div>
                <div class="knob-value-display" style="font-size: 11px; font-family: monospace; color: #fff; background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); text-align: center; min-width: 40px;">${formatValue(defaultValue)}</div>
            `;
            const wrapper = container.querySelector('.knob-wrapper'), valuePath = container.querySelector('.knob-value-path'), indicator = container.querySelector('.knob-indicator'), display = container.querySelector('.knob-value-display');
            let currentValue = defaultValue;

            const updateUI = (value) => {
                const normalized = (value - min) / (max - min);
                valuePath.setAttribute('stroke-dasharray', `${normalized * maxDash} ${circumference}`);
                indicator.style.transform = `rotate(${-135 + (normalized * 270)}deg)`;
                display.innerText = formatValue(value);
            };
            updateUI(currentValue);
            dashboard.appendChild(container);

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

            wrapper.addEventListener('mousedown', (e) => startDrag(e.clientY)); window.addEventListener('mousemove', (e) => doDrag(e.clientY)); window.addEventListener('mouseup', endDrag);
            wrapper.addEventListener('touchstart', (e) => startDrag(e.touches[0].clientY), { passive: false }); window.addEventListener('touchmove', (e) => { if (isDragging) { e.preventDefault(); doDrag(e.touches[0].clientY); } }, { passive: false }); window.addEventListener('touchend', endDrag);

            return {
                setValue: (v) => {
                    currentValue = v;
                    updateUI(v);
                }
            };
        };

        this.knobs['mix'] = createKnob('Mix', 0, 1.0, this.mix, v => Math.round(v * 100) + '%', v => { this.mix = v; this.updateMix(); });
        this.knobs['outVol'] = createKnob('Output', 0, 2.0, this.outVol, v => Math.round(v * 100) + '%', v => { this.outVol = v; this.outGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
    }
}