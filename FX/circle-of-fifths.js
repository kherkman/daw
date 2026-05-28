// circle-of-fifths.js
window.CustomAudioEffect = class CircleOfFifths {
    constructor(audioCtx) {
        this.ctx = audioCtx;

        // Audio Routing: Pass-through (Ei muuteta ääntä)
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        this.input.connect(this.output);

        // Tila-muuttujat
        this.playingNotes = new Map(); // MIDI-nuottien seuranta
        this.activeWedges = new Map(); // Seuranta tällä hetkellä soivista ympyrän sektoreista
        this.activeSequences = new Map(); // Rytmisekvenssien seuranta

        this.selectedRoot = "C";
        this.selectedScale = "Major";
        this.voicingStyle = "Piano";
        this.selectedRhythm = "One-time";
        this.keysEnabled = false;

        this.lastVoiceLeadNotes = []; // Voice leading -seuranta edelliselle soinnulle

        this.degreeMap = {}; // Tallentaa 1-7 näppäinten ja sektoreiden mappaukset

        // Kvinttiympyrän data (Myötäpäivään, alkaen kello 12:sta eli indeksistä 0)
        this.majLabels = ["C", "G", "D", "A", "E", "B", "Gb/F#", "Db", "Ab", "Eb", "Bb", "F"];
        this.minLabels = ["Am", "Em", "Bm", "F#m", "C#m", "G#m", "Ebm", "Bbm", "Fm", "Cm", "Gm", "Dm"];
        this.dimLabels = ["B°", "F#°", "C#°", "G#°", "D#°", "A#°", "F°", "C°", "G°", "D°", "A°", "E°"];

        this.chromaticRoots = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

        // Rytmikuviot (perustuvat 1/16-nuottien askeleisiin, max length määrittää tahdin/kierron koon)
        this.rhythms = {
            "Strum Down": { length: 16, steps: { 0: 'strum_down', 8: 'strum_down' } },
            "Strum Up": { length: 16, steps: { 0: 'strum_up', 8: 'strum_up' } },
            "Bass-Chord": { length: 16, steps: { 0: 'bass', 4: 'treble', 8: 'bass', 12: 'treble' } },
            "Arpeggio": { length: 16, steps: { 0: 0, 2: 1, 4: 2, 6: 3, 8: 4, 10: 2, 12: 1, 14: 0 } },
            "Waltz": { length: 12, steps: { 0: 'bass', 4: 'treble', 8: 'treble' } }, // 3/4 tahti (12 askelta)
            "Pop": { length: 16, steps: { 0: 'bass', 3: 'treble', 6: 'treble', 10: 'all', 12: 'treble' } },
            "Moving Bass Line": { length: 16, steps: { 0: 0, 4: 1, 8: 2, 12: 1 } },
            "Up Beat with Syncopated Bass": { length: 16, steps: { 0: 'bass', 2: 'treble', 7: 'bass', 10: 'treble', 14: 'treble' } },
            "Alberti Bass": { length: 16, steps: { 0: 0, 2: 3, 4: 1, 6: 3, 8: 0, 10: 3, 12: 1, 14: 3 } },
            "Rock and Roll": { length: 16, steps: { 0: 'bass', 2: 'treble', 4: 'bass', 6: 'treble', 8: 'bass', 10: 'treble', 12: 'bass', 14: 'treble' } },
            "Jazz": { length: 16, steps: { 0: 'bass', 4: 'treble', 8: 'bass', 14: 'treble' } },
            "Polyrhythm 3 vs 2": { length: 12, steps: { 0: 'all', 4: 'treble', 6: 'bass', 8: 'treble' } }, // 12 askelta, basso kahdesti, treble 3 kertaa
            "Polyrhythm 5 vs 2": { length: 20, steps: { 0: 'all', 4: 'treble', 8: 'treble', 10: 'bass', 12: 'treble', 16: 'treble' } } // Basso iskee 0 ja 10, Treble 0, 4, 8, 12, 16
        };

        this.initKeyboardListeners();
    }

    getNodes() {
        return { input: this.input, output: this.output };
    }

    // --- MIDI Käsittely ---

    playNote(midiNote, velocity = 100) {
        if (this.playingNotes.has(midiNote)) return;
        this.playingNotes.set(midiNote, true);
        if (typeof this.sendMidi === 'function') {
            this.sendMidi([0x90, midiNote, Math.floor(velocity)]);
        }
    }

    stopNote(midiNote) {
        if (!this.playingNotes.has(midiNote)) return;
        this.playingNotes.delete(midiNote);
        if (typeof this.sendMidi === 'function') {
            this.sendMidi([0x80, midiNote, 0]);
        }
    }

    stopAllNotes() {
        this.playingNotes.forEach((val, note) => this.stopNote(note));
        this.playingNotes.clear();
        
        this.activeSequences.forEach((seq) => clearTimeout(seq.timer));
        this.activeSequences.clear();
        this.activeWedges.clear();
        
        if (this.uiContainer) {
            const wedges = this.uiContainer.querySelectorAll('.cof-wedge-group');
            wedges.forEach(w => w.classList.remove('playing'));
        }
    }

    // --- Musiikin teoria ja soinnut ---

    getMidiRoot(label) {
        let clean = label.replace(/m|°/g, '').split('/')[0]; // "Gb/F#" -> "Gb"
        const map = {
            "C":0, "C#":1, "Db":1, "D":2, "D#":3, "Eb":3, "E":4, "F":5, "F#":6, "Gb":6, "G":7, "G#":8, "Ab":8, "A":9, "A#":10, "Bb":10, "B":11
        };
        return map[clean] || 0;
    }

    getVoiceLeadNotes(rootNote, type) {
        const pcDistances = {
            "Maj": [0, 4, 7],
            "Min": [0, 3, 7],
            "Dim": [0, 3, 6]
        };
        const intervals = pcDistances[type] || [0, 4, 7];
        const pitchClasses = intervals.map(i => (rootNote + i) % 12);
        
        // Basso aina juurisävel välillä C2 - B2
        const bass = (rootNote % 12) + 36; 

        if (!this.lastVoiceLeadNotes || this.lastVoiceLeadNotes.length === 0) {
            // Oletus: perusmuotoinen sointu alkaen keski-C:n (60) yläpuolelta
            const treble = pitchClasses.map(pc => {
                let note = pc + 60; 
                if (note < 60) note += 12; 
                return note;
            }).sort((a,b) => a-b);
            
            this.lastVoiceLeadNotes = treble;
            return [bass, ...treble];
        }

        const prevTreble = this.lastVoiceLeadNotes;
        
        // Permutaatiot soinnun käännösten minimoimiseksi (kolmisoinnuille 3! = 6 kpl)
        const perms = [
            [0, 1, 2], [0, 2, 1],
            [1, 0, 2], [1, 2, 0],
            [2, 0, 1], [2, 1, 0]
        ];

        let bestDist = Infinity;
        let bestNotes = [];

        // Etsii sävelluokalle lähimmän kohdenuotin oktaavia siirtämällä
        const getClosestNote = (pc, target) => {
            let octave = Math.floor(target / 12) * 12;
            let candidate1 = octave + pc;
            let candidate2 = candidate1 + 12;
            let candidate3 = candidate1 - 12;

            let c1d = Math.abs(candidate1 - target);
            let c2d = Math.abs(candidate2 - target);
            let c3d = Math.abs(candidate3 - target);

            if (c1d <= c2d && c1d <= c3d) return candidate1;
            if (c2d <= c1d && c2d <= c3d) return candidate2;
            return candidate3;
        };

        for (let p of perms) {
            let currentNotes = [];
            let dist = 0;
            for (let i = 0; i < 3; i++) {
                const pc = pitchClasses[p[i]];
                const ref = prevTreble[i] !== undefined ? prevTreble[i] : 60; 
                const closest = getClosestNote(pc, ref);
                currentNotes.push(closest);
                dist += Math.abs(closest - ref);
            }
            if (dist < bestDist) {
                bestDist = dist;
                bestNotes = currentNotes;
            }
        }

        bestNotes.sort((a, b) => a - b);
        this.lastVoiceLeadNotes = bestNotes;

        return [bass, ...bestNotes];
    }

    getChordNotes(label, type, voicing) {
        const rootNote = this.getMidiRoot(label);
        const notes = [];

        if (voicing === "Voice Lead") {
            return this.getVoiceLeadNotes(rootNote, type);
        }

        if (voicing === "Piano") {
            // Pianon tyyli: Basso oktaavia ja kahta alempana, kolmisointu C4-B4 alueella
            const bass = rootNote + 36; // C2 - B2
            notes.push(bass, bass + 12); // Basso + Oktaavi
            
            const triadRoot = rootNote + 60; // C4 - B4
            notes.push(triadRoot);
            
            if (type === "Maj") {
                notes.push(triadRoot + 4, triadRoot + 7);
            } else if (type === "Min") {
                notes.push(triadRoot + 3, triadRoot + 7);
            } else if (type === "Dim") {
                notes.push(triadRoot + 3, triadRoot + 6);
            }
        } else if (voicing === "Guitar") {
            // Kitaran tyyli: Avoimet otteet (Barre-tyyppinen logiikka realistiselle asettelulle)
            const isEString = [4, 5, 6, 7, 8].includes(rootNote); // E, F, F#, G, G# -> E-kieli bassona
            const bass = rootNote + (isEString ? 36 : 48); // 40-44 tai 45-51
            
            notes.push(bass);
            
            if (type === "Maj") {
                notes.push(bass + 7, bass + 12, bass + 16, bass + 19); // 1, 5, 8, 10, 12
                if (isEString) notes.push(bass + 24);
            } else if (type === "Min") {
                notes.push(bass + 7, bass + 12, bass + 15, bass + 19); // 1, 5, 8, b10, 12
                if (isEString) notes.push(bass + 24);
            } else if (type === "Dim") {
                notes.push(bass + 6, bass + 12, bass + 15); // Kitaran Dim-sointu
            }
        }
        return notes;
    }

    splitNotes(notes, voicing) {
        let bassCount = voicing === "Piano" ? 2 : 1;
        if (notes.length <= bassCount) bassCount = 1;

        return {
            bass: notes.slice(0, bassCount),
            treble: notes.slice(bassCount),
            all: notes
        };
    }

    // --- Rytmikone ---

    getStepDuration() {
        const bpm = window.bpm || window.globalTempo || 120;
        return (60000 / bpm) / 4; // Yksi 1/16 nuotin pituus
    }

    runRhythmStep(id) {
        const seq = this.activeSequences.get(id);
        if (!seq) return;

        const rhythmDef = this.rhythms[this.selectedRhythm];
        if (!rhythmDef) return;

        // Sammutetaan edellisen askeleen soivat nuotit
        seq.playingNow.forEach(n => this.stopNote(n));
        seq.playingNow = [];

        const stepAction = rhythmDef.steps[seq.step];
        
        if (stepAction !== undefined) {
            let notesToPlay = [];
            const split = this.splitNotes(seq.notes, this.voicingStyle);

            if (stepAction === 'all') {
                notesToPlay = split.all;
            } else if (stepAction === 'bass') {
                notesToPlay = split.bass;
            } else if (stepAction === 'treble') {
                notesToPlay = split.treble;
            } else if (stepAction === 'strum_down') {
                split.all.forEach((n, i) => {
                    setTimeout(() => {
                        if (this.activeSequences.has(id)) {
                            this.playNote(n, 100);
                            seq.playingNow.push(n);
                        }
                    }, i * 35);
                });
            } else if (stepAction === 'strum_up') {
                const reversed = [...split.all].reverse();
                reversed.forEach((n, i) => {
                    setTimeout(() => {
                        if (this.activeSequences.has(id)) {
                            this.playNote(n, 100);
                            seq.playingNow.push(n);
                        }
                    }, i * 35);
                });
            } else if (typeof stepAction === 'number') {
                const n = seq.notes[stepAction % seq.notes.length];
                notesToPlay.push(n);
            }

            // Normaalit samanaikaiset äänet
            if (notesToPlay.length > 0) {
                notesToPlay.forEach(n => {
                    this.playNote(n, 100);
                    seq.playingNow.push(n);
                });
            }
        }

        seq.step = (seq.step + 1) % rhythmDef.length;
        seq.timer = setTimeout(() => this.runRhythmStep(id), this.getStepDuration());
    }

    triggerWedgeOn(id, label, type) {
        if (this.activeWedges.has(id)) return;
        const notes = this.getChordNotes(label, type, this.voicingStyle);
        this.activeWedges.set(id, true);

        const el = this.uiContainer.querySelector(`#${id}`);
        if (el) el.classList.add('playing');

        if (this.selectedRhythm === "One-time") {
            notes.forEach(n => this.playNote(n, 100));
            this.activeSequences.set(id, { type: 'one-time', playingNow: [...notes] });
        } else {
            const seq = { step: 0, timer: null, notes: notes, playingNow: [] };
            this.activeSequences.set(id, seq);
            this.runRhythmStep(id);
        }
    }

    triggerWedgeOff(id) {
        if (!this.activeWedges.has(id)) return;
        this.activeWedges.delete(id);

        const seq = this.activeSequences.get(id);
        if (seq) {
            clearTimeout(seq.timer);
            seq.playingNow.forEach(n => this.stopNote(n));
            this.activeSequences.delete(id);
        }

        const el = this.uiContainer.querySelector(`#${id}`);
        if (el) el.classList.remove('playing');
    }

    // --- Tila ja päivitykset ---

    getState() {
        return {
            selectedRoot: this.selectedRoot,
            selectedScale: this.selectedScale,
            voicingStyle: this.voicingStyle,
            selectedRhythm: this.selectedRhythm,
            keysEnabled: this.keysEnabled
        };
    }

    setState(state) {
        if (!state) return;
        if (state.selectedRoot) this.selectedRoot = state.selectedRoot;
        if (state.selectedScale) this.selectedScale = state.selectedScale;
        if (state.voicingStyle) this.voicingStyle = state.voicingStyle;
        if (state.selectedRhythm) this.selectedRhythm = state.selectedRhythm;
        if (state.keysEnabled !== undefined) this.keysEnabled = state.keysEnabled;
        
        if (this.uiContainer) {
            this.uiContainer.querySelector('#cof-root-select').value = this.selectedRoot;
            this.uiContainer.querySelector('#cof-scale-select').value = this.selectedScale;
            this.uiContainer.querySelector('#cof-voicing-select').value = this.voicingStyle;
            this.uiContainer.querySelector('#cof-rhythm-select').value = this.selectedRhythm;
            
            const btn = this.uiContainer.querySelector('#cof-keys-toggle');
            if (this.keysEnabled) {
                btn.classList.add('active');
                btn.innerText = "KEYS: ON";
            } else {
                btn.classList.remove('active');
                btn.innerText = "KEYS: OFF";
            }
            this.updateCircleState();
        }
    }

    findPositionForScale(rootName, type) {
        const targetMidi = this.getMidiRoot(rootName);
        const searchArray = type === "Major" ? this.majLabels : this.minLabels;
        
        for (let i = 0; i < 12; i++) {
            if (this.getMidiRoot(searchArray[i]) === targetMidi) {
                return i;
            }
        }
        return 0;
    }

    updateCircleState() {
        if (!this.uiContainer) return;

        this.degreeMap = {};

        const wedges = this.uiContainer.querySelectorAll('.cof-wedge-group');
        wedges.forEach(w => {
            w.classList.remove('in-scale');
            w.querySelector('.roman-label').textContent = '';
        });

        const centerPos = this.findPositionForScale(this.selectedRoot, this.selectedScale);
        const leftPos = (centerPos + 11) % 12;
        const rightPos = (centerPos + 1) % 12;

        const setRoman = (type, pos, numeral, keyNum) => {
            const id = `cof-${type}-${pos}`;
            const el = this.uiContainer.querySelector(`#${id}`);
            if (el) {
                el.classList.add('in-scale');
                const displayText = this.keysEnabled ? `${numeral} [${keyNum}]` : numeral;
                el.querySelector('.roman-label').textContent = displayText;
                this.degreeMap[keyNum.toString()] = { id, label: el.dataset.label, type: el.dataset.type };
            }
        };

        if (this.selectedScale === "Major") {
            setRoman('maj', centerPos, 'I', 1);
            setRoman('min', leftPos, 'ii', 2);
            setRoman('min', rightPos, 'iii', 3);
            setRoman('maj', leftPos, 'IV', 4);
            setRoman('maj', rightPos, 'V', 5);
            setRoman('min', centerPos, 'vi', 6);
            setRoman('dim', centerPos, 'vii°', 7);
        } else {
            setRoman('min', centerPos, 'i', 1);
            setRoman('dim', centerPos, 'ii°', 2);
            setRoman('maj', centerPos, 'III', 3);
            setRoman('min', leftPos, 'iv', 4);
            setRoman('min', rightPos, 'v', 5);
            setRoman('maj', leftPos, 'VI', 6);
            setRoman('maj', rightPos, 'VII', 7);
        }
    }

    // --- UI Renderöinti ---

    polarToCartesian(centerX, centerY, radius, angleInDegrees) {
        const angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;
        return {
            x: centerX + (radius * Math.cos(angleInRadians)),
            y: centerY + (radius * Math.sin(angleInRadians))
        };
    }

    describeWedge(cx, cy, rInner, rOuter, startAngle, endAngle) {
        const startOuter = this.polarToCartesian(cx, cy, rOuter, endAngle);
        const endOuter = this.polarToCartesian(cx, cy, rOuter, startAngle);
        const startInner = this.polarToCartesian(cx, cy, rInner, endAngle);
        const endInner = this.polarToCartesian(cx, cy, rInner, startAngle);

        const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

        return [
            "M", startOuter.x, startOuter.y,
            "A", rOuter, rOuter, 0, largeArcFlag, 0, endOuter.x, endOuter.y,
            "L", endInner.x, endInner.y,
            "A", rInner, rInner, 0, largeArcFlag, 1, startInner.x, startInner.y,
            "Z"
        ].join(" ");
    }

    generateSvg() {
        const cx = 200;
        const cy = 200;
        let svgHtml = `<svg width="400" height="400" viewBox="0 0 400 400" class="cof-svg">`;

        const renderRing = (labels, prefix, chordType, rInner, rOuter, fontSize, offsetAngle = 0) => {
            let html = '';
            for (let i = 0; i < 12; i++) {
                const startAngle = i * 30 - 14.2 + offsetAngle;
                const endAngle = i * 30 + 14.2 + offsetAngle;
                const pathD = this.describeWedge(cx, cy, rInner, rOuter, startAngle, endAngle);
                
                const textRadius = (rInner + rOuter) / 2;
                const textPos = this.polarToCartesian(cx, cy, textRadius, i * 30 + offsetAngle);
                
                const yOffsetChord = chordType === "Dim" ? 2 : -4;
                const yOffsetRoman = chordType === "Dim" ? 2 : 10;

                html += `
                    <g class="cof-wedge-group" id="cof-${prefix}-${i}" data-label="${labels[i]}" data-type="${chordType}">
                        <path class="cof-wedge ${prefix}" d="${pathD}"></path>
                        <text x="${textPos.x}" y="${textPos.y + yOffsetChord}" class="chord-label" font-size="${fontSize}">${labels[i]}</text>
                        <text x="${textPos.x}" y="${textPos.y + yOffsetRoman}" class="roman-label" font-size="${fontSize - 4}"></text>
                    </g>
                `;
            }
            return html;
        };

        svgHtml += renderRing(this.majLabels, 'maj', 'Maj', 130, 195, 16);
        svgHtml += renderRing(this.minLabels, 'min', 'Min', 75, 128, 14);
        svgHtml += renderRing(this.dimLabels, 'dim', 'Dim', 35, 73, 11);

        svgHtml += `</svg>`;
        return svgHtml;
    }

    renderUI(container) {
        this.uiContainer = container;
        const color = '#00f0ff'; 
        container.style.setProperty('--cof-color', color);

        if (!document.getElementById('cof-styles')) {
            const style = document.createElement('style');
            style.id = 'cof-styles';
            style.textContent = `
                .cof-panel { background: #111; padding: 15px; border-radius: 8px; border: 1px solid #333; font-family: monospace; color: #eee; text-align: center; user-select: none;}
                .cof-header { color: var(--cof-color); font-weight: bold; letter-spacing: 2px; text-shadow: 0 0 10px rgba(0, 240, 255, 0.5); margin-bottom: 15px; font-size: 14px; }
                
                .cof-controls { display: flex; gap: 10px; justify-content: center; margin-bottom: 20px; flex-wrap: wrap; }
                .cof-select { background: #000; border: 1px solid #444; color: var(--cof-color); padding: 5px; font-family: monospace; border-radius: 3px; cursor: pointer; outline: none; }
                .cof-select:hover { border-color: #666; }

                .cof-btn { background: #222; border: 1px solid #555; color: #ddd; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-family: monospace; font-size: 11px; transition: 0.2s; height: 26px; }
                .cof-btn:hover { background: #333; border-color: var(--cof-color); }
                .cof-btn.active { background: var(--cof-color); color: #000; border-color: #fff; font-weight: bold; }

                .cof-svg-container { display: flex; justify-content: center; align-items: center; margin: 0 auto; width: 400px; max-width: 100%; height: auto;}
                .cof-svg { display: block; max-width: 100%; height: auto; }

                .cof-wedge-group { cursor: pointer; }
                .cof-wedge { fill: #1a1a1a; stroke: #333; stroke-width: 1.5; transition: 0.1s fill; }
                
                .cof-wedge-group:hover .cof-wedge { fill: #2a2a2a; }
                .cof-wedge-group.in-scale .cof-wedge { fill: #142a3a; stroke: #265; }
                .cof-wedge-group.playing .cof-wedge { fill: var(--cof-color) !important; stroke: #fff !important; }

                .chord-label { fill: #ccc; text-anchor: middle; dominant-baseline: middle; pointer-events: none; transition: 0.1s fill; font-weight: bold; }
                .roman-label { fill: #888; text-anchor: middle; dominant-baseline: middle; pointer-events: none; font-weight: normal; }
                
                .cof-wedge-group.in-scale .chord-label { fill: #fff; }
                .cof-wedge-group.in-scale .roman-label { fill: #0f8; font-weight: bold; }
                .cof-wedge-group.playing .chord-label, .cof-wedge-group.playing .roman-label { fill: #000; }
            `;
            document.head.appendChild(style);
        }

        const rootOptions = this.chromaticRoots.map(r => `<option value="${r}">${r}</option>`).join('');

        container.innerHTML = `
            <div class="cof-panel">
                <div class="cof-header">CIRCLE OF FIFTHS - CHORD PLAYER</div>
                
                <div class="cof-controls">
                    <div>
                        <label style="font-size: 10px; color: #888; display: block; margin-bottom: 2px;">ROOT</label>
                        <select id="cof-root-select" class="cof-select">${rootOptions}</select>
                    </div>
                    <div>
                        <label style="font-size: 10px; color: #888; display: block; margin-bottom: 2px;">SCALE</label>
                        <select id="cof-scale-select" class="cof-select">
                            <option value="Major">Major</option>
                            <option value="Minor">Minor</option>
                        </select>
                    </div>
                    <div>
                        <label style="font-size: 10px; color: #888; display: block; margin-bottom: 2px;">VOICING STYLE</label>
                        <select id="cof-voicing-select" class="cof-select">
                            <option value="Piano">Traditional Piano</option>
                            <option value="Guitar">Open Guitar</option>
                            <option value="Voice Lead">Voice Lead</option>
                        </select>
                    </div>
                    <div>
                        <label style="font-size: 10px; color: #888; display: block; margin-bottom: 2px;">RHYTHM</label>
                        <select id="cof-rhythm-select" class="cof-select">
                            <option value="One-time">One-time</option>
                            <option value="Strum Down">Strum Down</option>
                            <option value="Strum Up">Strum Up</option>
                            <option value="Bass-Chord">Bass-Chord</option>
                            <option value="Arpeggio">Arpeggio</option>
                            <option value="Waltz">Waltz</option>
                            <option value="Pop">Pop</option>
                            <option value="Moving Bass Line">Moving Bass Line</option>
                            <option value="Up Beat with Syncopated Bass">Up Beat with Syncopated Bass</option>
                            <option value="Alberti Bass">Alberti Bass</option>
                            <option value="Rock and Roll">Rock and Roll</option>
                            <option value="Jazz">Jazz</option>
                            <option value="Polyrhythm 3 vs 2">Polyrhythm 3 vs 2</option>
                            <option value="Polyrhythm 5 vs 2">Polyrhythm 5 vs 2</option>
                        </select>
                    </div>
                    <div style="display: flex; align-items: flex-end; padding-bottom: 2px;">
                        <button id="cof-keys-toggle" class="cof-btn" title="Use numbers 1-7 to play chords">KEYS: OFF</button>
                    </div>
                </div>

                <div class="cof-svg-container" id="cof-svg-wrapper">
                    ${this.generateSvg()}
                </div>
            </div>
        `;

        this.bindEvents();
        this.setState(this.getState()); 
    }

    bindEvents() {
        const rootSel = this.uiContainer.querySelector('#cof-root-select');
        const scaleSel = this.uiContainer.querySelector('#cof-scale-select');
        const voicSel = this.uiContainer.querySelector('#cof-voicing-select');
        const rhythmSel = this.uiContainer.querySelector('#cof-rhythm-select');
        const keysBtn = this.uiContainer.querySelector('#cof-keys-toggle');

        rootSel.addEventListener('change', (e) => { this.selectedRoot = e.target.value; this.updateCircleState(); });
        scaleSel.addEventListener('change', (e) => { this.selectedScale = e.target.value; this.updateCircleState(); });
        
        voicSel.addEventListener('change', (e) => { 
            this.stopAllNotes(); 
            this.voicingStyle = e.target.value; 
            this.lastVoiceLeadNotes = []; // Nollataan voice lead -historia uutta tyyliä varten
        });

        rhythmSel.addEventListener('change', (e) => {
            this.stopAllNotes();
            this.selectedRhythm = e.target.value;
        });

        keysBtn.addEventListener('click', () => {
            this.keysEnabled = !this.keysEnabled;
            this.stopAllNotes();
            
            if (this.keysEnabled) {
                keysBtn.classList.add('active');
                keysBtn.innerText = "KEYS: ON";
            } else {
                keysBtn.classList.remove('active');
                keysBtn.innerText = "KEYS: OFF";
            }
            this.updateCircleState();
        });

        // SVG Sektorien interaktio
        const wrapper = this.uiContainer.querySelector('#cof-svg-wrapper');
        
        const onStart = (e) => {
            const group = e.target.closest('.cof-wedge-group');
            if (group) {
                e.preventDefault();
                this.triggerWedgeOn(group.id, group.dataset.label, group.dataset.type);
            }
        };

        const onEnd = (e) => {
            const group = e.target.closest('.cof-wedge-group');
            if (group) {
                e.preventDefault();
                this.triggerWedgeOff(group.id);
            }
        };

        const onLeave = (e) => {
            const group = e.target.closest('.cof-wedge-group');
            if (group) this.triggerWedgeOff(group.id);
        };

        wrapper.addEventListener('mousedown', onStart);
        wrapper.addEventListener('mouseup', onEnd);
        wrapper.addEventListener('mouseout', (e) => {
            if (!e.relatedTarget || !e.relatedTarget.closest('.cof-wedge-group')) {
                if (e.target.closest('.cof-wedge-group')) {
                    onLeave(e);
                }
            }
        });

        wrapper.addEventListener('touchstart', (e) => {
            if(e.touches.length > 0) {
                const touch = e.touches[0];
                const elem = document.elementFromPoint(touch.clientX, touch.clientY);
                if (elem) {
                    const group = elem.closest('.cof-wedge-group');
                    if (group) {
                        e.preventDefault();
                        this.triggerWedgeOn(group.id, group.dataset.label, group.dataset.type);
                        wrapper.dataset.activeTouchId = group.id;
                    }
                }
            }
        }, {passive: false});

        wrapper.addEventListener('touchend', (e) => {
            e.preventDefault();
            if (wrapper.dataset.activeTouchId) {
                this.triggerWedgeOff(wrapper.dataset.activeTouchId);
                wrapper.dataset.activeTouchId = '';
            } else {
                this.stopAllNotes(); 
            }
        }, {passive: false});
        
        wrapper.addEventListener('touchcancel', () => this.stopAllNotes());
    }

    initKeyboardListeners() {
        this.keyStates = {};
        
        window.addEventListener('keydown', (e) => {
            if (!this.keysEnabled) return;
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
            if (e.repeat) return;
            
            const key = e.key;
            if (key >= '1' && key <= '7') {
                this.keyStates[key] = true;
                const wedge = this.degreeMap[key];
                if (wedge) {
                    this.triggerWedgeOn(wedge.id, wedge.label, wedge.type);
                }
            }
        });

        window.addEventListener('keyup', (e) => {
            const key = e.key;
            if (key >= '1' && key <= '7') {
                this.keyStates[key] = false;
                const wedge = this.degreeMap[key];
                if (wedge) {
                    this.triggerWedgeOff(wedge.id);
                }
            }
        });
    }
}