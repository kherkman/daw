// vibrato.js
// Pitch Shifting Vibrato (Delay-based Doppler) käyrä-visualisoinnilla
window.CustomAudioEffect = class VibratoEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();

        // Delay-linja luo "Doppler"-ilmiön kun aikaa moduloidaan
        this.delay = audioCtx.createDelay(0.1);
        this.delay.delayTime.value = 0.02; // Keskiarvoviive 20ms

        // LFO
        this.lfo = audioCtx.createOscillator();
        this.lfo.type = 'sine';
        this.lfo.frequency.value = 5.0; // Nopeus
        
        this.lfoDepth = audioCtx.createGain();
        this.lfoDepth.gain.value = 0.002; // Moduloinnin syvyys
        
        // Vaiheenkääntö
        this.phaseInverter = audioCtx.createGain();
        this.phaseInverter.gain.value = 1.0; 
        
        this.invertPhase = false; // Tila

        // UI-referenssit
        this.knobs = {};
        this.uiElements = {};

        // Reititys
        this.input.connect(this.delay);
        this.delay.connect(this.output);

        this.lfo.connect(this.phaseInverter);
        this.phaseInverter.connect(this.lfoDepth);
        this.lfoDepth.connect(this.delay.delayTime);

        this.lfo.start();
    }

    getNodes() { return { input: this.input, output: this.output }; }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            rate: this.lfo.frequency.value,
            depth: this.lfoDepth.gain.value,
            invertPhase: this.invertPhase
        };
    }

    setState(state) {
        if (!state) return;

        if (state.invertPhase !== undefined) {
            this.invertPhase = state.invertPhase;
            this.phaseInverter.gain.value = this.invertPhase ? -1.0 : 1.0;
            if (this.uiElements.phaseBtn) {
                if (this.invertPhase) this.uiElements.phaseBtn.classList.add('active');
                else this.uiElements.phaseBtn.classList.remove('active');
            }
        }

        if (state.rate !== undefined) {
            this.lfo.frequency.setTargetAtTime(state.rate, this.ctx.currentTime, 0.05);
            if (this.knobs['Rate']) this.knobs['Rate'].setValue(state.rate);
        }

        if (state.depth !== undefined) {
            this.lfoDepth.gain.setTargetAtTime(state.depth, this.ctx.currentTime, 0.05);
            if (this.knobs['Depth']) this.knobs['Depth'].setValue(state.depth);
        }
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#ff00aa';
        containerElement.style.setProperty('--fx-color', color);

        const styleId = 'fx-vib-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .vib-dashboard { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; padding: 15px 0; gap: 20px; }
                .btn-vib { background: rgba(0,0,0,0.5); border: 1px solid var(--fx-color); color: var(--fx-color); cursor: pointer; padding: 6px 12px; border-radius: 4px; font-weight: bold; font-size: 11px; text-transform: uppercase; transition: all 0.2s; }
                .btn-vib.active { background: var(--fx-color); color: #000; box-shadow: 0 0 10px var(--fx-color); }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div style="margin-bottom: 15px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">DOPPLER VIBRATO</div>
            
            <div style="text-align: center; margin-bottom: 10px;">
                <button id="vib-phase-btn" class="btn-vib ${this.invertPhase ? 'active' : ''}">Invert Phase</button>
            </div>

            <div style="display: flex; flex-direction: column; gap: 5px; margin-bottom: 15px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="width: 50px; font-size: 10px; color: #8b8b9f; text-align: right;">SPEED</div>
                    <canvas id="vib-canvas-speed" style="flex: 1; height: 30px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,0,170,0.2); border-radius: 4px;"></canvas>
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="width: 50px; font-size: 10px; color: #8b8b9f; text-align: right;">DEPTH</div>
                    <canvas id="vib-canvas-depth" style="flex: 1; height: 30px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,0,170,0.2); border-radius: 4px;"></canvas>
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="width: 50px; font-size: 10px; color: #8b8b9f; text-align: right;">PITCH</div>
                    <canvas id="vib-canvas-pitch" style="flex: 1; height: 60px; background: rgba(0,0,0,0.5); border: 1px solid rgba(255,0,170,0.5); border-radius: 4px;"></canvas>
                </div>
            </div>

            <div class="vib-dashboard" id="vib-knobs"></div>
        `;

        const phaseBtn = containerElement.querySelector('#vib-phase-btn');
        this.uiElements.phaseBtn = phaseBtn;

        phaseBtn.addEventListener('click', () => {
            this.invertPhase = !this.invertPhase;
            this.phaseInverter.gain.value = this.invertPhase ? -1.0 : 1.0;
            if (this.invertPhase) phaseBtn.classList.add('active');
            else phaseBtn.classList.remove('active');
        });

        // Knobs
        const dashboard = containerElement.querySelector('#vib-knobs');
        const createKnob = (container, label, min, max, defaultValue, formatValue, onChange) => {
            const div = document.createElement('div');
            div.style = "display: flex; flex-direction: column; align-items: center; user-select: none; width: 70px;";
            const radius = 25, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            div.innerHTML = `
                <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #8b8b9f; margin-bottom: 5px;">${label}</div>
                <div class="knob-wrapper" style="position: relative; width: 60px; height: 60px; cursor: ns-resize; margin-bottom: 8px; touch-action: none;">
                    <svg viewBox="0 0 60 60" style="width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 5px rgba(255, 0, 170, 0.3));">
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
            const updateUI = (value, triggerCallback = false) => {
                const normalized = (value - min) / (max - min);
                valuePath.setAttribute('stroke-dasharray', `${normalized * maxDash} ${circumference}`);
                indicator.style.transform = `rotate(${-135 + (normalized * 270)}deg)`;
                display.innerText = formatValue(value);
                if (triggerCallback) onChange(value);
            };
            updateUI(currentValue); container.appendChild(div);

            let isDragging = false, startY = 0, startValue = 0;
            const startDrag = (y) => { isDragging = true; startY = y; startValue = currentValue; document.body.style.cursor = 'ns-resize'; };
            const doDrag = (y) => {
                if (!isDragging) return;
                let newVal = startValue + (((startY - y) / 100) * (max - min));
                newVal = Math.max(min, Math.min(max, newVal));
                if (newVal !== currentValue) { currentValue = newVal; updateUI(currentValue, true); }
            };
            const endDrag = () => { if (isDragging) { isDragging = false; document.body.style.cursor = 'default'; } };

            wrapper.addEventListener('mousedown', (e) => startDrag(e.clientY)); window.addEventListener('mousemove', (e) => doDrag(e.clientY)); window.addEventListener('mouseup', endDrag);
            wrapper.addEventListener('touchstart', (e) => startDrag(e.touches[0].clientY), { passive: false }); window.addEventListener('touchmove', (e) => { if (isDragging) { e.preventDefault(); doDrag(e.touches[0].clientY); } }, { passive: false }); window.addEventListener('touchend', endDrag);
            
            return { setValue: (v) => { currentValue = v; updateUI(v, false); } };
        };

        this.knobs['Rate'] = createKnob(dashboard, 'Speed', 0.1, 20.0, this.lfo.frequency.value, v => v.toFixed(1) + ' Hz', v => this.lfo.frequency.setTargetAtTime(v, this.ctx.currentTime, 0.05));
        this.knobs['Depth'] = createKnob(dashboard, 'Depth', 0.0, 0.01, this.lfoDepth.gain.value, v => Math.round(v * 1000) + ' ms', v => this.lfoDepth.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05));

        // Visualisointi Canvaksilla
        const cSpeed = containerElement.querySelector('#vib-canvas-speed');
        const cDepth = containerElement.querySelector('#vib-canvas-depth');
        const cPitch = containerElement.querySelector('#vib-canvas-pitch');
        const ctxS = cSpeed.getContext('2d');
        const ctxD = cDepth.getContext('2d');
        const ctxP = cPitch.getContext('2d');

        let mountCheckCount = 0;
        let timeOffset = 0;

        const drawCanvas = () => {
            mountCheckCount++;
            if (!document.body.contains(cSpeed)) {
                if (mountCheckCount > 10) return;
                return requestAnimationFrame(drawCanvas);
            }

            const w = cSpeed.clientWidth, hs = cSpeed.clientHeight, hp = cPitch.clientHeight;
            cSpeed.width = w; cSpeed.height = hs;
            cDepth.width = w; cDepth.height = hs;
            cPitch.width = w; cPitch.height = hp;

            ctxS.clearRect(0,0,w,hs); ctxD.clearRect(0,0,w,hs); ctxP.clearRect(0,0,w,hp);

            const freq = this.lfo.frequency.value;
            const depth = this.lfoDepth.gain.value;
            const normDepth = depth / 0.01; // Skaalaa visuaalisesti
            const currentPhase = this.invertPhase ? -1.0 : 1.0;

            timeOffset += 0.02;

            ctxS.beginPath(); ctxD.beginPath(); ctxP.beginPath();
            ctxS.strokeStyle = 'rgba(255,255,255,0.5)';
            ctxD.strokeStyle = 'rgba(255,255,255,0.5)';
            ctxP.strokeStyle = color;
            ctxP.lineWidth = 2;

            // Piirretään aallot matemaattisesti
            for (let x = 0; x < w; x++) {
                // Skaalattu aika
                const t = (x / w) * 2.0 - timeOffset;
                
                // LFO
                const lfoVal = Math.sin(t * Math.PI * 2 * freq) * currentPhase;
                
                // Speed = pelkkä taajuusnäyttö
                const yS = hs/2 - (Math.sin(t * Math.PI * 2 * freq) * hs/3);
                
                // Depth = syvyysnäyttö
                const yD = hs/2 - (lfoVal * normDepth * hs/3);
                
                // Pitch = viiveajan derivaatta (Doppler efekti)
                // d/dt sin(wt) = w * cos(wt)
                const pitchShift = Math.cos(t * Math.PI * 2 * freq) * freq * normDepth * currentPhase;
                const yP = hp/2 - (pitchShift * hp * 0.5);

                if (x === 0) {
                    ctxS.moveTo(x, yS); ctxD.moveTo(x, yD); ctxP.moveTo(x, yP);
                } else {
                    ctxS.lineTo(x, yS); ctxD.lineTo(x, yD); ctxP.lineTo(x, yP);
                }
            }

            ctxS.stroke(); ctxD.stroke(); ctxP.stroke();
            requestAnimationFrame(drawCanvas);
        };
        drawCanvas();
    }
}