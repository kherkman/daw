// delay-effect.js
window.CustomAudioEffect = class DelayEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;

        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.dryNode = audioCtx.createGain();
        this.wetNode = audioCtx.createGain();
        
        this.delayNode = audioCtx.createDelay(5.0);
        this.feedbackNode = audioCtx.createGain();
        
        this.hpf = audioCtx.createBiquadFilter();
        this.hpf.type = 'highpass';
        this.lpf = audioCtx.createBiquadFilter();
        this.lpf.type = 'lowpass';
        
        this.panner = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : audioCtx.createPanner();

        // UUSI: Insert FX ketju delayn toistoille
        this.insertEffects = [];
        this.insertInput = audioCtx.createGain();
        this.insertOutput = audioCtx.createGain();

        // Arvot
        this.timeKnobValue = 0.4;
        this.isTempoSync = false;
        this.currentSyncLabel = "1/4";
        
        // Ulkoiset parametrit UI:ta varten
        this.feedbackValue = 0.5;
        this.hpfValue = 0.0;
        this.lpfValue = 1.0;
        this.panValue = 0.0;
        this.mixValue = 0.6;

        this.delayNode.delayTime.value = this.timeKnobValue; 
        this.feedbackNode.gain.value = this.feedbackValue;   
        this.dryNode.gain.value = 1.0;        
        this.wetNode.gain.value = this.mixValue;        
        this.hpf.frequency.value = 20;        
        this.lpf.frequency.value = 20000;     
        if (this.panner.pan) this.panner.pan.value = this.panValue; 

        // UI-referenssit
        this.knobs = {};
        this.uiElements = {};

        // Reititys
        this.input.connect(this.dryNode);
        this.dryNode.connect(this.output);

        this.input.connect(this.delayNode);
        this.delayNode.connect(this.hpf);
        this.hpf.connect(this.lpf);

        // Insertit kaikulooppiin (toistoihin)
        this.lpf.connect(this.insertInput);
        this.insertInput.connect(this.insertOutput); // Suoraan läpi oletuksena

        this.insertOutput.connect(this.feedbackNode);
        this.feedbackNode.connect(this.delayNode);

        this.insertOutput.connect(this.panner);
        this.panner.connect(this.wetNode);
        this.wetNode.connect(this.output);

        // Päivitetään delay-aikaa jatkuvasti jos tempo muuttuu
        this.timerId = setInterval(() => this.updateDelayTime(), 500);
    }

    destroy() {
        if (this.timerId) clearInterval(this.timerId);
    }

    reconnectInserts() {
        try { this.insertInput.disconnect(); } catch(e){}
        this.insertEffects.forEach(fx => {
            try { fx.instance.getNodes().output.disconnect(); } catch(e){}
        });

        let currentNode = this.insertInput;
        if (this.insertEffects.length === 0) {
            currentNode.connect(this.insertOutput);
        } else {
            this.insertEffects.forEach(fx => {
                currentNode.connect(fx.instance.getNodes().input);
                currentNode = fx.instance.getNodes().output;
            });
            currentNode.connect(this.insertOutput);
        }
    }

    updateDelayTime() {
        if (this.isTempoSync && window.globalTempo) {
            const divisions = [
                { label: '1/16', mult: 0.25 },
                { label: '1/8', mult: 0.5 },
                { label: '1/4', mult: 1.0 },
                { label: '3/8', mult: 1.5 },
                { label: '1/2', mult: 2.0 },
                { label: '1/1', mult: 4.0 }
            ];
            
            let norm = (this.timeKnobValue - 0.01) / (2.0 - 0.01);
            let index = Math.floor(norm * divisions.length);
            if(index >= divisions.length) index = divisions.length - 1;
            
            let div = divisions[index];
            this.currentSyncLabel = div.label;
            
            let beatDuration = 60.0 / window.globalTempo;
            let calculatedTime = beatDuration * div.mult;
            
            this.delayNode.delayTime.setTargetAtTime(calculatedTime, this.ctx.currentTime, 0.05);
            
            // Päivitetään näyttö jos ui funktio on määritetty
            if(this.updateTimeDisplay) this.updateTimeDisplay(this.currentSyncLabel);
        } else {
            this.delayNode.delayTime.setTargetAtTime(this.timeKnobValue, this.ctx.currentTime, 0.05);
            if(this.updateTimeDisplay) this.updateTimeDisplay(this.timeKnobValue.toFixed(2) + ' s');
        }
    }

    getFreq(val) { return 20 * Math.pow(1000, val); }

    getNodes() {
        return { input: this.input, output: this.output };
    }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            timeKnobValue: this.timeKnobValue,
            isTempoSync: this.isTempoSync,
            feedbackValue: this.feedbackValue,
            hpfValue: this.hpfValue,
            lpfValue: this.lpfValue,
            panValue: this.panValue,
            mixValue: this.mixValue,
            insertEffects: this.insertEffects.map(fx => ({
                id: fx.id,
                scriptText: fx.instance._scriptText,
                fileName: fx.instance._fileName,
                state: typeof fx.instance.getState === 'function' ? fx.instance.getState() : {}
            }))
        };
    }

    setState(state) {
        if (!state) return;

        if (state.isTempoSync !== undefined) {
            this.isTempoSync = state.isTempoSync;
            if (this.uiElements.syncBtn) {
                this.uiElements.syncBtn.innerText = "Sync: " + (this.isTempoSync ? "ON" : "OFF");
                this.uiElements.syncBtn.style.background = this.isTempoSync ? "var(--accent-primary)" : "rgba(0,0,0,0.5)";
                this.uiElements.syncBtn.style.color = this.isTempoSync ? "#000" : "var(--accent-primary)";
            }
        }

        if (state.timeKnobValue !== undefined) {
            this.timeKnobValue = state.timeKnobValue;
            this.updateDelayTime();
            if (this.knobs['time']) this.knobs['time'].setValue(this.timeKnobValue);
        }

        if (state.feedbackValue !== undefined) {
            this.feedbackValue = state.feedbackValue;
            this.feedbackNode.gain.setTargetAtTime(this.feedbackValue, this.ctx.currentTime, 0.05);
            if (this.knobs['feedback']) this.knobs['feedback'].setValue(this.feedbackValue);
        }

        if (state.hpfValue !== undefined) {
            this.hpfValue = state.hpfValue;
            this.hpf.frequency.setTargetAtTime(this.getFreq(this.hpfValue), this.ctx.currentTime, 0.05);
            if (this.knobs['hpf']) this.knobs['hpf'].setValue(this.hpfValue);
        }

        if (state.lpfValue !== undefined) {
            this.lpfValue = state.lpfValue;
            this.lpf.frequency.setTargetAtTime(this.getFreq(this.lpfValue), this.ctx.currentTime, 0.05);
            if (this.knobs['lpf']) this.knobs['lpf'].setValue(this.lpfValue);
        }

        if (state.panValue !== undefined) {
            this.panValue = state.panValue;
            if (this.panner.pan) this.panner.pan.setTargetAtTime(this.panValue, this.ctx.currentTime, 0.05);
            if (this.knobs['pan']) this.knobs['pan'].setValue(this.panValue);
        }

        if (state.mixValue !== undefined) {
            this.mixValue = state.mixValue;
            this.wetNode.gain.setTargetAtTime(this.mixValue, this.ctx.currentTime, 0.05);
            if (this.knobs['mix']) this.knobs['mix'].setValue(this.mixValue);
        }

        if (state.insertEffects) {
            this.insertEffects.forEach(fx => {
                if (typeof fx.instance.destroy === 'function') fx.instance.destroy();
                if (fx.dom) fx.dom.remove();
            });
            this.insertEffects = [];

            state.insertEffects.forEach(async fxD => {
                try {
                    let scriptText = fxD.scriptText;
                    if (window.localFxCache && window.localFxCache.has(fxD.fileName)) {
                        scriptText = window.localFxCache.get(fxD.fileName);
                    }

                    const oldEffectClass = window.CustomAudioEffect;
                    window.CustomAudioEffect = null;
                    const scriptTag = document.createElement('script');
                    scriptTag.textContent = scriptText;
                    document.head.appendChild(scriptTag); 
                    const NewFXClass = window.CustomAudioEffect;
                    window.CustomAudioEffect = oldEffectClass;
                    scriptTag.remove();

                    if (NewFXClass) {
                        const newInstance = new NewFXClass(this.ctx);
                        newInstance._scriptText = scriptText;
                        newInstance._fileName = fxD.fileName;
                        if(fxD.state && typeof newInstance.setState === 'function') newInstance.setState(fxD.state);

                        const wrapper = document.createElement('div');
                        wrapper.style = "background: rgba(0,0,0,0.6); border: 1px solid rgba(0, 240, 255, 0.2); border-radius: 8px; padding: 15px; position: relative; transform: scale(0.9);";
                        
                        const removeBtn = document.createElement('button');
                        removeBtn.innerText = "X";
                        removeBtn.style = "position: absolute; top: 10px; right: 10px; background: transparent; border: 1px solid #ff003c; color: #ff003c; border-radius: 50%; width: 20px; height: 20px; font-size: 10px; cursor: pointer; z-index: 10;";
                        
                        const uiContainer = document.createElement('div');
                        if (typeof newInstance.renderUI === 'function') newInstance.renderUI(uiContainer);

                        const fxObj = { id: fxD.id || Date.now(), instance: newInstance, dom: wrapper };
                        
                        removeBtn.onclick = () => {
                            if (typeof newInstance.destroy === 'function') newInstance.destroy();
                            this.insertEffects = this.insertEffects.filter(f => f.id !== fxObj.id);
                            wrapper.remove();
                            this.reconnectInserts();
                        };

                        wrapper.appendChild(removeBtn);
                        wrapper.appendChild(uiContainer);
                        
                        if (this.uiElements.insertsList) {
                            this.uiElements.insertsList.appendChild(wrapper);
                        }

                        this.insertEffects.push(fxObj);
                        this.reconnectInserts();
                    }
                } catch (e) { console.error("Virhe ladattaessa Echo Insertiä", e); }
            });
        }
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        containerElement.style.setProperty('--accent-primary', '#00f0ff');
        containerElement.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <div style="flex:1;"></div>
                <div style="color: var(--accent-primary); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px; flex:2;">ECHO STATION</div>
                <div style="flex:1; text-align: right;">
                    <button id="delay-sync-btn" style="background: ${this.isTempoSync ? 'var(--accent-primary)' : 'rgba(0,0,0,0.5)'}; border: 1px solid var(--accent-primary); color: ${this.isTempoSync ? '#000' : 'var(--accent-primary)'}; padding: 4px 8px; border-radius: 4px; font-size: 10px; cursor: pointer; text-transform: uppercase;">Sync: ${this.isTempoSync ? 'ON' : 'OFF'}</button>
                </div>
            </div>
            <div id="knob-dashboard" style="display: flex; flex-wrap: wrap; justify-content: center; align-items: center; padding: 15px 0; gap: 20px;"></div>
            
            <div style="background: rgba(0,0,0,0.5); border: 1px dashed rgba(0, 240, 255, 0.3); border-radius: 8px; padding: 15px; text-align: center; margin-top: 15px;">
                <div style="font-size: 11px; color: #8b8b9f; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px;">Echo Insert FX Chain</div>
                <div id="delay-inserts-list" style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 10px;"></div>
                
                <div style="display:flex; justify-content:center; gap:10px; flex-wrap:wrap; align-items:center;">
                    <select id="delay-fx-select" style="background: rgba(0,240,255,0.1); color: var(--accent-primary); border: 1px solid var(--accent-primary); padding: 5px 10px; border-radius: 4px; font-family: monospace; font-size: 11px; outline: none; cursor: pointer;">
                        <option value="">-- Valitse valmis FX --</option>
                    </select>
                    <label class="btn" style="display: inline-block; padding: 8px 15px; font-size: 11px; border-color: var(--accent-primary); color: var(--accent-primary); cursor: pointer; background: transparent;">
                        + Lataa (.JS)
                        <input type="file" id="delay-fx-upload" accept=".js" style="display: none;">
                    </label>
                </div>
            </div>
        `;

        const dashboard = containerElement.querySelector('#knob-dashboard');
        const syncBtn = containerElement.querySelector('#delay-sync-btn');
        this.uiElements.syncBtn = syncBtn;

        syncBtn.addEventListener('click', () => {
            this.isTempoSync = !this.isTempoSync;
            syncBtn.innerText = "Sync: " + (this.isTempoSync ? "ON" : "OFF");
            syncBtn.style.background = this.isTempoSync ? "var(--accent-primary)" : "rgba(0,0,0,0.5)";
            syncBtn.style.color = this.isTempoSync ? "#000" : "var(--accent-primary)";
            this.updateDelayTime();
        });

        const createKnob = (label, min, max, defaultValue, formatValue, onChange) => {
            const container = document.createElement('div');
            container.style = "display: flex; flex-direction: column; align-items: center; user-select: none; width: 75px;";
            const radius = 28, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            container.innerHTML = `
                <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #8b8b9f; margin-bottom: 5px;">${label}</div>
                <div class="knob-wrapper" style="position: relative; width: 70px; height: 70px; cursor: ns-resize; margin-bottom: 8px; touch-action: none;">
                    <svg viewBox="0 0 70 70" style="width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 4px var(--accent-primary));">
                        <circle cx="35" cy="35" r="${radius}" fill="none" stroke="#2a2a3b" stroke-width="8" stroke-linecap="round" stroke-dasharray="${maxDash} ${circumference}" />
                        <circle class="knob-value-path" cx="35" cy="35" r="${radius}" fill="none" stroke="var(--accent-primary)" stroke-width="8" stroke-linecap="round" stroke-dasharray="0 ${circumference}" style="transition: stroke 0.2s;" />
                        <circle cx="35" cy="35" r="20" fill="#1a1a24" stroke="#333" stroke-width="2" />
                    </svg>
                    <div class="knob-indicator" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none;">
                        <div style="position: absolute; width: 6px; height: 6px; background: var(--accent-primary); border-radius: 50%; top: 8px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 8px var(--accent-primary);"></div>
                    </div>
                </div>
                <div class="knob-value-display" style="font-size: 12px; font-family: monospace; color: #fff; background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 4px; text-align: center; min-width: 45px;">${formatValue(defaultValue)}</div>
            `;

            const wrapper = container.querySelector('.knob-wrapper'), valuePath = container.querySelector('.knob-value-path'), indicator = container.querySelector('.knob-indicator'), display = container.querySelector('.knob-value-display');
            let currentValue = defaultValue;

            const updateUI = (value) => {
                const normalized = (value - min) / (max - min);
                valuePath.setAttribute('stroke-dasharray', `${normalized * maxDash} ${circumference}`);
                indicator.style.transform = `rotate(${-135 + (normalized * 270)}deg)`;
                display.innerText = formatValue(value);
            };
            
            if(label === 'Time') {
                this.updateTimeDisplay = (text) => display.innerText = text;
            }

            updateUI(currentValue); dashboard.appendChild(container);

            let isDragging = false, startY = 0, startValue = 0;
            const startDrag = (y) => { isDragging = true; startY = y; startValue = currentValue; document.body.style.cursor = 'ns-resize'; };
            const doDrag = (y) => {
                if (!isDragging) return;
                let newVal = startValue + (((startY - y) / 150) * (max - min));
                newVal = Math.max(min, Math.min(max, newVal));
                if (newVal !== currentValue) { currentValue = newVal; updateUI(currentValue); onChange(currentValue); }
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

        const formatHz = (val) => { const f = this.getFreq(val); return f >= 1000 ? (f/1000).toFixed(1)+'k' : Math.round(f)+' Hz'; };
        const formatPan = (val) => Math.abs(val) < 0.05 ? "C" : (val < 0 ? Math.round(Math.abs(val)*100)+" L" : Math.round(val*100)+" R");

        this.knobs['time'] = createKnob('Time', 0.01, 2.0, this.timeKnobValue, (v) => this.isTempoSync ? this.currentSyncLabel : v.toFixed(2) + ' s', (v) => { this.timeKnobValue = v; this.updateDelayTime(); });
        this.knobs['feedback'] = createKnob('Feedback', 0.0, 0.95, this.feedbackValue, (v) => Math.round(v * 100) + ' %', (v) => { this.feedbackValue = v; this.feedbackNode.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); });
        this.knobs['hpf'] = createKnob('HPF', 0.0, 1.0, this.hpfValue, (v) => formatHz(v), (v) => { this.hpfValue = v; this.hpf.frequency.setTargetAtTime(this.getFreq(v), this.ctx.currentTime, 0.05); });
        this.knobs['lpf'] = createKnob('LPF', 0.0, 1.0, this.lpfValue, (v) => formatHz(v), (v) => { this.lpfValue = v; this.lpf.frequency.setTargetAtTime(this.getFreq(v), this.ctx.currentTime, 0.05); });
        this.knobs['pan'] = createKnob('Pan', -1.0, 1.0, this.panValue, (v) => formatPan(v), (v) => { this.panValue = v; if(this.panner.pan) this.panner.pan.setTargetAtTime(v, this.ctx.currentTime, 0.05); else if(this.panner.setPosition) this.panner.setPosition(v,0,1-Math.abs(v)); });
        this.knobs['mix'] = createKnob('Mix', 0.0, 1.0, this.mixValue, (v) => Math.round(v * 100) + ' %', (v) => { this.mixValue = v; this.wetNode.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); });

        // --- Insert FX Lataus ---
        const fxUpload = containerElement.querySelector('#delay-fx-upload');
        const fxSelect = containerElement.querySelector('#delay-fx-select');
        const insertsList = containerElement.querySelector('#delay-inserts-list');
        this.uiElements.insertsList = insertsList;

        if (window.FX_PLUGINS) {
            window.FX_PLUGINS.forEach(plugin => {
                fxSelect.innerHTML += `<option value="${plugin.file}">${plugin.name}</option>`;
            });
        }

        const addInsert = (scriptText, fileName) => {
            try {
                const oldEffectClass = window.CustomAudioEffect;
                window.CustomAudioEffect = null;
                const scriptTag = document.createElement('script');
                scriptTag.textContent = scriptText;
                document.head.appendChild(scriptTag); 
                const NewFXClass = window.CustomAudioEffect;
                window.CustomAudioEffect = oldEffectClass;
                scriptTag.remove();

                if (NewFXClass) {
                    const newInstance = new NewFXClass(this.ctx);
                    newInstance._scriptText = scriptText;
                    newInstance._fileName = fileName;
                    const fxId = Date.now();
                    
                    const wrapper = document.createElement('div');
                    wrapper.style = "background: rgba(0,0,0,0.6); border: 1px solid rgba(0, 240, 255, 0.2); border-radius: 8px; padding: 15px; position: relative; transform: scale(0.9);";
                    
                    const removeBtn = document.createElement('button');
                    removeBtn.innerText = "X";
                    removeBtn.style = "position: absolute; top: 10px; right: 10px; background: transparent; border: 1px solid #ff003c; color: #ff003c; border-radius: 50%; width: 20px; height: 20px; font-size: 10px; cursor: pointer; z-index: 10;";
                    
                    const uiContainer = document.createElement('div');
                    if(typeof newInstance.renderUI === 'function') newInstance.renderUI(uiContainer);

                    removeBtn.onclick = () => {
                        if (typeof newInstance.destroy === 'function') newInstance.destroy();
                        this.insertEffects = this.insertEffects.filter(f => f.id !== fxId);
                        wrapper.remove();
                        this.reconnectInserts();
                    };

                    wrapper.appendChild(removeBtn);
                    wrapper.appendChild(uiContainer);
                    insertsList.appendChild(wrapper);

                    this.insertEffects.push({ id: fxId, instance: newInstance, dom: wrapper });
                    this.reconnectInserts();
                }
            } catch (err) {
                alert("Virhe Insert-efektissä: " + err.message);
            }
        };

        fxUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => addInsert(event.target.result, file.name);
            reader.readAsText(file);
            e.target.value = ''; 
        });

        fxSelect.addEventListener('change', async (e) => {
            const fileName = e.target.value;
            if (!fileName) return;
            try {
                let scriptText;
                if (window.localFxCache && window.localFxCache.has(fileName)) {
                    scriptText = window.localFxCache.get(fileName);
                } else {
                    const response = await fetch('fx/' + fileName);
                    if (!response.ok) throw new Error("Tiedostoa ei löytynyt");
                    scriptText = await response.text();
                }
                addInsert(scriptText, fileName);
            } catch (err) { alert("Virhe ladattaessa efektiä: " + err.message); }
            e.target.value = '';
        });

        // Renderöi olemassa olevat insertit (jos ui rendataan uudelleen esim modaalissa)
        this.insertEffects.forEach(fx => {
            if (fx.dom && !insertsList.contains(fx.dom)) insertsList.appendChild(fx.dom);
        });
    }
}