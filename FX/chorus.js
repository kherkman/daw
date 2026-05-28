// chorus.js
window.CustomAudioEffect = class ChorusEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.dry = audioCtx.createGain();
        this.wet = audioCtx.createGain();
        this.delay = audioCtx.createDelay(1.0);
        this.lfo = audioCtx.createOscillator();
        this.lfoDepth = audioCtx.createGain();

        // Parametrien oletusarvot (tallennetaan propertyinä statea varten)
        this.rate = 1.2;
        this.depth = 0.01;
        this.delayTime = 0.03;
        this.mix = 0.7;

        // UI-referenssit
        this.knobs = {};

        // Asetetaan alkuarvot noodieille
        this.dry.gain.value = 1.0;
        this.wet.gain.value = this.mix;
        this.delay.delayTime.value = this.delayTime; 
        this.lfo.type = 'sine';
        this.lfo.frequency.value = this.rate;
        this.lfoDepth.gain.value = this.depth;
        this.lfo.start();

        // Reititys
        this.input.connect(this.dry);
        this.dry.connect(this.output);
        this.lfo.connect(this.lfoDepth);
        this.lfoDepth.connect(this.delay.delayTime);
        this.input.connect(this.delay);
        this.delay.connect(this.wet);
        this.wet.connect(this.output);
    }
    
    getNodes() { return { input: this.input, output: this.output }; }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            rate: this.rate,
            depth: this.depth,
            delayTime: this.delayTime,
            mix: this.mix
        };
    }

    setState(state) {
        if (!state) return;

        if (state.rate !== undefined) {
            this.rate = state.rate;
            this.lfo.frequency.setTargetAtTime(this.rate, this.ctx.currentTime, 0.05);
            if (this.knobs['rate']) this.knobs['rate'].setValue(this.rate);
        }
        if (state.depth !== undefined) {
            this.depth = state.depth;
            this.lfoDepth.gain.setTargetAtTime(this.depth, this.ctx.currentTime, 0.05);
            if (this.knobs['depth']) this.knobs['depth'].setValue(this.depth);
        }
        if (state.delayTime !== undefined) {
            this.delayTime = state.delayTime;
            this.delay.delayTime.setTargetAtTime(this.delayTime, this.ctx.currentTime, 0.05);
            if (this.knobs['delay']) this.knobs['delay'].setValue(this.delayTime);
        }
        if (state.mix !== undefined) {
            this.mix = state.mix;
            this.wet.gain.setTargetAtTime(this.mix, this.ctx.currentTime, 0.05);
            if (this.knobs['mix']) this.knobs['mix'].setValue(this.mix);
        }
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const styleId = 'fx-mod-styles';
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

        containerElement.style.setProperty('--fx-color', '#00ff88');
        containerElement.innerHTML = `<div style="margin-bottom: 5px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">ANALOG CHORUS</div><div class="fx-dashboard" id="chorus-dashboard"></div>`;
        const dashboard = containerElement.querySelector('#chorus-dashboard');

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

            return {
                setValue: (v) => {
                    currentValue = v;
                    updateUI(v);
                }
            };
        };

        this.knobs['rate'] = createKnob('Rate', 0.1, 5.0, this.rate, (v) => v.toFixed(1) + ' Hz', (v) => {
            this.rate = v;
            this.lfo.frequency.setTargetAtTime(v, this.ctx.currentTime, 0.05);
        });
        
        this.knobs['depth'] = createKnob('Depth', 0.0, 0.02, this.depth, (v) => Math.round(v * 1000) + ' ms', (v) => {
            this.depth = v;
            this.lfoDepth.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
        });
        
        this.knobs['delay'] = createKnob('Delay', 0.01, 0.05, this.delayTime, (v) => Math.round(v * 1000) + ' ms', (v) => {
            this.delayTime = v;
            this.delay.delayTime.setTargetAtTime(v, this.ctx.currentTime, 0.05);
        });
        
        this.knobs['mix'] = createKnob('Mix', 0.0, 1.0, this.mix, (v) => Math.round(v * 100) + ' %', (v) => {
            this.mix = v;
            this.wet.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
        });
    }
}