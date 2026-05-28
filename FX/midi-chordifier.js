window.CustomAudioEffect = class ChordifierEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;

        // Reititys (Audio menee suoraan läpi muuttumattomana, efekti tuottaa MIDIä)
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.input.connect(this.output);
        
        this.sidechainInput = audioCtx.createGain();

        // 12 nuotin tila (Pitch Classes 0-11). Oletus: C Major (C, D, E, F, G, A, B)
        this.activePitchClasses = new Set([0, 2, 4, 5, 7, 9, 11]);
        this.NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

        // Asteikkojen rakenteet tunnistusta varten
        this.SCALE_DICTIONARY = [
            { name: "Major", intervals: [0,2,4,5,7,9,11] },
            { name: "Minor", intervals: [0,2,3,5,7,8,10] },
            { name: "Harm. Min", intervals: [0,2,3,5,7,8,11] },
            { name: "Mel. Min", intervals: [0,2,3,5,7,9,11] },
            { name: "Dorian", intervals: [0,2,3,5,7,9,10] },
            { name: "Mixolydian", intervals: [0,2,4,5,7,9,10] }
        ];

        // Tila- ja seurantamuuttujat
        this.autoScaleMode = false;
        this.melodyNoteHistory = []; 
        
        this.currentScaleRoot = 0; // Oletus: C
        this.currentScaleScale = this.SCALE_DICTIONARY[0]; // Oletus: Major
        
        this.currentMelodyNote = -1; 
        this.currentVelocity = 0;
        this.currentChordNotes = []; 
        this.currentChordPCs = { root: -1, third: -1, fifth: -1 }; 
        
        this.chordProgression = [];
        this.lastPlayedChordName = "";

        this.uiElements = {};

        this._initWorklet();
    }

    // --- STANDARD DAW METHODS ---

    getNodes() { 
        return { input: this.input, output: this.output, sidechain: this.sidechainInput }; 
    }

    getState() {
        return {
            activePitchClasses: Array.from(this.activePitchClasses),
            autoScaleMode: this.autoScaleMode,
            currentScaleRoot: this.currentScaleRoot
        };
    }

    setState(state) {
        if (state) {
            if (state.activePitchClasses) this.activePitchClasses = new Set(state.activePitchClasses);
            if (state.autoScaleMode !== undefined) this.autoScaleMode = state.autoScaleMode;
            if (state.currentScaleRoot !== undefined) this.currentScaleRoot = state.currentScaleRoot;
            if (this.uiElements.buttons) {
                this.updateScaleDisplay();
                this.updateUI();
            }
        }
    }

    // --- MIDI I/O ---

    onMidi(msg) {
        // Lähetetään alkuperäinen MIDI läpi (pass-through)
        if (typeof this.onMidiOut === 'function') {
            this.onMidiOut(msg);
        }

        // MIDI Transport: Resetoi sointunäyttö kun DAW:n Play/Continue -nappia painetaan
        if (msg[0] === 0xFA || msg[0] === 0xFB) {
            this.clearProgression();
        }

        const status = msg[0] & 0xF0;
        const note = msg[1];
        const velocity = msg[2];

        // Luetaan nuotit ja luodaan soinnut
        if (status === 0x90 && velocity > 0) { 
            this.handleMelodyNoteOn(note, velocity / 127.0);
        } else if (status === 0x80 || (status === 0x90 && velocity === 0)) { 
            this.handleMelodyNoteOff(note);
        }
    }

    emitMidi(msg) {
        if (typeof this.sendMidi === 'function') {
            this.sendMidi(msg);
        } else if (typeof this.onMidiOut === 'function') {
            this.onMidiOut(msg);
        }
    }

    // --- AUDIO WORKLET PITCH DETECTION ---

    async _initWorklet() {
        const workletCode = `
            class ChordifierPitchProcessor extends AudioWorkletProcessor {
                constructor() {
                    super();
                    this.bufferSize = 4096;
                    this.buffer = new Float32Array(this.bufferSize);
                    this.writePos = 0;
                    this.currentNote = -1;
                    this.stableFrames = 0;
                    this.silenceFrames = 0;
                    this.rmsThreshold = 0.01;
                }

                detectPitch() {
                    let sumSq = 0;
                    for(let i = 0; i < 1024; i++) {
                        let idx = (this.writePos - 1 - i + this.bufferSize) % this.bufferSize;
                        sumSq += this.buffer[idx] * this.buffer[idx];
                    }
                    const rms = Math.sqrt(sumSq / 1024);

                    if (rms < this.rmsThreshold) return { hz: 0, rms }; 

                    let minDiff = Infinity;
                    let bestPeriod = 0;
                    const minPeriod = Math.floor(sampleRate / 1200); 
                    const maxPeriod = Math.floor(sampleRate / 60);   

                    for (let period = minPeriod; period < maxPeriod; period++) {
                        let diff = 0;
                        for (let i = 0; i < 512; i++) {
                            let idx1 = (this.writePos - 1 - i + this.bufferSize) % this.bufferSize;
                            let idx2 = (this.writePos - 1 - i - period + this.bufferSize) % this.bufferSize;
                            diff += Math.abs(this.buffer[idx1] - this.buffer[idx2]);
                        }
                        if (diff < minDiff) {
                            minDiff = diff;
                            bestPeriod = period;
                        }
                    }
                    
                    const avgDiff = minDiff / 512;
                    const confidence = 1.0 - (avgDiff / (rms * 2.0));

                    if (confidence > 0.4) {
                        return { hz: sampleRate / bestPeriod, rms };
                    }
                    return { hz: 0, rms };
                }

                hzToMidi(hz) { return 69 + 12 * Math.log2(hz / 440); }

                process(inputs, outputs) {
                    let hasData = false;
                    
                    if (inputs[0] && inputs[0].length > 0 && inputs[0][0].length > 0) hasData = true;
                    if (inputs[1] && inputs[1].length > 0 && inputs[1][0].length > 0) hasData = true;

                    if (!hasData) return true;

                    const channelData = (inputs[0] && inputs[0].length > 0) ? inputs[0][0] : inputs[1][0];
                    if (channelData) {
                        for (let i = 0; i < channelData.length; i++) {
                            let val = channelData[i] || 0;
                            if (inputs[1] && inputs[1].length > 0 && inputs[1][0]) {
                                val += inputs[1][0][i] || 0;
                            }
                            this.buffer[this.writePos] = val;
                            this.writePos = (this.writePos + 1) % this.bufferSize;
                        }
                    }

                    const { hz, rms } = this.detectPitch();

                    if (hz > 0) {
                        this.silenceFrames = 0;
                        const targetMidi = Math.round(this.hzToMidi(hz));
                        
                        if (targetMidi !== this.currentNote) {
                            this.stableFrames++;
                            if (this.stableFrames >= 3) { 
                                if (this.currentNote !== -1) {
                                    this.port.postMessage({ action: 'noteOff', note: this.currentNote });
                                }
                                let velocity = Math.min(1.0, Math.max(0.1, rms * 10));
                                this.port.postMessage({ action: 'noteOn', note: targetMidi, velocity: velocity });
                                this.currentNote = targetMidi;
                                this.stableFrames = 0;
                            }
                        } else {
                            this.stableFrames = 0;
                        }
                    } else {
                        this.silenceFrames++;
                        this.stableFrames = 0;
                        if (this.silenceFrames >= 5 && this.currentNote !== -1) {
                            this.port.postMessage({ action: 'noteOff', note: this.currentNote });
                            this.currentNote = -1;
                        }
                    }
                    return true;
                }
            }
            registerProcessor('chordifier-pitch-processor', ChordifierPitchProcessor);
        `;

        const dataUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(workletCode);
        try {
            await this.ctx.audioWorklet.addModule(dataUrl);
            this.worklet = new AudioWorkletNode(this.ctx, 'chordifier-pitch-processor', { numberOfInputs: 2 });
            this.worklet.port.onmessage = (e) => {
                if (e.data.action === 'noteOn') this.handleMelodyNoteOn(e.data.note, e.data.velocity);
                else if (e.data.action === 'noteOff') this.handleMelodyNoteOff(e.data.note);
            };
            
            this.input.connect(this.worklet, 0, 0);
            this.sidechainInput.connect(this.worklet, 0, 1);
        } catch (e) {
            console.error("Chordifier Worklet load failed:", e);
        }
    }

    // --- CHORD GENERATION LOGIC ---

    handleMelodyNoteOn(midiNote, velocity) {
        if (this.currentMelodyNote !== -1 && this.currentMelodyNote !== midiNote) {
            this.handleMelodyNoteOff(this.currentMelodyNote);
        }

        this.currentMelodyNote = midiNote;
        
        this.melodyNoteHistory.push({ pc: midiNote % 12, time: Date.now() });
        
        if (this.autoScaleMode) {
            // Päivittää tarvittaessa asteikon ennen soinnun laskemista
            this.recognizeScaleAndUpdate();
        }

        const chordResult = this.calculateBestChord(midiNote);
        if (chordResult) {
            this.playChord(chordResult.notes, chordResult.roles, velocity);
        } else {
            this.playChord([midiNote], { root: -1, third: -1, fifth: -1 }, velocity);
        }
    }

    handleMelodyNoteOff(midiNote) {
        if (this.currentMelodyNote === midiNote) {
            this.currentMelodyNote = -1;
            this.stopCurrentChord();
        }
    }

    playChord(midiNotesArray, roles, velocity) {
        this.stopCurrentChord(); 
        
        const velByte = Math.floor(velocity * 127);
        this.currentChordNotes = midiNotesArray;
        this.currentChordPCs = roles;
        this.currentVelocity = velocity;

        // Lisää sointu näyttöön
        if (roles.root !== -1) {
            const chordName = this.getChordName(roles.root, roles.third, roles.fifth);
            const romanNum = this.getRomanNumeral(roles.root, roles.third, roles.fifth);
            const label = `${chordName} (${romanNum})`;
            
            if (this.lastPlayedChordName !== label) {
                this.chordProgression.push(label);
                this.lastPlayedChordName = label;
                this.updateProgressionUI();
            }
        }

        this.currentChordNotes.forEach(note => {
            this.emitMidi([0x90, note, velByte]);
        });
        
        this.updateUI();
    }

    stopCurrentChord() {
        this.currentChordNotes.forEach(note => {
            this.emitMidi([0x80, note, 0]);
        });
        this.currentChordNotes = [];
        this.currentChordPCs = { root: -1, third: -1, fifth: -1 };
        this.updateUI();
    }

    calculateBestChord(melodyMidi) {
        const mPC = melodyMidi % 12;
        let candidates = [];

        for (let r = 0; r < 12; r++) {
            if (!this.activePitchClasses.has(r)) continue;

            const tMaj = (r + 4) % 12;
            const tMin = (r + 3) % 12;
            const fPerf = (r + 7) % 12;
            const fDim = (r + 6) % 12;

            let validThirds = [];
            if (this.activePitchClasses.has(tMaj)) validThirds.push({ pc: tMaj, type: 'maj' });
            if (this.activePitchClasses.has(tMin)) validThirds.push({ pc: tMin, type: 'min' });

            let validFifths = [];
            if (this.activePitchClasses.has(fPerf)) validFifths.push({ pc: fPerf, type: 'perf' });
            if (this.activePitchClasses.has(fDim)) validFifths.push({ pc: fDim, type: 'dim' });

            for (let t of validThirds) {
                for (let f of validFifths) {
                    const triadPCs = [r, t.pc, f.pc];
                    if (triadPCs.includes(mPC)) {
                        candidates.push({
                            root: r,
                            third: t.pc,
                            fifth: f.pc,
                            tType: t.type,
                            fType: f.type
                        });
                    }
                }
            }
        }

        if (candidates.length === 0) return null; 

        let bestCandidate = null;
        let maxScore = -Infinity;
        const prevPCs = this.currentChordNotes.map(n => n % 12);

        for (let c of candidates) {
            let score = 0;

            if (prevPCs.includes(c.root)) score += 10;
            if (prevPCs.includes(c.third)) score += 10;
            if (prevPCs.includes(c.fifth)) score += 10;

            if (c.tType === 'maj') score += 2;
            if (c.tType === 'min') score += 1;
            if (c.fType === 'perf') score += 2;

            if (c.root === mPC) score += 0.3;
            else if (c.fifth === mPC) score += 0.2;
            else if (c.third === mPC) score += 0.1;

            if (score > maxScore) {
                maxScore = score;
                bestCandidate = c;
            }
        }

        const outputNotes = [melodyMidi];
        const neededPCs = [bestCandidate.root, bestCandidate.third, bestCandidate.fifth].filter(pc => pc !== mPC);
        
        let prevCenterMidi = melodyMidi - 12; 
        if (this.currentChordNotes.length > 0) {
            const sum = this.currentChordNotes.reduce((a, b) => a + b, 0);
            prevCenterMidi = sum / this.currentChordNotes.length;
        }

        neededPCs.forEach(targetPC => {
            let bestNote = -1;
            let minDistance = Infinity;

            for (let oct = -2; oct <= 1; oct++) {
                const testNote = (Math.floor(melodyMidi / 12) + oct) * 12 + targetPC;
                const distance = Math.abs(testNote - prevCenterMidi);
                if (testNote > melodyMidi + 7) continue; 

                if (distance < minDistance) {
                    minDistance = distance;
                    bestNote = testNote;
                }
            }
            
            if (bestNote === -1) {
                const baseOct = Math.floor(melodyMidi / 12);
                bestNote = (baseOct - 1) * 12 + targetPC;
            }
            outputNotes.push(bestNote);
        });

        outputNotes.sort((a, b) => a - b);

        return {
            notes: outputNotes,
            roles: {
                root: bestCandidate.root,
                third: bestCandidate.third,
                fifth: bestCandidate.fifth
            }
        };
    }

    recognizeScaleAndUpdate() {
        const now = Date.now();
        this.melodyNoteHistory = this.melodyNoteHistory.filter(n => now - n.time < 15000); 
        
        if (this.melodyNoteHistory.length < 5) return; 

        const playedPCs = Array.from(new Set(this.melodyNoteHistory.map(n => n.pc)));
        let bestMatchRoot = 0;
        let bestMatchScale = null;
        let highestScore = -Infinity;

        for (let root = 0; root < 12; root++) {
            for (let scale of this.SCALE_DICTIONARY) {
                let score = 0;
                const scalePCs = scale.intervals.map(i => (root + i) % 12);
                
                for (let pc of playedPCs) {
                    if (scalePCs.includes(pc)) score += 1.0;
                    else score -= 1.5; 
                }

                if (score > highestScore) {
                    highestScore = score;
                    bestMatchRoot = root;
                    bestMatchScale = scale;
                }
            }
        }

        if (highestScore > (playedPCs.length * 0.5)) {
            const newActive = new Set(bestMatchScale.intervals.map(i => (bestMatchRoot + i) % 12));
            let changed = false;
            
            if (this.activePitchClasses.size !== newActive.size) changed = true;
            else {
                for (let a of this.activePitchClasses) {
                    if (!newActive.has(a)) { changed = true; break; }
                }
            }

            if (changed) {
                this.activePitchClasses = newActive;
                this.currentScaleRoot = bestMatchRoot;
                this.currentScaleScale = bestMatchScale;
                
                this.updateScaleDisplay();
                this.updateUI();
                // Emme enää kutsu recalculateCurrentNote() tässä, koska handleMelodyNoteOn 
                // jatkaa automaattisesti eteenpäin ja soittaa uuden soinnun päivitetyllä asteikolla.
            }
        }
    }

    shiftScale(direction) {
        const newActive = new Set();
        for (let pc of this.activePitchClasses) {
            newActive.add((pc + direction + 12) % 12);
        }
        this.activePitchClasses = newActive;
        this.currentScaleRoot = (this.currentScaleRoot + direction + 12) % 12;
        
        if (this.autoScaleMode) {
            this.autoScaleMode = false;
            if (this.uiElements.autoScaleBtn) {
                this.uiElements.autoScaleBtn.classList.remove('active');
                this.uiElements.autoScaleBtn.innerText = 'Auto-Scale: OFF';
            }
        }

        this.updateScaleDisplay();
        this.updateUI();
        this.recalculateCurrentNote();
    }

    recalculateCurrentNote() {
        if (this.currentMelodyNote !== -1) {
            const chordResult = this.calculateBestChord(this.currentMelodyNote);
            if (chordResult) {
                this.playChord(chordResult.notes, chordResult.roles, this.currentVelocity || 0.8);
            }
        }
    }

    clearProgression() {
        this.chordProgression = [];
        this.lastPlayedChordName = "";
        this.updateProgressionUI();
    }

    // --- NIMET JA ROOLIT ---

    getChordName(root, third, fifth) {
        if (root === -1) return "";
        let name = this.NOTE_NAMES[root];
        if (third !== -1 && fifth !== -1) {
            const isMinor = ((third - root + 12) % 12) === 3;
            const isDim = ((fifth - root + 12) % 12) === 6;
            const isAug = ((fifth - root + 12) % 12) === 8;
            if (isMinor && !isDim) name += "m";
            if (isDim) name += "dim";
            if (isAug) name += "aug";
        }
        return name;
    }

    getRomanNumeral(root, third, fifth) {
        if (root === -1 || third === -1) return "";
        const isMajor = ((third - root + 12) % 12) === 4;
        const isDim = ((fifth - root + 12) % 12) === 6;
        const isAug = ((fifth - root + 12) % 12) === 8;

        const diff = (root - this.currentScaleRoot + 12) % 12;
        const bases = ['i', 'bii', 'ii', 'biii', 'iii', 'iv', 'bv', 'v', 'bvi', 'vi', 'bvii', 'vii'];
        let numeral = bases[diff];
        
        if (isMajor || isAug) numeral = numeral.toUpperCase();
        if (isDim) numeral += '°';
        else if (isAug) numeral += '+';
        
        return numeral;
    }

    // --- KÄYTTÖLIITTYMÄ ---

    updateScaleDisplay() {
        if (this.uiElements.scaleNameDisplay) {
            const scaleName = this.currentScaleScale ? this.currentScaleScale.name : "Custom";
            this.uiElements.scaleNameDisplay.innerText = `${this.NOTE_NAMES[this.currentScaleRoot]} ${scaleName}`;
        }
    }

    updateProgressionUI() {
        if (this.uiElements.progressionDisplay) {
            this.uiElements.progressionDisplay.innerText = this.chordProgression.join(" - ") || "Waiting for chords...";
            this.uiElements.progressionDisplay.scrollLeft = this.uiElements.progressionDisplay.scrollWidth;
        }
    }

    updateUI() {
        if (!this.uiElements.buttons) return;

        const mPC = this.currentMelodyNote !== -1 ? this.currentMelodyNote % 12 : -1;

        for (let i = 0; i < 12; i++) {
            const btn = this.uiElements.buttons[i];
            const isActive = this.activePitchClasses.has(i);
            
            btn.style.boxShadow = 'none';
            btn.style.border = '1px solid #333';
            btn.style.opacity = isActive ? '1' : '0.4';
            btn.style.backgroundColor = isActive ? '#1a1a24' : '#0a0a0f';
            btn.style.color = '#8b8b9f';

            if (this.currentChordNotes.length > 0) {
                if (i === this.currentChordPCs.root) {
                    btn.style.backgroundColor = 'rgba(0, 255, 0, 0.2)';
                    btn.style.border = '1px solid #00ff00';
                    btn.style.color = '#00ff00';
                    btn.style.boxShadow = 'inset 0 0 10px rgba(0, 255, 0, 0.5)';
                } else if (i === this.currentChordPCs.third) {
                    btn.style.backgroundColor = 'rgba(255, 170, 0, 0.2)';
                    btn.style.border = '1px solid #ffaa00';
                    btn.style.color = '#ffaa00';
                    btn.style.boxShadow = 'inset 0 0 10px rgba(255, 170, 0, 0.5)';
                } else if (i === this.currentChordPCs.fifth) {
                    btn.style.backgroundColor = 'rgba(0, 136, 255, 0.2)';
                    btn.style.border = '1px solid #0088ff';
                    btn.style.color = '#0088ff';
                    btn.style.boxShadow = 'inset 0 0 10px rgba(0, 136, 255, 0.5)';
                }
            } else if (isActive) {
                btn.style.color = '#00ffff';
                btn.style.border = '1px solid rgba(0, 255, 255, 0.3)';
            }

            if (i === mPC) {
                btn.style.border = '2px solid #ffffff';
                btn.style.boxShadow = '0 0 15px #ffffff, inset 0 0 10px #ffffff';
                btn.style.color = '#ffffff';
                btn.style.fontWeight = 'bold';
            } else {
                btn.style.fontWeight = 'normal';
            }
        }
    }

    renderUI(containerElement) {
        const styleId = 'fx-chordifier-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .chord-panel { background: #0a0a0a; padding: 15px; border-radius: 8px; border: 1px solid #333; display: flex; flex-direction: column; gap: 12px; box-shadow: inset 0 0 20px rgba(0,0,0,0.8); font-family: sans-serif;}
                .chord-top-bar { display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.3); padding: 8px 15px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); }
                .chord-header { color: #00ffff; font-weight: bold; letter-spacing: 3px; font-size: 14px; text-shadow: 0 0 10px rgba(0,255,255,0.5); }
                
                .chord-controls { display: flex; align-items: center; }
                .chord-btn { background: #1a1a24; border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 6px 12px; border-radius: 4px; font-size: 11px; cursor: pointer; text-transform: uppercase; transition: all 0.2s; }
                .chord-btn:hover { background: #2a2a3b; }
                .chord-btn.active { background: rgba(0, 255, 255, 0.2); border-color: #00ffff; color: #00ffff; box-shadow: 0 0 10px rgba(0,255,255,0.3);}
                
                .chord-progression-box { background: #050508; border: 1px solid #222; border-radius: 4px; padding: 10px; color: #00ff00; font-family: monospace; font-size: 13px; white-space: nowrap; overflow-x: auto; min-height: 18px; box-shadow: inset 0 0 10px rgba(0,0,0,0.8); }
                .chord-progression-box::-webkit-scrollbar { height: 6px; }
                .chord-progression-box::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }

                .chord-notes-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin-top: 5px; }
                .chord-note-btn { 
                    aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
                    background: #1a1a24; border: 1px solid #333; border-radius: 6px;
                    font-size: 18px; font-weight: bold; cursor: pointer; user-select: none;
                    transition: all 0.1s;
                }
                .chord-note-btn:hover { background: #2a2a3b; }
                
                .chord-legend { display: flex; justify-content: center; gap: 20px; font-size: 11px; margin-top: 5px; color: #8b8b9f; }
                .legend-item { display: flex; align-items: center; gap: 5px; }
                .legend-color { width: 12px; height: 12px; border-radius: 3px; }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div class="chord-panel">
                <div class="chord-top-bar">
                    <div class="chord-header">LIVE CHORDIFIER</div>
                    <div class="chord-controls">
                        <button id="btn-trans-down" class="chord-btn" style="padding: 6px 10px; border-radius: 4px 0 0 4px;">-</button>
                        <div id="scale-name-display" style="background: #111; color: #ffff00; font-family: monospace; font-size: 12px; padding: 6px 10px; min-width: 80px; text-align: center; border-top: 1px solid #333; border-bottom: 1px solid #333;">C Major</div>
                        <button id="btn-trans-up" class="chord-btn" style="padding: 6px 10px; border-radius: 0 4px 4px 0;">+</button>
                        <button id="btn-auto-scale" class="chord-btn" style="margin-left: 15px;">Auto-Scale: OFF</button>
                    </div>
                </div>

                <div style="display: flex; gap: 10px; align-items: stretch;">
                    <div id="progression-display" class="chord-progression-box" style="flex: 1;">Waiting for chords...</div>
                    <button id="btn-clear-prog" class="chord-btn" title="Tyhjennä sointunäyttö" style="padding: 0 15px;">Clear</button>
                </div>

                <div style="font-size: 11px; color: #8b8b9f; text-align: center;">Valitse sallitut nuotit (Pitch Classes) sointujen rakentamiseen:</div>
                
                <div class="chord-notes-grid" id="notes-grid"></div>

                <div class="chord-legend">
                    <div class="legend-item"><div class="legend-color" style="background: rgba(0,255,0,0.5); border: 1px solid #00ff00;"></div> Root</div>
                    <div class="legend-item"><div class="legend-color" style="background: rgba(255,170,0,0.5); border: 1px solid #ffaa00;"></div> Third</div>
                    <div class="legend-item"><div class="legend-color" style="background: rgba(0,136,255,0.5); border: 1px solid #0088ff;"></div> Fifth</div>
                    <div class="legend-item"><div class="legend-color" style="background: transparent; border: 2px solid #ffffff;"></div> Melody</div>
                </div>
            </div>
        `;

        this.uiElements.scaleNameDisplay = containerElement.querySelector('#scale-name-display');
        this.uiElements.progressionDisplay = containerElement.querySelector('#progression-display');
        this.uiElements.autoScaleBtn = containerElement.querySelector('#btn-auto-scale');
        
        containerElement.querySelector('#btn-trans-down').onclick = () => this.shiftScale(-1);
        containerElement.querySelector('#btn-trans-up').onclick = () => this.shiftScale(1);
        containerElement.querySelector('#btn-clear-prog').onclick = () => this.clearProgression();

        const grid = containerElement.querySelector('#notes-grid');
        this.uiElements.buttons = [];

        for (let i = 0; i < 12; i++) {
            const btn = document.createElement('div');
            btn.className = 'chord-note-btn';
            btn.innerText = this.NOTE_NAMES[i];
            
            btn.onclick = () => {
                if (this.autoScaleMode) return; 
                
                if (this.activePitchClasses.has(i)) {
                    this.activePitchClasses.delete(i);
                } else {
                    this.activePitchClasses.add(i);
                }
                this.currentScaleScale = null; // Asetetaan "Custom"
                this.updateScaleDisplay();
                this.updateUI();
                this.recalculateCurrentNote();
            };
            
            grid.appendChild(btn);
            this.uiElements.buttons.push(btn);
        }

        this.uiElements.autoScaleBtn.onclick = () => {
            this.autoScaleMode = !this.autoScaleMode;
            if (this.autoScaleMode) {
                this.uiElements.autoScaleBtn.classList.add('active');
                this.uiElements.autoScaleBtn.innerText = 'Auto-Scale: ON';
                this.melodyNoteHistory = []; 
            } else {
                this.uiElements.autoScaleBtn.classList.remove('active');
                this.uiElements.autoScaleBtn.innerText = 'Auto-Scale: OFF';
            }
        };

        this.updateScaleDisplay();
        this.updateProgressionUI();
        this.updateUI();
    }
};