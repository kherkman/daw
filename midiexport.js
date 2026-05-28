/* =========================================
   LOCAL MIDI PARSER & EXPORTER (midiexport.js)
   Kevyt implementaatio MIDI-tiedostojen lukuun ja kirjoitukseen.
========================================= */

(function(exports) {
    const LocalMidi = {};

    // --- APUFUNKTIOT ---
    function readString(data, offset, len) {
        let str = "";
        for (let i = 0; i < len; i++) str += String.fromCharCode(data[offset + i]);
        return str;
    }

    function read32(data, offset) {
        return (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
    }

    function read16(data, offset) {
        return (data[offset] << 8) | data[offset + 1];
    }

    function writeVLQ(value) {
        let buffer = [value & 0x7F];
        while (value >>= 7) buffer.unshift((value & 0x7F) | 0x80);
        return buffer;
    }

    function writeString(str) {
        let arr = [];
        for (let i = 0; i < str.length; i++) arr.push(str.charCodeAt(i));
        return arr;
    }

    function write32(val) {
        return [(val >> 24) & 0xFF, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF];
    }

    function write16(val) {
        return [(val >> 8) & 0xFF, val & 0xFF];
    }

    // --- PARSER (LUKU) ---
    LocalMidi.parse = function(arrayBuffer) {
        const data = new Uint8Array(arrayBuffer);
        let offset = 0;

        if (readString(data, offset, 4) !== "MThd") throw new Error("Ei validi MIDI-tiedosto (MThd puuttuu).");
        offset += 4;
        
        const headerLen = read32(data, offset); offset += 4;
        const format = read16(data, offset); offset += 2;
        const trackCount = read16(data, offset); offset += 2;
        const ppq = read16(data, offset); offset += 2; // Ticks per quarter note

        let tracks = [];
        let globalTempo = 500000; // Mikrosekuntia per isku (oletus 120 BPM)

        for (let t = 0; t < trackCount; t++) {
            if (readString(data, offset, 4) !== "MTrk") {
                // Etsitään seuraava MTrk, jos välissä roskaa
                while (offset < data.length && readString(data, offset, 4) !== "MTrk") offset++;
                if (offset >= data.length) break;
            }
            offset += 4;
            const trackLen = read32(data, offset); offset += 4;
            const trackEnd = offset + trackLen;

            let trackName = `Raita ${t + 1}`;
            let activeNotes = {}; // Seurataan Note On tapahtumia: key -> note object
            let parsedNotes = [];
            let absoluteTicks = 0;
            let runningStatus = 0;

            while (offset < trackEnd) {
                // Lue delta-aika (VLQ)
                let delta = 0;
                while (true) {
                    let b = data[offset++];
                    delta = (delta << 7) | (b & 0x7F);
                    if (!(b & 0x80)) break;
                }
                absoluteTicks += delta;

                // Lue tapahtumatyyppi tai käytä running statusta
                let status = data[offset];
                if (status >= 0x80) {
                    runningStatus = status;
                    offset++;
                } else {
                    status = runningStatus;
                }

                const type = status >> 4;
                const channel = status & 0x0F;

                if (status === 0xFF) {
                    // Meta-tapahtumat
                    const metaType = data[offset++];
                    let metaLen = 0;
                    while (true) {
                        let b = data[offset++];
                        metaLen = (metaLen << 7) | (b & 0x7F);
                        if (!(b & 0x80)) break;
                    }

                    if (metaType === 0x03 && metaLen > 0) { // Track Name
                        trackName = readString(data, offset, metaLen);
                    } else if (metaType === 0x51 && metaLen === 3) { // Set Tempo
                        globalTempo = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
                    }
                    offset += metaLen;
                } 
                else if (status === 0xF0 || status === 0xF7) {
                    // Sysex
                    let sysexLen = 0;
                    while (true) {
                        let b = data[offset++];
                        sysexLen = (sysexLen << 7) | (b & 0x7F);
                        if (!(b & 0x80)) break;
                    }
                    offset += sysexLen;
                }
                else {
                    // Äänitapahtumat (Note On, Note Off, Control Change jne.)
                    let byte1 = data[offset++];
                    let byte2 = (type !== 0xC && type !== 0xD) ? data[offset++] : 0; // Program Change / Channel Pressure on vain 1 tavu

                    // Laske sekunnit nykyisellä tempolla
                    // (Tämä olettaa ettei tempo vaihdu kesken nuotin, mikä riittää yksinkertaiseen DAW:iin)
                    const timeSec = absoluteTicks * (globalTempo / 1000000.0) / ppq;

                    if (type === 0x9 && byte2 > 0) { // Note On
                        const key = `${channel}_${byte1}`;
                        activeNotes[key] = { pitch: byte1, start: timeSec, velocity: byte2 };
                    } 
                    else if (type === 0x8 || (type === 0x9 && byte2 === 0)) { // Note Off
                        const key = `${channel}_${byte1}`;
                        if (activeNotes[key]) {
                            let n = activeNotes[key];
                            n.duration = timeSec - n.start;
                            if (n.duration <= 0) n.duration = 0.05; // Failsafe
                            
                            // Normalisoidaan velocity 0-127 DAW:ia varten
                            parsedNotes.push({ pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity });
                            delete activeNotes[key];
                        }
                    }
                }
            }
            if (parsedNotes.length > 0) {
                tracks.push({ name: trackName, notes: parsedNotes });
            }
            offset = trackEnd;
        }

        return { tracks };
    };

    // --- WRITER (VIENTI) ---
    LocalMidi.exportTrack = function(trackName, notes) {
        const PPQ = 480; // Standardi Ticks Per Quarter Note
        const BPM = 120; // Oletus DAW tempo viennissä
        
        // Ticks = sekunnit * (BPM / 60) * PPQ
        // Koska 120/60 = 2, kerroin on sekunnit * 960.
        const secToTicks = (sec) => Math.round(sec * (BPM / 60) * PPQ);

        // 1. Muuta nuotit erillisiksi Note On / Note Off tapahtumiksi
        let events = [];
        notes.forEach(n => {
            events.push({ time: n.start, type: 'on', pitch: n.pitch, vel: n.velocity || 100 });
            events.push({ time: n.start + n.duration, type: 'off', pitch: n.pitch, vel: 0 });
        });

        // Lajittele aikajärjestykseen. Jos samalla hetkellä on off ja on, laita off ensin.
        events.sort((a, b) => {
            if (a.time === b.time) return a.type === 'off' ? -1 : 1;
            return a.time - b.time;
        });

        // 2. Rakenna Nuottiraita (MTrk)
        let trackData = [];
        
        // Raitojen nimi (Meta Event)
        trackData.push(0x00, 0xFF, 0x03); 
        let nameBytes = writeString(trackName || "Raita");
        trackData.push(...writeVLQ(nameBytes.length));
        trackData.push(...nameBytes);

        let lastTicks = 0;
        events.forEach(ev => {
            let ticks = secToTicks(ev.time);
            let delta = ticks - lastTicks;
            if (delta < 0) delta = 0;
            lastTicks = ticks;

            trackData.push(...writeVLQ(delta));
            if (ev.type === 'on') {
                trackData.push(0x90, ev.pitch, ev.vel); // 0x90 = Channel 0 Note On
            } else {
                trackData.push(0x80, ev.pitch, 0x00);   // 0x80 = Channel 0 Note Off
            }
        });

        // End of Track Meta Event
        trackData.push(0x00, 0xFF, 0x2F, 0x00);

        // 3. Rakenna Temporaita (MTrk)
        let tempoTrackData = [];
        // Asetetaan Tempo 120 BPM = 500,000 mikrosekuntia (0x07A120)
        tempoTrackData.push(0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20);
        tempoTrackData.push(0x00, 0xFF, 0x2F, 0x00); // End of Track

        // 4. Kokoa MIDI-tiedosto
        let midiFile = [];
        
        // MThd (Header)
        midiFile.push(...writeString("MThd"));
        midiFile.push(...write32(6)); // Header pituus aina 6
        midiFile.push(...write16(1)); // Format 1 (Useita raitoja)
        midiFile.push(...write16(2)); // Raitojen määrä (Tempo + Nuotit)
        midiFile.push(...write16(PPQ)); // Division

        // Tempo MTrk
        midiFile.push(...writeString("MTrk"));
        midiFile.push(...write32(tempoTrackData.length));
        midiFile.push(...tempoTrackData);

        // Nuotit MTrk
        midiFile.push(...writeString("MTrk"));
        midiFile.push(...write32(trackData.length));
        midiFile.push(...trackData);

        return new Uint8Array(midiFile);
    };

    exports.LocalMidi = LocalMidi;
})(window);