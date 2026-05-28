// phaser.js
window.CustomAudioEffect = class PhaserEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();

        // Nodes
        this.dryGain = audioCtx.createGain();
        this.wetGain = audioCtx.createGain();
        this.feedbackGain = audioCtx.createGain();

        // Parametrit
        this.rate = 0.5; // Hz
        this.depth = 1000; // Hz modulaatioalue
        this.centerFreq = 1500; // Hz
        this.feedback = 0.6;
        this.mix = 0.5;
        this.stageCount = 4; // 4, 8 tai 12

        this.stages = [];
        this.lfo = audioCtx.createOscillator();
        this.lfoGain = audioCtx.createGain();

        // UI-referenssit
        this.knobs = {};
        this.uiElements = {};

        this.lfo.type = 'sine';
        this.lfo.frequency.value = this.rate;
        this.lfoGain.gain.value = this.depth;

        this.updateMix();
        this.buildStages();

        this.lfo.start();
    }

    buildStages() {
        // Puhdista aiemmat kytkennät
        this.input.disconnect();
        this.stages.forEach(stage => stage.disconnect());
        this.lfoGain.disconnect();
        this.feedbackGain.disconnect();

        this.stages = [];

        // Reititys: Input -> Dry
        this.input.connect(this.dryGain);
        this.dryGain.connect(this.output);

        // Luo Allpass-suotimet
        for (let i = 0; i < this.stageCount; i++) {
            const filter = this.ctx.createBiquadFilter();
            filter.type = 'allpass';
            filter.frequency.value = this.centerFreq;
            this.stages.push(filter);
            
            // LFO kytketään jokaiseen suotimeen
            this.lfoGain.connect(filter.frequency);
        }

        // Kytke ketjuun
        this.input.connect(this.stages[0]);
        for (let i = 0; i < this.stages.length - 1; i++) {
            this.stages[i].connect(this.stages[i + 1]);
        }
        
        // Viimeinen menee Wet:iin ja Feedback:iin
        const lastStage = this.stages[this.stages.length - 1];
        lastStage.connect(this.wetGain);
        this.wetGain.connect(this.output);

        lastStage.connect(this.feedbackGain);
        this.feedbackGain.connect(this.stages[0]);

        this.feedbackGain.gain.value = this.feedback;
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
            centerFreq: this.centerFreq,
            feedback: this.feedback,
            mix: this.mix,
            stageCount: this.stageCount
        };
    }

    setState(state) {
        if (!state) return;

        if (state.stageCount !== undefined && state.stageCount !== this.stageCount) {
            this.stageCount = state.stageCount;
            this.buildStages();
            if (this.uiElements.stageSelect) this.uiElements.stageSelect.value = this.stageCount;
        }

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
        if (state.centerFreq !== undefined) {
            this.centerFreq = state.centerFreq;
            this.stages.forEach(stage => stage.frequency.setTargetAtTime(this.centerFreq, this.ctx.currentTime, 0.05));
            if (this.knobs['freq']) this.knobs['freq'].setValue(this.centerFreq);
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
        const color = '#0088ff'; // Blue
        containerElement.style.setProperty('--fx-color', color);

        containerElement.innerHTML = `
            <div style="margin-bottom: 10px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">CLASSIC PHASER</div>
            
            <div style="text-align: center; margin-bottom: 15px;">
                <label style="font-size: 10px; color: #8b8b9f; text-transform: uppercase; margin-right: 10px;">Stages</label>
                <select id="phaser-stage-select" style="background: #111; color: var(--fx-color); border: 1px solid var(--fx-color); padding: 5px 10px; border-radius: 4px; font-family: monospace; font-size: 12px; outline: none; cursor: pointer;">
                    <option value="4" ${this.stageCount === 4 ? 'selected' : ''}>4-Stage (Vintage)</option>
                    <option value="8" ${this.stageCount === 8 ? 'selected' : ''}>8-Stage (Deep)</option>
                    <option value="12" ${this.stageCount === 12 ? 'selected' : ''}>12-Stage (Liquid)</option>
                </select>
            </div>

            <div style="display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 15px;" id="phaser-dashboard"></div>
        `;
        
        this.uiElements.stageSelect = containerElement.querySelector('#phaser-stage-select');
        this.uiElements.stageSelect.addEventListener('change', (e) => {
            this.stageCount = parseInt(e.target.value);
            this.buildStages();
        });

        const dashboard = containerElement.querySelector('#phaser-dashboard');

        const createKnob = (label, min, max, defaultValue, formatValue, onChange) => {
            const container = document.createElement('div');
            container.style = "display: flex; flex-direction: column; align-items: center; user-select: none; width: 65px;";
            const radius = 22, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            container.innerHTML = `
                <div style="font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #8b8b9f; margin-bottom: 5px; text-align: center;">${label}</div>
                <div class="knob-wrapper" style="position: relative; width: 50px; height: 50px; cursor: ns-resize; margin-bottom: 8px; touch-action: none;">
                    <svg viewBox="0 0 54 54" style="width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 5px rgba(255,255,255,0.2));">
                        <circle cx="27" cy="27" r="${radius}" fill="none" stroke="#2a2a3b" stroke-width="6" stroke-linecap="round" stroke-dasharray="${maxDash} ${circumference}" />
                        <circle class="knob-value-path" cx="27" cy="27" r="${radius}" fill="none" stroke="var(--fx-color)" stroke-width="6" stroke-linecap="round" stroke-dasharray="0 ${circumference}" style="transition: stroke 0.2s;" />
                        <circle cx="27" cy="27" r="14" fill="#1a1a24" stroke="#333" stroke-width="2" />
                    </svg>
                    <div class="knob-indicator" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none;">
                        <div style="position: absolute; width: 5px; height: 5px; background: var(--fx-color); border-radius: 50%; top: 5px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 8px var(--fx-color);"></div>
                    </div>
                </div>
                <div class="knob-value-display" style="font-size: 10px; font-family: monospace; color: #fff; background: rgba(0,0,0,0.5); padding: 2px 4px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); text-align: center; min-width: 35px;">${formatValue(defaultValue)}</div>
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

        this.knobs['rate'] = createKnob('Rate', 0.1, 10.0, this.rate, v => v.toFixed(2) + ' Hz', v => { this.rate = v; this.lfo.frequency.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
        this.knobs['depth'] = createKnob('Depth', 100, 3000, this.depth, v => Math.round(v), v => { this.depth = v; this.lfoGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
        this.knobs['freq'] = createKnob('Center', 500, 5000, this.centerFreq, v => Math.round(v) + ' Hz', v => { this.centerFreq = v; this.stages.forEach(stage => stage.frequency.setTargetAtTime(v, this.ctx.currentTime, 0.05)); });
        this.knobs['feedback'] = createKnob('F.Back', 0, 0.9, this.feedback, v => Math.round(v * 100) + '%', v => { this.feedback = v; this.feedbackGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
        this.knobs['mix'] = createKnob('Mix', 0, 1.0, this.mix, v => Math.round(v * 100) + '%', v => { this.mix = v; this.updateMix(); });
    }
}