// exciter.js
window.CustomAudioEffect = class ExciterEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();

        this.dryGain = audioCtx.createGain();
        this.wetGain = audioCtx.createGain();
        
        this.hpf = audioCtx.createBiquadFilter();
        this.hpf.type = 'highpass';
        
        this.driveNode = audioCtx.createWaveShaper();
        this.driveNode.oversample = '4x';
        
        this.compGain = audioCtx.createGain(); // Tasoittaa lisättyjen harmonisten voimakkuutta

        // Parametrit
        this.freq = 3000;
        this.drive = 50;
        this.mix = 0.5;

        // UI-referenssit
        this.knobs = {};

        // Reititys
        this.input.connect(this.dryGain);
        this.dryGain.connect(this.output);

        this.input.connect(this.hpf);
        this.hpf.connect(this.driveNode);
        this.driveNode.connect(this.compGain);
        this.compGain.connect(this.wetGain);
        this.wetGain.connect(this.output);

        this.updateParams();
    }

    makeDistortionCurve(amount) {
        const k = amount;
        const n_samples = 44100;
        const curve = new Float32Array(n_samples);
        const deg = Math.PI / 180;
        for (let i = 0; i < n_samples; ++i) {
            const x = (i * 2) / n_samples - 1;
            // Exciterille tyypillinen pehmeä, ylä-ääniä korostava saturaatio
            curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
        }
        return curve;
    }

    updateParams() {
        this.hpf.frequency.setTargetAtTime(this.freq, this.ctx.currentTime, 0.05);
        this.driveNode.curve = this.makeDistortionCurve(this.drive);
        
        // Kompensoidaan volyymia särön kasvaessa
        this.compGain.gain.setTargetAtTime(1.0 - (this.drive / 200), this.ctx.currentTime, 0.05);

        this.dryGain.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.05); // Dry on aina 1.0 tässä rinnakkaisessa efektissä
        this.wetGain.gain.setTargetAtTime(this.mix, this.ctx.currentTime, 0.05); // Mix ohjaa vain lisättyjen harmonisten määrää
    }

    getNodes() {
        return { input: this.input, output: this.output };
    }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            freq: this.freq,
            drive: this.drive,
            mix: this.mix
        };
    }

    setState(state) {
        if (!state) return;

        if (state.freq !== undefined) {
            this.freq = state.freq;
            if (this.knobs['freq']) this.knobs['freq'].setValue(this.freq);
        }
        if (state.drive !== undefined) {
            this.drive = state.drive;
            if (this.knobs['drive']) this.knobs['drive'].setValue(this.drive);
        }
        if (state.mix !== undefined) {
            this.mix = state.mix;
            if (this.knobs['mix']) this.knobs['mix'].setValue(this.mix);
        }
        this.updateParams();
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#ffd700'; // Gold
        containerElement.style.setProperty('--fx-color', color);

        containerElement.innerHTML = `
            <div style="margin-bottom: 5px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">HARMONIC EXCITER</div>
            <div style="text-align: center; font-size: 10px; color: #888; margin-bottom: 15px;">Adds saturated harmonics to upper frequencies</div>
            <div style="display: flex; flex-wrap: wrap; justify-content: center; align-items: center; padding: 5px 0; gap: 20px;" id="exciter-dashboard"></div>
        `;
        const dashboard = containerElement.querySelector('#exciter-dashboard');

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

        this.knobs['freq'] = createKnob('Freq', 1000, 10000, this.freq, v => Math.round(v) + ' Hz', v => { this.freq = v; this.updateParams(); });
        this.knobs['drive'] = createKnob('Harmonics', 0, 100, this.drive, v => Math.round(v), v => { this.drive = v; this.updateParams(); });
        this.knobs['mix'] = createKnob('Amount', 0, 1.0, this.mix, v => Math.round(v * 100) + '%', v => { this.mix = v; this.updateParams(); });
    }
}