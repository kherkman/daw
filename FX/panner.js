// panner.js
// Graafinen, piirrettävä Auto-Panner (Envelope LFO) Tempo Syncillä
// Yläreuna = Oikea (R), Keskellä = Center (C), Alareuna = Vasen (L)

window.CustomAudioEffect = class PannerGraphEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        
        // StereoPannerNode, jolla panorointia ohjataan (-1.0 = Vasen, 1.0 = Oikea)
        this.panner = audioCtx.createStereoPanner();
        this.panner.pan.value = 0.0; // Oletuksena keskellä

        this.input.connect(this.panner);
        this.panner.connect(this.output);

        // Asetukset
        this.isSync = true;
        this.rateValue = 0.5; // Syncillä: 0.5 = 1/8 nuotti
        this.currentSyncLabel = "1/8";
        
        this.fadeIn = 0.0;
        this.fadeMid = 0.5;
        this.fadeOut = 0.0;

        // Käyrän taulukot
        this.arraySize = 64;
        this.baseCurve = new Float32Array(this.arraySize).fill(0.5);  // Piirretty 0.0 - 1.0 (0.5 = Keskellä)
        this.finalCurve = new Float32Array(this.arraySize).fill(0.5); // Visuaalinen 0.0 - 1.0
        this.audioCurve = new Float32Array(this.arraySize).fill(0.0); // Web Audio API -1.0 - 1.0

        // UI-referenssit
        this.knobs = {};
        this.uiElements = {};

        this.isPlaying = true;
        this.nextScheduleTime = this.ctx.currentTime + 0.1;
        
        // Ajastin joka syöttää käyrää Web Audio API:lle säännöllisesti
        this.schedulerTimer = setInterval(() => this.scheduleEnvelope(), 25);
        
        // Ladataan oletuspresetti (Sine LFO)
        this.loadPreset('Sine');
    }

    calculateFinalCurve() {
        for (let i = 0; i < this.arraySize; i++) {
            let progress = i / (this.arraySize - 1); 
            
            // Fade envelope laskenta (0.0 = ei efektiä, 1.0 = täysi efekti)
            let fadeEnv = 1.0;
            
            if (this.fadeIn > 0 && progress < this.fadeIn) {
                fadeEnv *= (progress / this.fadeIn);
            }
            
            if (this.fadeOut > 0 && progress > (1.0 - this.fadeOut)) {
                fadeEnv *= ((1.0 - progress) / this.fadeOut);
            }
            
            if (this.fadeMid !== 0.5) {
                let bend = (this.fadeMid * 2) - 1; 
                if (bend > 0) fadeEnv *= Math.pow(Math.sin(progress * Math.PI), 1.0 - bend);
                else fadeEnv *= Math.pow(Math.sin(progress * Math.PI), 1.0 + Math.abs(bend));
            }

            // Pannerissa Faden pitää vetää arvoa kohti keskustaa (0.5), ei nollaa (vasenta).
            // Interpoloidaan keskustan (0.5) ja käyttäjän piirtämän arvon välillä fade-arvon perusteella.
            this.finalCurve[i] = 0.5 + (this.baseCurve[i] - 0.5) * fadeEnv;

            // Muunnetaan UI:n 0.0 -> 1.0 asteikko Web Audion -1.0 (Vasen) -> 1.0 (Oikea) asteikkoon.
            this.audioCurve[i] = (this.finalCurve[i] * 2.0) - 1.0;
        }
    }

    loadPreset(type) {
        for (let i = 0; i < this.arraySize; i++) {
            let prog = i / this.arraySize;
            if (type === 'Square') {
                this.baseCurve[i] = prog < 0.5 ? 1.0 : 0.0; // Oikea -> Vasen
            } else if (type === 'Saw') {
                this.baseCurve[i] = 1.0 - prog; // Oikealta vasemmalle lineaarisesti
            } else if (type === 'Triangle') {
                this.baseCurve[i] = 1.0 - Math.abs((prog * 2.0) - 1.0); // Vasen -> Oikea -> Vasen
            } else if (type === 'Sine') {
                this.baseCurve[i] = (Math.sin(prog * Math.PI * 2 - Math.PI/2) + 1) / 2; // Pehmeä L-R-L
            } else if (type === 'Flat') {
                this.baseCurve[i] = 0.5; // Keskellä
            }
        }
        this.calculateFinalCurve();
    }

    scheduleEnvelope() {
        if (!this.isPlaying) return;
        const now = this.ctx.currentTime;
        
        if (this.nextScheduleTime < now) this.nextScheduleTime = now + 0.05;

        while (this.nextScheduleTime < now + 0.2) {
            let cycleDuration = 0.5; 
            if (this.isSync && window.globalTempo) {
                let beatDuration = 60.0 / window.globalTempo;
                cycleDuration = beatDuration * this.rateValue; 
            } else {
                cycleDuration = this.rateValue; 
            }

            try {
                this.panner.pan.setValueCurveAtTime(this.audioCurve, this.nextScheduleTime, cycleDuration);
            } catch(e) {
                this.panner.pan.setValueAtTime(0.0, this.nextScheduleTime); // Fallback keskelle
            }
            
            this.nextScheduleTime += cycleDuration;
        }
    }

    getNodes() { return { input: this.input, output: this.output }; }

    destroy() {
        this.isPlaying = false;
        clearInterval(this.schedulerTimer);
    }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            isSync: this.isSync,
            rateValue: this.rateValue,
            fadeIn: this.fadeIn,
            fadeMid: this.fadeMid,
            fadeOut: this.fadeOut,
            baseCurve: Array.from(this.baseCurve)
        };
    }

    setState(state) {
        if (!state) return;

        if (state.isSync !== undefined) {
            this.isSync = state.isSync;
            if (this.uiElements.syncBtn) {
                if (this.isSync) {
                    this.uiElements.syncBtn.classList.add('active');
                    this.uiElements.syncBtn.innerText = "Sync: ON";
                    if (this.knobs['Rate']) this.knobs['Rate'].updateRange(0.125, 4.0, this.rateValue);
                } else {
                    this.uiElements.syncBtn.classList.remove('active');
                    this.uiElements.syncBtn.innerText = "Sync: OFF";
                    if (this.knobs['Rate']) this.knobs['Rate'].updateRange(0.05, 5.0, this.rateValue);
                }
            }
        }

        if (state.rateValue !== undefined) {
            this.rateValue = state.rateValue;
            if (this.knobs['Rate']) this.knobs['Rate'].setValue(this.rateValue);
            if (this.updateRateDisplay) this.updateRateDisplay();
        }

        if (state.fadeIn !== undefined) {
            this.fadeIn = state.fadeIn;
            if (this.knobs['FadeIn']) this.knobs['FadeIn'].setValue(this.fadeIn);
        }

        if (state.fadeMid !== undefined) {
            this.fadeMid = state.fadeMid;
            if (this.knobs['FadeMid']) this.knobs['FadeMid'].setValue(this.fadeMid);
        }

        if (state.fadeOut !== undefined) {
            this.fadeOut = state.fadeOut;
            if (this.knobs['FadeOut']) this.knobs['FadeOut'].setValue(this.fadeOut);
        }

        if (state.baseCurve !== undefined) {
            this.baseCurve = new Float32Array(state.baseCurve);
            if (this.uiElements.presetSelect) this.uiElements.presetSelect.value = 'Flat';
        }

        this.calculateFinalCurve();
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#ff00aa'; // Pinkki väri erottamaan Panner Volumesta
        containerElement.style.setProperty('--fx-pan-color', color);

        const styleId = 'fx-pan-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .pan-dashboard { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; padding: 10px 0; gap: 20px; }
                .pan-panel { background: rgba(0,0,0,0.4); border: 1px solid rgba(255, 0, 170, 0.2); border-radius: 8px; padding: 15px; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center;}
                .pan-select { background: #000; color: var(--fx-pan-color); border: 1px solid var(--fx-pan-color); padding: 5px 10px; border-radius: 4px; font-family: monospace; font-size: 12px; outline: none; cursor: pointer; text-transform: uppercase; }
                .btn-pan-sync { background: rgba(0,0,0,0.5); border: 1px solid var(--fx-pan-color); color: var(--fx-pan-color); cursor: pointer; padding: 6px 12px; border-radius: 4px; font-weight: bold; font-size: 11px; text-transform: uppercase; transition: all 0.2s; }
                .btn-pan-sync.active { background: var(--fx-pan-color); color: #000; box-shadow: 0 0 10px var(--fx-pan-color); }
                
                .pan-knob-container { display: flex; flex-direction: column; align-items: center; user-select: none; width: 70px; }
                .pan-knob-wrapper { position: relative; width: 60px; height: 60px; cursor: ns-resize; margin-bottom: 8px; touch-action: none; }
                .pan-knob-svg { width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 5px rgba(255, 0, 170, 0.2)); }
                .pan-knob-track { fill: none; stroke: #2a2a3b; stroke-width: 8; stroke-linecap: round; }
                .pan-knob-value-path { fill: none; stroke: var(--fx-pan-color); stroke-width: 8; stroke-linecap: round; transition: stroke 0.2s; }
                .pan-knob-wrapper:active .pan-knob-value-path, .pan-knob-wrapper:hover .pan-knob-value-path { stroke: #fff; filter: drop-shadow(0 0 8px var(--fx-pan-color)); }
                .pan-knob-center { fill: #1a1a24; stroke: #333; stroke-width: 2; }
                .pan-knob-indicator { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
                .pan-knob-dot { position: absolute; width: 6px; height: 6px; background: var(--fx-pan-color); border-radius: 50%; top: 6px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 8px var(--fx-pan-color); }
                .pan-knob-label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #8b8b9f; margin-bottom: 5px; text-align: center; }
                .pan-knob-value-display { font-size: 11px; font-family: monospace; color: #fff; background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); text-align: center; min-width: 40px; }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div style="margin-bottom: 15px; color: var(--fx-pan-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">AUTO-PANNER</div>
            
            <div class="pan-panel">
                <div>
                    <label style="display: block; font-size: 10px; color: #8b8b9f; margin-bottom: 5px; text-transform: uppercase;">Shape Preset</label>
                    <select id="pan-preset" class="pan-select">
                        <option value="Sine">Sine</option>
                        <option value="Square">Square</option>
                        <option value="Triangle">Triangle</option>
                        <option value="Saw">Saw</option>
                        <option value="Flat">Center (Draw)</option>
                    </select>
                </div>
                <button id="pan-sync-btn" class="btn-pan-sync ${this.isSync ? 'active' : ''}">${this.isSync ? 'Sync: ON' : 'Sync: OFF'}</button>
            </div>

            <div style="width: 100%; max-width: 450px; height: 120px; background: rgba(0,0,0,0.6); border: 1px solid rgba(255, 0, 170, 0.4); border-radius: 6px; margin: 0 auto 15px auto; overflow: hidden; position: relative; cursor: crosshair;" id="pan-canvas-container">
                <canvas id="pan-canvas" style="width: 100%; height: 100%; display: block;"></canvas>
            </div>

            <div class="pan-dashboard" id="pan-knobs"></div>
        `;

        const presetSelect = containerElement.querySelector('#pan-preset');
        this.uiElements.presetSelect = presetSelect;
        
        const syncBtn = containerElement.querySelector('#pan-sync-btn');
        this.uiElements.syncBtn = syncBtn;

        const dashboard = containerElement.querySelector('#pan-knobs');
        const canvas = containerElement.querySelector('#pan-canvas');
        const canvasContainer = containerElement.querySelector('#pan-canvas-container');
        const ctx2d = canvas.getContext('2d');

        syncBtn.addEventListener('click', () => {
            this.isSync = !this.isSync;
            if(this.isSync) {
                syncBtn.classList.add('active'); syncBtn.innerText = "Sync: ON";
                this.rateValue = 0.5; this.knobs['Rate'].updateRange(0.125, 4.0, this.rateValue);
            } else {
                syncBtn.classList.remove('active'); syncBtn.innerText = "Sync: OFF";
                this.rateValue = 0.5; this.knobs['Rate'].updateRange(0.05, 5.0, this.rateValue);
            }
            this.updateRateDisplay();
        });

        presetSelect.addEventListener('change', (e) => this.loadPreset(e.target.value));

        let isDrawing = false;
        const drawOnCanvas = (clientX, clientY) => {
            const rect = canvas.getBoundingClientRect();
            const x = clientX - rect.left;
            const y = clientY - rect.top;
            
            const index = Math.floor((x / rect.width) * this.arraySize);
            const val = 1.0 - (y / rect.height); // Y on käänteinen. 1.0 = ylhäällä = Oikea. 0.0 = alhaalla = Vasen.
            
            if (index >= 0 && index < this.arraySize) {
                this.baseCurve[index] = Math.max(0, Math.min(1, val));
                this.calculateFinalCurve();
                presetSelect.value = 'Flat'; 
            }
        };

        canvasContainer.addEventListener('mousedown', (e) => { isDrawing = true; drawOnCanvas(e.clientX, e.clientY); });
        window.addEventListener('mousemove', (e) => { if (isDrawing) drawOnCanvas(e.clientX, e.clientY); });
        window.addEventListener('mouseup', () => { isDrawing = false; });
        
        canvasContainer.addEventListener('touchstart', (e) => { isDrawing = true; drawOnCanvas(e.touches[0].clientX, e.touches[0].clientY); }, {passive: false});
        window.addEventListener('touchmove', (e) => { if (isDrawing) { e.preventDefault(); drawOnCanvas(e.touches[0].clientX, e.touches[0].clientY); } }, {passive: false});
        window.addEventListener('touchend', () => { isDrawing = false; });

        const createKnob = (container, label, min, max, defaultValue, formatValue, onChange) => {
            const div = document.createElement('div');
            div.className = 'pan-knob-container';
            const radius = 25, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            div.innerHTML = `
                <div class="pan-knob-label">${label}</div>
                <div class="pan-knob-wrapper">
                    <svg class="pan-knob-svg" viewBox="0 0 60 60"><circle class="pan-knob-track" cx="30" cy="30" r="${radius}" stroke-dasharray="${maxDash} ${circumference}" /><circle class="pan-knob-value-path" cx="30" cy="30" r="${radius}" stroke-dasharray="0 ${circumference}" /><circle class="pan-knob-center" cx="30" cy="30" r="16" /></svg>
                    <div class="pan-knob-indicator"><div class="pan-knob-dot"></div></div>
                </div>
                <div class="pan-knob-value-display">${formatValue(defaultValue)}</div>
            `;
            const wrapper = div.querySelector('.pan-knob-wrapper'), valuePath = div.querySelector('.pan-knob-value-path'), indicator = div.querySelector('.pan-knob-indicator'), display = div.querySelector('.pan-knob-value-display');
            let currentValue = defaultValue, currentMin = min, currentMax = max;

            const updateUI = (value, triggerCallback = false) => {
                const normalized = (value - currentMin) / (currentMax - currentMin);
                valuePath.setAttribute('stroke-dasharray', `${Math.max(0, Math.min(1, normalized)) * maxDash} ${circumference}`);
                indicator.style.transform = `rotate(${-135 + (normalized * 270)}deg)`;
                display.innerText = formatValue(value);
                if (triggerCallback) onChange(value);
            };
            
            updateUI(currentValue); container.appendChild(div);

            let isDragging = false, startY = 0, startValue = 0;
            const startDrag = (y) => { isDragging = true; startY = y; startValue = currentValue; document.body.style.cursor = 'ns-resize'; };
            const doDrag = (y) => {
                if (!isDragging) return;
                let newVal = startValue + (((startY - y) / 100) * (currentMax - currentMin));
                newVal = Math.max(currentMin, Math.min(currentMax, newVal));
                if (newVal !== currentValue) { currentValue = newVal; updateUI(currentValue, true); }
            };
            const endDrag = () => { if (isDragging) { isDragging = false; document.body.style.cursor = 'default'; } };

            wrapper.addEventListener('mousedown', (e) => startDrag(e.clientY)); window.addEventListener('mousemove', (e) => doDrag(e.clientY)); window.addEventListener('mouseup', endDrag);
            wrapper.addEventListener('touchstart', (e) => startDrag(e.touches[0].clientY), { passive: false }); window.addEventListener('touchmove', (e) => { if (isDragging) { e.preventDefault(); doDrag(e.touches[0].clientY); } }, { passive: false }); window.addEventListener('touchend', endDrag);
            
            return { 
                setValue: (v) => { currentValue = v; updateUI(v, false); },
                updateRange: (newMin, newMax, newDef) => { currentMin = newMin; currentMax = newMax; currentValue = newDef; updateUI(currentValue); },
                setDisplay: (text) => { display.innerText = text; }
            };
        };

        const getSyncLabel = (val) => {
            const divs = [ { label: '1/16', mult: 0.25 }, { label: '1/8', mult: 0.5 }, { label: '1/4', mult: 1.0 }, { label: '1/2', mult: 2.0 }, { label: '1/1', mult: 4.0 } ];
            let closest = divs[0], minDist = Math.abs(val - divs[0].mult);
            for(let i=1; i<divs.length; i++) {
                let d = Math.abs(val - divs[i].mult);
                if(d < minDist) { minDist = d; closest = divs[i]; }
            }
            this.currentSyncLabel = closest.label; return closest.label;
        };

        this.updateRateDisplay = () => {
            if(this.isSync) this.knobs['Rate'].setDisplay(getSyncLabel(this.rateValue));
            else this.knobs['Rate'].setDisplay(this.rateValue.toFixed(2) + ' s');
        };

        let rateMin = this.isSync ? 0.125 : 0.05;
        let rateMax = this.isSync ? 4.0 : 5.0;

        this.knobs['Rate'] = createKnob(dashboard, 'Rate', rateMin, rateMax, this.rateValue, v => this.isSync ? getSyncLabel(v) : v.toFixed(2) + ' s', v => {
            if(this.isSync) {
                const divs = [0.25, 0.5, 1.0, 2.0, 4.0];
                this.rateValue = divs.reduce((prev, curr) => Math.abs(curr - v) < Math.abs(prev - v) ? curr : prev);
            } else this.rateValue = v;
            this.updateRateDisplay();
        });

        this.knobs['FadeIn'] = createKnob(dashboard, 'Fade In', 0, 0.5, this.fadeIn, v => Math.round(v*100)+'%', v => { this.fadeIn = v; this.calculateFinalCurve(); });
        this.knobs['FadeMid'] = createKnob(dashboard, 'Shape C', 0, 1.0, this.fadeMid, v => Math.round(v*100)+'%', v => { this.fadeMid = v; this.calculateFinalCurve(); });
        this.knobs['FadeOut'] = createKnob(dashboard, 'Fade Out', 0, 0.5, this.fadeOut, v => Math.round(v*100)+'%', v => { this.fadeOut = v; this.calculateFinalCurve(); });

        let mountCheckCount = 0;
        const drawCanvas = () => {
            mountCheckCount++;
            if (!document.body.contains(canvas)) {
                if (mountCheckCount > 10) { this.destroy(); return; }
                return requestAnimationFrame(drawCanvas);
            }

            const parent = canvas.parentElement;
            if (parent && (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight)) {
                canvas.width = parent.clientWidth || 450;
                canvas.height = parent.clientHeight || 120;
            }

            const w = canvas.width, h = canvas.height;
            if (!w || !h) return requestAnimationFrame(drawCanvas);

            ctx2d.clearRect(0, 0, w, h);

            // Keskiviiva (Center)
            ctx2d.strokeStyle = 'rgba(255,255,255,0.2)';
            ctx2d.lineWidth = 1;
            ctx2d.beginPath();
            ctx2d.moveTo(0, h/2); ctx2d.lineTo(w, h/2);
            ctx2d.stroke();

            // Ohjeruudukko
            ctx2d.strokeStyle = 'rgba(255,255,255,0.05)';
            ctx2d.beginPath();
            ctx2d.moveTo(w/4, 0); ctx2d.lineTo(w/4, h);
            ctx2d.moveTo(w/2, 0); ctx2d.lineTo(w/2, h);
            ctx2d.moveTo(w*0.75, 0); ctx2d.lineTo(w*0.75, h);
            ctx2d.stroke();

            // R/L Tekstit reunoille
            ctx2d.fillStyle = 'rgba(255, 0, 170, 0.5)';
            ctx2d.font = '10px monospace';
            ctx2d.fillText('R', 5, 12);
            ctx2d.fillText('C', 5, h/2 + 4);
            ctx2d.fillText('L', 5, h - 5);

            // Piirretään Panner Curve
            ctx2d.strokeStyle = color;
            ctx2d.lineWidth = 3;
            ctx2d.beginPath();
            const slice = w / (this.arraySize - 1);
            
            for (let i = 0; i < this.arraySize; i++) {
                const x = i * slice;
                const y = h - (this.finalCurve[i] * h); // 1.0 (Oikea) = Ylhäällä (y=0)
                if (i === 0) ctx2d.moveTo(x, y);
                else ctx2d.lineTo(x, y);
            }
            ctx2d.stroke();

            // Playhead
            let cycleDuration = this.rateValue;
            if (this.isSync && window.globalTempo) cycleDuration = (60.0 / window.globalTempo) * this.rateValue;
            
            const elapsed = this.ctx.currentTime % cycleDuration;
            const playX = (elapsed / cycleDuration) * w;

            ctx2d.strokeStyle = 'rgba(255, 255, 255, 0.8)';
            ctx2d.lineWidth = 2;
            ctx2d.beginPath();
            ctx2d.moveTo(playX, 0);
            ctx2d.lineTo(playX, h);
            ctx2d.stroke();

            requestAnimationFrame(drawCanvas);
        };
        drawCanvas();
    }
}