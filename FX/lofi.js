// lofi.js - Lo-Fi & Tape Modulation Effect
window.CustomAudioEffect = class LoFiEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();

        // Reititys
        this.dryGain = audioCtx.createGain();
        this.wetGain = audioCtx.createGain();
        
        // Suodattimet (Reduced Frequency Response)
        this.hpf = audioCtx.createBiquadFilter();
        this.hpf.type = 'highpass';
        this.lpf = audioCtx.createBiquadFilter();
        this.lpf.type = 'lowpass';

        // Särö (Tape Saturation)
        this.saturation = audioCtx.createWaveShaper();
        this.makeSaturationCurve(0);

        // Wow & Flutter (Vibrato / Tempo drift / Detune)
        this.delay = audioCtx.createDelay(1.0);
        this.delay.delayTime.value = 0.05; // 50ms base delay
        this.lfo = audioCtx.createOscillator();
        this.lfoGain = audioCtx.createGain();
        this.lfo.frequency.value = 1.0; // Rate
        this.lfoGain.gain.value = 0.0;  // Depth
        this.lfo.connect(this.lfoGain);
        this.lfoGain.connect(this.delay.delayTime);
        this.lfo.start();

        // Kohina (Tape Hiss)
        this.hissGain = audioCtx.createGain();
        this.hissGain.gain.value = 0;
        this.hissSource = this.createNoiseBuffer();
        this.hissSource.connect(this.hissGain);
        this.hissGain.connect(this.output);

        // Rätinä (Vinyl Crackle)
        this.crackleGain = audioCtx.createGain();
        this.crackleGain.gain.value = 0;
        this.crackleSource = this.createCrackleBuffer();
        this.crackleSource.connect(this.crackleGain);
        this.crackleGain.connect(this.output);

        // Kytkennät: Input -> Dry -> Output
        this.input.connect(this.dryGain);
        this.dryGain.connect(this.output);

        // Kytkennät: Input -> HPF -> LPF -> Saturation -> Delay -> Wet -> Output
        this.input.connect(this.hpf);
        this.hpf.connect(this.lpf);
        this.lpf.connect(this.saturation);
        this.saturation.connect(this.delay);
        this.delay.connect(this.wetGain);
        this.wetGain.connect(this.output);

        // Default parametrit
        this.params = {
            mix: 1.0,
            hpfFreq: 150,
            lpfFreq: 6000,
            drive: 0,
            hiss: 0,
            crackle: 0,
            driftRate: 1.0,
            driftDepth: 0
        };
        this.updateParams();
    }

    createNoiseBuffer() {
        const bufferSize = this.ctx.sampleRate * 2; 
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const output = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            output[i] = (Math.random() * 2 - 1) * 0.2; 
        }
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.start(0);
        return source;
    }

    createCrackleBuffer() {
        const bufferSize = this.ctx.sampleRate * 2; 
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const output = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            if (Math.random() < 0.001) {
                output[i] = (Math.random() * 2 - 1) * 0.8;
            } else if (Math.random() < 0.01) {
                output[i] = (Math.random() * 2 - 1) * 0.1;
            } else {
                output[i] = 0;
            }
        }
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.start(0);
        return source;
    }

    makeSaturationCurve(amount) {
        const k = typeof amount === 'number' ? amount : 50;
        const n_samples = 44100;
        const curve = new Float32Array(n_samples);
        const deg = Math.PI / 180;
        for (let i = 0; i < n_samples; ++i) {
            let x = i * 2 / n_samples - 1;
            curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
        }
        this.saturation.curve = curve;
    }

    updateParams() {
        this.wetGain.gain.setTargetAtTime(this.params.mix, this.ctx.currentTime, 0.05);
        this.dryGain.gain.setTargetAtTime(1.0 - this.params.mix, this.ctx.currentTime, 0.05);
        this.hpf.frequency.setTargetAtTime(this.params.hpfFreq, this.ctx.currentTime, 0.05);
        this.lpf.frequency.setTargetAtTime(this.params.lpfFreq, this.ctx.currentTime, 0.05);
        this.hissGain.gain.setTargetAtTime(this.params.hiss * 0.1, this.ctx.currentTime, 0.05);
        this.crackleGain.gain.setTargetAtTime(this.params.crackle * 0.5, this.ctx.currentTime, 0.05);
        this.lfo.frequency.setTargetAtTime(this.params.driftRate, this.ctx.currentTime, 0.05);
        this.lfoGain.gain.setTargetAtTime(this.params.driftDepth * 0.01, this.ctx.currentTime, 0.05);
        this.makeSaturationCurve(this.params.drive * 100);
    }

    getNodes() {
        return { input: this.input, output: this.output };
    }

    getState() { return this.params; }
    
    setState(state) {
        if (state) {
            this.params = { ...this.params, ...state };
            this.updateParams();
            if (this.updateUIValues) this.updateUIValues();
        }
    }

    // Tärkeä! Sammuttaa laitteet, kun efekti poistetaan.
    destroy() {
        try { this.hissSource.stop(); this.hissSource.disconnect(); } catch(e){}
        try { this.crackleSource.stop(); this.crackleSource.disconnect(); } catch(e){}
        try { this.lfo.stop(); this.lfo.disconnect(); } catch(e){}
    }

    renderUI(containerElement) {
        containerElement.style.setProperty('--accent-primary', '#ff9800');
        containerElement.innerHTML = `
            <div style="color: #ff9800; font-weight: bold; text-align: center; letter-spacing: 2px; font-size: 14px; margin-bottom: 15px; text-transform: uppercase;">Lo-Fi & Tape Simulator</div>
            <div id="lofi-knobs" style="display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 15px;"></div>
        `;

        const dashboard = containerElement.querySelector('#lofi-knobs');
        this.uiUpdaters = [];

        const createKnob = (label, key, min, max, formatValue) => {
            const container = document.createElement('div');
            container.style = "display: flex; flex-direction: column; align-items: center; user-select: none; width: 65px;";
            const radius = 24, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            
            container.innerHTML = `
                <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #8b8b9f; margin-bottom: 5px; text-align:center; height:24px; display:flex; align-items:flex-end;">${label}</div>
                <div class="knob-wrapper" style="position: relative; width: 60px; height: 60px; cursor: ns-resize; margin-bottom: 8px;">
                    <svg viewBox="0 0 60 60" style="width: 100%; height: 100%; transform: rotate(135deg);">
                        <circle cx="30" cy="30" r="${radius}" fill="none" stroke="#2a2a3b" stroke-width="6" stroke-linecap="round" stroke-dasharray="${maxDash} ${circumference}" />
                        <circle class="knob-value-path" cx="30" cy="30" r="${radius}" fill="none" stroke="#ff9800" stroke-width="6" stroke-linecap="round" stroke-dasharray="0 ${circumference}" style="transition: stroke 0.1s;" />
                        <circle cx="30" cy="30" r="16" fill="#1a1a24" stroke="#444" stroke-width="2" />
                    </svg>
                    <div class="knob-indicator" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none;">
                        <div style="position: absolute; width: 4px; height: 4px; background: #ff9800; border-radius: 50%; top: 8px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 6px #ff9800;"></div>
                    </div>
                </div>
                <div class="knob-value-display" style="font-size: 11px; font-family: monospace; color: #fff; background: rgba(0,0,0,0.5); padding: 2px 4px; border-radius: 4px; text-align: center; width:100%;">${formatValue(this.params[key])}</div>
            `;

            const wrapper = container.querySelector('.knob-wrapper');
            const valuePath = container.querySelector('.knob-value-path');
            const indicator = container.querySelector('.knob-indicator');
            const display = container.querySelector('.knob-value-display');

            const updateVisuals = () => {
                const val = this.params[key];
                const normalized = (val - min) / (max - min);
                valuePath.setAttribute('stroke-dasharray', `${normalized * maxDash} ${circumference}`);
                indicator.style.transform = `rotate(${-135 + (normalized * 270)}deg)`;
                display.innerText = formatValue(val);
            };

            this.uiUpdaters.push(updateVisuals);
            updateVisuals();
            dashboard.appendChild(container);

            let isDragging = false, startY = 0, startValue = 0;
            const startDrag = (y) => { isDragging = true; startY = y; startValue = this.params[key]; document.body.style.cursor = 'ns-resize'; };
            const doDrag = (y) => {
                if (!isDragging) return;
                let newVal = startValue + (((startY - y) / 100) * (max - min));
                newVal = Math.max(min, Math.min(max, newVal));
                if (newVal !== this.params[key]) { 
                    this.params[key] = newVal; 
                    updateVisuals(); 
                    this.updateParams(); 
                }
            };
            const endDrag = () => { if (isDragging) { isDragging = false; document.body.style.cursor = 'default'; } };

            wrapper.addEventListener('mousedown', (e) => startDrag(e.clientY)); window.addEventListener('mousemove', (e) => doDrag(e.clientY)); window.addEventListener('mouseup', endDrag);
        };

        const fPct = v => Math.round(v * 100) + '%';
        const fHz = v => Math.round(v) + 'Hz';

        createKnob('Drive', 'drive', 0, 1.0, fPct);
        createKnob('Tape Hiss', 'hiss', 0, 1.0, fPct);
        createKnob('Crackle', 'crackle', 0, 1.0, fPct);
        createKnob('Low Cut', 'hpfFreq', 20, 1000, fHz);
        createKnob('High Cut', 'lpfFreq', 1000, 20000, fHz);
        createKnob('Drift Rate', 'driftRate', 0.1, 10.0, v => v.toFixed(1) + 'Hz');
        createKnob('Drift Depth', 'driftDepth', 0, 1.0, fPct);
        createKnob('Mix', 'mix', 0, 1.0, fPct);

        this.updateUIValues = () => { this.uiUpdaters.forEach(f => f()); };
    }
}