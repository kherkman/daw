// sheet.js
// Äänenkorkeuden tunnistus ja reaaliaikaisesti vierivä nuotinnus (Grand Staff).
// Tunnistaa äänen audiosta (monofoninen) ja vastaanottaa polyfonista MIDI:ä DAW:sta.
// Sisältää reaaliaikaisen soinnun (Chord) ja asteikon (Scale) tunnistuksen.

window.CustomAudioEffect = class SheetVisualizerEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        
        // Reititys (Suora ohitus: ei muuteta alkuperäistä ääntä)
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.input.connect(this.output); // Bypass

        // Asetukset
        this.scrollSpeed = 2.0; // Pikseliä per frame
        this.volSensitivity = 0.3; // 0.0 - 1.0 (Threshold / Gate limit)
        this.timeReaction = 0.5;   // 0.0 - 1.0 (Stable/Silence frames)
        
        // Visuaalinen tila ja nuottien hallinta (Polyfoninen)
        this.scrollingNotes = [];
        this.activeNotes = new Map(); // midi -> { obj: noteRef, sources: Set('audio', 'midi') }
        this.noteHistory = []; // Asteikon tunnistusta varten (viimeisimmät soitetut sävelet)

        // Nuottiviivaston vakiot
        this.STAFF_LINE_SPACING = 10;
        this.HALF_SPACE = this.STAFF_LINE_SPACING / 2;
        this.CLEF_SPACING = this.STAFF_LINE_SPACING * 8; 
        this.LEFT_MARGIN = 80;
        this.TOP_STAFF_Y = 60;

        // Diatoniset askeleet (C=0, D=1...)
        this.LETTER_STEPS = { 'C': 0, 'D': 1, 'E': 2, 'F': 3, 'G': 4, 'A': 5, 'B': 6 };
        this.NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

        // Sointujen rakenteet (intervallit suhteessa juureen)
        this.CHORD_DICTIONARY = [
            { name: "Maj", intervals: [0,4,7] },
            { name: "Min", intervals: [0,3,7] },
            { name: "Dim", intervals: [0,3,6] },
            { name: "Aug", intervals: [0,4,8] },
            { name: "sus2", intervals: [0,2,7] },
            { name: "sus4", intervals: [0,5,7] },
            { name: "Maj7", intervals: [0,4,7,11] },
            { name: "Min7", intervals: [0,3,7,10] },
            { name: "Dom7", intervals: [0,4,7,10] },
            { name: "m7b5", intervals: [0,3,6,10] },
            { name: "Dim7", intervals: [0,3,6,9] },
            { name: "6", intervals: [0,4,7,9] },
            { name: "m6", intervals: [0,3,7,9] }
        ];

        // Asteikkojen rakenteet
        this.SCALE_DICTIONARY = [
            { name: "Major", intervals: [0,2,4,5,7,9,11] },
            { name: "Minor", intervals: [0,2,3,5,7,8,10] },
            { name: "Harm. Min", intervals: [0,2,3,5,7,8,11] },
            { name: "Mel. Min", intervals: [0,2,3,5,7,9,11] },
            { name: "Dorian", intervals: [0,2,3,5,7,9,10] },
            { name: "Mixolydian", intervals: [0,2,4,5,7,9,10] },
            { name: "Maj Pent", intervals: [0,2,4,7,9] },
            { name: "Min Pent", intervals: [0,3,5,7,10] }
        ];

        // Ankkurit nuottiviivastolla
        this.STEP_E4 = (4 * 7) + this.LETTER_STEPS['E']; 
        this.STEP_A3 = (3 * 7) + this.LETTER_STEPS['A']; 
        this.STEP_A4 = (4 * 7) + this.LETTER_STEPS['A']; 

        // UI-referenssit
        this.uiElements = {};
        this.animationId = null;
        this.resizeObserver = null;

        this._initWorklet();
        
        // Puhdistetaan vanhat nuotit asteikkohistoriasta säännöllisesti
        setInterval(() => this.updateScaleDetection(), 1000);
    }

    // --- MIDI-OHJAUS (DAW / HOST) ---
    onMidi(msg) {
        const status = msg[0] & 0xF0;
        const note = msg[1];
        const velocity = msg[2];

        if (status === 0x90 && velocity > 0) { // Note ON
            this.handleNoteOn(note, velocity / 127.0, 'midi');
        } else if (status === 0x80 || (status === 0x90 && velocity === 0)) { // Note OFF
            this.handleNoteOff(note, 'midi');
        }
    }

    async _initWorklet() {
        const workletCode = `
            class SheetVisualizerProcessor extends AudioWorkletProcessor {
                constructor() {
                    super();
                    this.bufferSize = 8192;
                    this.buffer = new Float32Array(this.bufferSize);
                    this.writePos = 0;
                    
                    this.currentNote = -1;
                    this.stableFrames = 0;
                    this.silenceFrames = 0;
                    
                    this.confidenceThreshold = 0.4;
                    
                    // Parametrisoitavat raja-arvot
                    this.rmsThreshold = 0.005; 
                    this.stableFramesMax = 3;
                    this.silenceFramesMax = 5;

                    this.port.onmessage = (e) => {
                        if (e.data.type === 'config') {
                            if (e.data.rmsThreshold !== undefined) this.rmsThreshold = e.data.rmsThreshold;
                            if (e.data.stableFramesMax !== undefined) this.stableFramesMax = e.data.stableFramesMax;
                            if (e.data.silenceFramesMax !== undefined) this.silenceFramesMax = e.data.silenceFramesMax;
                        }
                    };
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
                    const minPeriod = Math.floor(sampleRate / 1000); 
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

                    if (confidence > this.confidenceThreshold) {
                        return { hz: sampleRate / bestPeriod, rms };
                    }
                    return { hz: 0, rms };
                }

                hzToMidi(hz) { return 69 + 12 * Math.log2(hz / 440); }

                process(inputs, outputs) {
                    const input = inputs[0];
                    if (!input || !input.length || !input[0]) {
                        if (this.currentNote !== -1) {
                            this.port.postMessage({ type: 'midi', action: 'noteOff', note: this.currentNote });
                            this.currentNote = -1;
                        }
                        return true;
                    }

                    const inChannel = input[0];
                    for (let i = 0; i < inChannel.length; i++) {
                        this.buffer[this.writePos] = inChannel[i];
                        this.writePos = (this.writePos + 1) % this.bufferSize;
                    }

                    const { hz, rms } = this.detectPitch();

                    if (hz > 0) {
                        this.silenceFrames = 0;
                        const targetMidi = Math.round(this.hzToMidi(hz));
                        
                        if (targetMidi !== this.currentNote) {
                            this.stableFrames++;
                            if (this.stableFrames >= this.stableFramesMax) { 
                                if (this.currentNote !== -1) {
                                    this.port.postMessage({ type: 'midi', action: 'noteOff', note: this.currentNote });
                                }
                                
                                let intensity = rms / (this.rmsThreshold * 4);
                                intensity = Math.min(1.0, Math.max(0.1, intensity));

                                this.port.postMessage({ type: 'midi', action: 'noteOn', note: targetMidi, velocity: intensity });
                                this.currentNote = targetMidi;
                                this.stableFrames = 0;
                            }
                        } else {
                            this.stableFrames = 0;
                        }
                    } else {
                        this.silenceFrames++;
                        this.stableFrames = 0;
                        if (this.silenceFrames >= this.silenceFramesMax && this.currentNote !== -1) {
                            this.port.postMessage({ type: 'midi', action: 'noteOff', note: this.currentNote });
                            this.currentNote = -1;
                        }
                    }
                    return true;
                }
            }
            registerProcessor('sheetmusic-processor', SheetVisualizerProcessor);
        `;

        const dataUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(workletCode);
        try {
            await this.ctx.audioWorklet.addModule(dataUrl);
            this.worklet = new AudioWorkletNode(this.ctx, 'sheetmusic-processor');
            this.worklet.port.onmessage = (e) => {
                if (e.data.type === 'midi') {
                    if (e.data.action === 'noteOn') this.handleNoteOn(e.data.note, e.data.velocity, 'audio');
                    else if (e.data.action === 'noteOff') this.handleNoteOff(e.data.note, 'audio');
                }
            };
            this.input.connect(this.worklet);
            this.updateWorkletConfig();
        } catch (e) {
            console.error("SheetVisualizer Worklet load failed:", e);
        }
    }

    updateWorkletConfig() {
        if (!this.worklet) return;
        
        // Volyymiherkkyys tason säätö (Gate)
        // 0.0 -> herkkä (0.001 rms), 1.0 -> vaatii erittäin kovan äänen (0.3 rms)
        const rms = 0.001 + Math.pow(this.volSensitivity, 3) * 0.3;
        
        // Reagointinopeus
        const stable = Math.max(1, Math.round(12 - (this.timeReaction * 11)));
        const silence = Math.max(2, Math.round(15 - (this.timeReaction * 13)));

        this.worklet.port.postMessage({
            type: 'config',
            rmsThreshold: rms,
            stableFramesMax: stable,
            silenceFramesMax: silence
        });
    }

    getNodes() { return { input: this.input, output: this.output }; }

    getState() {
        return { 
            scrollSpeed: this.scrollSpeed,
            volSensitivity: this.volSensitivity,
            timeReaction: this.timeReaction
        };
    }

    setState(state) {
        if (!state) return;
        if (state.scrollSpeed !== undefined) {
            this.scrollSpeed = state.scrollSpeed;
            if (this.uiElements.speedKnob) this.uiElements.speedKnob.setValue(this.scrollSpeed);
        }
        if (state.volSensitivity !== undefined) {
            this.volSensitivity = state.volSensitivity;
            if (this.uiElements.volKnob) this.uiElements.volKnob.setValue(this.volSensitivity);
        }
        if (state.timeReaction !== undefined) {
            this.timeReaction = state.timeReaction;
            if (this.uiElements.reactionKnob) this.uiElements.reactionKnob.setValue(this.timeReaction);
        }
        this.updateWorkletConfig();
    }

    // --- MUSIIKINTUNNISTUS (PITCH, CHORD, SCALE) ---

    midiToNoteInfo(midi) {
        const name = this.NOTE_NAMES[midi % 12];
        const octave = Math.floor(midi / 12) - 1;
        const letter = name.charAt(0);
        const accidental = name.length > 1 ? name.charAt(1) : null;
        return { midi, name, letter, accidental, octave };
    }

    updateChordDetection() {
        if (!this.uiElements.chordDisplay) return;

        const activeMidis = Array.from(this.activeNotes.keys()).sort((a, b) => a - b);
        if (activeMidis.length === 0) {
            this.uiElements.chordDisplay.innerText = "-";
            this.uiElements.chordDisplay.style.color = '#555';
            return;
        }

        // Vain yksi nuotti
        if (activeMidis.length === 1) {
            this.uiElements.chordDisplay.innerText = this.NOTE_NAMES[activeMidis[0] % 12];
            this.uiElements.chordDisplay.style.color = '#555';
            return;
        }

        const bass = activeMidis[0] % 12;
        const pitchClasses = Array.from(new Set(activeMidis.map(m => m % 12))).sort((a,b) => a-b);
        let detectedChord = "?";

        // Kokeillaan jokaista aktiivista säveltä soinnun juurena (käännösten tunnistus)
        for (let root of pitchClasses) {
            let intervals = pitchClasses.map(p => (p - root + 12) % 12).sort((a,b) => a-b);
            let intStr = intervals.join(',');
            
            for (let c of this.CHORD_DICTIONARY) {
                if (c.intervals.join(',') === intStr) {
                    let rootName = this.NOTE_NAMES[root];
                    let invStr = (root !== bass) ? "/" + this.NOTE_NAMES[bass] : "";
                    detectedChord = rootName + c.name + invStr;
                    break;
                }
            }
            if (detectedChord !== "?") break;
        }

        // Voimasointu (Power chord) tunnistus, jos tarkkaa sointua ei löytynyt ja nuotteja on 2
        if (detectedChord === "?" && pitchClasses.length === 2) {
            let diff = (pitchClasses[1] - pitchClasses[0] + 12) % 12;
            if (diff === 7) detectedChord = this.NOTE_NAMES[pitchClasses[0]] + "5";
            if (diff === 5) detectedChord = this.NOTE_NAMES[pitchClasses[1]] + "5";
        }

        this.uiElements.chordDisplay.innerText = detectedChord;
        this.uiElements.chordDisplay.style.color = detectedChord !== "?" ? '#ff00ff' : '#888';
        this.uiElements.chordDisplay.style.textShadow = detectedChord !== "?" ? '0 0 10px #ff00ff' : 'none';
    }

    updateScaleDetection() {
        if (!this.uiElements.scaleDisplay) return;

        const now = Date.now();
        // Säilytetään muistissa vain viimeisen 10 sekunnin aikana soitetut nuotit
        this.noteHistory = this.noteHistory.filter(n => now - n.time < 10000);
        
        const pitchClasses = Array.from(new Set(this.noteHistory.map(n => n.pc))).sort((a,b) => a-b);
        
        if (pitchClasses.length < 4) {
            this.uiElements.scaleDisplay.innerText = "-";
            this.uiElements.scaleDisplay.style.color = '#555';
            return;
        }

        let bestMatch = "-";
        let highestScore = 0;

        for (let root = 0; root < 12; root++) {
            let shifted = pitchClasses.map(p => (p - root + 12) % 12);
            
            for (let s of this.SCALE_DICTIONARY) {
                let score = 0;
                for (let p of shifted) {
                    if (s.intervals.includes(p)) score += 1.0;
                    else score -= 1.5; // Rankaisu asteikon ulkopuolisista äänistä
                }
                
                let ratio = score / s.intervals.length;
                if (ratio > highestScore && ratio > 0.4) {
                    highestScore = ratio;
                    bestMatch = this.NOTE_NAMES[root] + " " + s.name;
                }
            }
        }

        this.uiElements.scaleDisplay.innerText = bestMatch;
        this.uiElements.scaleDisplay.style.color = bestMatch !== "-" ? '#ffff00' : '#888';
        this.uiElements.scaleDisplay.style.textShadow = bestMatch !== "-" ? '0 0 10px #ffff00' : 'none';
    }

    getTrebleY(absoluteStep) {
        const stepsFromE4 = absoluteStep - this.STEP_E4;
        const e4Y = this.TOP_STAFF_Y + (this.STAFF_LINE_SPACING * 4);
        return e4Y - (stepsFromE4 * this.HALF_SPACE);
    }

    getBassY(absoluteStep) {
        const bassTopY = this.TOP_STAFF_Y + (this.STAFF_LINE_SPACING * 4) + this.CLEF_SPACING;
        const stepsFromA3 = absoluteStep - this.STEP_A3;
        const a3Y = bassTopY; 
        return a3Y - (stepsFromA3 * this.HALF_SPACE);
    }

    handleNoteOn(midi, velocity = 1.0, source = 'audio') {
        const pc = midi % 12;
        this.noteHistory.push({ pc: pc, time: Date.now() });

        if (this.activeNotes.has(midi)) {
            // Nuotti on jo olemassa, lisätään lähde
            const noteData = this.activeNotes.get(midi);
            noteData.sources.add(source);
            noteData.obj.alpha = Math.max(noteData.obj.alpha, Math.max(0.2, Math.min(1.0, velocity)));
        } else {
            // Uusi nuotti
            const noteInfo = this.midiToNoteInfo(midi);
            const absoluteStep = (noteInfo.octave * 7) + this.LETTER_STEPS[noteInfo.letter];
            const canvasW = this.canvas ? this.canvas.width : 800;
            
            let yTreble = null, yBass = null;
            if (absoluteStep >= this.STEP_A3 && absoluteStep <= this.STEP_A4) {
                yTreble = this.getTrebleY(absoluteStep);
                yBass = this.getBassY(absoluteStep);
            } else if (absoluteStep > this.STEP_A4) {
                yTreble = this.getTrebleY(absoluteStep);
            } else {
                yBass = this.getBassY(absoluteStep);
            }

            const alpha = Math.max(0.2, Math.min(1.0, velocity));
            const newNote = {
                ...noteInfo,
                startX: canvasW, endX: canvasW, 
                yTreble, yBass, active: true, alpha: alpha 
            };

            this.scrollingNotes.push(newNote);
            this.activeNotes.set(midi, { obj: newNote, sources: new Set([source]) });
        }

        // Päivitä PITCH näyttö viimeisimpään nuottiin
        if (this.uiElements.pitchDisplay) {
            const info = this.midiToNoteInfo(midi);
            this.uiElements.pitchDisplay.innerText = `${info.name}${info.octave}`;
            this.uiElements.pitchDisplay.style.color = '#00ffff';
            this.uiElements.pitchDisplay.style.textShadow = '0 0 15px #00ffff';
        }

        this.updateChordDetection();
        this.updateScaleDetection();
    }

    handleNoteOff(midi, source = 'audio') {
        if (!this.activeNotes.has(midi)) return;

        const noteData = this.activeNotes.get(midi);
        noteData.sources.delete(source);

        // Jos millään lähteellä ei enää ole tätä nuottia aktiivisena, sammutetaan se
        if (noteData.sources.size === 0) {
            noteData.obj.active = false;
            this.activeNotes.delete(midi);
            
            if (this.activeNotes.size === 0 && this.uiElements.pitchDisplay) {
                this.uiElements.pitchDisplay.innerText = "-";
                this.uiElements.pitchDisplay.style.color = '#555';
                this.uiElements.pitchDisplay.style.textShadow = 'none';
            } else if (this.activeNotes.size > 0 && this.uiElements.pitchDisplay) {
                // Näytä joku jäljelle jääneistä
                const highestRemaining = Math.max(...Array.from(this.activeNotes.keys()));
                const info = this.midiToNoteInfo(highestRemaining);
                this.uiElements.pitchDisplay.innerText = `${info.name}${info.octave}`;
            }

            this.updateChordDetection();
        }
    }

    // --- PIIRTOLOGIIKKA ---

    drawLedgerLines(ctx, x, y, isTreble, alpha) {
        ctx.strokeStyle = `rgba(0, 255, 255, ${alpha * 0.6})`;
        ctx.lineWidth = 1;
        
        const topY = isTreble ? this.TOP_STAFF_Y : this.TOP_STAFF_Y + (this.STAFF_LINE_SPACING * 4) + this.CLEF_SPACING;
        const bottomY = topY + (this.STAFF_LINE_SPACING * 4);

        if (y < topY) {
            for (let ly = topY - this.STAFF_LINE_SPACING; ly >= y; ly -= this.STAFF_LINE_SPACING) {
                ctx.beginPath(); ctx.moveTo(x - 12, ly); ctx.lineTo(x + 12, ly); ctx.stroke();
            }
        } else if (y > bottomY) {
            for (let ly = bottomY + this.STAFF_LINE_SPACING; ly <= y; ly += this.STAFF_LINE_SPACING) {
                ctx.beginPath(); ctx.moveTo(x - 12, ly); ctx.lineTo(x + 12, ly); ctx.stroke();
            }
        }
    }

    drawGrandStaff(ctx, width) {
        ctx.strokeStyle = '#444';
        ctx.fillStyle = '#444';
        ctx.lineWidth = 1;

        for (let i = 0; i < 5; i++) {
            let y = this.TOP_STAFF_Y + (i * this.STAFF_LINE_SPACING);
            ctx.beginPath(); ctx.moveTo(this.LEFT_MARGIN - 20, y); ctx.lineTo(width, y); ctx.stroke();
        }

        let bassTopY = this.TOP_STAFF_Y + (this.STAFF_LINE_SPACING * 4) + this.CLEF_SPACING;
        for (let i = 0; i < 5; i++) {
            let y = bassTopY + (i * this.STAFF_LINE_SPACING);
            ctx.beginPath(); ctx.moveTo(this.LEFT_MARGIN - 20, y); ctx.lineTo(width, y); ctx.stroke();
        }

        ctx.beginPath();
        ctx.moveTo(this.LEFT_MARGIN - 20, this.TOP_STAFF_Y);
        ctx.lineTo(this.LEFT_MARGIN - 20, bassTopY + (this.STAFF_LINE_SPACING * 4));
        ctx.stroke();
    }

    draw() {
        if (!this.canvas) return;
        const ctx = this.canvasContext;
        const w = this.canvas.width;
        const h = this.canvas.height;

        ctx.clearRect(0, 0, w, h);
        this.drawGrandStaff(ctx, w);

        for (let i = this.scrollingNotes.length - 1; i >= 0; i--) {
            let note = this.scrollingNotes[i];
            
            note.startX -= this.scrollSpeed;
            if (!note.active) note.endX -= this.scrollSpeed;

            if (note.endX < this.LEFT_MARGIN) {
                this.scrollingNotes.splice(i, 1);
                continue;
            }

            const drawStartX = Math.max(note.startX, this.LEFT_MARGIN + 20);
            const drawEndX = Math.max(note.endX, this.LEFT_MARGIN + 20);
            
            if (drawStartX > drawEndX) continue;

            const drawSingle = (y, isTreble) => {
                if (drawEndX - drawStartX > 5) {
                    ctx.beginPath();
                    ctx.moveTo(drawStartX, y);
                    ctx.lineTo(drawEndX, y);
                    ctx.strokeStyle = `rgba(0, 255, 255, ${note.alpha * 0.5})`;
                    ctx.lineWidth = 6;
                    ctx.lineCap = 'round';
                    ctx.stroke();
                }

                if (note.startX >= this.LEFT_MARGIN + 20) {
                    this.drawLedgerLines(ctx, note.startX, y, isTreble, note.alpha);

                    if (note.accidental) {
                        ctx.fillStyle = `rgba(255, 0, 255, ${note.alpha})`;
                        ctx.font = "16px sans-serif";
                        ctx.fillText(note.accidental, note.startX - 18, y + 5);
                    }

                    ctx.beginPath();
                    ctx.ellipse(note.startX, y, 6, 4.5, -0.2, 0, 2 * Math.PI);
                    ctx.fillStyle = `rgba(0, 255, 255, ${note.alpha})`;
                    ctx.shadowColor = `rgba(0, 255, 255, ${note.alpha})`;
                    ctx.shadowBlur = 10 * note.alpha;
                    ctx.fill();
                    ctx.shadowBlur = 0;
                }
            };

            if (note.yTreble !== null) drawSingle(note.yTreble, true);
            if (note.yBass !== null) drawSingle(note.yBass, false);
        }

        const grad = ctx.createLinearGradient(this.LEFT_MARGIN - 20, 0, this.LEFT_MARGIN + 30, 0);
        grad.addColorStop(0, '#0a0a0a'); 
        grad.addColorStop(1, 'rgba(10, 10, 10, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(this.LEFT_MARGIN - 20, 0, 50, h);

        ctx.font = "40px serif";
        ctx.fillStyle = "#aaa";
        ctx.shadowColor = '#000'; ctx.shadowBlur = 5;
        let bassTopY = this.TOP_STAFF_Y + (this.STAFF_LINE_SPACING * 4) + this.CLEF_SPACING;
        ctx.fillText("\uD834\uDD1E", this.LEFT_MARGIN - 15, this.TOP_STAFF_Y + 35); 
        ctx.fillText("\uD834\uDD22", this.LEFT_MARGIN - 15, bassTopY + 30);  
        ctx.shadowBlur = 0;

        this.animationId = requestAnimationFrame(() => this.draw());
    }

    // --- KÄYTTÖLIITTYMÄ ---

    renderUI(containerElement) {
        const color = '#00ffff';
        containerElement.style.setProperty('--fx-color', color);

        const styleId = 'fx-sheet-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .sheet-panel { background: #0a0a0a; padding: 15px; border-radius: 8px; border: 1px solid #333; display: flex; flex-direction: column; gap: 15px; box-shadow: inset 0 0 20px rgba(0,0,0,0.8);}
                .sheet-row { display: flex; justify-content: space-between; align-items: stretch; gap: 10px; flex-wrap: wrap; }
                
                .sheet-display-group { display: flex; gap: 10px; flex: 2; justify-content: center; }
                .sheet-display-box { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #000; border: 1px solid rgba(0,255,255,0.3); border-radius: 8px; padding: 10px; min-width: 80px; box-shadow: inset 0 0 20px rgba(0,0,0,0.8);}
                .sheet-display-box.chord { border-color: rgba(255,0,255,0.3); }
                .sheet-display-box.scale { border-color: rgba(255,255,0,0.3); }
                
                .sheet-canvas-container { border: 1px solid #222; border-radius: 8px; background: #0d0d0d; box-shadow: inset 0 0 15px rgba(0,0,0,0.8); overflow: hidden; width: 100%; display: flex; justify-content: center; min-height: 260px;}
                
                .sheet-knob-group { display: flex; gap: 10px; align-items: center; justify-content: center; flex: 1;}
                
                .sheet-knob-container { display: flex; flex-direction: column; align-items: center; user-select: none; width: 50px; }
                .sheet-knob-wrapper { position: relative; width: 40px; height: 40px; cursor: ns-resize; margin-bottom: 5px; touch-action: none; }
                .sheet-knob-svg { width: 100%; height: 100%; transform: rotate(135deg); filter: drop-shadow(0 0 3px rgba(0,255,255,0.2));}
                .sheet-knob-track { fill: none; stroke: #222; stroke-width: 6; stroke-linecap: round; }
                .sheet-knob-value-path { fill: none; stroke: var(--fx-color); stroke-width: 6; stroke-linecap: round; transition: stroke 0.2s; }
                .sheet-knob-center { fill: #111; stroke: #333; stroke-width: 1.5; }
                .sheet-knob-indicator { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
                .sheet-knob-dot { position: absolute; width: 4px; height: 4px; background: var(--fx-color); border-radius: 50%; top: 4px; left: 50%; transform: translateX(-50%); box-shadow: 0 0 5px var(--fx-color);}
                .sheet-knob-label { font-size: 9px; color: #8b8b9f; margin-bottom: 3px; text-align: center; font-family: monospace;}
                .sheet-knob-value-display { font-size: 9px; font-family: monospace; color: #ccc; background: #000; padding: 2px 5px; border-radius: 3px; border: 1px solid #333; }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div style="margin-bottom: 15px; color: var(--fx-color); font-weight: bold; text-align: center; letter-spacing: 4px; font-size: 14px; text-shadow: 0 0 10px rgba(0,255,255,0.5);">REALTIME SHEET & CHORD VISUALIZER</div>
            
            <div class="sheet-panel">
                <div class="sheet-row">
                    <!-- Näytöt -->
                    <div class="sheet-display-group">
                        <div class="sheet-display-box">
                            <div style="font-size: 10px; color: #00ffff; margin-bottom: 2px; font-family: monospace; letter-spacing: 1px;">PITCH</div>
                            <div id="sheet-pitch-display" style="font-family: monospace; font-size: 28px; font-weight: bold; color: #555;">-</div>
                        </div>
                        <div class="sheet-display-box chord">
                            <div style="font-size: 10px; color: #ff00ff; margin-bottom: 2px; font-family: monospace; letter-spacing: 1px;">CHORD</div>
                            <div id="sheet-chord-display" style="font-family: monospace; font-size: 24px; font-weight: bold; color: #555;">-</div>
                        </div>
                        <div class="sheet-display-box scale">
                            <div style="font-size: 10px; color: #ffff00; margin-bottom: 2px; font-family: monospace; letter-spacing: 1px;">SCALE</div>
                            <div id="sheet-scale-display" style="font-family: monospace; font-size: 20px; font-weight: bold; color: #555; text-align:center;">-</div>
                        </div>
                    </div>

                    <!-- Nupit -->
                    <div class="sheet-knob-group">
                        <div id="vol-knob-area" title="0% = Nappaa kaiken, 100% = Nappaa vain todella kovat äänet"></div>
                        <div id="reaction-knob-area"></div>
                        <div id="speed-knob-area"></div>
                    </div>
                </div>

                <!-- Canvas -->
                <div class="sheet-canvas-container">
                    <canvas id="sheet-canvas" width="600" height="260"></canvas>
                </div>
            </div>
        `;

        this.uiElements.pitchDisplay = containerElement.querySelector('#sheet-pitch-display');
        this.uiElements.chordDisplay = containerElement.querySelector('#sheet-chord-display');
        this.uiElements.scaleDisplay = containerElement.querySelector('#sheet-scale-display');
        
        this.canvas = containerElement.querySelector('#sheet-canvas');
        this.canvasContext = this.canvas.getContext('2d');

        this.resizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                const newWidth = entry.contentRect.width;
                if (newWidth > 0 && this.canvas.width !== newWidth) {
                    this.canvas.width = newWidth;
                }
            }
        });
        this.resizeObserver.observe(this.canvas.parentElement);
        const initialWidth = this.canvas.parentElement.clientWidth;
        if (initialWidth > 0) this.canvas.width = initialWidth;

        const createKnob = (container, label, min, max, defaultValue, formatValue, onChange, customColor = null) => {
            const div = document.createElement('div');
            div.className = 'sheet-knob-container';
            const radius = 17, circumference = 2 * Math.PI * radius, maxDash = circumference * 0.75; 
            const strokeColor = customColor || 'var(--fx-color)';
            
            div.innerHTML = `
                <div class="sheet-knob-label">${label}</div>
                <div class="sheet-knob-wrapper">
                    <svg class="sheet-knob-svg" viewBox="0 0 40 40"><circle class="sheet-knob-track" cx="20" cy="20" r="${radius}" stroke-dasharray="${maxDash} ${circumference}" /><circle class="sheet-knob-value-path" cx="20" cy="20" r="${radius}" stroke-dasharray="0 ${circumference}" style="stroke: ${strokeColor};" /><circle class="sheet-knob-center" cx="20" cy="20" r="10" /></svg>
                    <div class="sheet-knob-indicator"><div class="sheet-knob-dot" style="background: ${strokeColor}; box-shadow: 0 0 5px ${strokeColor};"></div></div>
                </div>
                <div class="sheet-knob-value-display">${formatValue(defaultValue)}</div>
            `;
            const wrapper = div.querySelector('.sheet-knob-wrapper'), valuePath = div.querySelector('.sheet-knob-value-path'), indicator = div.querySelector('.sheet-knob-indicator'), display = div.querySelector('.sheet-knob-value-display');
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
            
            return { setValue: (v) => { currentValue = v; updateUI(v); } };
        };

        this.uiElements.volKnob = createKnob(
            containerElement.querySelector('#vol-knob-area'), 
            'VOL GATE', 0.0, 1.0, this.volSensitivity, 
            v => Math.round(v * 100) + '%', 
            v => { this.volSensitivity = v; this.updateWorkletConfig(); },
            '#ff00ff'
        );

        this.uiElements.reactionKnob = createKnob(
            containerElement.querySelector('#reaction-knob-area'), 
            'REACTION', 0.0, 1.0, this.timeReaction, 
            v => Math.round(v * 100) + '%', 
            v => { this.timeReaction = v; this.updateWorkletConfig(); }
        );

        this.uiElements.speedKnob = createKnob(
            containerElement.querySelector('#speed-knob-area'), 
            'SPEED', 0.5, 6.0, this.scrollSpeed, 
            v => v.toFixed(1) + 'x', 
            v => { this.scrollSpeed = v; }
        );

        if (this.animationId) cancelAnimationFrame(this.animationId);
        this.draw();
    }
}