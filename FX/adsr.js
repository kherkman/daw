// adsr.js
window.CustomAudioEffect = class ADSREnvelope {
    constructor(audioCtx) {
        this.ctx = audioCtx;

        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        
        this.liveGain = audioCtx.createGain();
        this.looperGain = audioCtx.createGain();
        
        this.envelopeGain = audioCtx.createGain();
        this.envelopeGain.gain.value = 0; 

        this.rate = 1.0;     
        this.attack = 0.05;  
        this.decay = 0.1;    
        this.sustain = 0.5;  
        this.release = 0.2;  

        this.looperSource = null;
        this.loopStartTime = 0.4;
        this.loopEndTime = 1.4;
        this.crossfadeTime = 0.1;
        
        this.looperMix = 0.0; 

        // Reititys
        this.input.connect(this.liveGain);
        this.liveGain.connect(this.envelopeGain);
        this.looperGain.connect(this.envelopeGain);
        this.envelopeGain.connect(this.output);

        this.nextNoteTime = this.ctx.currentTime + 0.1;
        this.isPlaying = true;
        this.updateMix();

        // UI-referenssit
        this.knobs = {};
        this.uiElements = {};

        this.schedulerTimer = setInterval(() => this.scheduleNotes(), 25);
    }

    updateMix() {
        this.liveGain.gain.value = Math.cos(this.looperMix * 0.5 * Math.PI);
        this.looperGain.gain.value = Math.sin(this.looperMix * 0.5 * Math.PI);
    }

    createCrossfadeLoop() {
        let buffer = null;
        try { buffer = audioBuffer; } catch(e) { alert("Lataa ensin päätiedosto (.WAV) soittimeen!"); return; }
        if (!buffer) { alert("Ei audiota saatavilla looppausta varten!"); return; }

        const sr = buffer.sampleRate;
        const startSamp = Math.floor(this.loopStartTime * sr);
        let endSamp = Math.floor(this.loopEndTime * sr);
        let xfadeSamp = Math.floor(this.crossfadeTime * sr);

        if (startSamp >= endSamp) { alert("Lopun täytyy olla alun jälkeen!"); return; }
        if (endSamp > buffer.length) endSamp = buffer.length;

        let totalSamps = endSamp - startSamp;
        if (xfadeSamp >= totalSamps / 2) xfadeSamp = Math.floor(totalSamps / 2);

        const loopLen = totalSamps - xfadeSamp;
        const newBuffer = this.ctx.createBuffer(buffer.numberOfChannels, loopLen, sr);

        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = newBuffer.getChannelData(ch);

            for (let i = 0; i < loopLen; i++) dst[i] = src[startSamp + i];

            for (let i = 0; i < xfadeSamp; i++) {
                const progress = i / xfadeSamp;
                const fadeIn = Math.sin(progress * 0.5 * Math.PI);
                const fadeOut = Math.cos(progress * 0.5 * Math.PI);
                const tailSample = src[startSamp + loopLen + i];
                dst[i] = (dst[i] * fadeIn) + (tailSample * fadeOut);
            }
        }

        if (this.looperSource) { try { this.looperSource.stop(); } catch(e){} }

        this.looperSource = this.ctx.createBufferSource();
        this.looperSource.buffer = newBuffer;
        this.looperSource.loop = true;
        this.looperSource.connect(this.looperGain);
        this.looperSource.start();
        
        const btn = document.getElementById('btn-apply-loop');
        if(btn) {
            const oldText = btn.innerText;
            btn.innerText = "LADATTU!";
            setTimeout(() => btn.innerText = oldText, 1000);
        }
    }

    scheduleNotes() {
        if (!this.isPlaying) return;
        const now = this.ctx.currentTime;
        if (this.nextNoteTime < now) this.nextNoteTime = now + 0.05;
        while (this.nextNoteTime < now + 0.1) {
            this.playEnvelope(this.nextNoteTime);
            this.nextNoteTime += (1.0 / this.rate);
        }
    }

    playEnvelope(time) {
        // Varmistetaan että aika on varmasti hieman tulevaisuudessa
        const t = Math.max(time, this.ctx.currentTime + 0.01);
        const cycleLength = 1.0 / this.rate;
        const gateLength = cycleLength * 0.5; 

        let a = Math.max(0.005, Math.min(this.attack, gateLength));
        let d = Math.max(0.005, Math.min(this.decay, gateLength - a));
        let r = Math.max(0.005, Math.min(this.release, cycleLength - gateLength));
        let sus = Math.max(0.001, this.sustain);

        const gain = this.envelopeGain.gain;
        
        // Turvallinen ADSR ketju Web Audio APIn vaatimalla tavalla
        gain.cancelScheduledValues(t);
        gain.setValueAtTime(0.001, t); 
        gain.linearRampToValueAtTime(1.0, t + a);
        gain.linearRampToValueAtTime(sus, t + a + d);
        gain.setValueAtTime(sus, t + gateLength);
        gain.linearRampToValueAtTime(0.001, t + gateLength + r);
    }

    getNodes() { return { input: this.input, output: this.output }; }

    // --- TALLENNUS JA LATAUS ---

    getState() {
        return {
            rate: this.rate,
            attack: this.attack,
            decay: this.decay,
            sustain: this.sustain,
            release: this.release,
            loopStartTime: this.loopStartTime,
            loopEndTime: this.loopEndTime,
            crossfadeTime: this.crossfadeTime,
            looperMix: this.looperMix
        };
    }

    setState(state) {
        if (!state) return;

        if (state.rate !== undefined) { this.rate = state.rate; if (this.knobs['rate']) this.knobs['rate'].setValue(this.rate); }
        if (state.attack !== undefined) { this.attack = state.attack; if (this.knobs['attack']) this.knobs['attack'].setValue(this.attack); }
        if (state.decay !== undefined) { this.decay = state.decay; if (this.knobs['decay']) this.knobs['decay'].setValue(this.decay); }
        if (state.sustain !== undefined) { this.sustain = state.sustain; if (this.knobs['sustain']) this.knobs['sustain'].setValue(this.sustain); }
        if (state.release !== undefined) { this.release = state.release; if (this.knobs['release']) this.knobs['release'].setValue(this.release); }
        
        if (state.loopStartTime !== undefined) { 
            this.loopStartTime = state.loopStartTime; 
            if (this.uiElements.startIn) this.uiElements.startIn.value = this.loopStartTime; 
        }
        if (state.loopEndTime !== undefined) { 
            this.loopEndTime = state.loopEndTime; 
            if (this.uiElements.endIn) this.uiElements.endIn.value = this.loopEndTime; 
            if (this.knobs['length']) this.knobs['length'].setValue(this.loopEndTime - this.loopStartTime);
        }
        if (state.crossfadeTime !== undefined) { this.crossfadeTime = state.crossfadeTime; if (this.knobs['crossfade']) this.knobs['crossfade'].setValue(this.crossfadeTime); }
        if (state.looperMix !== undefined) { 
            this.looperMix = state.looperMix; 
            this.updateMix(); 
            if (this.knobs['looperMix']) this.knobs['looperMix'].setValue(this.looperMix); 
        }
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#ccff00';
        containerElement.style.setProperty('--fx-color', color);

        containerElement.innerHTML = `
            <div style="margin-bottom: 15px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">ADSR GATE & LOOPER</div>
            
            <div style="background: rgba(0,0,0,0.3); border: 1px dashed rgba(204, 255, 0, 0.3); border-radius: 10px; padding: 15px; margin-bottom: 20px;">
                <div style="text-align: center; color: var(--fx-color); font-size: 10px; letter-spacing: 2px; margin-bottom: 10px;">SAMPLER / LOOPER</div>
                <div style="display: flex; justify-content: center; gap: 15px; margin-bottom: 15px; align-items: center;">
                    <div style="display: flex; flex-direction: column; align-items: center;">
                        <label style="font-size: 10px; color: #8b8b9f; text-transform: uppercase; margin-bottom: 5px;">Start (s)</label>
                        <input type="number" id="loop-start-in" value="${this.loopStartTime}" step="0.1" min="0" style="width: 60px; background: #000; border: 1px solid var(--fx-color); color: #fff; text-align: center; border-radius: 4px; padding: 4px; font-family: monospace; font-size: 12px; outline: none;">
                    </div>
                    <div style="display: flex; flex-direction: column; align-items: center;">
                        <label style="font-size: 10px; color: #8b8b9f; text-transform: uppercase; margin-bottom: 5px;">End (s)</label>
                        <input type="number" id="loop-end-in" value="${this.loopEndTime}" step="0.1" min="0.1" style="width: 60px; background: #000; border: 1px solid var(--fx-color); color: #fff; text-align: center; border-radius: 4px; padding: 4px; font-family: monospace; font-size: 12px; outline: none;">
                    </div>
                    <button id="btn-apply-loop" style="background: rgba(204, 255, 0, 0.1); border: 1px solid var(--fx-color); color: var(--fx-color); cursor: pointer; padding: 6px 12px; border-radius: 4px; font-weight: bold; font-size: 11px; text-transform: uppercase; transition: all 0.2s;">Päivitä Loop</button>
                </div>
                <div id="looper-dashboard" style="display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 20px;"></div>
            </div>

            <div style="width: 100%; max-width: 400px; height: 100px; background: rgba(0,0,0,0.4); border: 1px solid rgba(204, 255, 0, 0.2); border-radius: 8px; margin: 0 auto 15px auto; position: relative; overflow: hidden; box-shadow: inset 0 0 15px rgba(0,0,0,0.8);">
                <canvas id="adsr-canvas" style="width: 100%; height: 100%; display: block;"></canvas>
            </div>

            <div id="adsr-dashboard" style="display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 20px;"></div>
        `;

        const adsrDash = containerElement.querySelector('#adsr-dashboard');
        const looperDash = containerElement.querySelector('#looper-dashboard');
        const canvas = containerElement.querySelector('#adsr-canvas');
        const ctx2d = canvas.getContext('2d');

        const createKnob = (container, label, min, max, defaultValue, formatValue, onChange) => {
            const div = document.createElement('div');
            div.style = "display: flex; flex-direction: column; align-items: center; user-select: none; width: 70px;";
            const radius = 25, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            div.innerHTML = `
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
            const wrapper = div.querySelector('.knob-wrapper'), valuePath = div.querySelector('.knob-value-path'), indicator = div.querySelector('.knob-indicator'), display = div.querySelector('.knob-value-display');
            let currentValue = defaultValue;

            const updateUI = (value) => {
                const normalized = (value - min) / (max - min);
                valuePath.setAttribute('stroke-dasharray', `${normalized * maxDash} ${circumference}`);
                indicator.style.transform = `rotate(${-135 + (normalized * 270)}deg)`;
                display.innerText = formatValue(value);
            };
            updateUI(currentValue); container.appendChild(div);

            let isDragging = false, startY = 0, startValue = 0;
            const startDrag = (y) => { isDragging = true; startY = y; startValue = currentValue; document.body.style.cursor = 'ns-resize'; };
            const doDrag = (y) => {
                if (!isDragging) return;
                let newVal = startValue + (((startY - y) / 100) * (max - min));
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

        const startIn = containerElement.querySelector('#loop-start-in');
        const endIn = containerElement.querySelector('#loop-end-in');
        
        this.uiElements.startIn = startIn;
        this.uiElements.endIn = endIn;

        startIn.addEventListener('change', (e) => this.loopStartTime = parseFloat(e.target.value));
        endIn.addEventListener('change', (e) => this.loopEndTime = parseFloat(e.target.value));
        
        containerElement.querySelector('#btn-apply-loop').addEventListener('click', () => {
            this.loopStartTime = parseFloat(startIn.value);
            this.loopEndTime = parseFloat(endIn.value);
            this.createCrossfadeLoop();
        });

        this.knobs['length'] = createKnob(looperDash, 'Length', 0.1, 4.0, (this.loopEndTime - this.loopStartTime), (v) => v.toFixed(2) + ' s', (v) => {
            this.loopEndTime = this.loopStartTime + v;
            endIn.value = this.loopEndTime.toFixed(2);
        });

        this.knobs['crossfade'] = createKnob(looperDash, 'X-Fade', 0.0, 1.0, this.crossfadeTime, (v) => Math.round(v * 1000) + ' ms', (v) => this.crossfadeTime = v);
        this.knobs['looperMix'] = createKnob(looperDash, 'Loop Vol', 0.0, 1.0, this.looperMix, (v) => Math.round(v * 100) + ' %', (v) => { this.looperMix = v; this.updateMix(); });

        this.knobs['rate'] = createKnob(adsrDash, 'Rate', 0.5, 10.0, this.rate, (v) => v.toFixed(1) + ' Hz', (v) => this.rate = v);
        this.knobs['attack'] = createKnob(adsrDash, 'Attack', 0.001, 1.0, this.attack, (v) => Math.round(v * 1000) + ' ms', (v) => this.attack = v);
        this.knobs['decay'] = createKnob(adsrDash, 'Decay', 0.01, 1.0, this.decay, (v) => Math.round(v * 1000) + ' ms', (v) => this.decay = v);
        this.knobs['sustain'] = createKnob(adsrDash, 'Sustain', 0.0, 1.0, this.sustain, (v) => Math.round(v * 100) + ' %', (v) => this.sustain = v);
        this.knobs['release'] = createKnob(adsrDash, 'Release', 0.01, 2.0, this.release, (v) => Math.round(v * 1000) + ' ms', (v) => this.release = v);

        // KORJAUS 4: Estetään kankaan hävittämisbugi
        let mountCheckCount = 0;

        const drawCanvas = () => {
            mountCheckCount++;
            // Annetaan kankaan latautua HTML:ään rauhassa (noin 10 framea on turvallinen viive)
            if (!document.body.contains(canvas) && mountCheckCount > 10) {
                this.isPlaying = false; 
                clearInterval(this.schedulerTimer);
                if (this.looperSource) try { this.looperSource.stop(); } catch(e){}
                return; 
            }

            const parent = canvas.parentElement;
            if (parent && (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight)) {
                canvas.width = parent.clientWidth || 400;
                canvas.height = parent.clientHeight || 100;
            }

            const w = canvas.width, h = canvas.height;
            if (!w || !h) return requestAnimationFrame(drawCanvas);

            ctx2d.clearRect(0, 0, w, h);

            ctx2d.strokeStyle = 'rgba(255,255,255,0.05)'; ctx2d.lineWidth = 1; ctx2d.beginPath();
            ctx2d.moveTo(0, h/2); ctx2d.lineTo(w, h/2); ctx2d.stroke();

            const cycleLength = 1.0 / this.rate, gateLength = cycleLength * 0.5;
            let a = Math.min(this.attack, gateLength), d = Math.min(this.decay, gateLength - a), r = Math.min(this.release, cycleLength - gateLength);

            const timeToX = (t) => (t / cycleLength) * w;
            const valToY = (val) => h - (val * (h - 20)) - 10; 

            const p0x = 0, p0y = valToY(0);
            const p1x = timeToX(a), p1y = valToY(1.0);
            const p2x = timeToX(a + d), p2y = valToY(this.sustain);
            const p3x = timeToX(gateLength), p3y = valToY(this.sustain);
            const p4x = timeToX(gateLength + r), p4y = valToY(0);

            ctx2d.beginPath(); ctx2d.moveTo(p0x, h); ctx2d.lineTo(p0x, p0y); ctx2d.lineTo(p1x, p1y);
            ctx2d.quadraticCurveTo(p1x + (p2x - p1x) * 0.1, p2y, p2x, p2y);
            ctx2d.lineTo(p3x, p3y); ctx2d.lineTo(p4x, p4y); ctx2d.lineTo(w, h); 
            ctx2d.fillStyle = 'rgba(204, 255, 0, 0.15)'; ctx2d.fill();

            ctx2d.beginPath(); ctx2d.moveTo(p0x, p0y); ctx2d.lineTo(p1x, p1y);
            ctx2d.quadraticCurveTo(p1x + (p2x - p1x) * 0.1, p2y, p2x, p2y);
            ctx2d.lineTo(p3x, p3y); ctx2d.lineTo(p4x, p4y);
            ctx2d.strokeStyle = color; ctx2d.lineWidth = 3; ctx2d.stroke();

            const elapsed = this.ctx.currentTime % cycleLength; 
            const playheadX = (elapsed / cycleLength) * w;

            ctx2d.beginPath(); ctx2d.moveTo(playheadX, 0); ctx2d.lineTo(playheadX, h);
            ctx2d.strokeStyle = 'rgba(255, 255, 255, 0.8)'; ctx2d.lineWidth = 2; ctx2d.setLineDash([5, 5]); ctx2d.stroke(); ctx2d.setLineDash([]);

            ctx2d.beginPath();
            ctx2d.arc(playheadX, valToY(this.envelopeGain.gain.value), 6, 0, Math.PI * 2);
            ctx2d.fillStyle = '#fff'; ctx2d.fill();
            ctx2d.shadowBlur = 10; ctx2d.shadowColor = '#fff'; ctx2d.shadowBlur = 0;

            requestAnimationFrame(drawCanvas);
        };
        drawCanvas();
    }
}