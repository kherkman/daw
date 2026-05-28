// masterinfo.js
// Master-kanavan reaaliaikainen informaatiotyökalu ja analysaattori
// Ominaisuudet: True Peak (L/R), Sample Peak (L/R), LUFS-M, LUFS-S, LUFS-I, LRA, Clip Log.

window.CustomAudioEffect = class MasterInfoEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;

        // Pääreititys
        this.input = audioCtx.createGain();
        this.input.channelCount = 2;
        this.input.channelCountMode = 'explicit';
        
        this.output = audioCtx.createGain();

        // Pass-through
        this.input.connect(this.output);

        // --- DSP ja analysointireititys ---
        // Signaali jaetaan kahteen: raakaan ja K-painotettuun (LUFS)
        this.splitter = audioCtx.createChannelSplitter(2);
        this.input.connect(this.splitter);

        // K-Weighting Filtterit EBU R 128 (Stage 1 & 2) vasemmalle kanavalle
        this.preFilterL = audioCtx.createBiquadFilter();
        this.preFilterL.type = 'highshelf';
        this.preFilterL.frequency.value = 1681.97;
        this.preFilterL.gain.value = 4.0;
        
        this.rlbFilterL = audioCtx.createBiquadFilter();
        this.rlbFilterL.type = 'highpass';
        this.rlbFilterL.frequency.value = 38.1355;
        this.rlbFilterL.Q.value = 0.5003;

        // K-Weighting Filtterit oikealle kanavalle
        this.preFilterR = audioCtx.createBiquadFilter();
        this.preFilterR.type = 'highshelf';
        this.preFilterR.frequency.value = 1681.97;
        this.preFilterR.gain.value = 4.0;
        
        this.rlbFilterR = audioCtx.createBiquadFilter();
        this.rlbFilterR.type = 'highpass';
        this.rlbFilterR.frequency.value = 38.1355;
        this.rlbFilterR.Q.value = 0.5003;

        // Kytketään K-filtterit
        this.splitter.connect(this.preFilterL, 0);
        this.preFilterL.connect(this.rlbFilterL);
        
        this.splitter.connect(this.preFilterR, 1);
        this.preFilterR.connect(this.rlbFilterR);

        // Yhdistetään Raw (L, R) ja K-weighted (L, R) yhteen prosessoriin
        this.merger = audioCtx.createChannelMerger(4);
        this.splitter.connect(this.merger, 0, 0);   // Raw L (ch 0)
        this.splitter.connect(this.merger, 1, 1);   // Raw R (ch 1)
        this.rlbFilterL.connect(this.merger, 0, 2); // K-Weighted L (ch 2)
        this.rlbFilterR.connect(this.merger, 0, 3); // K-Weighted R (ch 3)

        // Analysaattorin prosessori (4096 samplea kerrallaan optimaalisen tehon saavuttamiseksi)
        this.processor = audioCtx.createScriptProcessor(4096, 4, 1);
        this.merger.connect(this.processor);
        
        // Jotta ScriptProcessor pysyy hengissä, sen täytyy olla kytketty aktiiviseen ketjuun (äänitaso nollilla)
        this.dummyGain = audioCtx.createGain();
        this.dummyGain.gain.value = 0;
        this.processor.connect(this.dummyGain);
        this.dummyGain.connect(this.output); // Kytketään ohjattuun outputiin, jotta reititys toimii oikein kaikilla selaimilla

        // --- Sisäiset muuttujat ---
        this.sampleRate = this.ctx.sampleRate || 44100;
        
        // LUFS aikaikkunat (Sampleina)
        this.windowM = Math.floor(this.sampleRate * 0.4);  // 400 ms
        this.windowS = Math.floor(this.sampleRate * 3.0);  // 3000 ms
        this.stepI = Math.floor(this.sampleRate * 0.1);    // 100 ms (Integrated päivitysväli)

        // Rengaspuskuri K-painotetuille energioille (3s edestä)
        this.kRing = new Float32Array(this.windowS);
        this.kIdx = 0;
        this.sampleCount = 0;

        // Historiat pidempää analyysia varten (Integrated & LRA)
        this.blocksI = [];     // 400ms lohkot
        this.lraHistory = [];  // 3s lohkot (1s välein tallennettu)
        this.samplesSinceLRAStep = 0;

        // Lukemat
        this.currentPeakL = 0; this.currentPeakR = 0;
        this.currentTpL = 0; this.currentTpR = 0;
        this.maxPeakL = 0; this.maxPeakR = 0;
        this.maxTpL = 0; this.maxTpR = 0;

        this.valM = -70; this.valS = -70;
        this.uiValI = -70; this.uiValLRA = 0;

        // Parabolisen interpolaation (True Peak) muistimuuttujat
        this.z1L = 0; this.z2L = 0;
        this.z1R = 0; this.z2R = 0;

        // Tila Clip-logia varten
        this.clipLog = [];
        this.clipState = { peakL: false, peakR: false, tpL: false, tpR: false };

        this.lastUiCalc = Date.now();
        this.startTime = Date.now();

        this.setupProcessing();
    }

    setupProcessing() {
        this.processor.onaudioprocess = (e) => {
            const rawL = e.inputBuffer.getChannelData(0);
            const rawR = e.inputBuffer.getChannelData(1);
            const kL = e.inputBuffer.getChannelData(2);
            const kR = e.inputBuffer.getChannelData(3);
            const len = rawL.length;

            let peakL = 0, peakR = 0;
            let tpL = 0, tpR = 0;

            for (let i = 0; i < len; i++) {
                const l = rawL[i];
                const r = rawR[i];
                const kl = kL[i];
                const kr = kR[i];

                // 1. Peak arviot
                const absL = Math.abs(l);
                const absR = Math.abs(r);
                if (absL > peakL) peakL = absL;
                if (absR > peakR) peakR = absR;

                // 2. True Peak arvio (Parabolinen interpolaatio / ITU-R BS.1770)
                // Vasen
                let y1L = this.z1L, y2L = this.z2L, y3L = l;
                if ((y2L > y1L && y2L > y3L) || (y2L < y1L && y2L < y3L)) {
                    let denomL = y1L - 2 * y2L + y3L;
                    if (denomL !== 0) {
                        let xL = -0.5 * (y3L - y1L) / denomL;
                        let tp = Math.abs(y2L - 0.25 * (y1L - y3L) * xL);
                        if (tp > tpL) tpL = tp;
                    }
                } else if (Math.abs(y2L) > tpL) { tpL = Math.abs(y2L); }
                this.z1L = y2L; this.z2L = y3L;

                // Oikea
                let y1R = this.z1R, y2R = this.z2R, y3R = r;
                if ((y2R > y1R && y2R > y3R) || (y2R < y1R && y2R < y3R)) {
                    let denomR = y1R - 2 * y2R + y3R;
                    if (denomR !== 0) {
                        let xR = -0.5 * (y3R - y1R) / denomR;
                        let tp = Math.abs(y2R - 0.25 * (y1R - y3R) * xR);
                        if (tp > tpR) tpR = tp;
                    }
                } else if (Math.abs(y2R) > tpR) { tpR = Math.abs(y2R); }
                this.z1R = y2R; this.z2R = y3R;

                // 3. LUFS energiapuskuri
                this.kRing[this.kIdx] = kl * kl + kr * kr;
                this.kIdx = (this.kIdx + 1) % this.windowS;
                
                // Integroitujen lohkojen tallennus (100ms välein)
                this.sampleCount++;
                if (this.sampleCount >= this.stepI) {
                    this.sampleCount -= this.stepI;
                    
                    let sumM = 0;
                    for (let j = 0; j < this.windowM; j++) {
                        let idx = this.kIdx - 1 - j;
                        if (idx < 0) idx += this.windowS;
                        sumM += this.kRing[idx];
                    }
                    this.blocksI.push(sumM / this.windowM);
                    if (this.blocksI.length > 36000) this.blocksI.shift(); // Maksimihistoria ~1 tunti
                }

                this.samplesSinceLRAStep++;
                if (this.samplesSinceLRAStep >= this.sampleRate) { // 1 sekunnin välein LRA:ta varten
                    this.samplesSinceLRAStep -= this.sampleRate;
                    let sumS = 0;
                    for (let j = 0; j < this.windowS; j++) {
                        sumS += this.kRing[j];
                    }
                    this.lraHistory.push(sumS / this.windowS);
                    if (this.lraHistory.length > 36000) this.lraHistory.shift();
                }
            }

            // Päivitetään aktiiviset Peak ja True Peak -arvot lineaarina
            this.currentPeakL = peakL; this.currentPeakR = peakR;
            this.currentTpL = tpL; this.currentTpR = tpR;
            
            if (peakL > this.maxPeakL) this.maxPeakL = peakL;
            if (peakR > this.maxPeakR) this.maxPeakR = peakR;
            if (tpL > this.maxTpL) this.maxTpL = tpL;
            if (tpR > this.maxTpR) this.maxTpR = tpR;

            // Clip -tarkastukset (1.0 = 0 dBFS)
            this.checkClip('Peak L', peakL, 'peakL');
            this.checkClip('Peak R', peakR, 'peakR');
            this.checkClip('True Peak L', tpL, 'tpL');
            this.checkClip('True Peak R', tpR, 'tpR');

            // Lasketaan hetkelliset LUFS M ja S
            let sumM = 0;
            for (let j = 0; j < this.windowM; j++) {
                let idx = this.kIdx - 1 - j;
                if (idx < 0) idx += this.windowS;
                sumM += this.kRing[idx];
            }
            this.valM = -0.691 + 10 * Math.log10((sumM / this.windowM) + 1e-10);

            let sumS = 0;
            for (let j = 0; j < this.windowS; j++) {
                sumS += this.kRing[j];
            }
            this.valS = -0.691 + 10 * Math.log10((sumS / this.windowS) + 1e-10);
        };
    }

    checkClip(name, val, stateKey) {
        if (val > 1.0) { // Ylittää 0 dB
            if (!this.clipState[stateKey]) {
                const db = 20 * Math.log10(val);
                this.addClipEvent(name, db);
                this.clipState[stateKey] = true;
            }
        } else {
            this.clipState[stateKey] = false;
        }
    }

    addClipEvent(name, db) {
        const now = Date.now() - this.startTime;
        const s = Math.floor(now / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        const timeStr = `[${String(h).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}]`;
        const msg = `${timeStr} ${name} Clip (+${db.toFixed(2)} dB)`;
        
        this.clipLog.unshift(msg);
        if (this.clipLog.length > 100) this.clipLog.pop(); // Pidetään viimeiset 100
        
        if (this.uiElements && this.uiElements.clipBox) {
            this.uiElements.clipBox.innerHTML = this.clipLog.join('<br>');
        }
    }

    resetMeters() {
        this.maxPeakL = 0; this.maxPeakR = 0;
        this.maxTpL = 0; this.maxTpR = 0;
        this.blocksI = [];
        this.lraHistory = [];
        this.clipLog = [];
        this.startTime = Date.now();
        this.uiValI = -70;
        this.uiValLRA = 0;
        if (this.uiElements && this.uiElements.clipBox) {
            this.uiElements.clipBox.innerHTML = 'Ei clippejä.';
        }
    }

    getNodes() {
        return { input: this.input, output: this.output };
    }

    getState() { return {}; }
    setState(state) {}

    // Raskas LUFS-I ja LRA matematiikka lasketaan UI-luupissa (~2 kertaa sekunnissa) jotta audio-thread ei hidastu
    calculateHeavyLUFS() {
        const absGate = Math.pow(10, -70.691 / 10);
        
        // LUFS-I
        let sumAbs = 0;
        let absGated = [];
        for (let i = 0; i < this.blocksI.length; i++) {
            if (this.blocksI[i] > absGate) {
                absGated.push(this.blocksI[i]);
                sumAbs += this.blocksI[i];
            }
        }
        
        if (absGated.length > 0) {
            let meanAbs = sumAbs / absGated.length;
            let relGate = meanAbs * 0.1; // -10 LU
            let sumRel = 0, countRel = 0;
            for (let i = 0; i < absGated.length; i++) {
                if (absGated[i] > relGate) {
                    sumRel += absGated[i];
                    countRel++;
                }
            }
            if (countRel > 0) {
                this.uiValI = -0.691 + 10 * Math.log10((sumRel / countRel) + 1e-10);
            }
        }

        // LRA (Loudness Range)
        let lraAbs = [];
        let lraSum = 0;
        for (let i = 0; i < this.lraHistory.length; i++) {
             if (this.lraHistory[i] > absGate) {
                 lraAbs.push(this.lraHistory[i]);
                 lraSum += this.lraHistory[i];
             }
        }
        if (lraAbs.length >= 2) {
            let meanAbs = lraSum / lraAbs.length;
            let relGate = meanAbs * 0.01; // -20 LU
            let valid = [];
            for (let i = 0; i < lraAbs.length; i++) {
                 if (lraAbs[i] > relGate) valid.push(lraAbs[i]);
            }
            if (valid.length >= 2) {
                valid.sort((a, b) => a - b);
                let p10 = valid[Math.floor(valid.length * 0.1)];
                let p95 = valid[Math.floor(valid.length * 0.95)];
                let l10 = -0.691 + 10 * Math.log10(p10 + 1e-10);
                let l95 = -0.691 + 10 * Math.log10(p95 + 1e-10);
                this.uiValLRA = Math.max(0, l95 - l10);
            }
        }
    }

    // --- KÄYTTÖLIITTYMÄ (UI) ---
    renderUI(container) {
        const color = '#00ffcc';
        container.style.setProperty('--mi-color', color);

        const styleId = 'fx-masterinfo-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .mi-panel { background: rgba(0,0,0,0.6); border: 1px solid rgba(0, 255, 204, 0.2); border-radius: 8px; padding: 15px; margin-bottom: 10px; font-family: monospace; color: #fff; }
                .mi-row { display: flex; gap: 15px; flex-wrap: wrap; }
                .mi-col { flex: 1; min-width: 150px; background: rgba(0,0,0,0.4); padding: 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05); }
                .mi-title { font-size: 11px; color: #8b8b9f; text-transform: uppercase; margin-bottom: 8px; font-weight: bold; }
                .mi-val-display { font-size: 18px; font-weight: bold; color: var(--mi-color); margin-bottom: 5px; }
                .mi-val-small { font-size: 10px; color: rgba(255,255,255,0.6); }
                
                .mi-meter-wrap { position: relative; height: 12px; background: #1a1a24; border-radius: 3px; overflow: hidden; margin-bottom: 5px; }
                .mi-meter-fill { height: 100%; background: var(--mi-color); width: 0%; transition: width 0.05s linear; }
                .mi-meter-fill.warning { background: #ffcc00; }
                .mi-meter-fill.danger { background: #ff3366; }
                
                .mi-meter-mark { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(255,255,255,0.3); z-index: 2;}
                .mi-meter-text { position: absolute; font-size: 8px; top: 1px; color: rgba(255,255,255,0.7); z-index: 3;}
                
                .mi-clip-box { height: 80px; overflow-y: auto; background: #000; border: 1px inset #333; padding: 5px; font-size: 10px; color: #ff3366; }
                .mi-btn { background: #1a1a24; color: var(--mi-color); border: 1px solid var(--mi-color); padding: 5px 15px; border-radius: 4px; font-family: monospace; cursor: pointer; text-transform: uppercase; font-size: 11px; }
                .mi-btn:hover { background: var(--mi-color); color: #000; transition: 0.2s; }
            `;
            document.head.appendChild(style);
        }

        // Rakennetaan HTML-rakenne
        container.innerHTML = `
            <div style="margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
                <div style="color: var(--mi-color); font-weight: bold; letter-spacing: 2px; font-size: 14px;">MASTER INSIGHT</div>
                <button class="mi-btn" id="mi-reset-btn">Reset All</button>
            </div>

            <div class="mi-row">
                <!-- Vasen kolumni: Peak / True Peak -->
                <div class="mi-col">
                    <div class="mi-title">Peak & True Peak</div>
                    
                    <div style="display:flex; justify-content: space-between;">
                        <span class="mi-val-small">L Peak</span>
                        <span class="mi-val-small" id="val-peakL">--</span>
                    </div>
                    <div class="mi-meter-wrap" id="meter-peakL">
                        <div class="mi-meter-fill"></div>
                    </div>
                    
                    <div style="display:flex; justify-content: space-between;">
                        <span class="mi-val-small">R Peak</span>
                        <span class="mi-val-small" id="val-peakR">--</span>
                    </div>
                    <div class="mi-meter-wrap" id="meter-peakR">
                        <div class="mi-meter-fill"></div>
                    </div>

                    <div style="display:flex; justify-content: space-between; margin-top: 10px;">
                        <span class="mi-val-small">L True Peak</span>
                        <span class="mi-val-small" id="val-tpL" style="color:#fff;">--</span>
                    </div>
                    <div class="mi-meter-wrap" id="meter-tpL">
                        <div class="mi-meter-fill" style="background:#e1bee7;"></div>
                    </div>
                    
                    <div style="display:flex; justify-content: space-between;">
                        <span class="mi-val-small">R True Peak</span>
                        <span class="mi-val-small" id="val-tpR" style="color:#fff;">--</span>
                    </div>
                    <div class="mi-meter-wrap" id="meter-tpR">
                        <div class="mi-meter-fill" style="background:#e1bee7;"></div>
                    </div>
                    
                    <div style="margin-top: 8px; font-size: 10px; color: #8b8b9f;">
                        Max TP L: <span id="val-max-tpL" style="color:#fff;">--</span> | 
                        Max TP R: <span id="val-max-tpR" style="color:#fff;">--</span>
                    </div>
                </div>

                <!-- Oikea kolumni: LUFS -->
                <div class="mi-col">
                    <div class="mi-title">Loudness (LUFS)</div>
                    
                    <div style="display:flex; justify-content: space-between; align-items: flex-end;">
                        <div>
                            <div class="mi-val-small">Integrated (I)</div>
                            <div class="mi-val-display" id="val-lufsI">-- LUFS</div>
                        </div>
                        <div style="text-align: right;">
                            <div class="mi-val-small">LRA</div>
                            <div class="mi-val-display" id="val-lra" style="color:#e1bee7; font-size:14px;">-- LU</div>
                        </div>
                    </div>

                    <div style="margin-top: 10px;">
                        <div style="display:flex; justify-content: space-between;">
                            <span class="mi-val-small">Momentary (M)</span>
                            <span class="mi-val-small" id="val-lufsM">--</span>
                        </div>
                        <div class="mi-meter-wrap" id="meter-lufsM">
                            <div class="mi-meter-mark" style="left:75%;"><div class="mi-meter-text" style="left:-15px;">-14</div></div>
                            <div class="mi-meter-fill" style="background:#00ccff;"></div>
                        </div>
                        
                        <div style="display:flex; justify-content: space-between;">
                            <span class="mi-val-small">Short-Term (S)</span>
                            <span class="mi-val-small" id="val-lufsS">--</span>
                        </div>
                        <div class="mi-meter-wrap" id="meter-lufsS">
                            <div class="mi-meter-mark" style="left:75%;"><div class="mi-meter-text" style="left:-15px;">-14</div></div>
                            <div class="mi-meter-fill" style="background:#00ff99;"></div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Graafinen Historiapaneeli -->
            <div class="mi-panel" style="height: 100px; padding: 5px; position: relative;">
                <canvas id="mi-history-canvas" style="width: 100%; height: 100%; display: block;"></canvas>
                <div style="position: absolute; top: 5px; left: 10px; font-size: 9px; color: rgba(255,255,255,0.5);">LUFS History (S: Green, M: Blue)</div>
            </div>

            <!-- Clip Log -->
            <div class="mi-panel" style="padding: 10px;">
                <div class="mi-title">Clip Log (> 0 dB)</div>
                <div class="mi-clip-box" id="mi-clip-log">Ei clippejä.</div>
            </div>
        `;

        this.uiElements = {
            clipBox: container.querySelector('#mi-clip-log'),
            valPeakL: container.querySelector('#val-peakL'),
            valPeakR: container.querySelector('#val-peakR'),
            valTpL: container.querySelector('#val-tpL'),
            valTpR: container.querySelector('#val-tpR'),
            valMaxTpL: container.querySelector('#val-max-tpL'),
            valMaxTpR: container.querySelector('#val-max-tpR'),
            valLufsI: container.querySelector('#val-lufsI'),
            valLra: container.querySelector('#val-lra'),
            valLufsM: container.querySelector('#val-lufsM'),
            valLufsS: container.querySelector('#val-lufsS'),
            
            fillPeakL: container.querySelector('#meter-peakL .mi-meter-fill'),
            fillPeakR: container.querySelector('#meter-peakR .mi-meter-fill'),
            fillTpL: container.querySelector('#meter-tpL .mi-meter-fill'),
            fillTpR: container.querySelector('#meter-tpR .mi-meter-fill'),
            fillLufsM: container.querySelector('#meter-lufsM .mi-meter-fill'),
            fillLufsS: container.querySelector('#meter-lufsS .mi-meter-fill'),
            
            canvas: container.querySelector('#mi-history-canvas')
        };

        const ctx2d = this.uiElements.canvas.getContext('2d');

        container.querySelector('#mi-reset-btn').onclick = () => this.resetMeters();

        const valToDb = (v) => v <= 0.0001 ? -80 : 20 * Math.log10(v);
        
        // Apufunktio mittaripalkkien skaalaamiseen (-60 -> +3 dB)
        const setMeter = (el, dbValue) => {
            const minDb = -60;
            const maxDb = 3;
            let percent = ((dbValue - minDb) / (maxDb - minDb)) * 100;
            percent = Math.max(0, Math.min(100, percent));
            el.style.width = `${percent}%`;
            
            if (dbValue >= 0) {
                el.className = 'mi-meter-fill danger';
            } else if (dbValue >= -6) {
                el.className = 'mi-meter-fill warning';
            } else {
                el.className = 'mi-meter-fill';
            }
        };

        const setLufsMeter = (el, lufs) => {
            const minL = -60;
            const maxL = 0;
            let percent = ((lufs - minL) / (maxL - minL)) * 100;
            percent = Math.max(0, Math.min(100, percent));
            el.style.width = `${percent}%`;
            
            if (lufs >= -9) {
                el.style.background = '#ff3366';
            } else if (lufs >= -14) {
                el.style.background = '#ffcc00';
            } else {
                el.style.background = ''; // Default CSS color
            }
        };

        const formatDb = (db) => db <= -79.9 ? '-inf dB' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
        const formatLufs = (l) => l <= -69.9 ? '-inf' : `${l.toFixed(1)}`;

        // Piirtoluuppi ja UI päivitys
        const histM = new Array(200).fill(-70);
        const histS = new Array(200).fill(-70);

        let mountCheckCount = 0;

        const drawLoop = () => {
            // Varmistetaan että UI on liitetty sivuun ennen ruudun päivitystä
            if (!document.body.contains(container)) {
                mountCheckCount++;
                if (mountCheckCount > 30) return; // Luovutetaan jos elementtiä ei koskaan lisättykään
                return requestAnimationFrame(drawLoop);
            }
            mountCheckCount = 0; // Nollataan, jos elementti on saatu kiinni

            const now = Date.now();
            if (now - this.lastUiCalc > 500) {
                this.calculateHeavyLUFS();
                this.lastUiCalc = now;
            }

            const dbPeakL = valToDb(this.currentPeakL);
            const dbPeakR = valToDb(this.currentPeakR);
            const dbTpL = valToDb(this.currentTpL);
            const dbTpR = valToDb(this.currentTpR);

            // Numeeriset päivitykset
            this.uiElements.valPeakL.innerText = formatDb(dbPeakL);
            this.uiElements.valPeakR.innerText = formatDb(dbPeakR);
            this.uiElements.valTpL.innerText = formatDb(dbTpL);
            this.uiElements.valTpR.innerText = formatDb(dbTpR);
            
            this.uiElements.valMaxTpL.innerText = formatDb(valToDb(this.maxTpL));
            this.uiElements.valMaxTpR.innerText = formatDb(valToDb(this.maxTpR));

            this.uiElements.valLufsI.innerText = `${formatLufs(this.uiValI)} LUFS`;
            this.uiElements.valLra.innerText = `${this.uiValLRA.toFixed(1)} LU`;
            this.uiElements.valLufsM.innerText = formatLufs(this.valM);
            this.uiElements.valLufsS.innerText = formatLufs(this.valS);

            // Mittarit
            setMeter(this.uiElements.fillPeakL, dbPeakL);
            setMeter(this.uiElements.fillPeakR, dbPeakR);
            setMeter(this.uiElements.fillTpL, dbTpL);
            setMeter(this.uiElements.fillTpR, dbTpR);

            setLufsMeter(this.uiElements.fillLufsM, this.valM);
            setLufsMeter(this.uiElements.fillLufsS, this.valS);

            // --- Canvas piirto (Historia) ---
            const cvs = this.uiElements.canvas;
            const parent = cvs.parentElement;
            if (cvs.width !== parent.clientWidth || cvs.height !== parent.clientHeight) {
                cvs.width = parent.clientWidth;
                cvs.height = parent.clientHeight;
            }

            histM.push(this.valM); histM.shift();
            histS.push(this.valS); histS.shift();

            const w = cvs.width, h = cvs.height;
            ctx2d.clearRect(0, 0, w, h);

            const minL = -50, maxL = 0;
            const getY = (val) => {
                if (val < minL) val = minL;
                if (val > maxL) val = maxL;
                return h - ((val - minL) / (maxL - minL)) * h;
            };

            // Viivat -14 LUFS kohdalle
            const y14 = getY(-14);
            ctx2d.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            ctx2d.setLineDash([5, 5]);
            ctx2d.beginPath();
            ctx2d.moveTo(0, y14); ctx2d.lineTo(w, y14);
            ctx2d.stroke();
            ctx2d.setLineDash([]);

            // S-käyrä
            ctx2d.strokeStyle = '#00ff99';
            ctx2d.lineWidth = 2;
            ctx2d.beginPath();
            for (let i = 0; i < histS.length; i++) {
                const x = (i / (histS.length - 1)) * w;
                const y = getY(histS[i]);
                if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
            }
            ctx2d.stroke();

            // M-käyrä
            ctx2d.strokeStyle = 'rgba(0, 204, 255, 0.6)';
            ctx2d.lineWidth = 1.5;
            ctx2d.beginPath();
            for (let i = 0; i < histM.length; i++) {
                const x = (i / (histM.length - 1)) * w;
                const y = getY(histM[i]);
                if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
            }
            ctx2d.stroke();

            // "Vuotavien" huippujen palautus, jotta mittarit tippuvat kauniisti jos ääntä ei ole
            this.currentPeakL *= 0.95; 
            this.currentPeakR *= 0.95;
            this.currentTpL *= 0.95;   
            this.currentTpR *= 0.95;

            requestAnimationFrame(drawLoop);
        };
        
        drawLoop();
    }
}