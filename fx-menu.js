/**
 * fx-menu.js
 * Generates the FX Menu UI with modsynth.js style rotary knobs,
 * stylized EQ sliders, and stereo/mono channel routing capabilities.
 */

(function() {
    // Inject dynamic CSS for the Knobs and customized EQ sliders
    const style = document.createElement('style');
    style.innerHTML = `
        .knob-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            margin: 5px;
            width: 45px;
        }
        .knob-label {
            font-size: 9px;
            font-family: monospace;
            color: #ddd;
            margin-bottom: 4px;
            text-shadow: 1px 1px 1px #000;
            font-weight: bold;
            white-space: nowrap;
        }
        .knob-value {
            font-size: 9px;
            font-family: monospace;
            color: #00f0ff;
            margin-top: 4px;
            text-shadow: 1px 1px 1px #000;
            font-weight: bold;
        }
        .knob {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: linear-gradient(145deg, #444, #111);
            border: 1px solid #000;
            position: relative;
            cursor: ns-resize;
            box-shadow: 0 3px 5px rgba(0,0,0,0.6), inset 0 1px 2px rgba(255,255,255,0.2);
            touch-action: none; /* Prevent scrolling when turning knobs */
        }
        .knob-indicator {
            position: absolute;
            top: 4px;
            left: 14.5px;
            width: 2px;
            height: 9px;
            background: #fff;
            transform-origin: 1px 12px;
            box-shadow: 0 0 4px #fff;
            border-radius: 1px;
            pointer-events: none;
        }
        
        /* Stylized EQ Sliders */
        .eq-slider-styled {
            -webkit-appearance: none;
            writing-mode: bt-lr; /* IE/Edge fallback */
            width: 14px;
            height: 110px;
            background: #1a1a1a;
            border-radius: 4px;
            border: 1px solid #333;
            outline: none;
            box-shadow: inset 0 2px 4px rgba(0,0,0,0.8);
            margin-bottom: 5px;
        }
        .eq-slider-styled::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 24px;
            height: 14px;
            background: linear-gradient(to bottom, #666, #444);
            border: 1px solid #222;
            border-radius: 3px;
            cursor: pointer;
            box-shadow: 0 2px 4px rgba(0,0,0,0.6);
            margin-left: -6px; /* Centering the thumb over the track */
        }
        .eq-slider-styled::-moz-range-thumb {
            width: 24px;
            height: 14px;
            background: linear-gradient(to bottom, #666, #444);
            border: 1px solid #222;
            border-radius: 3px;
            cursor: pointer;
        }
    `;
    document.head.appendChild(style);

    // --- Knob Component Logic ---
    function createKnob(parent, labelText, min, max, value, step, displayFormatter, onChangeCallback) {
        const wrapper = document.createElement('div');
        wrapper.className = 'knob-container';

        const label = document.createElement('div');
        label.className = 'knob-label';
        label.innerText = labelText;

        const valDisplay = document.createElement('div');
        valDisplay.className = 'knob-value';
        valDisplay.innerText = displayFormatter(value);

        const knob = document.createElement('div');
        knob.className = 'knob';
        
        const indicator = document.createElement('div');
        indicator.className = 'knob-indicator';
        knob.appendChild(indicator);

        wrapper.appendChild(label);
        wrapper.appendChild(knob);
        wrapper.appendChild(valDisplay);
        parent.appendChild(wrapper);

        // Rotation Math (-135deg to +135deg)
        const updateRotation = (val) => {
            const pct = (val - min) / (max - min);
            const deg = -135 + (pct * 270);
            indicator.style.transform = `rotate(${deg}deg)`;
            knob.title = displayFormatter(val);
        };
        updateRotation(value);

        // Drag Handling
        let isDragging = false;
        let startY = 0;
        let startVal = 0;
        let currentValue = value;

        const onDragStart = (e) => {
            isDragging = true;
            startY = e.clientY !== undefined ? e.clientY : e.touches[0].clientY;
            startVal = currentValue;
            e.preventDefault();
        };

        const onDragMove = (e) => {
            if (!isDragging) return;
            const currentY = e.clientY !== undefined ? e.clientY : e.touches[0].clientY;
            const deltaY = startY - currentY; // Moving UP increases value
            
            // Sensitivity
            let newVal = startVal + (deltaY * (max - min) / 150); 
            
            // Clamp
            newVal = Math.max(min, Math.min(max, newVal));
            
            // Apply step rounding
            if (step > 0) {
                newVal = Math.round(newVal / step) * step;
            }

            // Fix floating point "-0" issue
            if (Math.abs(newVal) < 0.0001) newVal = 0;

            if (currentValue !== newVal) {
                currentValue = newVal;
                updateRotation(currentValue);
                valDisplay.innerText = displayFormatter(currentValue);
                onChangeCallback(currentValue);
            }
        };

        const onDragEnd = () => {
            if(isDragging) {
                isDragging = false;
                if(window.saveState) window.saveState();
            }
        };

        knob.addEventListener('mousedown', (e) => {
            onDragStart(e);
            window.addEventListener('mousemove', onDragMove);
            window.addEventListener('mouseup', () => {
                onDragEnd();
                window.removeEventListener('mousemove', onDragMove);
            }, { once: true });
        });

        knob.addEventListener('touchstart', (e) => {
            onDragStart(e);
            window.addEventListener('touchmove', onDragMove, { passive: false });
            window.addEventListener('touchend', () => {
                onDragEnd();
                window.removeEventListener('touchmove', onDragMove);
            }, { once: true });
        }, { passive: false });

        return {
            updateValue: (newVal) => {
                currentValue = newVal;
                updateRotation(currentValue);
                valDisplay.innerText = displayFormatter(currentValue);
            }
        };
    }

    // --- Main UI Builder ---
    window.FXMenu = {
        build: function(containerId, parentObj, fxObj, titleStr, onUpdate, config) {
            const container = document.getElementById(containerId);
            const customArr = config.customArr || [];
            const customDom = config.customDom || null;
            const isRec = config.isRec || false;
            
            // Formatters
            const fPct = v => Math.round(v * 100) + '%'; 
            const fSec = v => v.toFixed(2) + 's'; 
            const fHz = v => Math.round(v) + 'Hz'; 
            const fDb = v => v.toFixed(1) + 'dB';
            
            // Pan Formatter fix (shows 'C' reliably)
            const fPan = v => {
                if (Math.abs(v) < 0.001) return 'C';
                return v < 0 ? 'L' : 'R';
            };

            // Näytetään raidan tiedot (Alkuperäiset vs. Web Audio API) jos parentObj on olemassa
            let trackInfoHtml = '';
            if (parentObj) {
                if (parentObj.isMidi) {
                    trackInfoHtml = `<div style="font-size: 0.75rem; color: #aaa; margin-bottom: 15px; background: #222; padding: 6px 10px; border-radius: 4px; display: inline-block; border: 1px solid #333;">Raidan tyyppi: <b style="color:#fff;">MIDI</b></div>`;
                } else if (parentObj.buffer) {
                    const sr = parentObj.buffer.sampleRate;
                    const ch = parentObj.buffer.numberOfChannels;
                    const chStr = ch === 1 ? 'Mono' : (ch === 2 ? 'Stereo' : ch + ' ch');
                    const infoId = 'track-info-' + parentObj.id.replace(/[^a-zA-Z0-9]/g, '');
                    
                    trackInfoHtml = `<div id="${infoId}" style="font-size: 0.75rem; color: #aaa; margin-bottom: 15px; background: #222; padding: 6px 10px; border-radius: 4px; display: inline-block; line-height: 1.5; border: 1px solid #333;">
                        <div style="margin-bottom: 2px;">Raidan tyyppi: <b style="color:#fff;">Audio (${chStr})</b></div>
                        <div style="margin-bottom: 2px;" title="Web Audio API dekoodaa audion aina tähän sisäiseen työskentelymuotoon efektointia varten.">Web Audio API: <b style="color:#00f0ff;">${sr} Hz / 32-bit float</b></div>
                        <div>Alkuperäinen tiedosto: <b id="${infoId}-orig" style="color:#4caf50;">Tarkistetaan...</b></div>
                    </div>`;

                    // Asynchronous original file metadata check
                    if (parentObj.file && parentObj.file.slice && parentObj.file.name) {
                        const fname = parentObj.file.name.toLowerCase();
                        if (fname.endsWith('.wav')) {
                            const reader = new FileReader();
                            reader.onload = (e) => {
                                try {
                                    const view = new DataView(e.target.result);
                                    let origSr = "Tuntematon";
                                    let origBd = "Tuntematon";
                                    // Parse RIFF WAVE Header
                                    if (view.byteLength >= 44 && view.getUint32(0, false) === 0x52494646 && view.getUint32(8, false) === 0x57415645) {
                                        let offset = 12;
                                        while (offset < view.byteLength - 8) {
                                            if (view.getUint32(offset, false) === 0x666d7420) { // 'fmt '
                                                origSr = view.getUint32(offset + 12, true) + " Hz";
                                                origBd = view.getUint16(offset + 22, true) + "-bit";
                                                break;
                                            }
                                            // Skip to next chunk
                                            offset += 8 + view.getUint32(offset + 4, true);
                                        }
                                    }
                                    const el = document.getElementById(`${infoId}-orig`);
                                    if (el) el.innerHTML = `${origSr} / ${origBd}`;
                                } catch(err) {
                                    const el = document.getElementById(`${infoId}-orig`);
                                    if (el) el.innerHTML = `Virhe luennassa`;
                                }
                            };
                            // Read first 8KB to ensure we catch 'fmt ' even if there's junk data at start
                            reader.readAsArrayBuffer(parentObj.file.slice(0, 8192)); 
                        } else {
                            setTimeout(() => {
                                const el = document.getElementById(`${infoId}-orig`);
                                if (el) el.innerHTML = `Pakattu (${fname.split('.').pop().toUpperCase()}) - Ei kiinteää bittisyvyyttä`;
                            }, 10);
                        }
                    } else if (parentObj.fileName && parentObj.fileName.startsWith('Äänitys')) {
                        setTimeout(() => {
                            const el = document.getElementById(`${infoId}-orig`);
                            if (el) el.innerHTML = `DAW Äänitys (Sama kuin Web Audio API)`;
                        }, 10);
                    } else {
                        setTimeout(() => {
                            const el = document.getElementById(`${infoId}-orig`);
                            if (el) el.innerHTML = `Ei saatavilla`;
                        }, 10);
                    }
                }
            }

            container.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink:0;">
                    <h3 style="margin:0; color:white;">${titleStr}</h3>
                    <button onclick="document.querySelector('.modal.active').classList.remove('active')" class="primary">Sulje</button>
                </div>
                ${trackInfoHtml}
                ${isRec ? '<p style="font-size:0.75rem; color:#aaa; margin-top:-10px;">Huom: Käytä kuulokkeita kierron (feedback) estämiseksi. Nämä efektit vaikuttavat monitorointiin ja tallentuvat uudelle raidalle äänitettäessä.</p>' : ''}
            `;
            
            const addRow = (html) => { 
                const d = document.createElement('div'); 
                d.className='settings-row'; 
                d.style.flexDirection = 'column'; 
                d.style.alignItems = 'flex-start'; 
                d.innerHTML = html; 
                container.appendChild(d); 
                return d;
            };

            const bindToggle = (id, fxKey, wrapperId) => { 
                const btn = document.getElementById(id); 
                const wrapper = wrapperId ? document.getElementById(wrapperId) : null; 
                if (btn) {
                    btn.className = 'fx-toggle ' + (fxObj[fxKey].on ? 'on' : ''); 
                    btn.innerText = fxObj[fxKey].on ? 'ON' : 'OFF'; 
                    if (wrapper) wrapper.style.display = fxObj[fxKey].on ? 'flex' : 'none'; 
                    btn.onclick = () => { 
                        fxObj[fxKey].on = !fxObj[fxKey].on; 
                        btn.className = 'fx-toggle ' + (fxObj[fxKey].on ? 'on' : ''); 
                        btn.innerText = fxObj[fxKey].on ? 'ON' : 'OFF'; 
                        if (wrapper) wrapper.style.display = fxObj[fxKey].on ? 'flex' : 'none'; 
                        onUpdate(); 
                        if(window.saveState) window.saveState(); 
                    }; 
                }
            };

            // --- Custom FX Section ---
            if(customDom) {
                const customFxSection = document.createElement('div'); 
                customFxSection.innerHTML = `<div class="fx-header" style="margin-bottom: 10px;"><span class="fx-title" style="color:#00f0ff;">Custom JS Plugins</span></div>`;
                
                const addBtnContainer = document.createElement('div'); 
                addBtnContainer.style.marginBottom = "15px"; addBtnContainer.style.display = "flex"; addBtnContainer.style.gap = "10px"; addBtnContainer.style.alignItems = "center"; addBtnContainer.style.flexWrap = "wrap";
                
                const addBtn = document.createElement('label'); 
                addBtn.className = 'file-upload-label'; addBtn.style = "display:inline-flex; cursor:pointer; background: rgba(0, 240, 255, 0.1); color: #00f0ff; border-color: #00f0ff; margin:0;"; 
                addBtn.innerHTML = `+ Lataa FX (.JS)<input type="file" accept=".js" multiple style="display:none;">`; 
                addBtnContainer.appendChild(addBtn);
                
                // Allow manually loading multiple FX files locally and cache them/instantiate them
                addBtn.querySelector('input').addEventListener('change', (e) => { 
                    const files = Array.from(e.target.files); 
                    if (!files.length) return; 
                    
                    if (!window.localFxCache) window.localFxCache = new Map();
                    let loadedCount = 0;

                    files.forEach(file => {
                        const reader = new FileReader(); 
                        reader.onload = (event) => { 
                            window.localFxCache.set(file.name, event.target.result);
                            loadedCount++;
                            
                            // Jos valittiin vain yksi tiedosto, ladataan se välittömästi käyttöön
                            if (files.length === 1) {
                                if(window.instantiateCustomFX) window.instantiateCustomFX(event.target.result, file.name, null, customArr, customDom, () => { onUpdate(); if(window.saveState) window.saveState(); }); 
                            } 
                            // Muussa tapauksessa vain tallennetaan selaimen muistiin ja ilmoitetaan lopussa
                            else if (loadedCount === files.length) {
                                alert(files.length + " efektiä ladattu selaimen välimuistiin. Voit nyt valita ne vetovalikosta!");
                            }
                        }; 
                        reader.readAsText(file); 
                    });
                    e.target.value = ''; 
                });

                const dropdown = document.createElement('select'); dropdown.className = 'input-label'; dropdown.style.background = 'rgba(0, 240, 255, 0.1)'; dropdown.style.color = '#00f0ff'; dropdown.style.borderColor = '#00f0ff';
                let optionsHTML = `<option value="">-- Valitse valmis FX --</option>`;
                if (window.FX_PLUGINS) { window.FX_PLUGINS.forEach(plugin => { optionsHTML += `<option value="${plugin.file}">${plugin.name}</option>`; }); }
                dropdown.innerHTML = optionsHTML;
                
                dropdown.addEventListener('change', async (e) => {
                    const fileName = e.target.value; 
                    if (!fileName) return;
                    try { 
                        let scriptText;
                        if (window.localFxCache && window.localFxCache.has(fileName)) {
                            scriptText = window.localFxCache.get(fileName);
                        } else {
                            const response = await fetch(`FX/${fileName}`);  
                            if (!response.ok) throw new Error(`Tiedostoa ei löytynyt: ${fileName}`); 
                            scriptText = await response.text(); 
                        }
                        if(window.instantiateCustomFX) {
                            window.instantiateCustomFX(scriptText, fileName, null, customArr, customDom, () => { 
                                onUpdate(); 
                                if(window.saveState) window.saveState(); 
                            }); 
                        }
                    } catch (err) { 
                        alert("Virhe:\n" + err.message + "\n\nAvataan tiedostonvalinta. Valitse haluamasi efektikirjaston tiedostot (voit valita kaikki kerralla)."); 
                        
                        // Automaattinen tiedoston latauksen avaaminen virheen jälkeen
                        const fileInput = document.createElement('input');
                        fileInput.type = 'file';
                        fileInput.multiple = true;
                        fileInput.accept = '.js';
                        
                        fileInput.onchange = (ev) => {
                            const files = Array.from(ev.target.files);
                            if (!window.localFxCache) window.localFxCache = new Map();
                            let loadedCount = 0;
                            let targetScriptFound = false;
                            
                            files.forEach(f => {
                                const reader = new FileReader();
                                reader.onload = (rev) => {
                                    window.localFxCache.set(f.name, rev.target.result);
                                    loadedCount++;
                                    
                                    if (f.name === fileName) targetScriptFound = true;
                                    
                                    if (loadedCount === files.length) {
                                        if (targetScriptFound) {
                                            // Jos etsitty skripti löytyi ja ladattiin, avataan se heti automaattisesti!
                                            const scriptText = window.localFxCache.get(fileName);
                                            if (window.instantiateCustomFX) {
                                                window.instantiateCustomFX(scriptText, fileName, null, customArr, customDom, () => { onUpdate(); if(window.saveState) window.saveState(); });
                                            }
                                        } else {
                                            alert("Valitut tiedostot ladattu välimuistiin, mutta äsken valitsemaasi efektiä (" + fileName + ") ei löytynyt niiden joukosta. Kokeile valita valikosta toinen efekti.");
                                        }
                                    }
                                };
                                reader.readAsText(f);
                            });
                        };
                        
                        // Laukaisu
                        fileInput.click();
                        
                    } 
                    e.target.value = ''; 
                });
                addBtnContainer.appendChild(dropdown); 

                customFxSection.appendChild(addBtnContainer); 
                customFxSection.appendChild(customDom); 
                container.appendChild(customFxSection);
            }

            // --- Routing & Sidechain Section (Raidoille/Ryhmille, ei Masterille) ---
            if (parentObj) {
                if (!fxObj.channelMode) fxObj.channelMode = 'stereo';
                if (fxObj.invertPhase === undefined) fxObj.invertPhase = false; // Taaksepäin yhteensopivuus

                const routingRow = addRow(`<div class="fx-header" style="border:none; padding:0; margin:0;"><span class="fx-title">Routing & Sidechain</span></div><div class="fx-controls-wrapper" style="display:flex; width:100%; gap:10px;"></div>`);
                const routingWrapper = routingRow.querySelector('.fx-controls-wrapper');

                const routingSelect = document.createElement('select');
                routingSelect.className = 'input-label';
                routingSelect.style = "background:#111; flex:1;";
                routingSelect.innerHTML = `
                    <option value="stereo" ${fxObj.channelMode==='stereo'?'selected':''}>Stereo (Oletus)</option>
                    <option value="left" ${fxObj.channelMode==='left'?'selected':''}>Left -> Mono</option>
                    <option value="right" ${fxObj.channelMode==='right'?'selected':''}>Right -> Mono</option>
                    <option value="mono" ${fxObj.channelMode==='mono'?'selected':''}>L+R -> Mono</option>
                `;
                routingSelect.onchange = (e) => {
                    fxObj.channelMode = e.target.value;
                    onUpdate();
                    if(window.saveState) window.saveState();
                };
                routingWrapper.appendChild(routingSelect);

                // Invert Phase Toggle
                const invertBtn = document.createElement('button');
                invertBtn.className = 'fx-toggle ' + (fxObj.invertPhase ? 'on' : '');
                invertBtn.innerText = 'Phase: ' + (fxObj.invertPhase ? 'INVERTED' : 'NORMAL');
                invertBtn.style.flex = "1";
                invertBtn.style.padding = "0 10px";
                invertBtn.onclick = () => {
                    fxObj.invertPhase = !fxObj.invertPhase;
                    invertBtn.className = 'fx-toggle ' + (fxObj.invertPhase ? 'on' : '');
                    invertBtn.innerText = 'Phase: ' + (fxObj.invertPhase ? 'INVERTED' : 'NORMAL');
                    onUpdate();
                    if(window.saveState) window.saveState();
                };
                routingWrapper.appendChild(invertBtn);

                if (config.globalTracks && config.globalGroups) {
                    let scOptions = `<option value="">-- Ei Sidechainia --</option>`;
                    config.globalTracks.forEach(t => { if(t.id !== parentObj.id) scOptions += `<option value="${t.id}">${t.name} (Raita)</option>`; });
                    config.globalGroups.forEach(g => { if(g.id !== parentObj.id) scOptions += `<option value="${g.id}">${g.name} (Ryhmä)</option>`; });

                    const scSelect = document.createElement('select');
                    scSelect.className = 'input-label';
                    scSelect.style = "background:#111; flex:1;";
                    scSelect.innerHTML = scOptions;
                    // Asetetaan valinta raidan tallennetun tilan mukaisesti
                    scSelect.value = parentObj.sidechainSource || "";
                    
                    scSelect.onchange = (e) => {
                        parentObj.sidechainSource = e.target.value;
                        onUpdate();
                        if(window.saveState) window.saveState();
                    };
                    routingWrapper.appendChild(scSelect);
                }
            }

            // --- Gain, Pan & Fades Knobs ---
            const mainRow = addRow(`<div class="fx-header" style="border:none; padding:0; margin:0;"><span class="fx-title">${isRec ? 'Monitoring Gain' : 'Gain'}, Pan & Fades</span></div><div class="fx-controls-wrapper" id="wrapMain" style="display:flex; flex-wrap:wrap;"></div>`);
            const wrapMain = mainRow.querySelector('#wrapMain');
            
            // createKnob(parent, label, min, max, val, step, formatter, callback)
            createKnob(wrapMain, 'Vol', 0, 12.0, fxObj.vol, 0.01, fPct, val => { 
                fxObj.vol = val; 
                // Päivitetään aaltomuodon korkeus livenä, jos kyseessä on olemassa oleva audioraita
                if (parentObj && typeof parentObj.drawWaveform === 'function' && parentObj.canvas) {
                    parentObj.drawWaveform(parentObj.canvas);
                }
                onUpdate(); 
            });
            createKnob(wrapMain, 'Pan', -1.0, 1.0, fxObj.pan, 0.05, fPan, val => { fxObj.pan = val; onUpdate(); });

            // Fades and Playback Rate for Audio Tracks
            if (parentObj && parentObj.buffer && !parentObj.isMidi) {
                // Fade In ja Out samalle riville Pan & Vol kanssa
                createKnob(wrapMain, 'Fade In', 0, 10.0, parentObj.fadeIn || 0, 0.1, fSec, val => { parentObj.fadeIn = val; onUpdate(); });
                createKnob(wrapMain, 'Fade Out', 0, 10.0, parentObj.fadeOut || 0, 0.1, fSec, val => { parentObj.fadeOut = val; onUpdate(); });

                if (window.PlaybackRateModule) {
                    window.PlaybackRateModule.injectUI(fxObj, container, (newRate) => {
                        window.PlaybackRateModule.applyLiveRate(parentObj, newRate);
                        parentObj.updateUIPlacements();
                        if(window.refreshTimeline) window.refreshTimeline();
                    });
                }
            }

            // --- Filters (LPF / HPF) ---
            const lpfRow = addRow(`<div class="fx-header"><span class="fx-title">LPF</span><button id="togLpf" class="fx-toggle">OFF</button></div><div id="wrapLpf" class="fx-controls-wrapper" style="display:flex;"></div>`);
            const wrapLpf = lpfRow.querySelector('#wrapLpf');
            bindToggle('togLpf', 'lpf', 'wrapLpf');
            createKnob(wrapLpf, 'Freq', 20, 20000, fxObj.lpf.freq, 10, fHz, val => { fxObj.lpf.freq = val; onUpdate(); });
            createKnob(wrapLpf, 'Res (Q)', 0.1, 20.0, fxObj.lpf.q, 0.1, v => v.toFixed(1), val => { fxObj.lpf.q = val; onUpdate(); });

            const hpfRow = addRow(`<div class="fx-header"><span class="fx-title">HPF</span><button id="togHpf" class="fx-toggle">OFF</button></div><div id="wrapHpf" class="fx-controls-wrapper" style="display:flex;"></div>`);
            const wrapHpf = hpfRow.querySelector('#wrapHpf');
            bindToggle('togHpf', 'hpf', 'wrapHpf');
            createKnob(wrapHpf, 'Freq', 20, 20000, fxObj.hpf.freq, 10, fHz, val => { fxObj.hpf.freq = val; onUpdate(); });
            createKnob(wrapHpf, 'Res (Q)', 0.1, 20.0, fxObj.hpf.q, 0.1, v => v.toFixed(1), val => { fxObj.hpf.q = val; onUpdate(); });

            // --- Time Effects ---
            const revRow = addRow(`<div class="fx-header"><span class="fx-title">Reverb</span><button id="togRev" class="fx-toggle">OFF</button></div><div id="wrapRev" class="fx-controls-wrapper" style="display:flex;"></div>`);
            const wrapRev = revRow.querySelector('#wrapRev');
            bindToggle('togRev', 'reverb', 'wrapRev');
            createKnob(wrapRev, 'Mix', 0, 1.0, fxObj.reverb.mix, 0.01, fPct, val => { fxObj.reverb.mix = val; onUpdate(); });
            createKnob(wrapRev, 'Decay', 0.1, 5.0, fxObj.reverb.decay, 0.1, fSec, val => { fxObj.reverb.decay = val; onUpdate(); });

            const choRow = addRow(`<div class="fx-header"><span class="fx-title">Chorus</span><button id="togCho" class="fx-toggle">OFF</button></div><div id="wrapCho" class="fx-controls-wrapper" style="display:flex;"></div>`);
            const wrapCho = choRow.querySelector('#wrapCho');
            bindToggle('togCho', 'chorus', 'wrapCho');
            createKnob(wrapCho, 'Mix', 0, 1.0, fxObj.chorus.mix, 0.01, fPct, val => { fxObj.chorus.mix = val; onUpdate(); });
            createKnob(wrapCho, 'Rate', 0.1, 10.0, fxObj.chorus.rate, 0.1, fHz, val => { fxObj.chorus.rate = val; onUpdate(); });
            createKnob(wrapCho, 'Depth', 0, 0.01, fxObj.chorus.depth, 0.001, v => v.toFixed(3), val => { fxObj.chorus.depth = val; onUpdate(); });

            const flaRow = addRow(`<div class="fx-header"><span class="fx-title">Flanger</span><button id="togFla" class="fx-toggle">OFF</button></div><div id="wrapFla" class="fx-controls-wrapper" style="display:flex;"></div>`);
            const wrapFla = flaRow.querySelector('#wrapFla');
            bindToggle('togFla', 'flanger', 'wrapFla');
            createKnob(wrapFla, 'Mix', 0, 1.0, fxObj.flanger.mix, 0.01, fPct, val => { fxObj.flanger.mix = val; onUpdate(); });
            createKnob(wrapFla, 'Rate', 0.1, 10.0, fxObj.flanger.rate, 0.1, fHz, val => { fxObj.flanger.rate = val; onUpdate(); });
            createKnob(wrapFla, 'Fdbk', 0, 0.95, fxObj.flanger.feedback, 0.05, fPct, val => { fxObj.flanger.feedback = val; onUpdate(); });

            const delRow = addRow(`<div class="fx-header"><span class="fx-title">Delay</span><button id="togDel" class="fx-toggle">OFF</button></div><div id="wrapDel" class="fx-controls-wrapper" style="display:flex;"></div>`);
            const wrapDel = delRow.querySelector('#wrapDel');
            bindToggle('togDel', 'delay', 'wrapDel');
            createKnob(wrapDel, 'Mix', 0, 1.0, fxObj.delay.mix, 0.01, fPct, val => { fxObj.delay.mix = val; onUpdate(); });
            createKnob(wrapDel, 'Time', 0, 2.0, fxObj.delay.time, 0.01, fSec, val => { fxObj.delay.time = val; onUpdate(); });
            createKnob(wrapDel, 'Fdbk', 0, 0.95, fxObj.delay.feedback, 0.05, fPct, val => { fxObj.delay.feedback = val; onUpdate(); });

            // --- EQ 16-Band ---
            const eqDiv = document.createElement('div'); 
            eqDiv.className = 'settings-row'; 
            eqDiv.style.flexDirection='column'; 
            eqDiv.style.alignItems='stretch'; 
            eqDiv.innerHTML = `<div class="fx-header"><span class="fx-title">EQ (16-Band)</span><button id="togEq" class="fx-toggle">OFF</button></div>`; 
            
            const eqWrap = document.createElement('div'); 
            eqWrap.id = 'wrapEq'; 
            eqWrap.className = 'fx-controls-wrapper'; 
            
            const eqGrid = document.createElement('div'); 
            eqGrid.className = 'eq-grid';
            
            const EQ_FREQS = [30, 60, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000, 20000, 22000];
            EQ_FREQS.forEach((f, i) => { 
                const div = document.createElement('div'); 
                div.className = 'eq-band'; 
                
                const inp = document.createElement('input'); 
                inp.type = 'range'; 
                inp.min = -15; 
                inp.max = 15; 
                inp.step = 0.5; 
                inp.className = 'eq-slider-styled';
                inp.value = fxObj.eq.values[i]; 
                
                inp.oninput = e => { 
                    fxObj.eq.values[i] = parseFloat(e.target.value); 
                    onUpdate(); 
                }; 
                inp.onchange = () => { if(window.saveState) window.saveState(); }; 
                inp.addEventListener('touchmove', e => e.stopPropagation(), {passive:true}); 
                
                const fLabel = document.createElement('span');
                fLabel.className = 'eq-freq';
                fLabel.innerText = f >= 1000 ? (f/1000)+'k' : f;

                div.append(inp); 
                div.append(fLabel);
                eqGrid.appendChild(div); 
            });
            
            eqWrap.appendChild(eqGrid); 
            eqDiv.appendChild(eqWrap); 
            container.appendChild(eqDiv); 
            bindToggle('togEq', 'eq', 'wrapEq');

            // --- Limiter ---
            const limRow = addRow(`<div class="fx-header"><span class="fx-title">Limiter</span><button id="togLim" class="fx-toggle">OFF</button></div><div id="wrapLim" class="fx-controls-wrapper" style="display:flex;"></div>`);
            const wrapLim = limRow.querySelector('#wrapLim');
            bindToggle('togLim', 'limiter', 'wrapLim');
            createKnob(wrapLim, 'Thresh', -20, 0, fxObj.limiter.threshold, 0.1, fDb, val => { fxObj.limiter.threshold = val; onUpdate(); });
        }
    };

})();