// playbackrate.js
(function(global) {
    global.PlaybackRateModule = {
        // 1. Injektoi liukusäätimen DAW:in FX-modaaliin
        injectUI: function(fxObj, container, onUpdateCallback) {
            // Taaksepäin yhteensopivuus vanhojen projektien kanssa
            if (fxObj.playbackRate === undefined) fxObj.playbackRate = 1.0;

            const row = document.createElement('div');
            row.className = 'settings-row';
            row.style.flexDirection = 'column';
            row.style.alignItems = 'flex-start';
            
            row.innerHTML = `
                <div class="fx-header" style="border:none; padding:0; margin:0;">
                    <span class="fx-title">Toistonopeus (Playback Rate)</span>
                </div>
                <div class="fx-controls-wrapper" style="display:flex; width: 100%;">
                    <div class="control-group" style="flex:1;">
                        <label>Nopeus: <span id="uiPbRateVal">${fxObj.playbackRate.toFixed(2)}x</span></label>
                        <input type="range" id="uiPbRate" min="0.2" max="3.0" step="0.01" value="${fxObj.playbackRate}">
                    </div>
                </div>
            `;
            
            container.appendChild(row);

            const slider = row.querySelector('#uiPbRate');
            const valDisplay = row.querySelector('#uiPbRateVal');

            slider.addEventListener('input', (e) => {
                const newRate = parseFloat(e.target.value);
                fxObj.playbackRate = newRate;
                valDisplay.innerText = newRate.toFixed(2) + 'x';
                
                // Kutsutaan callbackia, joka skaalaa raidan aikajanalla ja muuttaa nopeutta livenä
                if (typeof onUpdateCallback === 'function') {
                    onUpdateCallback(newRate);
                }
            });

            // Tallennetaan tilanne vain, kun hiiri päästetään irti (undo/redo -puskuri)
            slider.addEventListener('change', () => {
                if (global.saveState) global.saveState();
            });
        },

        // 2. Päivittää olemassa olevan UI:n, jos modal avataan uudelleen
        updateExistingUI: function(fxObj) {
            if (fxObj.playbackRate === undefined) return;
            const slider = document.getElementById('uiPbRate');
            const valDisplay = document.getElementById('uiPbRateVal');
            if (slider && valDisplay) {
                slider.value = fxObj.playbackRate;
                valDisplay.innerText = fxObj.playbackRate.toFixed(2) + 'x';
            }
        },

        // 3. Asettaa nopeuden reaaliajassa Web Audio API:n lähteelle
        applyLiveRate: function(track, newRate) {
            if (track.source && track.source.playbackRate) {
                track.source.playbackRate.value = newRate;
            }
        }
    };
})(window);