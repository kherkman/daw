// delay.js
window.CustomAudioEffect = class DelayEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();

        // Nodes
        this.dryGain = audioCtx.createGain();
        this.wetGain = audioCtx.createGain();
        
        this.delayNode = audioCtx.createDelay(5.0); // max 5 seconds
        this.feedbackGain = audioCtx.createGain();
        this.filterNode = audioCtx.createBiquadFilter();
        this.filterNode.type = 'lowpass';
        
        // Default parameters
        this.time = 0.3; // seconds (or fraction of a beat if tempo synced)
        this.feedback = 0.4;
        this.mix = 0.3;
        this.filterCutoff = 3000;
        this.tempoSync = false;
        
        // Tempo state
        this.currentBpm = window.bpm || 120; // Oletetaan että sovellus voi asettaa global BPM
        
        // UI-referenssit
        this.knobs = {};
        this.uiElements = {};

        // Routing
        // Input -> Dry
        this.input.connect(this.dryGain);
        this.dryGain.connect(this.output);

        // Input -> Delay -> Filter -> Wet
        this.input.connect(this.delayNode);
        this.delayNode.connect(this.filterNode);
        this.filterNode.connect(this.wetGain);
        this.wetGain.connect(this.output);

        // Feedback Loop: Filter -> FeedbackGain -> Delay
        this.filterNode.connect(this.feedbackGain);
        this.feedbackGain.connect(this.delayNode);

        // Apply init values
        this.updateTime();
        this.feedbackGain.gain.value = this.feedback;
        this.filterNode.frequency.value = this.filterCutoff;
        this.updateMix();
        
        // Monitor global BPM changes if exists
        setInterval(() => {
            if (window.bpm && window.bpm !== this.currentBpm) {
                this.currentBpm = window.bpm;
                if (this.tempoSync) this.updateTime();
            }
        }, 1000);
    }

    updateTime() {
        let actualTimeInSeconds = this.time;
        if (this.tempoSync) {
            // this.time is treated as multiplier (e.g. 0.5 = 1/8 note)
            const beatDuration = 60.0 / this.currentBpm;
            actualTimeInSeconds = beatDuration * this.time;
        }
        // Ensure within bounds
        actualTimeInSeconds = Math.max(0.01, Math.min(4.99, actualTimeInSeconds));
        this.delayNode.delayTime.setTargetAtTime(actualTimeInSeconds, this.ctx.currentTime, 0.05);
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
            time: this.time,
            feedback: this.feedback,
            mix: this.mix,
            filterCutoff: this.filterCutoff,
            tempoSync: this.tempoSync
        };
    }

    setState(state) {
        if (!state) return;

        if (state.tempoSync !== undefined) {
            this.tempoSync = state.tempoSync;
            if (this.uiElements.syncBtn) {
                if (this.tempoSync) this.uiElements.syncBtn.classList.add('active');
                else this.uiElements.syncBtn.classList.remove('active');
            }
        }

        if (state.time !== undefined) {
            this.time = state.time;
            this.updateTime();
            if (this.knobs['time']) this.knobs['time'].setValue(this.time);
        }
        if (state.feedback !== undefined) {
            this.feedback = state.feedback;
            this.feedbackGain.gain.setTargetAtTime(this.feedback, this.ctx.currentTime, 0.05);
            if (this.knobs['feedback']) this.knobs['feedback'].setValue(this.feedback);
        }
        if (state.filterCutoff !== undefined) {
            this.filterCutoff = state.filterCutoff;
            this.filterNode.frequency.setTargetAtTime(this.filterCutoff, this.ctx.currentTime, 0.05);
            if (this.knobs['filter']) this.knobs['filter'].setValue(this.filterCutoff);
        }
        if (state.mix !== undefined) {
            this.mix = state.mix;
            this.updateMix();
            if (this.knobs['mix']) this.knobs['mix'].setValue(this.mix);
        }
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#00ffff'; // Cyan
        containerElement.style.setProperty('--fx-color', color);

        const styleId = 'fx-delay-styles';
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
                    background: rgba(0,255,255,0.2); border-color: var(--fx-color); 
                    color: var(--fx-color); box-shadow: 0 0 10px rgba(0,255,255,0.5); 
                }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div style="margin-bottom: 5px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">ANALOG DELAY</div>
            <div style="text-align: center;">
                <button id="delay-sync-btn" class="btn-sync ${this.tempoSync ? 'active' : ''}">Tempo Sync</button>
            </div>
            <div style="display: flex; flex-wrap: wrap; justify-content: center; align-items: center; padding: 5px 0; gap: 20px;" id="delay-dashboard"></div>
        `;
        
        const dashboard = containerElement.querySelector('#delay-dashboard');
        const syncBtn = containerElement.querySelector('#delay-sync-btn');
        this.uiElements.syncBtn = syncBtn;

        syncBtn.addEventListener('click', () => {
            this.tempoSync = !this.tempoSync;
            if (this.tempoSync) {
                syncBtn.classList.add('active');
                // Auto-convert to a sane beat value if activating
                if (this.time > 2.0) this.time = 1.0; 
            } else {
                syncBtn.classList.remove('active');
            }
            this.updateTime();
            // Force re-render of Time knob visual label behavior
            if (this.knobs['time']) this.knobs['time'].setValue(this.time);
        });

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
                if (v <= 0.75) return '1/8.';
                if (v <= 1.0) return '1/4';
                if (v <= 1.5) return '1/4.';
                if (v <= 2.0) return '1/2';
                return '> 1/2';
            }
            return Math.round(v * 1000) + ' ms';
        };

        this.knobs['time'] = createKnob('Time', 0.05, 2.0, this.time, formatTime, v => { this.time = v; this.updateTime(); });
        this.knobs['feedback'] = createKnob('F.Back', 0, 0.95, this.feedback, v => Math.round(v * 100) + '%', v => { this.feedback = v; this.feedbackGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
        this.knobs['filter'] = createKnob('Tone', 500, 10000, this.filterCutoff, v => Math.round(v) + ' Hz', v => { this.filterCutoff = v; this.filterNode.frequency.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
        this.knobs['mix'] = createKnob('Mix', 0, 1.0, this.mix, v => Math.round(v * 100) + '%', v => { this.mix = v; this.updateMix(); });
    }
}