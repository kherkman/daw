// saturation.js
window.CustomAudioEffect = class SaturationEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();

        // Nodes
        this.dryGain = audioCtx.createGain();
        this.wetGain = audioCtx.createGain();
        
        this.driveNode = audioCtx.createWaveShaper();
        this.driveNode.oversample = '4x';
        
        this.volumeNode = audioCtx.createGain();

        // Parametrit
        this.drive = 30; 
        this.algorithm = 'tape'; // 'tape', 'tube', 'warm'
        this.mix = 1.0; 
        this.vol = 1.0;

        // UI-referenssit
        this.knobs = {};
        this.uiElements = {};

        // Routing
        this.input.connect(this.dryGain);
        this.dryGain.connect(this.output);

        this.input.connect(this.driveNode);
        this.driveNode.connect(this.volumeNode);
        this.volumeNode.connect(this.wetGain);
        this.wetGain.connect(this.output);

        this.updateCurve();
        this.updateMix();
        this.volumeNode.gain.value = this.vol;
    }

    makeCurve(amount, type) {
        const k = typeof amount === 'number' ? amount : 50;
        const n_samples = 44100;
        const curve = new Float32Array(n_samples);
        const deg = Math.PI / 180;
        
        for (let i = 0; i < n_samples; ++i) {
            let x = (i * 2) / n_samples - 1;
            
            if (type === 'tape') {
                // Tape: Symmetrical, slight compression, odd harmonics
                curve[i] = (2 / Math.PI) * Math.atan(x * (1 + k / 10));
            } else if (type === 'tube') {
                // Tube: Asymmetrical, even harmonics
                if (x < 0) {
                    curve[i] = x;
                } else {
                    curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
                }
            } else {
                // Warm: Very soft saturation
                curve[i] = Math.tanh(x * (1 + k / 20));
            }
        }
        return curve;
    }

    updateCurve() {
        this.driveNode.curve = this.makeCurve(this.drive, this.algorithm);
    }

    updateMix() {
        this.dryGain.gain.setTargetAtTime(Math.cos(this.mix * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
        this.wetGain.gain.setTargetAtTime(Math.sin(this.mix * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
    }

    getNodes() {
        return { input: this.input, output: this.output };
    }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            drive: this.drive,
            algorithm: this.algorithm,
            mix: this.mix,
            vol: this.vol
        };
    }

    setState(state) {
        if (!state) return;

        if (state.algorithm !== undefined && state.algorithm !== this.algorithm) {
            this.algorithm = state.algorithm;
            if (this.uiElements.algoSelect) this.uiElements.algoSelect.value = this.algorithm;
        }

        if (state.drive !== undefined) {
            this.drive = state.drive;
            if (this.knobs['drive']) this.knobs['drive'].setValue(this.drive);
        }

        if (state.mix !== undefined) {
            this.mix = state.mix;
            this.updateMix();
            if (this.knobs['mix']) this.knobs['mix'].setValue(this.mix);
        }

        if (state.vol !== undefined) {
            this.vol = state.vol;
            this.volumeNode.gain.setTargetAtTime(this.vol, this.ctx.currentTime, 0.05);
            if (this.knobs['vol']) this.knobs['vol'].setValue(this.vol);
        }

        this.updateCurve();
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#ff4500'; // OrangeRed
        containerElement.style.setProperty('--fx-color', color);

        containerElement.innerHTML = `
            <div style="margin-bottom: 10px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">ANALOG SATURATION</div>
            
            <div style="text-align: center; margin-bottom: 15px;">
                <label style="font-size: 10px; color: #8b8b9f; text-transform: uppercase; margin-right: 10px;">Circuit</label>
                <select id="sat-algo-select" style="background: #111; color: var(--fx-color); border: 1px solid var(--fx-color); padding: 5px 10px; border-radius: 4px; font-family: monospace; font-size: 12px; outline: none; cursor: pointer;">
                    <option value="tape" ${this.algorithm === 'tape' ? 'selected' : ''}>Magnetic Tape</option>
                    <option value="tube" ${this.algorithm === 'tube' ? 'selected' : ''}>Vacuum Tube</option>
                    <option value="warm" ${this.algorithm === 'warm' ? 'selected' : ''}>Warm Drive</option>
                </select>
            </div>

            <div style="display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 20px;" id="sat-dashboard"></div>
        `;
        
        this.uiElements.algoSelect = containerElement.querySelector('#sat-algo-select');
        this.uiElements.algoSelect.addEventListener('change', (e) => {
            this.algorithm = e.target.value;
            this.updateCurve();
        });

        const dashboard = containerElement.querySelector('#sat-dashboard');

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

        this.knobs['drive'] = createKnob('Drive', 0, 100, this.drive, v => Math.round(v), v => { this.drive = v; this.updateCurve(); });
        this.knobs['mix'] = createKnob('Mix', 0, 1.0, this.mix, v => Math.round(v * 100) + '%', v => { this.mix = v; this.updateMix(); });
        this.knobs['vol'] = createKnob('Output', 0, 2.0, this.vol, v => Math.round(v * 100) + '%', v => { this.vol = v; this.volumeNode.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
    }
}