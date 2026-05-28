/* =========================================
   FX PLUGINS LIST (fx-list.js)
   Kaikki saatavilla olevat efektit
========================================= */

(function(exports) {
    // Tämä taulukko toimii rekisterinä saatavilla oleville efekteille.
    // Kaikki liitteenä olevat efektit on lisätty tähän luetteloon aakkosjärjestyksessä.
    
    const pluginList = [
        { name: "Basic Channel (EQ/Pan/Vol)", file: "basic.js" },
        { name: "Signal Flow Router", file: "signalflow.js" },
        { name: "EQ", file: "eq.js" },
        { name: "Dynamics (Comp/Limit/Gate)", file: "limit-comp-gate.js" },
        { name: "LUFS & Peaks Meter", file: "masterinfo.js" },

        { name: "Advanced Room Simulator", file: "room.js" },
        { name: "Delay", file: "delay.js" },
        { name: "Delay (Echo Station)", file: "echostation.js" },
        { name: "Reverb", file: "reverb.js" },

        { name: "Chorus", file: "chorus.js" },
        { name: "Phaser", file: "phaser.js" },
        { name: "Flanger", file: "flanger.js" },
        { name: "Ring Modulator", file: "ring.js" },
        { name: "Rotary", file: "rotary.js" },
        { name: "Randomizer", file: "randomizer.js" },
        { name: "Panner", file: "panner.js" },
        { name: "Vibrato", file: "vibrato.js" },
        { name: "Volume Modifier", file: "volume.js" },
    
        { name: "Diatonic Harmonizer", file: "harmonizer.js" },

        { name: "ADSR Gate & Looper", file: "adsr.js" },
        { name: "Audio Synthesizer", file: "audiosynth.js" },
        { name: "Audio Sampler", file: "audiosampler.js" },
        { name: "Trance Gate", file: "trancegate.js" },
        { name: "Tuner", file: "tune.js" },

        { name: "Distortion (Basic)", file: "distortion.js" },
        { name: "Distortion (Advanced)", file: "mutator.js" },
        { name: "Saturation", file: "saturation.js" },
        { name: "Harmonic Exciter", file: "exciter.js" },
        { name: "Lo-Fi & Tape Simulator", file: "lofi.js" },
        { name: "Guitar Amp", file: "guitaramp.js" },
        { name: "Bass Amp", file: "bassamp.js" },
        { name: "Cabinet Simulator", file: "cabinet.js" },

        { name: "Spectrogram Visualizer", file: "spectrogram.js" },
        
        { name: "3D Surround Room (HRTF)", file: "surround.js" },

        { name: "MIDI/Audio Sheet Note Visualizer", file: "sheet.js" },
        { name: "MIDI/Audio Modular Synthesizer", file: "modsynth.js" },
        { name: "MIDI/Audio to Piano", file: "piano.js" },
        { name: "MIDI Isomorphic Keys", file: "midi-isomorphic.js" },
        { name: "MIDI Drum Kit", file: "midi-drums.js" },
        { name: "MIDI Bass", file: "midi-bass.js" },
        { name: "MIDI Guitar", file: "midi-guitar.js" },
        { name: "MIDI Circle of Fifths", file: "circle-of-fifths.js" },
        { name: "MIDI Chord Pad", file: "midi-chordpad.js" },
        { name: "MIDI Bassline", file: "midi-bassline.js" },
        { name: "MIDI Chordifier", file: "midi-chordifier.js" },
        { name: "MIDI Scale Converter", file: "midi-scaleconverter.js" },
        { name: "MIDI Humanizer/Quantizer", file: "midi-humanizer.js" },
        { name: "MIDI Sequencer", file: "midi-sequencer.js" },
        { name: "MIDI Mapper / Sampler", file: "midimap.js" },
        { name: "Microtone", file: "microtone.js" }
    ];

    // Viedään lista globaaliin nimiavaruuteen (window)
    exports.FX_PLUGINS = pluginList;

})(window);