// rotary.js
// Rotary Speaker (Leslie) efekti – Doppler, Tremolo ja Stereo Panning
window.CustomAudioEffect = class RotaryEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        
        // Crossover filter: Jaetaan signaali ylä- ja alaääniin (Drum ja Horn)
        this.splitFreq = 800;
        this.lowPass = audioCtx.createBiquadFilter();
        this.lowPass.type = 'lowpass';
        this.lowPass.frequency.value = this.splitFreq;

        this.highPass = audioCtx.createBiquadFilter();
        this.highPass.type = 'highpass';
        this.highPass.frequency.value = this.splitFreq;

        // --- HORN (Highs) ---
        this.hornDelay = audioCtx.createDelay(0.1);
        this.hornDelay.delayTime.value = 0.01;
        this.hornGain = audioCtx.createGain();
        this.hornPan = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : audioCtx.createPanner();
        if(this.hornPan.pan) this.hornPan.pan.value = 0;

        // --- DRUM (Lows) ---
        this.drumDelay = audioCtx.createDelay(0.1);
        this.drumDelay.delayTime.value = 0.01;
        this.drumGain = audioCtx.createGain();
        this.drumPan = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : audioCtx.createPanner();
        if(this.drumPan.pan) this.drumPan.pan.value = 0;

        // LFOt pyörimiselle (Drum pyörii hitaammin ja raskaammin kuin Horn)
        this.lfoSpeed = 4.0; // Base speed Hz
        this.width = 1.0;

        // Horn LFO
        this.lfoHorn = audioCtx.createOscillator();
        this.lfoHorn.type = 'sine';
        this.lfoHorn.frequency.value = this.lfoSpeed;
        
        // Tremolo (AM)
        this.hornTremoloDepth = audioCtx.createGain();
        this.hornTremoloDepth.gain.value = 0.4;
        this.lfoHorn.connect(this.hornTremoloDepth);
        this.hornTremoloDepth.connect(this.hornGain.gain);

        // Vibrato/Doppler (FM)
        this.hornVibratoDepth = audioCtx.createGain();
        this.hornVibratoDepth.gain.value = 0.002;
        this.lfoHorn.connect(this.hornVibratoDepth);
        this.hornVibratoDepth.connect(this.hornDelay.delayTime);

        // Panning (Stereo Width)
        this.hornPanDepth = audioCtx.createGain();
        this.hornPanDepth.gain.value = this.width;
        this.lfoHorn.connect(this.hornPanDepth);
        if(this.hornPan.pan) this.hornPanDepth.connect(this.hornPan.pan);

        // Drum LFO (Hitaampi)
        this.lfoDrum = audioCtx.createOscillator();
        this.lfoDrum.type = 'sine';
        this.lfoDrum.frequency.value = this.lfoSpeed * 0.8; 

        // Drum moduloinnit (pienemmät kuin Hornilla)
        this.drumTremoloDepth = audioCtx.createGain();
        this.drumTremoloDepth.gain.value = 0.2;
        this.lfoDrum.connect(this.drumTremoloDepth);
        this.drumTremoloDepth.connect(this.drumGain.gain);

        this.drumVibratoDepth = audioCtx.createGain();
        this.drumVibratoDepth.gain.value = 0.001;
        this.lfoDrum.connect(this.drumVibratoDepth);
        this.drumVibratoDepth.connect(this.drumDelay.delayTime);

        this.drumPanDepth = audioCtx.createGain();
        this.drumPanDepth.gain.value = this.width * 0.6; // Rummun tila kapeampi
        this.lfoDrum.connect(this.drumPanDepth);
        if(this.drumPan.pan) this.drumPanDepth.connect(this.drumPan.pan);

        // Reititys
        this.input.connect(this.lowPass);
        this.input.connect(this.highPass);

        this.highPass.connect(this.hornDelay);
        this.hornDelay.connect(this.hornGain);
        this.hornGain.connect(this.hornPan);
        this.hornPan.connect(this.output);

        this.lowPass.connect(this.drumDelay);
        this.drumDelay.connect(this.drumGain);
        this.drumGain.connect(this.drumPan);
        this.drumPan.connect(this.output);

        this.lfoHorn.start();
        this.lfoDrum.start();
    }

    setSpeed(val) {
        this.lfoSpeed = val;
        this.lfoHorn.frequency.setTargetAtTime(val, this.ctx.currentTime, 0.5); // Viive matkii moottorin kiihtymistä
        this.lfoDrum.frequency.setTargetAtTime(val * 0.8, this.ctx.currentTime, 1.0); // Rumpu kiihtyy hitaammin
    }

    setWidth(val) {
        this.width = val;
        this.hornPanDepth.gain.setTargetAtTime(val, this.ctx.currentTime, 0.1);
        this.drumPanDepth.gain.setTargetAtTime(val * 0.6, this.ctx.currentTime, 0.1);
    }

    getNodes() { return { input: this.input, output: this.output }; }

    renderUI(containerElement) {
        const color = '#ff8800';
        containerElement.style.setProperty('--fx-color', color);

        containerElement.innerHTML = `
            <div style="margin-bottom: 15px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">ROTARY SPEAKER</div>
            <div style="display: flex; justify-content: center; gap: 30px;" id="rotary-knobs"></div>
        `;

        const dashboard = containerElement.querySelector('#rotary-knobs');

        const createKnob = (container, label, min, max, defaultValue, formatValue, onChange) => {
            const div = document.createElement('div');
            div.style = "display: flex; flex-direction: column; align-items: center; user-select: none; width: 70px;";
            const radius = 25, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            div.innerHTML = `
                <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #8b8b9f; margin-bottom: 5px;">${label}</div>
                <div class="knob-wrapper" style="position: relative; width: 60px; height: 60px; cursor: ns-resize; margin-bottom: 8px; touch-action: none;">
                    <svg viewBox="0 0 60 60" style="width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 5px rgba(255, 136, 0, 0.3));">
                        <circle cx="30" cy="30" r="${radius}" fill="none" stroke="#2a2a3b" stroke-width="8" stroke-linecap="round" stroke-dasharray="${maxDash} ${circumference}" />
                        <circle class="knob-value-path" cx="30" cy="30" r="${radius}" fill="none" stroke="var(--fx-color)" stroke-width="8" stroke-linecap="round" stroke-dasharray="0 ${circumference}" style="transition: stroke 0.2s;" />
                        <circle cx="30" cy="30" r="16" fill="#1a1a24" stroke="#333" stroke-width="2" />
                    </svg>
                    <div class="knob-indicator" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none;"><div style="position: absolute; width: 6px; height: 6px; background: var(--fx-color); border-radius: 50%; top: 6px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 8px var(--fx-color);"></div></div>
                </div>
                <div class="knob-value-display" style="font-size: 11px; font-family: monospace; color: #fff; background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); text-align: center; min-width: 40px;">${formatValue(defaultValue)}</div>
            `;
            const wrapper = div.querySelector('.knob-wrapper'), valuePath = div.querySelector('.knob-value-path'), indicator = div.querySelector('.knob-indicator'), display = div.querySelector('.knob-value-display');
            let currentValue = defaultValue;
            const updateUI = (value) => {
                const normalized = (value - min) / (max - min);
                valuePath.setAttribute('stroke-dasharray', `${normalized * maxDash} ${circumference}`);
                indicator.style.transform = `rotate(${-135 + (normalized * 270)}deg)`;
                display.innerText = formatValue(value);
            };
            updateUI(currentValue); container.appendChild(div);

            let isDragging = false, startY = 0, startValue = 0;
            const startDrag = (y) => { isDragging = true; startY = y; startValue = currentValue; document.body.style.cursor = 'ns-resize'; };
            const doDrag = (y) => {
                if (!isDragging) return;
                let newVal = startValue + (((startY - y) / 100) * (max - min));
                newVal = Math.max(min, Math.min(max, newVal));
                if (newVal !== currentValue) { currentValue = newVal; updateUI(currentValue); onChange(currentValue); }
            };
            const endDrag = () => { if (isDragging) { isDragging = false; document.body.style.cursor = 'default'; } };

            wrapper.addEventListener('mousedown', (e) => startDrag(e.clientY)); window.addEventListener('mousemove', (e) => doDrag(e.clientY)); window.addEventListener('mouseup', endDrag);
            wrapper.addEventListener('touchstart', (e) => startDrag(e.touches[0].clientY), { passive: false }); window.addEventListener('touchmove', (e) => { if (isDragging) { e.preventDefault(); doDrag(e.touches[0].clientY); } }, { passive: false }); window.addEventListener('touchend', endDrag);
        };

        createKnob(dashboard, 'Speed', 0.5, 10.0, 4.0, v => v.toFixed(1) + ' Hz', v => this.setSpeed(v));
        createKnob(dashboard, 'Width', 0.0, 1.0, 1.0, v => Math.round(v * 100) + ' %', v => this.setWidth(v));
    }
}