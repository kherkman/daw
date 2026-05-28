// randomizer.js
window.CustomAudioEffect = class RandomizerEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();

        // Reititys: Dry / Wet
        this.dryGain = audioCtx.createGain();
        this.wetGain = audioCtx.createGain();

        // FX Nodet
        this.filter = audioCtx.createBiquadFilter();
        this.filter.type = 'bandpass';
        
        this.panner = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : audioCtx.createPanner();
        if(this.panner.pan) this.panner.pan.value = 0;

        this.delay = audioCtx.createDelay(1.0);
        this.delay.delayTime.value = 0.01;

        // Kytkennät
        this.input.connect(this.dryGain);
        this.dryGain.connect(this.output);

        this.input.connect(this.filter);
        this.filter.connect(this.panner);
        this.panner.connect(this.delay);
        this.delay.connect(this.wetGain);
        this.wetGain.connect(this.output);

        // Parametrit
        this.rate = 4.0;      // Hz (kuinka usein arvotaan)
        this.amount = 0.5;    // 0.0 - 1.0 (kuinka rajuja muutokset ovat)
        this.mix = 0.5;       // Dry/Wet
        this.glitchMode = false; // Smooth vs äkilliset hypyt

        this.knobs = {};
        this.uiElements = {};
        this.timerId = null;

        this.updateMix();
        this.startRandomizer();
    }

    startRandomizer() {
        if (this.timerId) clearInterval(this.timerId);
        const intervalMs = 1000 / this.rate;
        
        this.timerId = setInterval(() => {
            this.randomizeParameters();
        }, intervalMs);
    }

    randomizeParameters() {
        const now = this.ctx.currentTime;
        const amt = this.amount;
        
        // Arvotaan arvot
        const minFreq = 100;
        const maxFreq = 10000;
        // Taajuus pyörii amountin sallimissa rajoissa
        const targetFreq = minFreq + (Math.random() * (maxFreq - minFreq) * amt);
        
        // Panorointi (-1 ... 1)
        const targetPan = (Math.random() * 2 - 1) * amt;
        
        // Delay time (5ms ... 300ms)
        const targetDelay = 0.005 + (Math.random() * 0.3 * amt);

        if (this.glitchMode) {
            // Äkilliset hypyt (Glitch / Stutter)
            this.filter.frequency.setValueAtTime(targetFreq, now);
            if(this.panner.pan) this.panner.pan.setValueAtTime(targetPan, now);
            this.delay.delayTime.setValueAtTime(targetDelay, now);
        } else {
            // Pehmeät liukumiset (Liquid / Space)
            const timeConst = 1.0 / this.rate; 
            this.filter.frequency.setTargetAtTime(targetFreq, now, timeConst * 0.5);
            if(this.panner.pan) this.panner.pan.setTargetAtTime(targetPan, now, timeConst * 0.5);
            this.delay.delayTime.setTargetAtTime(targetDelay, now, timeConst * 0.5);
        }
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
            amount: this.amount,
            mix: this.mix,
            glitchMode: this.glitchMode
        };
    }

    setState(state) {
        if (!state) return;
        if (state.glitchMode !== undefined) {
            this.glitchMode = state.glitchMode;
            if (this.uiElements.btnGlitch) {
                if (this.glitchMode) this.uiElements.btnGlitch.classList.add('active');
                else this.uiElements.btnGlitch.classList.remove('active');
            }
        }
        if (state.rate !== undefined) {
            this.rate = state.rate;
            this.startRandomizer();
            if (this.knobs['rate']) this.knobs['rate'].setValue(this.rate);
        }
        if (state.amount !== undefined) {
            this.amount = state.amount;
            if (this.knobs['amount']) this.knobs['amount'].setValue(this.amount);
        }
        if (state.mix !== undefined) {
            this.mix = state.mix;
            this.updateMix();
            if (this.knobs['mix']) this.knobs['mix'].setValue(this.mix);
        }
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#00ff66'; // Neon Green
        containerElement.style.setProperty('--fx-color', color);

        const styleId = 'fx-rnd-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .btn-rnd { 
                    background: #111; border: 1px solid #555; color: #888; cursor: pointer; 
                    padding: 4px 8px; border-radius: 4px; font-family: monospace; font-size: 10px; 
                    text-transform: uppercase; transition: all 0.2s; margin-bottom: 10px; 
                }
                .btn-rnd.active { 
                    background: rgba(0,255,102,0.2); border-color: var(--fx-color); 
                    color: #fff; box-shadow: 0 0 10px rgba(0,255,102,0.5); 
                }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div style="margin-bottom: 5px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">CHAOS RANDOMIZER</div>
            <div style="text-align: center;">
                <button id="rnd-glitch-btn" class="btn-rnd ${this.glitchMode ? 'active' : ''}">Glitch Mode</button>
            </div>
            <div style="display: flex; flex-wrap: wrap; justify-content: center; align-items: center; padding: 10px 0; gap: 20px;" id="rnd-dashboard"></div>
        `;

        const glitchBtn = containerElement.querySelector('#rnd-glitch-btn');
        this.uiElements.btnGlitch = glitchBtn;
        glitchBtn.addEventListener('click', () => {
            this.glitchMode = !this.glitchMode;
            if (this.glitchMode) glitchBtn.classList.add('active');
            else glitchBtn.classList.remove('active');
        });

        const dashboard = containerElement.querySelector('#rnd-dashboard');

        const createKnob = (label, min, max, defaultValue, formatValue, onChange) => {
            const container = document.createElement('div');
            container.style = "display: flex; flex-direction: column; align-items: center; user-select: none; width: 60px;";
            const radius = 22, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            container.innerHTML = `
                <div style="font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #8b8b9f; margin-bottom: 5px; text-align: center;">${label}</div>
                <div class="knob-wrapper" style="position: relative; width: 50px; height: 50px; cursor: ns-resize; margin-bottom: 8px; touch-action: none;">
                    <svg viewBox="0 0 54 54" style="width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 5px rgba(0,255,102,0.3));">
                        <circle cx="27" cy="27" r="${radius}" fill="none" stroke="#2a2a3b" stroke-width="6" stroke-linecap="round" stroke-dasharray="${maxDash} ${circumference}" />
                        <circle class="knob-value-path" cx="27" cy="27" r="${radius}" fill="none" stroke="var(--fx-color)" stroke-width="6" stroke-linecap="round" stroke-dasharray="0 ${circumference}" style="transition: stroke 0.2s;" />
                        <circle cx="27" cy="27" r="14" fill="#1a1a24" stroke="#333" stroke-width="2" />
                    </svg>
                    <div class="knob-indicator" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none;">
                        <div style="position: absolute; width: 5px; height: 5px; background: #fff; border-radius: 50%; top: 5px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 8px #fff;"></div>
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
                    currentValue = newVal; updateUI(currentValue); onChange(currentValue); 
                }
            };
            const endDrag = () => { if (isDragging) { isDragging = false; document.body.style.cursor = 'default'; } };

            wrapper.addEventListener('mousedown', (e) => startDrag(e.clientY)); window.addEventListener('mousemove', (e) => doDrag(e.clientY)); window.addEventListener('mouseup', endDrag);
            wrapper.addEventListener('touchstart', (e) => startDrag(e.touches[0].clientY), { passive: false }); window.addEventListener('touchmove', (e) => { if (isDragging) { e.preventDefault(); doDrag(e.touches[0].clientY); } }, { passive: false }); window.addEventListener('touchend', endDrag);

            return { setValue: (v) => { currentValue = v; updateUI(v); } };
        };

        this.knobs['rate'] = createKnob('Rate', 0.5, 20.0, this.rate, v => v.toFixed(1) + 'Hz', v => { this.rate = v; this.startRandomizer(); });
        this.knobs['amount'] = createKnob('Amount', 0.0, 1.0, this.amount, v => Math.round(v * 100) + '%', v => { this.amount = v; });
        this.knobs['mix'] = createKnob('Mix', 0.0, 1.0, this.mix, v => Math.round(v * 100) + '%', v => { this.mix = v; this.updateMix(); });
    }
}