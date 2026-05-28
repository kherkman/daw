// room.js
// EDISTYNYT HUONEAKUSTIIKAN SIMULAATTORI - KORJATTU VERSIO
// Toimii ilman palvelinta, kaikki reititykset ja gainit korjattu

window.CustomAudioEffect = class RoomSimulator {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        
        // Pääreititys
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        
        // === SUORA ÄÄNI ===
        this.directDelay = audioCtx.createDelay(0.05);
        this.directAttenuation = audioCtx.createGain();
        this.directFilter = audioCtx.createBiquadFilter();
        this.directFilter.type = 'lowpass';
        this.directGain = audioCtx.createGain();
        
        // === MÄRKÄ REITTI ===
        this.wetGain = audioCtx.createGain();
        
        // === ILMAVAIMENNUS ===
        this.airAbsorptionLpf = audioCtx.createBiquadFilter();
        this.airAbsorptionLpf.type = 'lowpass';
        this.airAbsorptionHpf = audioCtx.createBiquadFilter();
        this.airAbsorptionHpf.type = 'highpass';
        
        // Marraskenen reitti (kuiva signaali märän rinnalle)
        this.dryGain = audioCtx.createGain();
        
        // === VARHAISET HEIJASTUKSET ===
        this.earlyReflections = [];
        
        // === JÄLKIKAIUNTA ===
        this.reverbDelay = audioCtx.createDelay(0.5);
        this.reverbFeedback = audioCtx.createGain();
        this.reverbMix = audioCtx.createGain();
        
        // === MODULAATIO ===
        this.modLFO = null;
        this.modGain = audioCtx.createGain();
        
        // === KONVOLUUTIO ===
        this.convolver = audioCtx.createConvolver();
        this.convolverGain = audioCtx.createGain();
        this.useConvolver = false;
        
        // === SEINÄMATERIAALIT ===
        this.wallMaterials = {
            'drywall':   { name: 'Drywall', absorption: 0.30, diffusion: 0.30 },
            'concrete':  { name: 'Concrete', absorption: 0.15, diffusion: 0.10 },
            'wood':      { name: 'Wood', absorption: 0.25, diffusion: 0.50 },
            'carpet':    { name: 'Carpet', absorption: 0.45, diffusion: 0.60 },
            'glass':     { name: 'Glass', absorption: 0.08, diffusion: 0.20 },
            'curtain':   { name: 'Curtain', absorption: 0.60, diffusion: 0.80 },
            'brick':     { name: 'Brick', absorption: 0.25, diffusion: 0.25 },
            'marble':    { name: 'Marble', absorption: 0.10, diffusion: 0.15 }
        };
        this.currentWallMaterial = 'concrete';
        
        // === PARAMETRIT ===
        this.roomType = 'studio';
        this.wetLevel = 35;
        this.roomSize = 50;
        this.decayTime = 1.5;
        this.diffusion = 0.5;
        this.modulationAmount = 0.001;
        this.earlyReflectionLevel = 0.4;
        
        // UI-elementit
        this.uiElements = {};
        this.knobs = {};
        
        // === KRIITTINEN: REITITYKSET (KORJATTU) ===
        this.setupRouting();
        
        // Alusta komponentit
        this.initEarlyReflections();
        this.initReverb();
        this.initModulation();
        
        // Oletusasetukset ja varmista että ääni kulkee
        this.applyRoomSettings();
        
        // Varmista että kuiva signaali kuuluu oletuksena
        this.dryGain.gain.value = 1.0;
        this.wetGain.gain.value = 0.3;
    }
    
    setupRouting() {
        // Kuiva reitti (suora ääni ilman efektejä)
        this.input.connect(this.dryGain);
        this.dryGain.connect(this.output);
        
        // Märkä reitti ilmavaimennuksen kautta
        this.input.connect(this.airAbsorptionLpf);
        this.airAbsorptionLpf.connect(this.airAbsorptionHpf);
        
        // Varhaiset heijastukset
        for (const er of this.earlyReflections) {
            this.airAbsorptionHpf.connect(er.delay);
            er.delay.connect(er.gain);
            er.gain.connect(this.wetGain);
        }
        
        // Jälkikaiunta (yksinkertainen mutta toimiva)
        this.airAbsorptionHpf.connect(this.reverbDelay);
        this.reverbDelay.connect(this.reverbFeedback);
        this.reverbFeedback.connect(this.reverbDelay);
        this.reverbDelay.connect(this.reverbMix);
        this.reverbMix.connect(this.wetGain);
        
        // Konvoluutio (rinnan)
        this.airAbsorptionHpf.connect(this.convolver);
        this.convolver.connect(this.convolverGain);
        this.convolverGain.connect(this.wetGain);
        
        // Märkä gain outputiin
        this.wetGain.connect(this.output);
        
        // Aseta oletusarvot
        this.dryGain.gain.value = 0.7;
        this.wetGain.gain.value = 0.3;
        this.convolverGain.gain.value = 0;
        this.reverbMix.gain.value = 0.8;
    }
    
    initEarlyReflections() {
        // Yksinkertaiset mutta tehokkaat varhaiset heijastukset
        const delays = [0.008, 0.015, 0.022, 0.030, 0.040, 0.052, 0.065];
        const gains = [0.35, 0.28, 0.22, 0.17, 0.13, 0.09, 0.06];
        
        for (let i = 0; i < delays.length; i++) {
            const delay = this.ctx.createDelay(0.1);
            const gain = this.ctx.createGain();
            const panner = this.ctx.createStereoPanner();
            
            delay.delayTime.value = delays[i];
            gain.gain.value = gains[i] * this.earlyReflectionLevel;
            
            // Panorointi - vuorotellen vasen/oikea
            panner.pan.value = i % 2 === 0 ? -0.5 + (i * 0.1) : 0.5 - (i * 0.1);
            
            this.earlyReflections.push({ delay, gain, panner, baseGain: gains[i], baseDelay: delays[i] });
            
            // Reititys: delay -> gain -> panner -> wetGain
            delay.connect(gain);
            gain.connect(panner);
            panner.connect(this.wetGain);
        }
    }
    
    initReverb() {
        // Yksinkertainen mutta toimiva kaiunta
        this.reverbDelay.delayTime.value = 0.05;
        this.reverbFeedback.gain.value = 0.5;
    }
    
    initModulation() {
        try {
            this.modLFO = this.ctx.createOscillator();
            this.modLFO.type = 'sine';
            this.modLFO.frequency.value = 0.25;
            
            this.modGain.gain.value = this.modulationAmount;
            
            this.modLFO.connect(this.modGain);
            this.modGain.connect(this.reverbDelay.delayTime);
            this.modLFO.start();
        } catch(e) {
            console.warn("Modulation not supported:", e);
        }
    }
    
    getRoomPresets() {
        return {
            'studio': {
                name: 'Studio',
                decayMs: 800,
                dampingFreq: 8000,
                lowCutFreq: 60,
                earlyBoost: 0.25,
                wetLevel: 30,
                roomSize: 50,
                decayTime: 1.5,
                diffusion: 0.4,
                modulation: 0.001,
                material: 'drywall'
            },
            'room': {
                name: 'Living Room',
                decayMs: 600,
                dampingFreq: 10000,
                lowCutFreq: 100,
                earlyBoost: 0.35,
                wetLevel: 35,
                roomSize: 40,
                decayTime: 1.2,
                diffusion: 0.5,
                modulation: 0.002,
                material: 'carpet'
            },
            'chamber': {
                name: 'Chamber',
                decayMs: 1200,
                dampingFreq: 6000,
                lowCutFreq: 80,
                earlyBoost: 0.30,
                wetLevel: 40,
                roomSize: 60,
                decayTime: 1.8,
                diffusion: 0.55,
                modulation: 0.0015,
                material: 'wood'
            },
            'hall': {
                name: 'Concert Hall',
                decayMs: 2500,
                dampingFreq: 4500,
                lowCutFreq: 50,
                earlyBoost: 0.20,
                wetLevel: 45,
                roomSize: 75,
                decayTime: 2.5,
                diffusion: 0.70,
                modulation: 0.0025,
                material: 'wood'
            },
            'church': {
                name: 'Church',
                decayMs: 4000,
                dampingFreq: 3500,
                lowCutFreq: 40,
                earlyBoost: 0.15,
                wetLevel: 50,
                roomSize: 85,
                decayTime: 3.5,
                diffusion: 0.80,
                modulation: 0.003,
                material: 'brick'
            },
            'cathedral': {
                name: 'Cathedral',
                decayMs: 6000,
                dampingFreq: 2800,
                lowCutFreq: 30,
                earlyBoost: 0.12,
                wetLevel: 55,
                roomSize: 95,
                decayTime: 4.5,
                diffusion: 0.85,
                modulation: 0.0035,
                material: 'marble'
            },
            'plate': {
                name: 'Plate Reverb',
                decayMs: 2000,
                dampingFreq: 7000,
                lowCutFreq: 100,
                earlyBoost: 0.28,
                wetLevel: 40,
                roomSize: 50,
                decayTime: 2.0,
                diffusion: 0.45,
                modulation: 0.008,
                material: 'glass'
            }
        };
    }
    
    applyPreset(presetId) {
        const presets = this.getRoomPresets();
        const preset = presets[presetId];
        if (!preset) return;
        
        this.roomType = presetId;
        
        // Päivitä arvot
        this.wetLevel = preset.wetLevel;
        this.roomSize = preset.roomSize;
        this.decayTime = preset.decayTime;
        this.diffusion = preset.diffusion;
        this.modulationAmount = preset.modulation;
        this.currentWallMaterial = preset.material;
        
        // Päivitä UI
        if (this.knobs['Wet']) this.knobs['Wet'].updateValue(preset.wetLevel);
        if (this.knobs['Size']) this.knobs['Size'].updateValue(preset.roomSize);
        if (this.knobs['Decay']) this.knobs['Decay'].updateValue(preset.decayTime);
        if (this.knobs['Diffusion']) this.knobs['Diffusion'].updateValue(preset.diffusion * 100);
        if (this.knobs['Modulation']) this.knobs['Modulation'].updateValue(preset.modulation * 1000);
        if (this.uiElements.materialSelect) this.uiElements.materialSelect.value = preset.material;
        if (this.uiElements.presetSelect) this.uiElements.presetSelect.value = presetId;
        
        // Päivitä audio
        this.applyRoomSettingsFromPreset(preset);
    }
    
    applyRoomSettingsFromPreset(preset) {
        const time = this.ctx.currentTime;
        
        const sizeFactor = this.roomSize / 50;
        const decayMs = preset.decayMs * Math.pow(sizeFactor, 1.2);
        const finalDecay = decayMs * (this.decayTime / 1.5);
        
        // Laske feedback (kuinka kauan kaiunta kestää)
        let feedback = Math.pow(0.001, 30 / finalDecay);
        feedback = Math.min(0.92, Math.max(0.3, feedback));
        
        // Säädä viiveaika huoneen koon mukaan
        const delayTime = 0.02 + (this.roomSize / 100) * 0.06;
        this.reverbDelay.delayTime.setTargetAtTime(delayTime, time, 0.05);
        this.reverbFeedback.gain.setTargetAtTime(feedback, time, 0.05);
        
        // Säädä varhaisten heijastusten tasoa ja viiveitä
        for (let i = 0; i < this.earlyReflections.length; i++) {
            const newGain = this.earlyReflections[i].baseGain * preset.earlyBoost * (1 + this.roomSize / 200) * this.earlyReflectionLevel;
            const newDelay = Math.min(0.08, this.earlyReflections[i].baseDelay * sizeFactor);
            
            this.earlyReflections[i].gain.gain.setTargetAtTime(Math.min(0.5, newGain), time, 0.05);
            this.earlyReflections[i].delay.delayTime.setTargetAtTime(newDelay, time, 0.05);
        }
        
        // Säädä taajuusvaimennusta
        const dampingFreq = preset.dampingFreq * (1 + this.roomSize / 200);
        this.airAbsorptionLpf.frequency.setTargetAtTime(Math.min(20000, dampingFreq), time, 0.1);
        this.airAbsorptionLpf.Q.value = 0.7;
        
        const lowCutFreq = preset.lowCutFreq / (1 + this.roomSize / 300);
        this.airAbsorptionHpf.frequency.setTargetAtTime(Math.max(20, lowCutFreq), time, 0.1);
        this.airAbsorptionHpf.Q.value = 0.7;
        
        // Seinämateriaalin vaikutus
        const material = this.wallMaterials[this.currentWallMaterial];
        if (material) {
            // Materiaali vaikuttaa feedbackiin ja diffuusioon
            const materialFactor = 1 - material.absorption;
            this.reverbFeedback.gain.setTargetAtTime(feedback * materialFactor, time, 0.05);
        }
        
        // Modulaation määrä
        if (this.modGain) {
            this.modGain.gain.setTargetAtTime(this.modulationAmount, time, 0.05);
        }
        
        // Märkä/kuiva -suhde
        this.updateWetLevel();
    }
    
    setWallMaterial(materialId) {
        this.currentWallMaterial = materialId;
        this.applyRoomSettings();
    }
    
    applyRoomSettings() {
        const presets = this.getRoomPresets();
        const preset = presets[this.roomType];
        if (preset) {
            this.applyRoomSettingsFromPreset(preset);
        }
    }
    
    updateWetLevel() {
        const time = this.ctx.currentTime;
        const wetNormalized = Math.min(0.85, this.wetLevel / 100);
        
        // Kuiva signaali (100% - märkä)
        this.dryGain.gain.setTargetAtTime(1 - wetNormalized * 0.6, time, 0.05);
        // Märkä signaali
        this.wetGain.gain.setTargetAtTime(wetNormalized, time, 0.05);
    }
    
    updateDecayTime() { this.applyRoomSettings(); }
    updateRoomSize() { this.applyRoomSettings(); }
    updateDiffusion() { this.applyRoomSettings(); }
    
    setWetLevel(value) { this.wetLevel = value; this.updateWetLevel(); }
    setRoomSize(value) { this.roomSize = value; this.updateRoomSize(); }
    setDecayTime(value) { this.decayTime = value; this.updateDecayTime(); }
    setDiffusion(value) { this.diffusion = value / 100; this.updateDiffusion(); }
    setModulation(value) { this.modulationAmount = value / 1000; if (this.modGain) this.modGain.gain.value = this.modulationAmount; }
    setEarlyLevel(value) { this.earlyReflectionLevel = value / 100; this.applyRoomSettings(); }
    
    setUseConvolver(use) {
        this.useConvolver = use;
        this.convolverGain.gain.value = use ? 0.7 : 0;
        this.reverbMix.gain.value = use ? 0.3 : 0.8;
    }
    
    async loadImpulseResponse(file) {
        try {
            const arrayBuffer = await file.arrayBuffer();
            const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
            this.convolver.buffer = audioBuffer;
            this.setUseConvolver(true);
            if (this.uiElements.useConvolverCheckbox) this.uiElements.useConvolverCheckbox.checked = true;
            return true;
        } catch (error) {
            console.error('Failed to load IR:', error);
            return false;
        }
    }
    
    getNodes() { 
        return { input: this.input, output: this.output }; 
    }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            roomType: this.roomType,
            wetLevel: this.wetLevel,
            roomSize: this.roomSize,
            decayTime: this.decayTime,
            diffusion: this.diffusion,
            modulationAmount: this.modulationAmount,
            earlyReflectionLevel: this.earlyReflectionLevel,
            currentWallMaterial: this.currentWallMaterial,
            useConvolver: this.useConvolver
        };
    }

    setState(state) {
        if (!state) return;

        if (state.useConvolver !== undefined) {
            this.setUseConvolver(state.useConvolver);
            if (this.uiElements.useConvolverCheckbox) this.uiElements.useConvolverCheckbox.checked = state.useConvolver;
        }

        if (state.roomType !== undefined) {
            this.roomType = state.roomType;
            if (this.uiElements.presetSelect) this.uiElements.presetSelect.value = this.roomType;
        }

        if (state.currentWallMaterial !== undefined) {
            this.currentWallMaterial = state.currentWallMaterial;
            if (this.uiElements.materialSelect) this.uiElements.materialSelect.value = this.currentWallMaterial;
        }

        if (state.wetLevel !== undefined) { this.wetLevel = state.wetLevel; if (this.knobs['Wet']) this.knobs['Wet'].updateValue(this.wetLevel); }
        if (state.roomSize !== undefined) { this.roomSize = state.roomSize; if (this.knobs['Size']) this.knobs['Size'].updateValue(this.roomSize); }
        if (state.decayTime !== undefined) { this.decayTime = state.decayTime; if (this.knobs['Decay']) this.knobs['Decay'].updateValue(this.decayTime); }
        if (state.diffusion !== undefined) { this.diffusion = state.diffusion; if (this.knobs['Diffusion']) this.knobs['Diffusion'].updateValue(this.diffusion * 100); }
        if (state.modulationAmount !== undefined) { this.modulationAmount = state.modulationAmount; if (this.knobs['Modulation']) this.knobs['Modulation'].updateValue(this.modulationAmount * 1000); }
        if (state.earlyReflectionLevel !== undefined) { this.earlyReflectionLevel = state.earlyReflectionLevel; if (this.knobs['Early']) this.knobs['Early'].updateValue(this.earlyReflectionLevel * 100); }

        this.applyRoomSettings();
    }
    
    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#6cc0ff';
        containerElement.style.setProperty('--fx-color', color);
        
        const styleId = 'fx-room-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .room-panel { background: rgba(0,0,0,0.6); border: 1px solid rgba(108, 192, 255, 0.3); border-radius: 12px; padding: 20px; margin-bottom: 15px; }
                .room-select, .room-select-material { background: #0a0a14; color: var(--fx-color); border: 1px solid var(--fx-color); padding: 8px 15px; border-radius: 6px; font-family: monospace; font-size: 13px; outline: none; cursor: pointer; text-transform: uppercase; font-weight: bold; }
                .room-select { width: 100%; max-width: 200px; margin-bottom: 10px; }
                .knob-container { display: inline-flex; flex-direction: column; align-items: center; user-select: none; width: 85px; margin: 0 5px 15px; }
                .knob-wrapper { position: relative; width: 65px; height: 65px; cursor: ns-resize; margin-bottom: 6px; touch-action: none; }
                .knob-svg { width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 3px rgba(255,255,255,0.2)); }
                .knob-track { fill: none; stroke: #2a2a3b; stroke-width: 6; stroke-linecap: round; }
                .knob-value-path { fill: none; stroke: var(--fx-color); stroke-width: 6; stroke-linecap: round; transition: stroke 0.2s; }
                .knob-wrapper:active .knob-value-path, .knob-wrapper:hover .knob-value-path { stroke: #fff; filter: drop-shadow(0 0 6px var(--fx-color)); }
                .knob-center { fill: #1a1a24; stroke: #333; stroke-width: 2; }
                .knob-indicator { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
                .knob-dot { position: absolute; width: 5px; height: 5px; background: var(--fx-color); border-radius: 50%; top: 6px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 6px var(--fx-color); }
                .knob-label { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #8b8b9f; margin-bottom: 4px; text-align: center; }
                .knob-value-display { font-size: 11px; font-family: monospace; color: #fff; background: rgba(0,0,0,0.6); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); text-align: center; min-width: 40px; }
                .room-grid { display: flex; flex-wrap: wrap; justify-content: center; gap: 5px; margin-top: 15px; margin-bottom: 15px; }
                .material-row { display: flex; gap: 10px; align-items: center; justify-content: center; margin: 15px 0; flex-wrap: wrap; }
                .ir-controls { display: flex; gap: 10px; align-items: center; justify-content: center; margin-top: 15px; padding-top: 15px; border-top: 1px solid rgba(108,192,255,0.2); }
                .ir-label { font-size: 11px; color: #8b8b9f; cursor: pointer; padding: 6px 12px; background: rgba(108,192,255,0.1); border-radius: 6px; border: 1px solid rgba(108,192,255,0.3); }
                .ir-label:hover { background: rgba(108,192,255,0.2); }
                .checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #8b8b9f; cursor: pointer; }
                .advanced-header { cursor: pointer; padding: 8px; text-align: center; color: var(--fx-color); font-size: 11px; text-transform: uppercase; letter-spacing: 2px; border-top: 1px solid rgba(108,192,255,0.2); margin-top: 10px; }
                .advanced-content { display: none; padding-top: 10px; }
                .advanced-content.open { display: block; }
            `;
            document.head.appendChild(style);
        }
        
        containerElement.innerHTML = `
            <div style="margin-bottom: 15px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 13px;">🎧 ADVANCED ROOM SIMULATOR</div>
            
            <div class="room-panel">
                <label style="display: block; font-size: 10px; color: #8b8b9f; text-transform: uppercase; margin-bottom: 8px;">Room Type</label>
                <select id="room-preset" class="room-select">
                    <option value="studio">🎛️ Studio</option>
                    <option value="room">🏠 Living Room</option>
                    <option value="chamber">🎵 Chamber</option>
                    <option value="hall">🏛️ Concert Hall</option>
                    <option value="church">⛪ Church</option>
                    <option value="cathedral">🕍 Cathedral</option>
                    <option value="plate">🥏 Plate Reverb</option>
                </select>
                
                <div class="room-grid">
                    <div id="wet-knob"></div>
                    <div id="size-knob"></div>
                    <div id="decay-knob"></div>
                    <div id="diffusion-knob"></div>
                </div>
                
                <div class="material-row">
                    <label style="font-size: 10px; color: #8b8b9f;">Wall Material:</label>
                    <select id="material-select" class="room-select-material">
                        ${Object.entries(this.wallMaterials).map(([id, m]) => 
                            `<option value="${id}">${m.name}</option>`
                        ).join('')}
                    </select>
                </div>
                
                <div class="advanced-header" id="advanced-toggle">🔧 Advanced Controls ▼</div>
                <div class="advanced-content" id="advanced-content">
                    <div class="room-grid">
                        <div id="modulation-knob"></div>
                        <div id="early-level-knob"></div>
                    </div>
                    
                    <div class="ir-controls">
                        <label class="checkbox-label">
                            <input type="checkbox" id="use-convolver" ${this.useConvolver ? 'checked' : ''}> Use Convolution (IR)
                        </label>
                        <label class="ir-label" id="ir-upload-label">
                            📁 Load IR File
                            <input type="file" id="ir-file" accept="audio/wav,audio/mp3,audio/ogg" style="display:none;">
                        </label>
                    </div>
                    <div style="font-size: 10px; color: #6c6c8f; text-align: center; margin-top: 10px;">
                        💡 Tip: Load real impulse responses for authentic spaces
                    </div>
                </div>
            </div>
        `;
        
        this.uiElements.presetSelect = containerElement.querySelector('#room-preset');
        this.uiElements.materialSelect = containerElement.querySelector('#material-select');
        this.uiElements.useConvolverCheckbox = containerElement.querySelector('#use-convolver');
        this.uiElements.irFileInput = containerElement.querySelector('#ir-file');
        
        const wetContainer = containerElement.querySelector('#wet-knob');
        const sizeContainer = containerElement.querySelector('#size-knob');
        const decayContainer = containerElement.querySelector('#decay-knob');
        const diffusionContainer = containerElement.querySelector('#diffusion-knob');
        const modulationContainer = containerElement.querySelector('#modulation-knob');
        const earlyLevelContainer = containerElement.querySelector('#early-level-knob');
        
        const createKnob = (container, label, min, max, defaultValue, formatValue, setter) => {
            const div = document.createElement('div');
            div.className = 'knob-container';
            const radius = 28, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75;
            div.innerHTML = `
                <div class="knob-label">${label}</div>
                <div class="knob-wrapper">
                    <svg class="knob-svg" viewBox="0 0 65 65">
                        <circle class="knob-track" cx="32.5" cy="32.5" r="${radius}" stroke-dasharray="${maxDash} ${circumference}" />
                        <circle class="knob-value-path" cx="32.5" cy="32.5" r="${radius}" stroke-dasharray="0 ${circumference}" />
                        <circle class="knob-center" cx="32.5" cy="32.5" r="18" />
                    </svg>
                    <div class="knob-indicator"><div class="knob-dot"></div></div>
                </div>
                <div class="knob-value-display">${formatValue(defaultValue)}</div>
            `;
            const wrapper = div.querySelector('.knob-wrapper'), valuePath = div.querySelector('.knob-value-path'), indicator = div.querySelector('.knob-indicator'), display = div.querySelector('.knob-value-display');
            let currentValue = defaultValue;
            
            const updateUI = (value) => {
                const normalized = (value - min) / (max - min);
                valuePath.setAttribute('stroke-dasharray', `${normalized * maxDash} ${circumference}`);
                indicator.style.transform = `rotate(${-135 + (normalized * 270)}deg)`;
                display.innerText = formatValue(value);
            };
            
            updateUI(currentValue);
            container.appendChild(div);
            
            let isDragging = false, startY = 0, startValue = 0;
            const startDrag = (y) => { isDragging = true; startY = y; startValue = currentValue; document.body.style.cursor = 'ns-resize'; };
            const doDrag = (y) => {
                if (!isDragging) return;
                let newVal = startValue + (((startY - y) / 150) * (max - min));
                newVal = Math.max(min, Math.min(max, newVal));
                if (newVal !== currentValue) { 
                    currentValue = newVal; 
                    updateUI(currentValue); 
                    setter(currentValue);
                }
            };
            const endDrag = () => { if (isDragging) { isDragging = false; document.body.style.cursor = 'default'; } };
            
            wrapper.addEventListener('mousedown', (e) => startDrag(e.clientY)); 
            window.addEventListener('mousemove', (e) => doDrag(e.clientY)); 
            window.addEventListener('mouseup', endDrag);
            wrapper.addEventListener('touchstart', (e) => startDrag(e.touches[0].clientY), { passive: false }); 
            window.addEventListener('touchmove', (e) => { if (isDragging) { e.preventDefault(); doDrag(e.touches[0].clientY); } }, { passive: false }); 
            window.addEventListener('touchend', endDrag);
            
            return {
                updateValue: (newVal) => {
                    currentValue = Math.max(min, Math.min(max, newVal));
                    updateUI(currentValue);
                }
            };
        };
        
        this.knobs['Wet'] = createKnob(wetContainer, 'WET', 0, 100, this.wetLevel, v => Math.round(v) + '%', (v) => this.setWetLevel(v));
        this.knobs['Size'] = createKnob(sizeContainer, 'SIZE', 0, 100, this.roomSize, v => Math.round(v) + '%', (v) => this.setRoomSize(v));
        this.knobs['Decay'] = createKnob(decayContainer, 'DECAY', 0.3, 5, this.decayTime, v => v.toFixed(1) + 's', (v) => this.setDecayTime(v));
        this.knobs['Diffusion'] = createKnob(diffusionContainer, 'DIFFUSE', 0, 100, this.diffusion * 100, v => Math.round(v) + '%', (v) => this.setDiffusion(v));
        this.knobs['Modulation'] = createKnob(modulationContainer, 'MOD', 0, 8, this.modulationAmount * 1000, v => v.toFixed(1) + 'ms', (v) => this.setModulation(v));
        this.knobs['Early'] = createKnob(earlyLevelContainer, 'EARLY', 0, 100, this.earlyReflectionLevel * 100, v => Math.round(v) + '%', (v) => this.setEarlyLevel(v));
        
        // Tapahtumat
        this.uiElements.presetSelect.addEventListener('change', (e) => this.applyPreset(e.target.value));
        this.uiElements.materialSelect.addEventListener('change', (e) => this.setWallMaterial(e.target.value));
        
        if (this.uiElements.useConvolverCheckbox) {
            this.uiElements.useConvolverCheckbox.addEventListener('change', (e) => this.setUseConvolver(e.target.checked));
        }
        
        if (this.uiElements.irFileInput) {
            const irLabel = containerElement.querySelector('#ir-upload-label');
            if (irLabel) {
                irLabel.addEventListener('click', () => this.uiElements.irFileInput.click());
            }
            this.uiElements.irFileInput.addEventListener('change', (e) => {
                if (e.target.files[0]) this.loadImpulseResponse(e.target.files[0]);
            });
        }
        
        // Advanced toggle
        const toggleBtn = containerElement.querySelector('#advanced-toggle');
        const advancedContent = containerElement.querySelector('#advanced-content');
        if (toggleBtn && advancedContent) {
            toggleBtn.addEventListener('click', () => {
                advancedContent.classList.toggle('open');
                toggleBtn.innerHTML = advancedContent.classList.contains('open') ? '🔧 Advanced Controls ▲' : '🔧 Advanced Controls ▼';
            });
        }
        
        // Aseta preselectin arvo
        this.uiElements.presetSelect.value = this.roomType;
        if (this.uiElements.materialSelect) {
            this.uiElements.materialSelect.value = this.currentWallMaterial;
        }
        
        // Varmista että ääni kuuluu heti
        setTimeout(() => {
            this.updateWetLevel();
            this.applyRoomSettings();
        }, 100);
    }
}