// spectrogram.js
window.CustomAudioEffect = class SpectrogramVisualizer {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        
        // Koska kyseessä on vain visualisaattori, reititetään ääni suoraan läpi
        this.input.connect(this.output);

        // Luodaan AnalyserNode taajuuksien analysointia varten
        this.analyser = audioCtx.createAnalyser();
        this.analyser.fftSize = 2048; // Määrittää taajuusresoluution (1024 taajuuskaistaa)
        this.analyser.smoothingTimeConstant = 0.0; // 0 = Puhdas, välitön data ilman hitautta
        
        // Haaroitetaan input analysaattoriin
        this.input.connect(this.analyser);
        
        // Puskuri taajuusdatalle
        this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

        // Spektrogrammin oletusasetukset
        this.settings = {
            speed: 2,         // Rullausnopeus pikseleinä per frame
            sensitivity: 1.2,  // Värin voimakkuus/herkkyys
            zoom: 0.5         // Kuinka suuri osa taajuuksista näytetään (1.0 = koko 22kHz, 0.5 = 11kHz)
        };

        this.knobs = {};
        this.animationFrameId = null;
        this.canvas = null;
        this.canvasCtx = null;
    }
    
    getNodes() { 
        return { input: this.input, output: this.output }; 
    }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return this.settings;
    }

    setState(state) {
        if (!state) return;

        if (state.speed !== undefined) {
            this.settings.speed = state.speed;
            if (this.knobs['speed']) this.knobs['speed'].setValue(state.speed);
        }
        if (state.sensitivity !== undefined) {
            this.settings.sensitivity = state.sensitivity;
            if (this.knobs['sensitivity']) this.knobs['sensitivity'].setValue(state.sensitivity);
        }
        if (state.zoom !== undefined) {
            this.settings.zoom = state.zoom;
            if (this.knobs['zoom']) this.knobs['zoom'].setValue(state.zoom);
        }
    }

    // --- PIIRTO (SPECTROGRAM LOGIC) ---

    drawSpectrogram() {
        // Poistettu .isConnected tarkistus, joka voi aiheuttaa bugin DOM-latauksen yhteydessä
        if (!this.canvas) return; 
        
        this.animationFrameId = requestAnimationFrame(() => this.drawSpectrogram());

        const width = this.canvas.width;
        const height = this.canvas.height;
        const speed = this.settings.speed;

        // 1. Siirretään kuvaa vasemmalle
        this.canvasCtx.drawImage(this.canvas, -speed, 0);

        // 2. Haetaan taajuusdata
        this.analyser.getByteFrequencyData(this.dataArray);

        // 3. Luodaan uusi sarake
        const imgData = this.canvasCtx.createImageData(speed, height);
        const data = imgData.data;

        const visibleBins = Math.floor(this.analyser.frequencyBinCount * this.settings.zoom);

        for (let y = 0; y < height; y++) {
            const binIndex = Math.floor((1 - (y / height)) * visibleBins);
            let val = this.dataArray[binIndex] * this.settings.sensitivity;
            val = Math.max(0, Math.min(255, val)); 

            let r = 0, g = 0, b = 0;
            const norm = val / 255;
            
            // LISÄTTY: Jos signaali on 0 (hiljaisuus), piirretään tummanharmaa/sinertävä tausta
            // Näin näet, että canvas ainakin liikkuu!
            if (norm === 0) {
                r = 15; g = 15; b = 20; 
            } else if (norm < 0.33) {
                b = Math.floor((norm / 0.33) * 255); 
            } else if (norm < 0.66) {
                b = 255 - Math.floor(((norm - 0.33) / 0.33) * 255);
                r = Math.floor(((norm - 0.33) / 0.33) * 255); 
            } else {
                r = 255;
                g = Math.floor(((norm - 0.66) / 0.34) * 255); 
            }

            for (let x = 0; x < speed; x++) {
                const idx = (y * speed + x) * 4;
                data[idx] = r;
                data[idx + 1] = g;
                data[idx + 2] = b;
                data[idx + 3] = 255; 
            }
        }

        this.canvasCtx.putImageData(imgData, width - speed, 0);
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const styleId = 'fx-mod-styles';
        // Luodaan tyylit vain kerran (jaettu basic.js tyylien kanssa)
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .fx-dashboard { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; padding: 15px 0; gap: 25px; }
                .knob-container { display: flex; flex-direction: column; align-items: center; user-select: none; width: 80px; }
                .knob-wrapper { position: relative; width: 70px; height: 70px; cursor: ns-resize; margin-bottom: 8px; touch-action: none; }
                .knob-svg { width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 5px rgba(255,255,255,0.2)); }
                .knob-track { fill: none; stroke: #2a2a3b; stroke-width: 8; stroke-linecap: round; }
                .knob-value-path { fill: none; stroke: var(--fx-color); stroke-width: 8; stroke-linecap: round; transition: stroke 0.2s; }
                .knob-wrapper:active .knob-value-path, .knob-wrapper:hover .knob-value-path { stroke: #fff; filter: drop-shadow(0 0 8px var(--fx-color)); }
                .knob-center { fill: #1a1a24; stroke: #333; stroke-width: 2; }
                .knob-indicator { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
                .knob-dot { position: absolute; width: 6px; height: 6px; background: var(--fx-color); border-radius: 50%; top: 8px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 8px var(--fx-color); }
                .knob-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted); margin-bottom: 5px; text-align: center; }
                .knob-value-display { font-size: 12px; font-family: monospace; color: var(--text-main); background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); text-align: center; min-width: 45px; }
                
                /* Spektrogrammille spesifit tyylit */
                .spectrogram-wrapper { width: 100%; max-width: 600px; padding: 10px; background: #0f0f15; border-radius: 8px; border: 1px solid #2a2a3b; }
                .spectrogram-canvas { width: 100%; height: 150px; background: #000; display: block; border-radius: 4px; border: 1px solid #000; box-shadow: inset 0 0 10px rgba(0,0,0,0.8); }
            `;
            document.head.appendChild(style);
        }

        // Asetetaan Spektrogrammi-moduulille oma teemaväri (Magenta)
        containerElement.style.setProperty('--fx-color', '#ff00aa');
        containerElement.innerHTML = `
            <div style="margin-bottom: 5px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">SPECTROGRAM</div>
            <div class="fx-dashboard" style="flex-direction: column; gap: 15px;">
                <div class="spectrogram-wrapper">
                    <canvas id="spectrogram-canvas" width="600" height="256" class="spectrogram-canvas"></canvas>
                </div>
                <div class="fx-dashboard" id="spectrogram-controls" style="padding: 0;"></div>
            </div>
        `;
        
        this.canvas = containerElement.querySelector('#spectrogram-canvas');
        this.canvasCtx = this.canvas.getContext('2d', { willReadFrequently: true }); // willReadFrequently tekee drawImage -rullauksesta nopeampaa selaimelle
        
        const controlsContainer = containerElement.querySelector('#spectrogram-controls');

        // Nuppien luontifunktio (identtinen basic.js kanssa)
        const createKnob = (label, min, max, defaultValue, formatValue, onChange) => {
            const container = document.createElement('div');
            container.className = 'knob-container';
            const radius = 28, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            container.innerHTML = `
                <div class="knob-label">${label}</div>
                <div class="knob-wrapper">
                    <svg class="knob-svg" viewBox="0 0 70 70">
                        <circle class="knob-track" cx="35" cy="35" r="${radius}" stroke-dasharray="${maxDash} ${circumference}" />
                        <circle class="knob-value-path" cx="35" cy="35" r="${radius}" stroke-dasharray="0 ${circumference}" />
                        <circle class="knob-center" cx="35" cy="35" r="20" />
                    </svg>
                    <div class="knob-indicator"><div class="knob-dot"></div></div>
                </div>
                <div class="knob-value-display">${formatValue(defaultValue)}</div>
            `;
            const wrapper = container.querySelector('.knob-wrapper'), 
                  valuePath = container.querySelector('.knob-value-path'), 
                  indicator = container.querySelector('.knob-indicator'), 
                  display = container.querySelector('.knob-value-display');
            let currentValue = defaultValue;

            const updateUI = (value) => {
                const normalized = (value - min) / (max - min);
                valuePath.setAttribute('stroke-dasharray', `${normalized * maxDash} ${circumference}`);
                indicator.style.transform = `rotate(${-135 + (normalized * 270)}deg)`;
                display.innerText = formatValue(value);
            };
            updateUI(currentValue);
            controlsContainer.appendChild(container);

            let isDragging = false, startY = 0, startValue = 0;
            const startDrag = (y) => { isDragging = true; startY = y; startValue = currentValue; document.body.style.cursor = 'ns-resize'; };
            const doDrag = (y) => {
                if (!isDragging) return;
                let newVal = startValue + (((startY - y) / 150) * (max - min));
                newVal = Math.max(min, Math.min(max, newVal));
                if (newVal !== currentValue) { 
                    currentValue = newVal; 
                    updateUI(currentValue); 
                    onChange(currentValue); 
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
                setValue: (v) => {
                    currentValue = v;
                    updateUI(v);
                }
            };
        };

        // Speed (Rullausnopeus)
        this.knobs['speed'] = createKnob('Speed', 1, 10, this.settings.speed, 
            (v) => Math.round(v) + ' px', 
            (v) => this.settings.speed = Math.round(v)
        );

        // Sensitivity (Värin herkkyys, tekee hiljaisista äänistä kirkkaampia)
        this.knobs['sensitivity'] = createKnob('Sens', 0.5, 3.0, this.settings.sensitivity, 
            (v) => v.toFixed(1) + ' x', 
            (v) => this.settings.sensitivity = v
        );

        // Zoom (Rajaa näyttämään vain matalammat taajuudet. Max on n. 22kHz, Zoom 0.5 on n. 11kHz yläraja)
        this.knobs['zoom'] = createKnob('Y-Zoom', 0.1, 1.0, this.settings.zoom, 
            (v) => Math.round((v * (this.ctx.sampleRate / 2)) / 1000) + ' kHz', 
            (v) => this.settings.zoom = v
        );

        // Pysäytetään mahdollinen vanha looppi ja aloitetaan uusi piirtolooppi
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
        this.drawSpectrogram();
    }
}