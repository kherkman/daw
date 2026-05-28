// distortion.js
window.CustomAudioEffect = class DistortionEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();

        // Solmut
        this.dryGain = audioCtx.createGain();
        this.wetGain = audioCtx.createGain();
        
        this.driveNode = audioCtx.createWaveShaper();
        this.driveNode.oversample = '4x';
        
        this.toneNode = audioCtx.createBiquadFilter();
        this.toneNode.type = 'lowpass';
        
        this.volumeNode = audioCtx.createGain();

        // Parametrit
        this.drive = 50; 
        this.shape = 50; // UUSI PARAMETRI: Kontekstuaalinen säätö
        this.tone = 3000; 
        this.mix = 1.0; 
        this.vol = 1.0;
        this.type = 'soft'; // 'soft', 'hard', 'fuzz', 'tube', 'foldback', 'bitcrush'

        // UI-referenssit
        this.knobs = {};
        this.uiElements = {};

        // Reititys
        this.input.connect(this.dryGain);
        this.dryGain.connect(this.output);

        this.input.connect(this.driveNode);
        this.driveNode.connect(this.toneNode);
        this.toneNode.connect(this.volumeNode);
        this.volumeNode.connect(this.wetGain);
        this.wetGain.connect(this.output);

        this.updateCurve();
        this.toneNode.frequency.value = this.tone;
        this.volumeNode.gain.value = this.vol;
        this.updateMix();
    }

    makeDistortionCurve(amount, type, shapeAmount) {
        const k = typeof amount === 'number' ? amount : 50;
        const s = typeof shapeAmount === 'number' ? shapeAmount : 50;
        const n_samples = 44100;
        const curve = new Float32Array(n_samples);
        const deg = Math.PI / 180;
        
        // Normalisoidaan parametrit helpommin laskettavaan muotoon
        const driveFac = (k / 100) * 10 + 1; // 1 -> 11
        const shapeFac = s / 100; // 0.0 -> 1.0
        
        for (let i = 0; i < n_samples; ++i) {
            let x = (i * 2) / n_samples - 1;
            
            switch(type) {
                case 'hard':
                    // Hard clipping + Shape säätää epäsymmetriaa (DC bias effect)
                    let bias = (shapeFac - 0.5) * 0.4;
                    curve[i] = Math.max(-1, Math.min(1, (x + bias) * driveFac));
                    break;

                case 'fuzz':
                    // Asymmetric fuzz + Shape säätää "dying battery" / gate -efektiä
                    const fuzzFactor = k / 10;
                    const asym = shapeFac * 2; // 0 -> 2
                    if (x < 0) {
                        curve[i] = -Math.pow(Math.abs(x), fuzzFactor > 0 ? 1 / (fuzzFactor * (2 - asym) + 0.1) : 1);
                    } else {
                        curve[i] = 1 - Math.exp(-x * fuzzFactor * (asym + 0.1));
                    }
                    break;

                case 'tube':
                    // Putkisärö (Tanh) + Shape tuo esiin toista harmonista kerrannaista
                    let tx = x * driveFac * 1.5;
                    let asymTube = shapeFac - 0.5;
                    curve[i] = Math.tanh(tx + asymTube * (tx * tx));
                    break;

                case 'foldback':
                    // Aaltomuoto taittuu itsensä yli. Shape ohjaa taittumistiheyttä.
                    let foldFreq = 1 + shapeFac * 3;
                    curve[i] = Math.sin(x * driveFac * foldFreq * (Math.PI / 2));
                    break;

                case 'bitcrush':
                    // Shape määrittää bittisyvyyden (vähemmän shapea = enemmän crushia)
                    // Drive toimii pregainina ennen kvantisointia
                    let bits = 2 + Math.floor((1 - shapeFac) * 14); // 16 -> 2 bits
                    let steps = Math.pow(2, bits);
                    let preGainX = Math.max(-1, Math.min(1, x * driveFac));
                    curve[i] = Math.round(preGainX * steps) / steps;
                    break;

                case 'soft':
                default:
                    // Soft clipping. Shape muuttaa käyrän luonnetta pehmeän ja puolikovan välillä.
                    let s_mix = shapeFac;
                    let c1 = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
                    let c2 = Math.tanh(x * driveFac);
                    curve[i] = c1 * (1 - s_mix) + c2 * s_mix;
                    break;
            }

            // Varmistetaan ettei käyrä räjähdä yli rajojen
            if (curve[i] > 1) curve[i] = 1;
            if (curve[i] < -1) curve[i] = -1;
        }
        return curve;
    }

    updateCurve() {
        this.driveNode.curve = this.makeDistortionCurve(this.drive, this.type, this.shape);
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
            shape: this.shape,
            tone: this.tone,
            mix: this.mix,
            vol: this.vol,
            type: this.type
        };
    }

    setState(state) {
        if (!state) return;

        if (state.type !== undefined && state.type !== this.type) {
            this.type = state.type;
            if (this.uiElements.typeSelect) this.uiElements.typeSelect.value = this.type;
        }

        if (state.drive !== undefined) {
            this.drive = state.drive;
            if (this.knobs['drive']) this.knobs['drive'].setValue(this.drive);
        }

        if (state.shape !== undefined) {
            this.shape = state.shape;
            if (this.knobs['shape']) this.knobs['shape'].setValue(this.shape);
        }
        
        // Päivitetään curve kerralla, kun drive/shape/type on mahdollisesti muuttunut
        this.updateCurve();

        if (state.tone !== undefined) {
            this.tone = state.tone;
            this.toneNode.frequency.setTargetAtTime(this.tone, this.ctx.currentTime, 0.05);
            if (this.knobs['tone']) this.knobs['tone'].setValue(this.tone);
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
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#ff2222';
        containerElement.style.setProperty('--fx-color', color);

        containerElement.innerHTML = `
            <div style="margin-bottom: 10px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">DISTORTION</div>
            
            <div style="text-align: center; margin-bottom: 15px;">
                <label style="font-size: 10px; color: #8b8b9f; text-transform: uppercase; margin-right: 10px;">Type</label>
                <select id="dist-type-select" style="background: #111; color: var(--fx-color); border: 1px solid var(--fx-color); padding: 5px 10px; border-radius: 4px; font-family: monospace; font-size: 12px; outline: none; cursor: pointer;">
                    <option value="soft" ${this.type === 'soft' ? 'selected' : ''}>Overdrive (Soft)</option>
                    <option value="tube" ${this.type === 'tube' ? 'selected' : ''}>Tube (Warm)</option>
                    <option value="hard" ${this.type === 'hard' ? 'selected' : ''}>Distortion (Hard)</option>
                    <option value="fuzz" ${this.type === 'fuzz' ? 'selected' : ''}>Fuzz (Asym)</option>
                    <option value="foldback" ${this.type === 'foldback' ? 'selected' : ''}>Foldback (Synth)</option>
                    <option value="bitcrush" ${this.type === 'bitcrush' ? 'selected' : ''}>Bitcrush (Digital)</option>
                </select>
            </div>

            <div style="display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 15px;" id="dist-dashboard"></div>
        `;
        
        this.uiElements.typeSelect = containerElement.querySelector('#dist-type-select');
        this.uiElements.typeSelect.addEventListener('change', (e) => {
            this.type = e.target.value;
            this.updateCurve();
        });

        const dashboard = containerElement.querySelector('#dist-dashboard');

        const createKnob = (label, min, max, defaultValue, formatValue, onChange) => {
            const container = document.createElement('div');
            container.style = "display: flex; flex-direction: column; align-items: center; user-select: none; width: 65px;";
            const radius = 25, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            container.innerHTML = `
                <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #8b8b9f; margin-bottom: 5px; text-align: center;">${label}</div>
                <div class="knob-wrapper" style="position: relative; width: 55px; height: 55px; cursor: ns-resize; margin-bottom: 8px; touch-action: none;">
                    <svg viewBox="0 0 60 60" style="width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 5px rgba(255,255,255,0.2));">
                        <circle cx="30" cy="30" r="${radius}" fill="none" stroke="#2a2a3b" stroke-width="8" stroke-linecap="round" stroke-dasharray="${maxDash} ${circumference}" />
                        <circle class="knob-value-path" cx="30" cy="30" r="${radius}" fill="none" stroke="var(--fx-color)" stroke-width="8" stroke-linecap="round" stroke-dasharray="0 ${circumference}" style="transition: stroke 0.2s;" />
                        <circle cx="30" cy="30" r="16" fill="#1a1a24" stroke="#333" stroke-width="2" />
                    </svg>
                    <div class="knob-indicator" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none;">
                        <div style="position: absolute; width: 6px; height: 6px; background: var(--fx-color); border-radius: 50%; top: 5px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 8px var(--fx-color);"></div>
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
        this.knobs['shape'] = createKnob('Shape', 0, 100, this.shape, v => Math.round(v), v => { this.shape = v; this.updateCurve(); });
        this.knobs['tone'] = createKnob('Tone', 500, 10000, this.tone, v => Math.round(v) + 'Hz', v => { this.tone = v; this.toneNode.frequency.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
        this.knobs['mix'] = createKnob('Mix', 0, 1.0, this.mix, v => Math.round(v * 100) + '%', v => { this.mix = v; this.updateMix(); });
        this.knobs['vol'] = createKnob('Volume', 0, 2.0, this.vol, v => Math.round(v * 100) + '%', v => { this.vol = v; this.volumeNode.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
    }
}