// guitaramp.js
window.CustomAudioEffect = class GuitarAmpEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();

        // Pre-EQ (kitaralle sopiva High-pass)
        this.preFilter = audioCtx.createBiquadFilter();
        this.preFilter.type = 'highpass';
        this.preFilter.frequency.value = 80;

        // Drive stage
        this.driveNode = audioCtx.createWaveShaper();
        this.driveNode.oversample = '4x';

        // 3-Band Tone Stack (Post-Drive)
        this.lowEQ = audioCtx.createBiquadFilter();
        this.lowEQ.type = 'lowshelf';
        this.lowEQ.frequency.value = 250;

        this.midEQ = audioCtx.createBiquadFilter();
        this.midEQ.type = 'peaking';
        this.midEQ.frequency.value = 800;
        this.midEQ.Q.value = 1.0;

        this.highEQ = audioCtx.createBiquadFilter();
        this.highEQ.type = 'highshelf';
        this.highEQ.frequency.value = 3000;

        this.volumeNode = audioCtx.createGain();

        // Parametrit
        this.drive = 40; 
        this.low = 0;
        this.mid = 0;
        this.high = 0;
        this.volume = 1.0;

        // UI-referenssit
        this.knobs = {};

        // Reititys: Input -> Pre-Filter -> Drive -> Low -> Mid -> High -> Volume -> Output
        this.input.connect(this.preFilter);
        this.preFilter.connect(this.driveNode);
        this.driveNode.connect(this.lowEQ);
        this.lowEQ.connect(this.midEQ);
        this.midEQ.connect(this.highEQ);
        this.highEQ.connect(this.volumeNode);
        this.volumeNode.connect(this.output);

        this.updateDrive();
    }

    makeDistortionCurve(amount) {
        const k = typeof amount === 'number' ? amount : 50;
        const n_samples = 44100;
        const curve = new Float32Array(n_samples);
        const deg = Math.PI / 180;
        for (let i = 0; i < n_samples; ++i) {
            const x = (i * 2) / n_samples - 1;
            // Putkimainen epäsymmetrinen särö
            if (x < 0) {
                curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x)) * 0.8;
            } else {
                curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
            }
        }
        return curve;
    }

    updateDrive() {
        this.driveNode.curve = this.makeDistortionCurve(this.drive);
    }

    getNodes() {
        return { input: this.input, output: this.output };
    }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            drive: this.drive,
            low: this.low,
            mid: this.mid,
            high: this.high,
            volume: this.volume
        };
    }

    setState(state) {
        if (!state) return;

        if (state.drive !== undefined) { 
            this.drive = state.drive; 
            this.updateDrive(); 
            if (this.knobs['drive']) this.knobs['drive'].setValue(this.drive); 
        }
        if (state.low !== undefined) { 
            this.low = state.low; 
            this.lowEQ.gain.setTargetAtTime(this.low, this.ctx.currentTime, 0.05); 
            if (this.knobs['low']) this.knobs['low'].setValue(this.low); 
        }
        if (state.mid !== undefined) { 
            this.mid = state.mid; 
            this.midEQ.gain.setTargetAtTime(this.mid, this.ctx.currentTime, 0.05); 
            if (this.knobs['mid']) this.knobs['mid'].setValue(this.mid); 
        }
        if (state.high !== undefined) { 
            this.high = state.high; 
            this.highEQ.gain.setTargetAtTime(this.high, this.ctx.currentTime, 0.05); 
            if (this.knobs['high']) this.knobs['high'].setValue(this.high); 
        }
        if (state.volume !== undefined) { 
            this.volume = state.volume; 
            this.volumeNode.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05); 
            if (this.knobs['volume']) this.knobs['volume'].setValue(this.volume); 
        }
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#ff5500'; // Orange
        containerElement.style.setProperty('--fx-color', color);

        containerElement.innerHTML = `
            <div style="margin-bottom: 5px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">GUITAR AMP</div>
            <div style="display: flex; flex-wrap: wrap; justify-content: center; align-items: center; padding: 15px 0; gap: 20px;" id="guitaramp-dashboard"></div>
        `;
        const dashboard = containerElement.querySelector('#guitaramp-dashboard');

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

        this.knobs['drive'] = createKnob('Drive', 0, 100, this.drive, v => Math.round(v), v => { this.drive = v; this.updateDrive(); });
        this.knobs['low'] = createKnob('Low', -15, 15, this.low, v => (v > 0 ? '+' : '') + Math.round(v) + 'dB', v => { this.low = v; this.lowEQ.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
        this.knobs['mid'] = createKnob('Mid', -15, 15, this.mid, v => (v > 0 ? '+' : '') + Math.round(v) + 'dB', v => { this.mid = v; this.midEQ.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
        this.knobs['high'] = createKnob('High', -15, 15, this.high, v => (v > 0 ? '+' : '') + Math.round(v) + 'dB', v => { this.high = v; this.highEQ.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
        this.knobs['volume'] = createKnob('Volume', 0, 2, this.volume, v => Math.round(v * 100) + '%', v => { this.volume = v; this.volumeNode.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
    }
}