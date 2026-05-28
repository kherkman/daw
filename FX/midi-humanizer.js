// midi-humanizer.js
window.CustomAudioEffect = class MidiHumanizerEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        
        // Audio kulkee vain suoraan läpi tässä efektissä
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.input.connect(this.output);

        // Host ohjelma voi rekisteröidä tähän funktion, esim:
        // humanizer.onMidiOut = (msg) => synth.onMidi(msg);
        this.onMidiOut = null;

        // Parametrit
        this.mode = 'humanize'; // 'humanize' tai 'quantize'
        
        // Humanize asetukset
        this.timingJitter = 30; // ms
        this.velVariance = 15;  // +/- velocity
        
        // Quantize asetukset
        this.bpm = 120;
        this.division = 4; // 4 = 16-osanuotti, 2 = 8-osanuotti jne.

        this.knobs = {};
        this.uiElements = {};
    }

    // Host kutsuu tätä kun uusi MIDI-viesti tulee sisään
    onMidi(msg) {
        const status = msg[0] & 0xF0;
        const note = msg[1];
        let velocity = msg[2];

        // Jos ei ole Note ON tai Note OFF, lähetä suoraan eteenpäin
        if (status !== 0x90 && status !== 0x80) {
            this.sendMidi(msg);
            return;
        }

        if (this.mode === 'humanize') {
            // Lisää satunnaisuutta voimakkuuteen (Vain Note ON viesteissä joissa vel > 0)
            if (status === 0x90 && velocity > 0) {
                const varAmount = (Math.random() * 2 - 1) * this.velVariance;
                velocity = Math.min(127, Math.max(1, Math.round(velocity + varAmount)));
            }

            // Lisää satunnaisuutta ajoitukseen
            const delayMs = Math.random() * this.timingJitter;
            setTimeout(() => {
                this.sendMidi([status, note, velocity]);
            }, delayMs);

        } else if (this.mode === 'quantize') {
            // Kvantisointi (Real-time viivästys seuraavaan haluttuun grid-pisteeseen)
            const beatLengthSeconds = 60.0 / this.bpm;
            const gridLengthSeconds = beatLengthSeconds / this.division; // Esim. 16-osat
            
            const currentTime = this.ctx.currentTime;
            
            // Lasketaan mihin kohtaan audiotimeä seuraava grid osuu
            const nextGridTime = Math.ceil(currentTime / gridLengthSeconds) * gridLengthSeconds;
            
            // Odotusaika millisekunteina
            let waitMs = (nextGridTime - currentTime) * 1000;
            
            // Pienikin viive ohittaa selaimen synkroni-loopin, jolloin prosessi tuntuu oikealta
            setTimeout(() => {
                this.sendMidi([status, note, velocity]);
            }, waitMs);
        }
    }

    sendMidi(msg) {
        if (typeof this.onMidiOut === 'function') {
            this.onMidiOut(msg);
        }
    }

    getNodes() {
        return { input: this.input, output: this.output };
    }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            mode: this.mode,
            timingJitter: this.timingJitter,
            velVariance: this.velVariance,
            bpm: this.bpm
        };
    }

    setState(state) {
        if (!state) return;
        if (state.mode !== undefined) {
            this.mode = state.mode;
            this.updateModeUI();
        }
        if (state.timingJitter !== undefined) {
            this.timingJitter = state.timingJitter;
            if (this.knobs['jitter']) this.knobs['jitter'].setValue(this.timingJitter);
        }
        if (state.velVariance !== undefined) {
            this.velVariance = state.velVariance;
            if (this.knobs['vel']) this.knobs['vel'].setValue(this.velVariance);
        }
        if (state.bpm !== undefined) {
            this.bpm = state.bpm;
            if (this.knobs['bpm']) this.knobs['bpm'].setValue(this.bpm);
        }
    }

    updateModeUI() {
        if (!this.uiElements.btnHum || !this.uiElements.btnQuant) return;
        
        this.uiElements.btnHum.classList.remove('active');
        this.uiElements.btnQuant.classList.remove('active');

        if (this.mode === 'humanize') {
            this.uiElements.btnHum.classList.add('active');
            this.uiElements.humanizeKnobs.style.display = 'flex';
            this.uiElements.quantizeKnobs.style.display = 'none';
        } else {
            this.uiElements.btnQuant.classList.add('active');
            this.uiElements.humanizeKnobs.style.display = 'none';
            this.uiElements.quantizeKnobs.style.display = 'flex';
        }
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#ffcc00'; // Neon Yellow/Gold
        containerElement.style.setProperty('--fx-color', color);

        const styleId = 'fx-midi-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .btn-midi { 
                    background: #111; border: 1px solid #555; color: #888; cursor: pointer; 
                    padding: 6px 12px; border-radius: 4px; font-family: monospace; font-size: 11px; 
                    text-transform: uppercase; transition: all 0.2s; 
                }
                .btn-midi.active { 
                    background: rgba(255,204,0,0.2); border-color: var(--fx-color); 
                    color: #fff; box-shadow: 0 0 10px rgba(255,204,0,0.5); 
                }
                .midi-knob-group {
                    display: flex; flex-wrap: wrap; justify-content: center; align-items: center; padding: 15px 0; gap: 20px;
                }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div style="margin-bottom: 10px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">MIDI PROCESSOR</div>
            
            <div style="display: flex; justify-content: center; gap: 10px; margin-bottom: 10px;">
                <button id="btn-humanize" class="btn-midi">HUMANIZE</button>
                <button id="btn-quantize" class="btn-midi">QUANTIZE</button>
            </div>

            <div id="humanize-knobs" class="midi-knob-group"></div>
            <div id="quantize-knobs" class="midi-knob-group" style="display: none;"></div>
        `;

        this.uiElements.btnHum = containerElement.querySelector('#btn-humanize');
        this.uiElements.btnQuant = containerElement.querySelector('#btn-quantize');
        this.uiElements.humanizeKnobs = containerElement.querySelector('#humanize-knobs');
        this.uiElements.quantizeKnobs = containerElement.querySelector('#quantize-knobs');

        this.uiElements.btnHum.addEventListener('click', () => { this.mode = 'humanize'; this.updateModeUI(); });
        this.uiElements.btnQuant.addEventListener('click', () => { this.mode = 'quantize'; this.updateModeUI(); });
        
        this.updateModeUI();

        const createKnob = (targetDiv, label, min, max, defaultValue, formatValue, onChange) => {
            const container = document.createElement('div');
            container.style = "display: flex; flex-direction: column; align-items: center; user-select: none; width: 60px;";
            const radius = 22, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            container.innerHTML = `
                <div style="font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #8b8b9f; margin-bottom: 5px; text-align: center;">${label}</div>
                <div class="knob-wrapper" style="position: relative; width: 50px; height: 50px; cursor: ns-resize; margin-bottom: 8px; touch-action: none;">
                    <svg viewBox="0 0 54 54" style="width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 5px rgba(255,204,0,0.3));">
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
            targetDiv.appendChild(container);

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

        // Luodaan säätimet
        this.knobs['jitter'] = createKnob(this.uiElements.humanizeKnobs, 'Timing', 0, 100, this.timingJitter, v => Math.round(v) + 'ms', v => this.timingJitter = v);
        this.knobs['vel'] = createKnob(this.uiElements.humanizeKnobs, 'Vel Var', 0, 64, this.velVariance, v => '+/- ' + Math.round(v), v => this.velVariance = v);
        
        this.knobs['bpm'] = createKnob(this.uiElements.quantizeKnobs, 'Grid BPM', 60, 240, this.bpm, v => Math.round(v), v => this.bpm = v);
    }
}