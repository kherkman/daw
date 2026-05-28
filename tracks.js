(function(global) {
    "use strict";

    class TrackGroup {
        constructor(id, name) {
            this.id = id; this.name = name; this.fx = global.createDefaultFX(); this.customFX = []; this.customFxDom = document.createElement('div'); this.customFxDom.className = 'custom-fx-list';
            this.isMuted = false; this.isCollapsed = false; this.isSelected = false; this.liveNodes = null; 
            this.analyserL = global.audioCtx.createAnalyser(); this.analyserL.fftSize = 1024;
            this.analyserR = global.audioCtx.createAnalyser(); this.analyserR.fftSize = 1024;
            this.sidechainSource = ""; global.scBusses.set(this.id, global.audioCtx.createGain());
            this.createUI();
        }
        createUI() {
            this.DOM = document.createElement('div'); this.DOM.className = 'group-container'; this.DOM.id = `group-container-${this.id}`;
            this.header = document.createElement('div'); this.header.className = 'track group-header';
            this.header.innerHTML = `
                <div class="track-controls">
                    <input type="text" id="name-input-${this.id}" class="track-name-input group-name-input" value="${this.name.replace(/"/g, '&quot;')}">
                    <div class="meter-container">
                        <canvas id="meterL-${this.id}" class="vu-meter" style="height:4px;"></canvas>
                        <canvas id="meterR-${this.id}" class="vu-meter" style="height:4px; margin-top:2px;"></canvas>
                    </div>
                    <div class="control-row">
                        <input type="checkbox" id="cb-${this.id}" class="track-select-cb">
                        <button id="mute-${this.id}" class="track-btn mute-btn">M</button>
                        <button onclick="openEQ('${this.id}', true)" class="track-btn">FX</button>
                        <button id="collapse-btn-${this.id}" class="track-btn primary">[-]</button>
                    </div>
                </div>`;
            this.lane = document.createElement('div'); this.lane.className = 'waveform-lane'; this.canvas = document.createElement('canvas'); this.canvas.style.display = 'none';
            this.lane.appendChild(this.canvas); this.header.appendChild(this.lane);
            this.tracksArea = document.createElement('div'); this.tracksArea.className = 'group-tracks-area'; this.tracksArea.id = `group-tracks-${this.id}`;
            this.DOM.append(this.header, this.tracksArea);
            this.DOM.querySelector(`#name-input-${this.id}`).onchange = e => { this.name = e.target.value; global.saveState(); };
            this.DOM.querySelector(`#cb-${this.id}`).onchange = e => { this.isSelected = e.target.checked; global.updateSelectionCount(); };
            this.muteBtn = this.DOM.querySelector(`#mute-${this.id}`); this.muteBtn.onclick = () => { this.isMuted = !this.isMuted; global.updateMuteVisuals(); global.saveState(); };
            this.DOM.querySelector(`#collapse-btn-${this.id}`).onclick = () => { this.isCollapsed = !this.isCollapsed; this.updateVisuals(); global.saveState(); };
        }
        updateVisuals() {
            this.tracksArea.style.display = this.isCollapsed ? 'none' : 'block'; document.getElementById(`collapse-btn-${this.id}`).innerText = this.isCollapsed ? '[+]' : '[-]';
            this.canvas.style.display = this.isCollapsed ? 'block' : 'none'; this.muteBtn.className = 'track-btn mute-btn ' + (this.isMuted ? 'active' : '');
            if(this.isCollapsed) this.drawCombinedWaveform();
        }
        drawCombinedWaveform() {
            if(!this.isCollapsed) return; 
            const dur = Math.max(global.getMaxDOMEnd(), 10); 
            const fullPx = dur * global.PIXELS_PER_SECOND;
            this.canvas.style.width = fullPx + 'px';
            this.canvas.width = Math.min(fullPx, 32000);
            const scaleX = this.canvas.width / fullPx;
            
            const h = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--track-height')) || 110; 
            this.canvas.height = h - 20;
            const ctx = this.canvas.getContext('2d'); ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); ctx.globalCompositeOperation = 'lighter';
            global.tracks.filter(t => t.groupId === this.id && !t.isMuted && !t.isMidi).forEach(t => {
                const rate = (t.fx && t.fx.playbackRate) ? t.fx.playbackRate : 1.0;
                const startX = t.startTimeOffset * global.PIXELS_PER_SECOND; 
                const sx = (t.trimStart / rate) * global.PIXELS_PER_SECOND; 
                const sw = ((t.trimEnd - t.trimStart) / rate) * global.PIXELS_PER_SECOND;
                if(sw > 0) { 
                    try { 
                        const t_fullPx = (t.buffer.duration / rate) * global.PIXELS_PER_SECOND;
                        const t_scaleX = t.canvas.width / t_fullPx;
                        ctx.drawImage(t.canvas, sx * t_scaleX, 0, sw * t_scaleX, t.canvas.height, (startX + sx) * scaleX, 0, sw * scaleX, this.canvas.height); 
                    } catch(e){} 
                }
            }); ctx.globalCompositeOperation = 'source-over';
        }
    }

    class Track {
        constructor(id, file, buffer, name) {
            this.id = id; this.file = file; this.buffer = buffer; this.name = name || file.name; this.fileName = file.name; this.isMidi = false;
            this.fx = global.createDefaultFX(); this.customFX = []; this.customFxDom = document.createElement('div'); this.customFxDom.className = 'custom-fx-list';
            this.fadeIn = 0.0; this.fadeOut = 0.0; this.isMuted = false; this.isSelected = false; this.groupId = null;
            this.startTimeOffset = 0; this.trimStart = 0; this.trimEnd = buffer.duration;
            this.liveNodes = null; 
            this.analyserL = global.audioCtx.createAnalyser(); this.analyserL.fftSize = 1024;
            this.analyserR = global.audioCtx.createAnalyser(); this.analyserR.fftSize = 1024;
            this.source = null;
            this.sidechainSource = ""; global.scBusses.set(this.id, global.audioCtx.createGain());
            this.createUI();
        }
        createUI() {
            this.DOM = document.createElement('div'); this.DOM.className = 'track'; this.DOM.id = `track-${this.id}`;
            this.DOM.innerHTML = `
                <div class="track-controls">
                    <input type="text" id="name-input-${this.id}" class="track-name-input" value="${this.name.replace(/"/g, '&quot;')}">
                    <div class="meter-container">
                        <canvas id="meterL-${this.id}" class="vu-meter" style="height:4px;"></canvas>
                        <canvas id="meterR-${this.id}" class="vu-meter" style="height:4px; margin-top:2px;"></canvas>
                    </div>
                    <div class="control-row">
                        <input type="checkbox" id="cb-${this.id}" class="track-select-cb">
                        <button id="mute-${this.id}" class="track-btn mute-btn">M</button>
                        <button onclick="openEQ('${this.id}', false)" class="track-btn">FX</button>
                        <button onclick="duplicateTrack('${this.id}')" class="track-btn" style="background:#555;" title="Kopioi">Dpl</button>
                    </div>
                </div>`;
            const lane = document.createElement('div'); lane.className = 'waveform-lane';
            const clip = document.createElement('div'); clip.className = 'audio-clip'; this.canvas = document.createElement('canvas'); 
            const trimL = document.createElement('div'); trimL.className = 'trim-handle trim-start'; const trimR = document.createElement('div'); trimR.className = 'trim-handle trim-end';
            const maskL = document.createElement('div'); maskL.className = 'trim-mask-left'; const maskR = document.createElement('div'); maskR.className = 'trim-mask-right';
            const fadeIn = document.createElement('div'); fadeIn.className = 'fade-in-overlay'; const fadeOut = document.createElement('div'); fadeOut.className = 'fade-out-overlay';
            clip.append(this.canvas, maskL, maskR, fadeIn, fadeOut, trimL, trimR); lane.appendChild(clip); this.DOM.appendChild(lane);
            this.DOM.querySelector(`#name-input-${this.id}`).onchange = e => { this.name = e.target.value; global.saveState(); };
            this.DOM.querySelector(`#cb-${this.id}`).onchange = e => { this.isSelected = e.target.checked; global.updateSelectionCount(); };
            this.muteBtn = this.DOM.querySelector(`#mute-${this.id}`); this.muteBtn.onclick = () => { this.isMuted = !this.isMuted; global.updateMuteVisuals(); global.saveState(); };
            this.setupDrag(clip); this.setupTrim(trimL, 'start', clip, maskL); this.setupTrim(trimR, 'end', clip, maskR);
            this.canvas.width = Math.min(this.buffer.duration * global.PIXELS_PER_SECOND, 32000); 
            this.drawWaveform(this.canvas);
        }
        updateVisuals() { this.muteBtn.className = 'track-btn mute-btn ' + (this.isMuted ? 'active' : ''); }
        updateUIPlacements() {
            const el = this.DOM.querySelector('.audio-clip'); if(!el) return;
            const rate = (this.fx && this.fx.playbackRate) ? this.fx.playbackRate : 1.0;
            
            el.style.left = (this.startTimeOffset * global.PIXELS_PER_SECOND) + 'px'; 
            el.style.width = ((this.buffer.duration / rate) * global.PIXELS_PER_SECOND) + 'px';
            
            el.querySelector('.trim-mask-left').style.width = ((this.trimStart / rate) * global.PIXELS_PER_SECOND) + 'px'; 
            el.querySelector('.trim-mask-right').style.width = (((this.buffer.duration - this.trimEnd) / rate) * global.PIXELS_PER_SECOND) + 'px';
            
            el.querySelector('.trim-start').style.left = (((this.trimStart / rate) * global.PIXELS_PER_SECOND) - 10) + 'px'; 
            el.querySelector('.trim-end').style.right = ((((this.buffer.duration - this.trimEnd) / rate) * global.PIXELS_PER_SECOND) - 10) + 'px';
            
            el.querySelector('.fade-in-overlay').style.width = ((this.fadeIn / rate) * global.PIXELS_PER_SECOND) + 'px'; 
            el.querySelector('.fade-in-overlay').style.left = ((this.trimStart / rate) * global.PIXELS_PER_SECOND) + 'px';
            
            el.querySelector('.fade-out-overlay').style.width = ((this.fadeOut / rate) * global.PIXELS_PER_SECOND) + 'px'; 
            el.querySelector('.fade-out-overlay').style.right = (((this.buffer.duration - this.trimEnd) / rate) * global.PIXELS_PER_SECOND) + 'px';
        }
        drawWaveform(canvas) {
            const ctx = canvas.getContext('2d'); 
            const data = this.buffer.getChannelData(0); 
            const step = Math.ceil(data.length / canvas.width); 
            const centerY = canvas.height / 2;
            const scale = centerY * (this.fx.vol !== undefined ? this.fx.vol : 1.0);
            
            ctx.clearRect(0,0, canvas.width, canvas.height); 
            ctx.fillStyle = '#00bcd4'; 
            ctx.beginPath();
            
            for (let i = 0; i < canvas.width; i++) { 
                let min = 1.0, max = -1.0; 
                for (let j = 0; j < step; j++) { 
                    const v = data[(i * step) + j]; 
                    if (v < min) min = v; 
                    if (v > max) max = v; 
                } 
                ctx.fillRect(i, centerY + min * scale, 1, Math.max(1, (max - min) * scale)); 
            }
        }
        setupDrag(el) { let initLeft; global.addDragListener(el, { onStart: () => { initLeft = el.offsetLeft; }, onMove: (x, dx) => { let l = initLeft + dx; if (global.snapEnabled) { const beatDur = 60 / global.bpm; l = Math.round((l / global.PIXELS_PER_SECOND) / beatDur) * beatDur * global.PIXELS_PER_SECOND; } const rate = (this.fx && this.fx.playbackRate) ? this.fx.playbackRate : 1.0; this.startTimeOffset = Math.max(-(this.trimStart / rate), l / global.PIXELS_PER_SECOND); this.updateUIPlacements(); global.refreshTimeline(); }, onEnd: () => { global.saveState(); } }); }
        setupTrim(h, type, clip, mask) { global.addDragListener(h, { onMove: (x, dx) => { const rate = (this.fx && this.fx.playbackRate) ? this.fx.playbackRate : 1.0; const rect = clip.getBoundingClientRect(); const lx = x - rect.left; let t = (lx / global.PIXELS_PER_SECOND) * rate; if (t < 0) t = 0; if (t > this.buffer.duration) t = this.buffer.duration; if (type === 'start') { if (t >= this.trimEnd - 0.1) return; if (this.startTimeOffset + (t / rate) < 0) t = -this.startTimeOffset * rate; this.trimStart = t; } else { if (t <= this.trimStart + 0.1) return; this.trimEnd = t; } this.updateUIPlacements(); global.refreshTimeline(); }, onEnd: () => { global.saveState(); } }); }
        play(ctx, dest, startWhen, fileOffset, playDur) {
            const src = ctx.createBufferSource(); 
            src.buffer = this.buffer; 
            const rate = (this.fx && this.fx.playbackRate) ? this.fx.playbackRate : 1.0;
            src.playbackRate.value = rate; 
            
            const isLive = (ctx === global.audioCtx);
            const nodes = global.buildFXChain(ctx, src, dest, this.fx, isLive ? {split: true, nodeL: this.analyserL, nodeR: this.analyserR} : null, this.customFX, this.id, this.sidechainSource, isLive ? global.scBusses : arguments[5]);
            nodes.outGain.gain.setValueAtTime(this.isMuted ? 0 : this.fx.vol, startWhen);
            
            if (!this.isMuted) {
                if (this.fadeIn > 0) { 
                    const fiStart = startWhen + ((this.trimStart - fileOffset) / rate); 
                    nodes.outGain.gain.setValueAtTime(0, fiStart); 
                    nodes.outGain.gain.linearRampToValueAtTime(this.fx.vol, fiStart + (this.fadeIn / rate)); 
                }
                if (this.fadeOut > 0) { 
                    const foEnd = startWhen + ((this.trimEnd - fileOffset) / rate); 
                    nodes.outGain.gain.setValueAtTime(this.fx.vol, foEnd - (this.fadeOut / rate)); 
                    nodes.outGain.gain.linearRampToValueAtTime(0, foEnd); 
                }
            }
            if (isLive) { this.liveNodes = nodes; this.source = src; }
            src.start(startWhen, fileOffset, playDur * rate); 
        }
    }

    class MidiTrack {
        constructor(id, name) {
            this.id = id; this.name = name || "MIDI Raita"; this.isMidi = true; 
            this.fx = global.createDefaultFX(); this.customFX = []; this.customFxDom = document.createElement('div'); this.customFxDom.className = 'custom-fx-list';
            this.isMuted = false; this.isSelected = false; this.groupId = null; this.notes = []; 
            this.automation = { pitch: [], mod: [], pan: [] }; 
            this.sampler = new global.RoundRobinSampler();
            this.activeSources = []; 
            this.analyserL = global.audioCtx.createAnalyser(); this.analyserL.fftSize = 1024;
            this.analyserR = global.audioCtx.createAnalyser(); this.analyserR.fftSize = 1024;
            this.startTimeOffset = 0; this.contentDuration = 4.0; this.trimStart = 0; this.trimEnd = 4.0; 
            this.scheduledMidiEvents = []; 
            this.sidechainSource = ""; 
            this.midiInputSource = ""; 
            global.scBusses.set(this.id, global.audioCtx.createGain());
            this.createUI();
        }

        broadcastMidi(msg) {
            if (window.broadcastSidechainMidi) {
                window.broadcastSidechainMidi(this.id, msg);
            }
        }

        patchFxChain() {
            if (!this.customFX || this.customFX.length === 0) return;
            const lastFx = this.customFX[this.customFX.length - 1];
            
            // Estetään päällekkäiset kuuntelijat
            if (lastFx.sendMidi && lastFx.sendMidi.isDawPatched) return;
            
            const newSendMidi = (msg) => {
                let midiData = msg.data ? msg.data : msg;
                const [status, pitch, velocity] = midiData;
                const type = status & 0xf0;

                // 1. Piano Roll UI käsittely (jos tämä raita on valittu)
                if (window.pianoRollUI && window.pianoRollUI.activeTrack === this) {
                    window.pianoRollUI.handleGeneratedMidi(midiData);
                } else {
                    // 2. Taustasoitto samplerilla (jos raita ei ole aktiivisena käyttöliittymässä)
                    if (type === 0x90 && velocity > 0) {
                        if (global.audioCtx && global.masterBusInput && this.sampler) {
                            let srcInfo = this.sampler.playNote(global.audioCtx, global.masterBusInput, pitch, velocity, global.audioCtx.currentTime, 0, 10);
                            if (!this._fxPlayingNotes) this._fxPlayingNotes = {};
                            this._fxPlayingNotes[pitch] = srcInfo;
                        }
                    } else if (type === 0x80 || (type === 0x90 && velocity === 0)) {
                        if (this._fxPlayingNotes && this._fxPlayingNotes[pitch]) {
                            if (this.sampler) this.sampler.stopNote(this._fxPlayingNotes[pitch], global.audioCtx);
                            delete this._fxPlayingNotes[pitch];
                        }
                    }
                }

                // 3. Jaa eteenpäin sidechain-verkostolle (Mahdollistaa äänityksen toiselle raidalle efektin takaa)
                if (typeof this.broadcastMidi === 'function') {
                    this.broadcastMidi(midiData);
                }
            };
            
            newSendMidi.isDawPatched = true;
            lastFx.sendMidi = newSendMidi;
        }

        createUI() {
            this.DOM = document.createElement('div'); this.DOM.className = 'track midi-track'; this.DOM.id = `track-${this.id}`;
            this.DOM.innerHTML = `
                <div class="track-controls">
                    <input type="text" id="name-input-${this.id}" class="track-name-input" value="${this.name}" style="border-color:#4caf50;">
                    <div class="meter-container">
                        <canvas id="meterL-${this.id}" class="vu-meter" style="height:4px;"></canvas>
                        <canvas id="meterR-${this.id}" class="vu-meter" style="height:4px; margin-top:2px;"></canvas>
                    </div>
                    <div class="control-row">
                        <input type="checkbox" id="cb-${this.id}" class="track-select-cb">
                        <button id="mute-${this.id}" class="track-btn mute-btn">M</button>
                        <button onclick="window.pianoRollUI.open(masterTrackPool.get('${this.id}'))" class="track-btn primary" style="font-weight:bold;">Roll</button>
                        <button onclick="openEQ('${this.id}', false)" class="track-btn">FX</button>
                        <button onclick="duplicateTrack('${this.id}')" class="track-btn" style="background:#555;" title="Kopioi">Dpl</button>
                    </div>
                </div>`;
            this.lane = document.createElement('div'); this.lane.className = 'waveform-lane'; 
            this.midiRegion = document.createElement('div'); this.midiRegion.className = 'midi-region';
            this.canvas = document.createElement('canvas'); 
            
            const trimL = document.createElement('div'); trimL.className = 'trim-handle trim-start'; 
            const trimR = document.createElement('div'); trimR.className = 'trim-handle trim-end';
            const maskL = document.createElement('div'); maskL.className = 'trim-mask-left'; 
            const maskR = document.createElement('div'); maskR.className = 'trim-mask-right';
            
            this.midiRegion.append(this.canvas, maskL, maskR, trimL, trimR);
            this.lane.appendChild(this.midiRegion); this.DOM.appendChild(this.lane);
            
            this.DOM.querySelector(`#name-input-${this.id}`).onchange = e => { this.name = e.target.value; global.saveState(); };
            this.DOM.querySelector(`#cb-${this.id}`).onchange = e => { this.isSelected = e.target.checked; global.updateSelectionCount(); };
            this.muteBtn = this.DOM.querySelector(`#mute-${this.id}`); this.muteBtn.onclick = () => { this.isMuted = !this.isMuted; global.updateMuteVisuals(); global.saveState(); };
            
            this.midiRegion.addEventListener('dblclick', () => { global.pianoRollUI.open(this); });
            this.setupDrag(this.midiRegion); this.setupTrim(trimL, 'start', this.midiRegion, maskL); this.setupTrim(trimR, 'end', this.midiRegion, maskR);
            this.updateUIPlacements();
        }
        setupDrag(el) { let initLeft; global.addDragListener(el, { onStart: () => { initLeft = el.offsetLeft; }, onMove: (x, dx) => { let l = initLeft + dx; if (global.snapEnabled) { const beatDur = 60 / global.bpm; l = Math.round((l / global.PIXELS_PER_SECOND) / beatDur) * beatDur * global.PIXELS_PER_SECOND; } this.startTimeOffset = Math.max(-this.trimStart, l / global.PIXELS_PER_SECOND); this.updateUIPlacements(); global.refreshTimeline(); }, onEnd: () => { global.saveState(); } }); }
        setupTrim(h, type, clip, mask) { global.addDragListener(h, { onMove: (x, dx) => { const rect = clip.getBoundingClientRect(); const lx = x - rect.left; let t = lx / global.PIXELS_PER_SECOND; if (t < 0) t = 0; if (t > this.contentDuration) t = this.contentDuration; if (type === 'start') { if (t >= this.trimEnd - 0.1) return; if (this.startTimeOffset + t < 0) t = -this.startTimeOffset; this.trimStart = t; } else { if (t <= this.trimStart + 0.1) return; this.trimEnd = t; } this.updateUIPlacements(); global.refreshTimeline(); }, onEnd: () => { global.saveState(); } }); }
        updateVisuals() { 
            this.muteBtn.className = 'track-btn mute-btn ' + (this.isMuted ? 'active' : ''); 
            let maxEnd = 4; this.notes.forEach(n => { if(n.start + n.duration > maxEnd) maxEnd = n.start + n.duration; });
            if(maxEnd > this.contentDuration) { if(this.trimEnd >= this.contentDuration - 0.1) this.trimEnd = maxEnd; this.contentDuration = maxEnd; }
            this.updateUIPlacements(); this.drawNotes();
        }
        updateUIPlacements() { 
            this.midiRegion.style.left = (this.startTimeOffset * global.PIXELS_PER_SECOND) + 'px'; this.midiRegion.style.width = (this.contentDuration * global.PIXELS_PER_SECOND) + 'px';
            this.midiRegion.querySelector('.trim-mask-left').style.width = (this.trimStart * global.PIXELS_PER_SECOND) + 'px'; this.midiRegion.querySelector('.trim-mask-right').style.width = ((this.contentDuration - this.trimEnd) * global.PIXELS_PER_SECOND) + 'px';
            this.midiRegion.querySelector('.trim-start').style.left = ((this.trimStart * global.PIXELS_PER_SECOND) - 10) + 'px'; this.midiRegion.querySelector('.trim-end').style.right = (((this.contentDuration - this.trimEnd) * global.PIXELS_PER_SECOND) - 10) + 'px'; 
        }
        drawNotes() {
            const fullPx = this.contentDuration * global.PIXELS_PER_SECOND;
            this.canvas.width = Math.min(fullPx, 32000);
            const scaleX = this.canvas.width / fullPx;
            const h = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--track-height')) || 110; this.canvas.height = h - 20;
            const ctx = this.canvas.getContext('2d'); ctx.clearRect(0,0, this.canvas.width, this.canvas.height); 
            this.notes.forEach(n => { 
                const x = n.start * global.PIXELS_PER_SECOND * scaleX; 
                const w = Math.max(2, n.duration * global.PIXELS_PER_SECOND * scaleX); 
                const y = this.canvas.height - Math.max(4, ((n.pitch / 127) * this.canvas.height)); 
                const alpha = 0.3 + (n.velocity / 127) * 0.7;
                ctx.fillStyle = `rgba(76, 175, 80, ${alpha})`;
                ctx.fillRect(x, y, w, 4); 
            });
        }
    }

    global.TrackGroup = TrackGroup;
    global.Track = Track;
    global.MidiTrack = MidiTrack;

})(typeof window !== 'undefined' ? window : this);