// sequencer.js
window.CustomAudioEffect = class StepSequencerEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();

        this.dryGain = audioCtx.createGain();
        this.wetGain = audioCtx.createGain();
        
        // Gate (Volume) ohjaus
        this.gateNode = audioCtx.createGain();

        // Parametrit
        this.steps = [1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0]; // 16 askelta
        this.rate = 1.0; // Jos ei tempo sync, Hz
        this.mix = 1.0;
        this.tempoSync = true;
        this.currentBpm = window.bpm || 120;
        
        // Ajastin ja tila
        this.currentStep = 0;
        this.isPlaying = true;
        this.nextStepTime = this.ctx.currentTime + 0.1;

        // UI-referenssit
        this.knobs = {};
        this.uiElements = {};

        // Reititys
        this.input.connect(this.dryGain);
        this.dryGain.connect(this.output);

        this.input.connect(this.gateNode);
        this.gateNode.connect(this.wetGain);
        this.wetGain.connect(this.output);

        this.updateMix();
        
        // Aloitetaan sekvensseri loop
        this.schedulerTimer = setInterval(() => this.scheduleSteps(), 25);

        // Tempo-monitorointi
        setInterval(() => {
            if (window.bpm && window.bpm !== this.currentBpm) {
                this.currentBpm = window.bpm;
            }
        }, 1000);
    }

    updateMix() {
        this.dryGain.gain.setTargetAtTime(Math.cos(this.mix * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
        this.wetGain.gain.setTargetAtTime(Math.sin(this.mix * 0.5 * Math.PI), this.ctx.currentTime, 0.05);
    }

    getStepDuration() {
        if (this.tempoSync) {
            // Rate on kerroin: esim. 0.25 = 1/16 nuotti, 0.5 = 1/8 nuotti
            const beatDuration = 60.0 / this.currentBpm;
            return beatDuration * this.rate; 
        }
        return 1.0 / this.rate;
    }

    scheduleSteps() {
        if (!this.isPlaying) return;
        const now = this.ctx.currentTime;
        
        while (this.nextStepTime < now + 0.1) {
            const stepValue = this.steps[this.currentStep];
            const stepDur = this.getStepDuration();
            
            // ADSR -tyyppinen verhokäyrä gatelle (poistaa naksumisen)
            this.gateNode.gain.cancelScheduledValues(this.nextStepTime);
            this.gateNode.gain.setValueAtTime(this.gateNode.gain.value, this.nextStepTime);
            
            if (stepValue === 1) {
                this.gateNode.gain.linearRampToValueAtTime(1.0, this.nextStepTime + 0.01);
                this.gateNode.gain.setValueAtTime(1.0, this.nextStepTime + stepDur - 0.02);
                this.gateNode.gain.linearRampToValueAtTime(0.001, this.nextStepTime + stepDur);
            } else {
                this.gateNode.gain.linearRampToValueAtTime(0.001, this.nextStepTime + 0.01);
            }

            // Visuaalinen päivitys
            if (this.uiElements.stepDots && this.uiElements.stepDots.length > 0) {
                const stepIndex = this.currentStep;
                setTimeout(() => {
                    this.uiElements.stepDots.forEach(d => d.style.boxShadow = 'none');
                    if (this.uiElements.stepDots[stepIndex]) {
                        this.uiElements.stepDots[stepIndex].style.boxShadow = '0 0 10px #ff00ff';
                    }
                }, (this.nextStepTime - now) * 1000);
            }

            this.currentStep = (this.currentStep + 1) % 16;
            this.nextStepTime += stepDur;
        }
    }

    getNodes() {
        return { input: this.input, output: this.output };
    }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            steps: [...this.steps],
            rate: this.rate,
            mix: this.mix,
            tempoSync: this.tempoSync
        };
    }

    setState(state) {
        if (!state) return;

        if (state.steps !== undefined) {
            this.steps = [...state.steps];
            if (this.uiElements.stepButtons) {
                this.uiElements.stepButtons.forEach((btn, i) => {
                    if (this.steps[i]) btn.classList.add('active');
                    else btn.classList.remove('active');
                });
            }
        }

        if (state.tempoSync !== undefined) {
            this.tempoSync = state.tempoSync;
            if (this.uiElements.syncBtn) {
                if (this.tempoSync) this.uiElements.syncBtn.classList.add('active');
                else this.uiElements.syncBtn.classList.remove('active');
            }
        }

        if (state.rate !== undefined) {
            this.rate = state.rate;
            if (this.knobs['rate']) this.knobs['rate'].setValue(this.rate);
        }

        if (state.mix !== undefined) {
            this.mix = state.mix;
            this.updateMix();
            if (this.knobs['mix']) this.knobs['mix'].setValue(this.mix);
        }
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#ff00ff'; // Magenta
        containerElement.style.setProperty('--fx-color', color);

        const styleId = 'fx-seq-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .btn-sync { 
                    background: #111; border: 1px solid #555; color: #888; cursor: pointer; 
                    padding: 4px 8px; border-radius: 4px; font-family: monospace; font-size: 10px; 
                    text-transform: uppercase; transition: all 0.2s; margin-bottom: 10px; 
                }
                .btn-sync.active { 
                    background: rgba(255,0,255,0.2); border-color: var(--fx-color); 
                    color: var(--fx-color); box-shadow: 0 0 10px rgba(255,0,255,0.5); 
                }
                .step-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 5px; margin-bottom: 15px; width: 100%; max-width: 350px; margin-left: auto; margin-right: auto;}
                .step-btn {
                    aspect-ratio: 1; background: #1a1a1a; border: 1px solid #333; border-radius: 4px;
                    cursor: pointer; position: relative; transition: all 0.1s;
                }
                .step-btn.active { background: var(--fx-color); border-color: #fff; box-shadow: 0 0 10px var(--fx-color); }
                .step-dot {
                    position: absolute; bottom: -8px; left: 50%; transform: translateX(-50%);
                    width: 4px; height: 4px; border-radius: 50%; background: #fff; opacity: 0.5;
                }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div style="margin-bottom: 5px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">TRANCE GATE</div>
            <div style="text-align: center;">
                <button id="seq-sync-btn" class="btn-sync ${this.tempoSync ? 'active' : ''}">Tempo Sync</button>
            </div>
            
            <div class="step-grid" id="seq-grid"></div>

            <div style="display: flex; flex-wrap: wrap; justify-content: center; align-items: center; padding: 5px 0; gap: 20px;" id="seq-dashboard"></div>
        `;

        // Sync Button
        const syncBtn = containerElement.querySelector('#seq-sync-btn');
        this.uiElements.syncBtn = syncBtn;
        syncBtn.addEventListener('click', () => {
            this.tempoSync = !this.tempoSync;
            if (this.tempoSync) {
                syncBtn.classList.add('active');
                if (this.rate > 1.0) this.rate = 0.25; // Default 1/16 note
            } else {
                syncBtn.classList.remove('active');
            }
            if (this.knobs['rate']) this.knobs['rate'].setValue(this.rate);
        });

        // 16-Step Grid
        const grid = containerElement.querySelector('#seq-grid');
        this.uiElements.stepButtons = [];
        this.uiElements.stepDots = [];

        for (let i = 0; i < 16; i++) {
            const btn = document.createElement('div');
            btn.className = 'step-btn';
            if (this.steps[i]) btn.classList.add('active');
            
            const dot = document.createElement('div');
            dot.className = 'step-dot';
            btn.appendChild(dot);
            
            btn.addEventListener('click', () => {
                this.steps[i] = this.steps[i] === 1 ? 0 : 1;
                if (this.steps[i]) btn.classList.add('active');
                else btn.classList.remove('active');
            });

            grid.appendChild(btn);
            this.uiElements.stepButtons.push(btn);
            this.uiElements.stepDots.push(dot);
        }

        // Dashboard
        const dashboard = containerElement.querySelector('#seq-dashboard');

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

        const formatTime = (v) => {
            if (this.tempoSync) {
                if (v <= 0.125) return '1/32';
                if (v <= 0.25) return '1/16';
                if (v <= 0.33) return '1/12';
                if (v <= 0.5) return '1/8';
                if (v <= 1.0) return '1/4';
                return '1/2';
            }
            return v.toFixed(1) + ' Hz';
        };

        this.knobs['rate'] = createKnob('Speed', 0.1, 10.0, this.rate, formatTime, v => { this.rate = v; });
        this.knobs['mix'] = createKnob('Mix', 0, 1.0, this.mix, v => Math.round(v * 100) + '%', v => { this.mix = v; this.updateMix(); });
    }
}