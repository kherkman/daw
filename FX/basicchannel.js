// basicchannel.js
window.CustomAudioEffect = class BasicChannelEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        
        // Luodaan solmut (nodes)
        this.hpf = audioCtx.createBiquadFilter();
        this.hpf.type = 'highpass';
        
        this.lpf = audioCtx.createBiquadFilter();
        this.lpf.type = 'lowpass';
        
        this.panner = audioCtx.createStereoPanner();
        this.volume = audioCtx.createGain();

        // Asetetaan oletusarvot (HPF ja LPF pois tieltä, Pan keskelle, Vol 100%)
        this.hpf.frequency.value = 10;
        this.lpf.frequency.value = 20000;
        this.panner.pan.value = 0;
        this.volume.gain.value = 1.0;

        // Kytketään reititys: Input -> HPF -> LPF -> Pan -> Volume -> Output
        this.input.connect(this.hpf);
        this.hpf.connect(this.lpf);
        this.lpf.connect(this.panner);
        this.panner.connect(this.volume);
        this.volume.connect(this.output);

        // Varastoidaan käyttöliittymän nuppien viittaukset
        this.knobs = {};
    }
    
    getNodes() { 
        return { input: this.input, output: this.output }; 
    }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            hpf: this.hpf.frequency.value,
            lpf: this.lpf.frequency.value,
            pan: this.panner.pan.value,
            vol: this.volume.gain.value
        };
    }

    setState(state) {
        if (!state) return;

        if (state.hpf !== undefined) {
            this.hpf.frequency.value = state.hpf;
            if (this.knobs['hpf']) this.knobs['hpf'].setValue(state.hpf);
        }
        if (state.lpf !== undefined) {
            this.lpf.frequency.value = state.lpf;
            if (this.knobs['lpf']) this.knobs['lpf'].setValue(state.lpf);
        }
        if (state.pan !== undefined) {
            this.panner.pan.value = state.pan;
            if (this.knobs['pan']) this.knobs['pan'].setValue(state.pan);
        }
        if (state.vol !== undefined) {
            this.volume.gain.value = state.vol;
            if (this.knobs['vol']) this.knobs['vol'].setValue(state.vol);
        }
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const styleId = 'fx-mod-styles';
        // Luodaan tyylit vain kerran, jos niitä ei vielä ole
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .fx-dashboard { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; padding: 15px 0; gap: 25px; }
                .knob-container { display: flex; flex-direction: column; align-items: center; user-select: none; width: 80px; }
                .knob-wrapper { position: relative; width: 70px; height: 70px; cursor: ns-resize; margin-bottom: 8px; touch-action: none; }
                .knob-svg { width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 5px rgba(255,255,255,0.2)); }
                .knob-track { fill: none; stroke: #2a2a3b; stroke-width: 8; stroke-linecap: round; }
                .knob-value-path { fill: none; stroke: var(--fx-color); stroke-width: 8; stroke-linecap: round; transition: stroke 0.2s; }
                .knob-wrapper:active .knob-value-path, .knob-wrapper:hover .knob-value-path { stroke: #fff; filter: drop-shadow(0 0 8px var(--fx-color)); }
                .knob-center { fill: #1a1a24; stroke: #333; stroke-width: 2; }
                .knob-indicator { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
                .knob-dot { position: absolute; width: 6px; height: 6px; background: var(--fx-color); border-radius: 50%; top: 8px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 8px var(--fx-color); }
                .knob-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted); margin-bottom: 5px; text-align: center; }
                .knob-value-display { font-size: 12px; font-family: monospace; color: var(--text-main); background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); text-align: center; min-width: 45px; }
            `;
            document.head.appendChild(style);
        }

        // Asetetaan Basic-moduulille oma teemaväri (esim. syaani/sininen)
        containerElement.style.setProperty('--fx-color', '#00d2ff');
        containerElement.innerHTML = `<div style="margin-bottom: 5px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">BASIC CHANNEL</div><div class="fx-dashboard" id="basic-dashboard"></div>`;
        const dashboard = containerElement.querySelector('#basic-dashboard');

        const createKnob = (label, min, max, defaultValue, formatValue, onChange) => {
            const container = document.createElement('div');
            container.className = 'knob-container';
            const radius = 28, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            container.innerHTML = `
                <div class="knob-label">${label}</div>
                <div class="knob-wrapper">
                    <svg class="knob-svg" viewBox="0 0 70 70">
                        <circle class="knob-track" cx="35" cy="35" r="${radius}" stroke-dasharray="${maxDash} ${circumference}" />
                        <circle class="knob-value-path" cx="35" cy="35" r="${radius}" stroke-dasharray="0 ${circumference}" />
                        <circle class="knob-center" cx="35" cy="35" r="20" />
                    </svg>
                    <div class="knob-indicator"><div class="knob-dot"></div></div>
                </div>
                <div class="knob-value-display">${formatValue(defaultValue)}</div>
            `;
            const wrapper = container.querySelector('.knob-wrapper'), 
                  valuePath = container.querySelector('.knob-value-path'), 
                  indicator = container.querySelector('.knob-indicator'), 
                  display = container.querySelector('.knob-value-display');
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
                let newVal = startValue + (((startY - y) / 150) * (max - min));
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

            // Palautetaan API nuppien visuaaliseen päivittämiseen ohjelmallisesti
            return {
                setValue: (v) => {
                    currentValue = v;
                    updateUI(v);
                }
            };
        };

        // HPF (High-Pass Filter): 10Hz - 2000Hz
        this.knobs['hpf'] = createKnob('HPF', 10, 2000, this.hpf.frequency.value, 
            (v) => Math.round(v) + ' Hz', 
            (v) => this.hpf.frequency.setTargetAtTime(v, this.ctx.currentTime, 0.05)
        );

        // LPF (Low-Pass Filter): 500Hz - 20000Hz
        this.knobs['lpf'] = createKnob('LPF', 500, 20000, this.lpf.frequency.value, 
            (v) => (v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz'), 
            (v) => this.lpf.frequency.setTargetAtTime(v, this.ctx.currentTime, 0.05)
        );

        // Pan: -1 (Vasen) - +1 (Oikea)
        this.knobs['pan'] = createKnob('Pan', -1.0, 1.0, this.panner.pan.value, 
            (v) => {
                if (Math.abs(v) < 0.05) return 'C';
                return v < 0 ? 'L' + Math.round(-v * 100) : 'R' + Math.round(v * 100);
            }, 
            (v) => this.panner.pan.setTargetAtTime(v, this.ctx.currentTime, 0.05)
        );

        // Volume: 0% - 200% (mahdollistaa pienen vahvistuksen)
        this.knobs['vol'] = createKnob('Volume', 0.0, 2.0, this.volume.gain.value, 
            (v) => Math.round(v * 100) + ' %', 
            (v) => this.volume.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05)
        );
    }
}
