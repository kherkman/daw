// flanger.js
window.CustomAudioEffect = class FlangerEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();

        // Nodes
        this.dryGain = audioCtx.createGain();
        this.wetGain = audioCtx.createGain();
        
        this.delayNode = audioCtx.createDelay(0.02); // max 20ms
        this.delayNode.delayTime.value = 0.005; // base delay 5ms
        
        this.feedbackGain = audioCtx.createGain();
        
        this.lfo = audioCtx.createOscillator();
        this.lfo.type = 'sine';
        this.lfoGain = audioCtx.createGain(); // Depth
        
        // Default parameters
        this.rate = 0.5; // Hz
        this.depth = 0.002; // 2ms modulaatio
        this.feedback = 0.5;
        this.mix = 0.5;

        // UI-referenssit
        this.knobs = {};

        // Routing
        this.input.connect(this.dryGain);
        this.dryGain.connect(this.output);

        this.input.connect(this.delayNode);
        
        this.lfo.connect(this.lfoGain);
        this.lfoGain.connect(this.delayNode.delayTime);
        
        // Feedback loop
        this.delayNode.connect(this.feedbackGain);
        this.feedbackGain.connect(this.delayNode);
        
        this.delayNode.connect(this.wetGain);
        this.wetGain.connect(this.output);

        // Init values
        this.lfo.frequency.value = this.rate;
        this.lfoGain.gain.value = this.depth;
        this.feedbackGain.gain.value = this.feedback;
        this.updateMix();
        
        this.lfo.start();
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
            rate: this.rate,
            depth: this.depth,
            feedback: this.feedback,
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
            this.lfoGain.gain.setTargetAtTime(this.depth, this.ctx.currentTime, 0.05);
            if (this.knobs['depth']) this.knobs['depth'].setValue(this.depth);
        }
        if (state.feedback !== undefined) {
            this.feedback = state.feedback;
            this.feedbackGain.gain.setTargetAtTime(this.feedback, this.ctx.currentTime, 0.05);
            if (this.knobs['feedback']) this.knobs['feedback'].setValue(this.feedback);
        }
        if (state.mix !== undefined) {
            this.mix = state.mix;
            this.updateMix();
            if (this.knobs['mix']) this.knobs['mix'].setValue(this.mix);
        }
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#ff00aa'; // Pink
        containerElement.style.setProperty('--fx-color', color);

        containerElement.innerHTML = `
            <div style="margin-bottom: 5px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">ANALOG FLANGER</div>
            <div style="display: flex; flex-wrap: wrap; justify-content: center; align-items: center; padding: 15px 0; gap: 20px;" id="flanger-dashboard"></div>
        `;
        const dashboard = containerElement.querySelector('#flanger-dashboard');

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

        this.knobs['rate'] = createKnob('Rate', 0.1, 5.0, this.rate, v => v.toFixed(2) + ' Hz', v => { this.rate = v; this.lfo.frequency.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
        this.knobs['depth'] = createKnob('Depth', 0.0005, 0.005, this.depth, v => Math.round(v * 1000) + ' ms', v => { this.depth = v; this.lfoGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
        this.knobs['feedback'] = createKnob('F.Back', 0, 0.95, this.feedback, v => Math.round(v * 100) + '%', v => { this.feedback = v; this.feedbackGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
        this.knobs['mix'] = createKnob('Mix', 0, 1.0, this.mix, v => Math.round(v * 100) + '%', v => { this.mix = v; this.updateMix(); });
    }
}