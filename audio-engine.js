(function(global) {
    "use strict";

    const EQ_FREQS = [30, 60, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000, 20000, 22000];
    let masterChainEntry = null;

    function audioBufferToWav(buffer) {
        let numOfChan = buffer.numberOfChannels, length = buffer.length * numOfChan * 2 + 44, 
        outBuffer = new ArrayBuffer(length), view = new DataView(outBuffer), 
        channels = [], i, offset = 0, pos = 0;
        
        const setU16 = d => { view.setUint16(pos, d, true); pos += 2; }; 
        const setU32 = d => { view.setUint32(pos, d, true); pos += 4; };
        
        setU32(0x46464952); setU32(length - 8); setU32(0x45564157); setU32(0x20746d66); 
        setU32(16); setU16(1); setU16(numOfChan); setU32(buffer.sampleRate); 
        setU32(buffer.sampleRate * 2 * numOfChan); setU16(numOfChan * 2); setU16(16); 
        setU32(0x61746164); setU32(length - pos - 4);
        
        for (i = 0; i < numOfChan; i++) channels.push(buffer.getChannelData(i));
        while (pos < length) { 
            for (i = 0; i < numOfChan; i++) { 
                let s = Math.max(-1, Math.min(1, channels[i][offset] || 0)); 
                s = (s < 0 ? s * 32768 : s * 32767) | 0; 
                view.setInt16(pos, s, true); pos += 2; 
            } 
            offset++; 
        }
        return new Blob([outBuffer], { type: "audio/wav" });
    }

    function generateImpulseResponse(ctx, decay) {
        const length = ctx.sampleRate * decay; const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
        const left = impulse.getChannelData(0); const right = impulse.getChannelData(1);
        for (let i = 0; i < length; i++) { const n = length - i; left[i] = (Math.random() * 2 - 1) * Math.pow(n / length, 5); right[i] = (Math.random() * 2 - 1) * Math.pow(n / length, 5); }
        return impulse;
    }

    function buildFXChain(ctx, inputNode, outputNode, fxState, liveAnalysers = null, customFXArray = [], ownerId = null, scSourceId = null, scBussesMap = global.scBusses) {
        let current = inputNode;

        if (fxState.channelMode && fxState.channelMode !== 'stereo') {
            const splitter = ctx.createChannelSplitter(2);
            const merger = ctx.createChannelMerger(2);
            current.connect(splitter);

            if (fxState.channelMode === 'left') {
                splitter.connect(merger, 0, 0); 
                splitter.connect(merger, 0, 1); 
            } else if (fxState.channelMode === 'right') {
                splitter.connect(merger, 1, 0); 
                splitter.connect(merger, 1, 1); 
            } else if (fxState.channelMode === 'mono') {
                const mixGain = ctx.createGain();
                mixGain.gain.value = 0.5; 
                splitter.connect(mixGain, 0);
                splitter.connect(mixGain, 1);
                mixGain.connect(merger, 0, 0);
                mixGain.connect(merger, 0, 1);
            }
            current = merger;
        }

        const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = fxState.lpf.freq; lpf.Q.value = fxState.lpf.q;
        if (fxState.lpf.on) { current.connect(lpf); current = lpf; }

        const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = fxState.hpf.freq; hpf.Q.value = fxState.hpf.q;
        if (fxState.hpf.on) { current.connect(hpf); current = hpf; }

        const revIn = ctx.createGain(); const revDry = ctx.createGain(); const revWet = ctx.createGain();
        const convolver = ctx.createConvolver(); convolver.buffer = generateImpulseResponse(ctx, fxState.reverb.decay);
        current.connect(revIn); revIn.connect(revDry); revIn.connect(convolver); convolver.connect(revWet);
        const revOut = ctx.createGain(); revDry.connect(revOut); revWet.connect(revOut);
        if (fxState.reverb.on) { revDry.gain.value = 1 - fxState.reverb.mix; revWet.gain.value = fxState.reverb.mix; } else { revDry.gain.value = 1; revWet.gain.value = 0; }
        current = revOut;

        const chIn = ctx.createGain(); const chDry = ctx.createGain(); const chWet = ctx.createGain();
        const chDelay = ctx.createDelay(); chDelay.delayTime.value = 0.03; const chLfo = ctx.createOscillator(); chLfo.frequency.value = fxState.chorus.rate;
        const chDepth = ctx.createGain(); chDepth.gain.value = fxState.chorus.depth; chLfo.connect(chDepth); chDepth.connect(chDelay.delayTime); chLfo.start(0);
        current.connect(chIn); chIn.connect(chDry); chIn.connect(chDelay); chDelay.connect(chWet);
        const chOut = ctx.createGain(); chDry.connect(chOut); chWet.connect(chOut);
        if (fxState.chorus.on) { chDry.gain.value = 1 - fxState.chorus.mix; chWet.gain.value = fxState.chorus.mix; } else { chDry.gain.value = 1; chWet.gain.value = 0; }
        current = chOut;

        const flIn = ctx.createGain(); const flDry = ctx.createGain(); const flWet = ctx.createGain();
        const flDelay = ctx.createDelay(); flDelay.delayTime.value = 0.005; const flFdbk = ctx.createGain(); flFdbk.gain.value = fxState.flanger.feedback;
        const flLfo = ctx.createOscillator(); flLfo.frequency.value = fxState.flanger.rate; const flDepth = ctx.createGain(); flDepth.gain.value = fxState.flanger.depth;
        flLfo.connect(flDepth); flDepth.connect(flDelay.delayTime); flLfo.start(0);
        current.connect(flIn); flIn.connect(flDry); flIn.connect(flDelay); flDelay.connect(flWet); flDelay.connect(flFdbk); flFdbk.connect(flDelay);
        const flOut = ctx.createGain(); flDry.connect(flOut); flWet.connect(flOut);
        if (fxState.flanger.on) { flDry.gain.value = 1 - fxState.flanger.mix; flWet.gain.value = fxState.flanger.mix; } else { flDry.gain.value = 1; flWet.gain.value = 0; }
        current = flOut;

        const delIn = ctx.createGain(); const delDry = ctx.createGain(); const delWet = ctx.createGain();
        const delNode = ctx.createDelay(3.0); delNode.delayTime.value = fxState.delay.time; const delFdbk = ctx.createGain(); delFdbk.gain.value = fxState.delay.feedback;
        current.connect(delIn); delIn.connect(delDry); delIn.connect(delNode); delNode.connect(delFdbk); delFdbk.connect(delNode); delNode.connect(delWet);
        const delOut = ctx.createGain(); delDry.connect(delOut); delWet.connect(delOut);
        if (fxState.delay.on) { delDry.gain.value = 1 - fxState.delay.mix; delWet.gain.value = fxState.delay.mix; } else { delDry.gain.value = 1; delWet.gain.value = 0; }
        current = delOut;

        let eqPrev = current;
        EQ_FREQS.forEach((f, i) => { const filt = ctx.createBiquadFilter(); filt.type = 'peaking'; filt.frequency.value = f; filt.Q.value = 1.5; filt.gain.value = fxState.eq.on ? fxState.eq.values[i] : 0; eqPrev.connect(filt); eqPrev = filt; });
        current = eqPrev;

        const sourceScBus = (scSourceId && scBussesMap) ? scBussesMap.get(scSourceId) : null;
        if (customFXArray && customFXArray.length > 0) {
            customFXArray.forEach(fx => {
                if (fx && typeof fx.getNodes === 'function') {
                    const nodes = fx.getNodes(); 
                    try { nodes.output.disconnect(); } catch(e){}
                    current.connect(nodes.input); 
                    current = nodes.output;

                    if (nodes.sidechain && sourceScBus) {
                        try { sourceScBus.disconnect(nodes.sidechain); } catch(e){}
                        sourceScBus.connect(nodes.sidechain);
                    }
                }
            });
        }

        const limiter = ctx.createDynamicsCompressor(); limiter.knee.value = 0; limiter.attack.value = 0.003; limiter.release.value = 0.25;
        if (fxState.limiter.on) { limiter.threshold.value = fxState.limiter.threshold; limiter.ratio.value = 20; } else { limiter.ratio.value = 1; }
        current.connect(limiter); current = limiter;

        if (fxState.invertPhase) {
            const inverter = ctx.createGain();
            inverter.gain.value = -1;
            current.connect(inverter);
            current = inverter;
        }

        const panner = ctx.createStereoPanner(); panner.pan.value = fxState.pan;
        const outGain = ctx.createGain(); outGain.gain.value = fxState.vol;
        current.connect(panner); panner.connect(outGain);
        
        // -------------------------------------------------------------
        // ULOSTULOJEN JAKAMINEN (Main / Group Output + Sidechain Bus)
        // -------------------------------------------------------------

        // 1. Pääsignaalin reititys kohteeseen (Output Node) ja analysaattoreihin
        if (liveAnalysers) {
            if (liveAnalysers.split) {
                const splitter = ctx.createChannelSplitter(2);
                outGain.connect(splitter);
                splitter.connect(liveAnalysers.nodeL, 0, 0); 
                splitter.connect(liveAnalysers.nodeR, 1, 0); 
                outGain.connect(outputNode); 
            } else {
                outGain.connect(liveAnalysers.node);
                liveAnalysers.node.connect(outputNode);
            }
        } else {
            outGain.connect(outputNode);
        }

        // 2. Tuplattu rinnakkainen ulostulo Sidechain-väylään
        if (ownerId && scBussesMap && scBussesMap.has(ownerId)) {
            const scTarget = scBussesMap.get(ownerId);
            try { outGain.disconnect(scTarget); } catch(e){} // Varmistetaan ettei tule tuplaliitoksia
            outGain.connect(scTarget);
        }

        return { outGain, panner };
    }

    function rebuildMasterGraph() {
        if (masterChainEntry) {
            global.masterBusInput.disconnect(masterChainEntry);
        }
        masterChainEntry = global.audioCtx.createGain();
        global.masterBusInput.connect(masterChainEntry);

        buildFXChain(
            global.audioCtx, 
            masterChainEntry, 
            global.audioCtx.destination, 
            global.masterFX, 
            { split: true, nodeL: global.masterAnalyserL, nodeR: global.masterAnalyserR }, 
            global.masterCustomFX,
            'master',
            null
        );
    }

    function instantiateCustomFX(scriptText, fileName, stateData, targetArray, targetDom, onUpdate) {
        try {
            const originalWindowAdd = window.addEventListener;
            const originalDocAdd = document.addEventListener;
            const capturedListeners = [];

            window.addEventListener = function(type, listener, options) {
                capturedListeners.push({ target: window, type, listener, options });
                originalWindowAdd.call(window, type, listener, options);
            };
            document.addEventListener = function(type, listener, options) {
                capturedListeners.push({ target: document, type, listener, options });
                originalDocAdd.call(document, type, listener, options);
            };

            const oldEffectClass = window.CustomAudioEffect; window.CustomAudioEffect = null;
            const scriptTag = document.createElement('script'); scriptTag.textContent = scriptText; document.head.appendChild(scriptTag);
            const NewFXClass = window.CustomAudioEffect; window.CustomAudioEffect = oldEffectClass; scriptTag.remove();

            window.addEventListener = originalWindowAdd;
            document.addEventListener = originalDocAdd;

            if (NewFXClass) {
                const newInstance = new NewFXClass(global.audioCtx); 
                newInstance._scriptText = scriptText; 
                newInstance._fileName = fileName;
                newInstance._capturedListeners = capturedListeners;

                if(stateData && typeof newInstance.setState === 'function') newInstance.setState(stateData);

                const wrapper = document.createElement('div'); wrapper.style = "background: rgba(0,0,0,0.6); border: 1px solid rgba(0, 240, 255, 0.3); border-radius: 8px; padding: 15px; position: relative; margin-bottom: 10px; box-shadow: inset 0 0 10px rgba(0,0,0,0.5);";
                const removeBtn = document.createElement('button'); removeBtn.innerText = "X"; removeBtn.style = "position: absolute; top: 10px; right: 10px; background: transparent; border: 1px solid #ff003c; color: #ff003c; border-radius: 50%; width: 24px; height: 24px; font-size: 10px; font-weight: bold; cursor: pointer; z-index: 10;";
                const uiContainer = document.createElement('div');
                if(typeof newInstance.renderUI === 'function') newInstance.renderUI(uiContainer); else { uiContainer.innerText = fileName + " (Ei käyttöliittymää)"; uiContainer.style.color = "#8b8b9f"; uiContainer.style.fontSize = "12px"; }

                removeBtn.onclick = () => {
                    if (typeof newInstance.destroy === 'function') newInstance.destroy(); 
                    newInstance._capturedListeners.forEach(l => {
                        l.target.removeEventListener(l.type, l.listener, l.options);
                    });
                    const index = targetArray.indexOf(newInstance); if(index > -1) targetArray.splice(index, 1);
                    wrapper.remove(); if(onUpdate) onUpdate();
                };

                // PÄIVITETTY MIDI-LÄPÄISY (Pass-through)
                newInstance._chainSendMidi = function(msg) {
                    const idx = targetArray.indexOf(this);
                    if (idx > -1) {
                        // Etsitään seuraava efekti ketjusta, joka ymmärtää MIDIä.
                        // Tämä hyppää automaattisesti sellaisten audio-efektien yli, joilla ei ole onMidi-funktiota.
                        for (let i = idx + 1; i < targetArray.length; i++) {
                            const nextFx = targetArray[i];
                            if (typeof nextFx.onMidi === 'function') {
                                nextFx.onMidi(msg);
                                return; // Lopetetaan etsintä, signaali toimitettu eteenpäin
                            }
                        }
                    }
                };

                let externalSendMidi = null;
                Object.defineProperty(newInstance, 'sendMidi', {
                    get: () => {
                        return (msg) => {
                            newInstance._chainSendMidi(msg);
                            if(externalSendMidi) externalSendMidi(msg);
                        };
                    },
                    set: (fn) => { externalSendMidi = fn; }
                });

                wrapper.appendChild(removeBtn); wrapper.appendChild(uiContainer); targetDom.appendChild(wrapper);
                targetArray.push(newInstance); 
                if (onUpdate) onUpdate();
                
                return newInstance;
            }
        } catch(err) { console.error("Virhe Custom FX:", err); }
        return null;
    }

    function buildOfflineCustomFX(customFXArray, offCtx) {
        const arr = []; customFXArray.forEach(fx => { try { const oldClass = window.CustomAudioEffect; window.CustomAudioEffect = null; const scriptTag = document.createElement('script'); scriptTag.textContent = fx._scriptText; document.head.appendChild(scriptTag); const NewClass = window.CustomAudioEffect; window.CustomAudioEffect = oldClass; scriptTag.remove(); if(NewClass) { const inst = new NewClass(offCtx); if(typeof inst.setState === 'function' && typeof fx.getState === 'function') { inst.setState(fx.getState()); } arr.push(inst); } } catch(e) { } }); return arr;
    }

    async function executeExport() {
        const start = parseFloat(document.getElementById('exportStart').value); const end = parseFloat(document.getElementById('exportEnd').value);
        if (end <= start) return alert("Virheellinen pituus."); global.closeExportModal(); 
        document.getElementById('statusText').innerText = "Exporting WAV"; document.getElementById('statusText').classList.add('busy');

        setTimeout(async () => {
            try {
                const dur = end - start; const offCtx = new OfflineAudioContext(2, dur * 44100, 44100);
                
                const offScBusses = new Map();
                global.tracks.forEach(t => offScBusses.set(t.id, offCtx.createGain()));
                global.groups.forEach(g => offScBusses.set(g.id, offCtx.createGain()));

                const offMasterCustom = buildOfflineCustomFX(global.masterCustomFX, offCtx);
                const bus = offCtx.createGain(); 
                buildFXChain(offCtx, bus, offCtx.destination, global.masterFX, null, offMasterCustom, 'master', null, offScBusses);
                
                const groupBusses = {}; global.groups.forEach(g => { const offGroupCustom = buildOfflineCustomFX(g.customFX, offCtx); const inNode = offCtx.createGain(); const nodes = buildFXChain(offCtx, inNode, bus, g.fx, null, offGroupCustom, g.id, g.sidechainSource, offScBusses); nodes.outGain.gain.value = g.isMuted ? 0 : g.fx.vol; groupBusses[g.id] = inNode; });

                global.tracks.forEach(t => {
                    const dest = t.groupId && groupBusses[t.groupId] ? groupBusses[t.groupId] : bus;
                    const offTrackCustom = buildOfflineCustomFX(t.customFX, offCtx);
                    
                    if(t.isMidi) {
                        if(!t.isMuted) {
                            const trackIn = offCtx.createGain(); const nodes = buildFXChain(offCtx, trackIn, dest, t.fx, null, offTrackCustom, t.id, t.sidechainSource, offScBusses); nodes.outGain.gain.value = t.fx.vol;
                            const regionAbsStart = t.startTimeOffset + t.trimStart; const regionAbsEnd = t.startTimeOffset + t.trimEnd;
                            
                            t.notes.forEach(note => {
                                const noteAbsStart = t.startTimeOffset + note.start; const noteAbsEnd = noteAbsStart + note.duration;
                                const playAbsStart = Math.max(noteAbsStart, regionAbsStart); const playAbsEnd = Math.min(noteAbsEnd, regionAbsEnd);
                                const rStart = playAbsStart - start; const rEnd = playAbsEnd - start;
                                if(rStart < dur && rEnd > 0 && playAbsStart < playAbsEnd) {
                                    let offsetTimeline = playAbsStart - noteAbsStart; let drawDur = playAbsEnd - playAbsStart; let when = rStart;
                                    if(rStart < 0) { offsetTimeline += Math.abs(rStart); drawDur -= Math.abs(rStart); when = 0; }
                                    
                                    t.sampler.playNote(offCtx, trackIn, note.pitch, note.velocity, when, offsetTimeline, drawDur);
                                }
                            });

                        }
                    } else {
                        const rate = (t.fx && t.fx.playbackRate) ? t.fx.playbackRate : 1.0;
                        const aStart = t.startTimeOffset + (t.trimStart / rate); 
                        const aEnd = t.startTimeOffset + (t.trimEnd / rate); 
                        const rStart = aStart - start;
                        
                        if (rStart >= 0 && rStart < dur) { 
                            const pDur = Math.min(aEnd - aStart, dur - rStart); 
                            const src = offCtx.createBufferSource(); 
                            src.buffer = t.buffer; 
                            src.playbackRate.value = rate;
                            const nodes = buildFXChain(offCtx, src, dest, t.fx, null, offTrackCustom, t.id, t.sidechainSource, offScBusses); 
                            nodes.outGain.gain.setValueAtTime(t.isMuted ? 0 : t.fx.vol, rStart); 
                            if (!t.isMuted) { 
                                if (t.fadeIn > 0) { 
                                    const fiStart = rStart; 
                                    nodes.outGain.gain.setValueAtTime(0, fiStart); 
                                    nodes.outGain.gain.linearRampToValueAtTime(t.fx.vol, fiStart + (t.fadeIn / rate)); 
                                } 
                                if (t.fadeOut > 0) { 
                                    const foEnd = rStart + pDur; 
                                    nodes.outGain.gain.setValueAtTime(t.fx.vol, foEnd - (t.fadeOut / rate)); 
                                    nodes.outGain.gain.linearRampToValueAtTime(0, foEnd); 
                                } 
                            }
                            src.start(rStart, t.trimStart, pDur * rate);
                        } else if (rStart < 0 && (aEnd - start) > 0) { 
                            const offShiftTimeline = Math.abs(rStart); 
                            const offShiftSource = offShiftTimeline * rate;
                            const pDur = Math.min((aEnd - start), dur); 
                            const src = offCtx.createBufferSource(); 
                            src.buffer = t.buffer; 
                            src.playbackRate.value = rate;
                            const nodes = buildFXChain(offCtx, src, dest, t.fx, null, offTrackCustom, t.id, t.sidechainSource, offScBusses); 
                            nodes.outGain.gain.setValueAtTime(t.isMuted ? 0 : t.fx.vol, 0); 
                            if (!t.isMuted) { 
                                if (t.fadeIn > offShiftSource) { 
                                    const fiStart = 0; 
                                    nodes.outGain.gain.setValueAtTime( (offShiftSource/t.fadeIn)*t.fx.vol, fiStart); 
                                    nodes.outGain.gain.linearRampToValueAtTime(t.fx.vol, fiStart + ((t.fadeIn-offShiftSource)/rate)); 
                                } 
                                if (t.fadeOut > 0) { 
                                    const foEnd = pDur; 
                                    nodes.outGain.gain.setValueAtTime(t.fx.vol, foEnd - (t.fadeOut / rate)); 
                                    nodes.outGain.gain.linearRampToValueAtTime(0, foEnd); 
                                } 
                            }
                            src.start(0, t.trimStart + offShiftSource, pDur * rate);
                        }
                    }
                });
                
                const buf = await offCtx.startRendering(); 
                const wav = audioBufferToWav(buf);
                const a = document.createElement('a'); a.href = URL.createObjectURL(wav); a.download = 'mix.wav'; a.click(); 
                
            } catch(e) { alert("Virhe viennissä: " + e.message); } 
            finally { document.getElementById('statusText').innerText = "Valmis"; document.getElementById('statusText').classList.remove('busy'); }
        }, 50);
    }

    // Expose functionality to the global scope
    global.audioBufferToWav = audioBufferToWav;
    global.generateImpulseResponse = generateImpulseResponse;
    global.buildFXChain = buildFXChain;
    global.rebuildMasterGraph = rebuildMasterGraph;
    global.instantiateCustomFX = instantiateCustomFX;
    global.buildOfflineCustomFX = buildOfflineCustomFX;
    global.executeExport = executeExport;

})(typeof window !== 'undefined' ? window : this);