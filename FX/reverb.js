// reverb.js
window.CustomAudioEffect = class ReverbEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.dry = audioCtx.createGain();
        this.wet = audioCtx.createGain();
        this.convolver = audioCtx.createConvolver();
        this.tailOutput = audioCtx.createGain(); 

        this.splitter = audioCtx.createChannelSplitter(2);
        this.merger = audioCtx.createChannelMerger(2);
        this.gainLL = audioCtx.createGain();
        this.gainLR = audioCtx.createGain();
        this.gainRL = audioCtx.createGain();
        this.gainRR = audioCtx.createGain();

        // UUSI: Mahdollistaa useamman Insert-efektin peräkkäin
        this.insertEffects = [];
        this.insertInput = audioCtx.createGain();
        this.insertOutput = audioCtx.createGain();

        this.timeValue = 2.0; 
        this.widthValue = 1.0;
        this.mixValue = 0.4;

        // UI-referenssit
        this.knobs = {};
        this.uiElements = {};

        this.generateImpulseResponse();
        this.updateWidth();
        this.updateMix();

        // Reititys (Alkuperäinen)
        this.input.connect(this.dry);
        this.dry.connect(this.output);
        this.input.connect(this.convolver);
        this.convolver.connect(this.tailOutput);

        // Reititys (Insert FX -ketju)
        this.tailOutput.connect(this.insertInput);
        this.insertInput.connect(this.insertOutput); // Oletuksena suora läpivienti
        this.insertOutput.connect(this.splitter);

        this.splitter.connect(this.gainLL, 0); 
        this.splitter.connect(this.gainLR, 0); 
        this.splitter.connect(this.gainRL, 1); 
        this.splitter.connect(this.gainRR, 1); 

        this.gainLL.connect(this.merger, 0, 0);
        this.gainLR.connect(this.merger, 0, 1);
        this.gainRL.connect(this.merger, 0, 0);
        this.gainRR.connect(this.merger, 0, 1);

        this.merger.connect(this.wet);
        this.wet.connect(this.output);
    }

    reconnectInserts() {
        // Irrotetaan kaikki
        try { this.insertInput.disconnect(); } catch(e){}
        this.insertEffects.forEach(fx => {
            try { fx.instance.getNodes().output.disconnect(); } catch(e){}
        });

        // Rakennetaan ketju uudelleen
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

    generateImpulseResponse() {
        const sampleRate = this.ctx.sampleRate;
        const length = sampleRate * this.timeValue;
        const impulse = this.ctx.createBuffer(2, length, sampleRate);
        const left = impulse.getChannelData(0), right = impulse.getChannelData(1);

        for (let i = 0; i < length; i++) {
            const fadeIn = Math.min(i / (sampleRate * 0.01), 1.0); 
            const decay = Math.exp(-i / (sampleRate * (this.timeValue / 4))); 
            left[i] = (Math.random() * 2 - 1) * decay * fadeIn;
            right[i] = (Math.random() * 2 - 1) * decay * fadeIn;
        }
        this.convolver.buffer = impulse;
    }

    updateWidth() {
        const direct = 0.5 + (this.widthValue / 2), cross = 0.5 - (this.widthValue / 2);
        this.gainLL.gain.setTargetAtTime(direct, this.ctx.currentTime, 0.05);
        this.gainRR.gain.setTargetAtTime(direct, this.ctx.currentTime, 0.05);
        this.gainLR.gain.setTargetAtTime(cross, this.ctx.currentTime, 0.05);
        this.gainRL.gain.setTargetAtTime(cross, this.ctx.currentTime, 0.05);
    }

    updateMix() {
        const dryGain = Math.cos(this.mixValue * 0.5 * Math.PI), wetGain = Math.sin(this.mixValue * 0.5 * Math.PI);
        this.dry.gain.setTargetAtTime(dryGain, this.ctx.currentTime, 0.05);
        this.wet.gain.setTargetAtTime(wetGain, this.ctx.currentTime, 0.05);
    }

    getNodes() { return { input: this.input, output: this.output }; }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            timeValue: this.timeValue,
            widthValue: this.widthValue,
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

        if (state.timeValue !== undefined && state.timeValue !== this.timeValue) {
            this.timeValue = state.timeValue;
            this.generateImpulseResponse();
            if (this.knobs['Time']) this.knobs['Time'].setValue(this.timeValue);
        }

        if (state.widthValue !== undefined) {
            this.widthValue = state.widthValue;
            this.updateWidth();
            if (this.knobs['Width']) this.knobs['Width'].setValue(this.widthValue);
        }

        if (state.mixValue !== undefined) {
            this.mixValue = state.mixValue;
            this.updateMix();
            if (this.knobs['Mix']) this.knobs['Mix'].setValue(this.mixValue);
        }

        if (state.insertEffects) {
            // Tyhjennä vanhat insertit
            this.insertEffects.forEach(fx => {
                if (typeof fx.instance.destroy === 'function') fx.instance.destroy();
                if (fx.dom) fx.dom.remove();
            });
            this.insertEffects = [];

            // Lataa tallennetut insertit
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
                        wrapper.style = "background: rgba(0,0,0,0.6); border: 1px solid rgba(136, 204, 255, 0.2); border-radius: 8px; padding: 15px; position: relative; transform: scale(0.9);";
                        
                        const removeBtn = document.createElement('button');
                        removeBtn.innerText = "X";
                        removeBtn.style = "position: absolute; top: 10px; right: 10px; background: transparent; border: 1px solid #ff003c; color: #ff003c; border-radius: 50%; width: 20px; height: 20px; font-size: 10px; cursor: pointer; z-index: 10;";
                        
                        const uiContainer = document.createElement('div');
                        if(typeof newInstance.renderUI === 'function') newInstance.renderUI(uiContainer);

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
                } catch (e) { console.error("Virhe ladattaessa Reverb Insertiä", e); }
            });
        }
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        containerElement.style.setProperty('--fx-color', '#88ccff');
        containerElement.innerHTML = `
            <div style="margin-bottom: 10px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">STUDIO REVERB</div>
            <div class="fx-dashboard" id="reverb-dashboard" style="display: flex; justify-content: center; gap: 20px; flex-wrap: wrap; margin-bottom: 15px;"></div>
            
            <div style="background: rgba(0,0,0,0.5); border: 1px dashed rgba(136, 204, 255, 0.3); border-radius: 8px; padding: 15px; text-align: center; position: relative;">
                <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px;">Tail Insert FX Chain</div>
                
                <div id="reverb-inserts-list" style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 10px;"></div>

                <div style="display:flex; justify-content:center; gap:10px; flex-wrap:wrap; align-items:center;">
                    <select id="reverb-fx-select" style="background: rgba(136,204,255,0.1); color: var(--fx-color); border: 1px solid var(--fx-color); padding: 5px 10px; border-radius: 4px; font-family: monospace; font-size: 11px; outline: none; cursor: pointer;">
                        <option value="">-- Valitse valmis FX --</option>
                    </select>
                    <label class="btn" style="display: inline-flex; padding: 6px 12px; font-size: 11px; border-color: var(--fx-color); color: var(--fx-color); cursor: pointer; background: transparent;">
                        + Lataa (.JS)
                        <input type="file" id="reverb-fx-upload" accept=".js" style="display: none;">
                    </label>
                </div>
            </div>
        `;

        const dashboard = containerElement.querySelector('#reverb-dashboard');

        const createKnob = (label, min, max, defaultValue, formatValue, onChange) => {
            const container = document.createElement('div');
            container.style = "display: flex; flex-direction: column; align-items: center; user-select: none; width: 70px;";
            const radius = 25, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            container.innerHTML = `
                <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #8b8b9f; margin-bottom: 5px;">${label}</div>
                <div class="knob-wrapper" style="position: relative; width: 60px; height: 60px; cursor: ns-resize; margin-bottom: 8px; touch-action: none;">
                    <svg viewBox="0 0 60 60" style="width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 4px var(--fx-color));">
                        <circle cx="30" cy="30" r="${radius}" fill="none" stroke="#2a2a3b" stroke-width="6" stroke-linecap="round" stroke-dasharray="${maxDash} ${circumference}" />
                        <circle class="knob-value-path" cx="30" cy="30" r="${radius}" fill="none" stroke="var(--fx-color)" stroke-width="6" stroke-linecap="round" stroke-dasharray="0 ${circumference}" style="transition: stroke 0.2s;" />
                        <circle cx="30" cy="30" r="16" fill="#1a1a24" stroke="#333" stroke-width="2" />
                    </svg>
                    <div class="knob-indicator" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none;">
                        <div style="position: absolute; width: 6px; height: 6px; background: var(--fx-color); border-radius: 50%; top: 6px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 6px var(--fx-color);"></div>
                    </div>
                </div>
                <div class="knob-value-display" style="font-size: 11px; font-family: monospace; color: #fff; background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 4px; min-width: 40px; text-align: center;">${formatValue(defaultValue)}</div>
            `;
            const wrapper = container.querySelector('.knob-wrapper'), valuePath = container.querySelector('.knob-value-path'), indicator = container.querySelector('.knob-indicator'), display = container.querySelector('.knob-value-display');
            let currentValue = defaultValue;

            const updateUI = (value) => {
                const normalized = (value - min) / (max - min);
                valuePath.setAttribute('stroke-dasharray', `${normalized * maxDash} ${circumference}`);
                indicator.style.transform = `rotate(${-135 + (normalized * 270)}deg)`;
                display.innerText = formatValue(value);
            };
            updateUI(currentValue); dashboard.appendChild(container);

            let isDragging = false, startY = 0, startValue = 0;
            const startDrag = (y) => { isDragging = true; startY = y; startValue = currentValue; document.body.style.cursor = 'ns-resize'; };
            const doDrag = (y) => {
                if (!isDragging) return;
                let newVal = startValue + (((startY - y) / 120) * (max - min));
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

        this.knobs['Time'] = createKnob('Time', 0.1, 10.0, this.timeValue, (v) => v.toFixed(1) + ' s', (v) => { this.timeValue = v; this.generateImpulseResponse(); });
        this.knobs['Width'] = createKnob('Width', 0.0, 1.0, this.widthValue, (v) => Math.round(v * 100) + ' %', (v) => { this.widthValue = v; this.updateWidth(); });
        this.knobs['Mix'] = createKnob('Mix', 0.0, 1.0, this.mixValue, (v) => Math.round(v * 100) + ' %', (v) => { this.mixValue = v; this.updateMix(); });

        // --- Insert FX Lataus ---
        const fxUpload = containerElement.querySelector('#reverb-fx-upload');
        const insertsList = containerElement.querySelector('#reverb-inserts-list');
        const fxSelect = containerElement.querySelector('#reverb-fx-select');
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
                    wrapper.style = "background: rgba(0,0,0,0.6); border: 1px solid rgba(136, 204, 255, 0.2); border-radius: 8px; padding: 15px; position: relative; transform: scale(0.9);";
                    
                    const removeBtn = document.createElement('button');
                    removeBtn.innerText = "X";
                    removeBtn.style = "position: absolute; top: 10px; right: 10px; background: transparent; border: 1px solid #ff003c; color: #ff003c; border-radius: 50%; width: 20px; height: 20px; font-size: 10px; cursor: pointer; z-index: 10;";
                    
                    const uiContainer = document.createElement('div');
                    if (typeof newInstance.renderUI === 'function') newInstance.renderUI(uiContainer);

                    const fxObj = { id: fxId, instance: newInstance, dom: wrapper };
                    
                    removeBtn.onclick = () => {
                        if (typeof newInstance.destroy === 'function') newInstance.destroy();
                        this.insertEffects = this.insertEffects.filter(f => f.id !== fxId);
                        wrapper.remove();
                        this.reconnectInserts();
                    };

                    wrapper.appendChild(removeBtn);
                    wrapper.appendChild(uiContainer);
                    insertsList.appendChild(wrapper);

                    this.insertEffects.push(fxObj);
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
        
        // Renderöi olemassa olevat insertit jos ui rendataan uudelleen (esim modal kiinni ja auki)
        this.insertEffects.forEach(fx => {
            if (fx.dom && !insertsList.contains(fx.dom)) {
                insertsList.appendChild(fx.dom);
            }
        });
    }
}