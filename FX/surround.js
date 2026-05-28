// surround.js
// 3D Spatial Audio & Head Tracking (HRTF Surround for Headphones)

window.CustomAudioEffect = class SurroundGraphEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        
        // Luodaan 3D Panner (HRTF on optimoitu kuulokkeille)
        this.panner = audioCtx.createPanner();
        this.panner.panningModel = 'HRTF';
        this.panner.distanceModel = 'inverse';
        this.panner.refDistance = 1;
        this.panner.maxDistance = 10000;
        this.panner.rolloffFactor = 1.5;
        this.panner.coneInnerAngle = 360;
        this.panner.coneOuterAngle = 360;

        this.input.connect(this.panner);
        this.panner.connect(this.output);

        // Asetukset & Tilamuuttujat
        this.sourceRadius = 3.0; // Äänenlähteen etäisyys (0 - 10)
        this.sourceAngle = 0;    // Äänenlähteen kulma (Maailma-koordinaatisto)
        
        this.isTracking = false;
        this.headAngle = 0;      // Kuuntelijan pään kääntö (Device Orientation)
        this.initialAlpha = null; 

        // Bindataan funktio jotta se voidaan poistaa event listenereistä
        this.handleOrientation = this.handleOrientation.bind(this);
        
        this.updatePanner();
    }

    updatePanner() {
        // Lasketaan suhteellinen kulma.
        // Jos pää kääntyy oikealle (+ kulma), äänenlähde siirtyy pään suhteen vasemmalle (- kulma).
        let effectiveAngle = this.sourceAngle - this.headAngle;
        let rad = effectiveAngle * (Math.PI / 180);
        
        // Z on syvyys (negatiivinen on edessä Web Audio API:ssa)
        let x = this.sourceRadius * Math.sin(rad);
        let z = -this.sourceRadius * Math.cos(rad);
        let y = 0; // Pidetään tasaisella 2D ympyrällä

        const now = this.ctx.currentTime;
        if (this.panner.positionX) {
            this.panner.positionX.setTargetAtTime(x, now, 0.05);
            this.panner.positionY.setTargetAtTime(y, now, 0.05);
            this.panner.positionZ.setTargetAtTime(z, now, 0.05);
        } else {
            this.panner.setPosition(x, y, z);
        }
    }

    handleOrientation(event) {
        if (!this.isTracking) return;

        let alpha = event.webkitCompassHeading || event.alpha; 
        if (alpha === null) return;

        if (this.initialAlpha === null) {
            this.initialAlpha = alpha;
        }

        // Lasketaan pään kierto alkuperäisestä suunnasta
        let diff = alpha - this.initialAlpha;
        
        // Pidetään arvot -180 ja 180 välillä
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;

        this.headAngle = diff;
        this.updatePanner();
    }

    resetTracking() {
        this.initialAlpha = null;
        this.headAngle = 0;
        this.updatePanner();
    }

    getState() {
        return { r: this.sourceRadius, a: this.sourceAngle, track: this.isTracking };
    }

    setState(state) {
        if (state.r !== undefined) this.sourceRadius = state.r;
        if (state.a !== undefined) this.sourceAngle = state.a;
        if (state.track && !this.isTracking) this.toggleTracking(null);
        this.updatePanner();
    }

    getNodes() { return { input: this.input, output: this.output }; }

    destroy() {
        window.removeEventListener('deviceorientation', this.handleOrientation);
        this.isTracking = false;
    }

    toggleTracking(btnEl) {
        if (this.isTracking) {
            this.isTracking = false;
            window.removeEventListener('deviceorientation', this.handleOrientation);
            this.resetTracking();
            if(btnEl) { btnEl.innerText = 'Enable Head Tracking'; btnEl.classList.remove('active'); }
        } else {
            // iOS 13+ vaatii käyttäjän interaktion luvan kysymiseen
            if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
                DeviceOrientationEvent.requestPermission().then(state => {
                    if (state === 'granted') {
                        this.isTracking = true;
                        window.addEventListener('deviceorientation', this.handleOrientation, true);
                        if(btnEl) { btnEl.innerText = 'Tracking ON (Reset)'; btnEl.classList.add('active'); }
                    } else {
                        alert("Permission denied. Head tracking requires device sensor access.");
                    }
                }).catch(console.error);
            } else {
                // Muut selaimet / Android
                this.isTracking = true;
                window.addEventListener('deviceorientation', this.handleOrientation, true);
                if(btnEl) { btnEl.innerText = 'Tracking ON (Reset)'; btnEl.classList.add('active'); }
            }
        }
    }

    renderUI(containerElement) {
        const color = '#00e5ff'; // Syaani
        containerElement.style.setProperty('--fx-sur-color', color);

        const styleId = 'fx-sur-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .sur-panel { background: rgba(0,0,0,0.4); border: 1px solid rgba(0, 229, 255, 0.2); border-radius: 8px; padding: 15px; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center;}
                .btn-track { background: rgba(0,0,0,0.5); border: 1px solid var(--fx-sur-color); color: var(--fx-sur-color); cursor: pointer; padding: 8px 12px; border-radius: 4px; font-weight: bold; font-size: 11px; text-transform: uppercase; transition: all 0.2s; }
                .btn-track.active { background: var(--fx-sur-color); color: #000; box-shadow: 0 0 10px var(--fx-sur-color); }
                .sur-canvas-container { width: 100%; max-width: 300px; aspect-ratio: 1/1; background: #000; border: 2px solid #2a2a3b; border-radius: 50%; margin: 0 auto 15px auto; overflow: hidden; position: relative; cursor: crosshair; box-shadow: inset 0 0 30px rgba(0, 229, 255, 0.1); }
                .sur-info { text-align: center; font-family: monospace; font-size: 12px; color: #aaa; background: #111; padding: 5px; border-radius: 4px; }
            `;
            document.head.appendChild(style);
        }

        containerElement.innerHTML = `
            <div style="margin-bottom: 15px; color: var(--fx-sur-color); font-weight: bold; text-align: center; letter-spacing: 3px; font-size: 14px;">3D SURROUND ROOM</div>
            
            <div class="sur-panel">
                <div style="font-size:10px; color:#888;">USE HEADPHONES <br>FOR HRTF AUDIO</div>
                <button id="sur-track-btn" class="btn-track ${this.isTracking ? 'active' : ''}">${this.isTracking ? 'Tracking ON (Reset)' : 'Enable Head Tracking'}</button>
            </div>

            <div class="sur-canvas-container" id="sur-canvas-container">
                <canvas id="sur-canvas" style="width: 100%; height: 100%; display: block;"></canvas>
            </div>

            <div class="sur-info">
                Angle: <span id="sur-ang" style="color:white;">0°</span> | Dist: <span id="sur-dist" style="color:white;">0.0m</span>
            </div>
        `;

        const trackBtn = containerElement.querySelector('#sur-track-btn');
        const canvas = containerElement.querySelector('#sur-canvas');
        const canvasContainer = containerElement.querySelector('#sur-canvas-container');
        const angInfo = containerElement.querySelector('#sur-ang');
        const distInfo = containerElement.querySelector('#sur-dist');
        const ctx2d = canvas.getContext('2d');

        trackBtn.addEventListener('click', () => {
            if (this.isTracking) {
                // Jos päällä, resetoidaan kulma
                this.resetTracking();
                trackBtn.innerText = 'Tracking ON (Reset)';
            } else {
                this.toggleTracking(trackBtn);
            }
        });

        // Kosketus ja Hiiri kankaalle
        let isDragging = false;
        const maxDist = 10.0;

        const handleInput = (clientX, clientY) => {
            const rect = canvas.getBoundingClientRect();
            const cx = rect.width / 2;
            const cy = rect.height / 2;
            
            // X ja Y suhteessa keskipisteeseen
            const dx = clientX - rect.left - cx;
            const dy = clientY - rect.top - cy;
            
            // Etäisyys pikseleinä, maksimi puolet leveydestä (säde)
            const pxDist = Math.sqrt(dx*dx + dy*dy);
            const maxPx = cx;
            
            // Skaalataan maxDist arvoon
            this.sourceRadius = Math.min(maxDist, (pxDist / maxPx) * maxDist);
            
            // Kulma (0 on ylhäällä, kasvaa myötäpäivään)
            let angle = Math.atan2(dx, -dy) * (180 / Math.PI);
            if (angle < 0) angle += 360;
            this.sourceAngle = angle;

            this.updatePanner();
        };

        canvasContainer.addEventListener('mousedown', (e) => { isDragging = true; handleInput(e.clientX, e.clientY); });
        window.addEventListener('mousemove', (e) => { if (isDragging) handleInput(e.clientX, e.clientY); });
        window.addEventListener('mouseup', () => { isDragging = false; });
        
        canvasContainer.addEventListener('touchstart', (e) => { isDragging = true; handleInput(e.touches[0].clientX, e.touches[0].clientY); }, {passive: false});
        window.addEventListener('touchmove', (e) => { if (isDragging) { e.preventDefault(); handleInput(e.touches[0].clientX, e.touches[0].clientY); } }, {passive: false});
        window.addEventListener('touchend', () => { isDragging = false; });

        // Rendering Loop
        let mountCheckCount = 0;
        const drawCanvas = () => {
            mountCheckCount++;
            if (!document.body.contains(canvas)) {
                if (mountCheckCount > 10) return; // Poistu loopista jos hävitetty DOM:sta
                return requestAnimationFrame(drawCanvas);
            }

            const parent = canvas.parentElement;
            if (parent && (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight)) {
                canvas.width = parent.clientWidth || 300;
                canvas.height = parent.clientHeight || 300;
            }

            const w = canvas.width;
            const h = canvas.height;
            const cx = w / 2;
            const cy = h / 2;
            
            ctx2d.clearRect(0, 0, w, h);

            // Piirrä Radar-renkaat
            ctx2d.strokeStyle = 'rgba(0, 229, 255, 0.15)';
            ctx2d.lineWidth = 1;
            [0.25, 0.5, 0.75].forEach(scale => {
                ctx2d.beginPath();
                ctx2d.arc(cx, cy, cx * scale, 0, Math.PI * 2);
                ctx2d.stroke();
            });

            // Piirrä L/R merkit
            ctx2d.fillStyle = 'rgba(255,255,255,0.2)';
            ctx2d.font = '10px monospace';
            ctx2d.fillText('L', 10, cy + 4);
            ctx2d.fillText('R', w - 18, cy + 4);

            // --- Kuuntelijan Pää (Keskellä) ---
            ctx2d.save();
            ctx2d.translate(cx, cy);
            
            // Käännetään päätä puhelimen anturin mukaan
            ctx2d.rotate(this.headAngle * Math.PI / 180);
            
            // Pää (Ympyrä)
            ctx2d.fillStyle = '#fff';
            ctx2d.beginPath();
            ctx2d.arc(0, 0, 8, 0, Math.PI * 2);
            ctx2d.fill();
            
            // Nenä (Osoittaa katselusuunnan)
            ctx2d.fillStyle = color;
            ctx2d.beginPath();
            ctx2d.moveTo(-4, 0);
            ctx2d.lineTo(4, 0);
            ctx2d.lineTo(0, -12);
            ctx2d.fill();
            
            ctx2d.restore();

            // --- Äänenlähde ---
            let srcRadPx = (this.sourceRadius / maxDist) * cx;
            let srcRadAngle = this.sourceAngle * (Math.PI / 180);
            
            let srcX = cx + srcRadPx * Math.sin(srcRadAngle);
            let srcY = cy - srcRadPx * Math.cos(srcRadAngle);

            ctx2d.fillStyle = color;
            ctx2d.shadowBlur = 10;
            ctx2d.shadowColor = color;
            ctx2d.beginPath();
            ctx2d.arc(srcX, srcY, 8, 0, Math.PI * 2);
            ctx2d.fill();
            ctx2d.shadowBlur = 0; // Reset

            // Päivitä UI Tekstit
            angInfo.innerText = Math.round(this.sourceAngle) + '°';
            distInfo.innerText = this.sourceRadius.toFixed(1) + 'm';

            requestAnimationFrame(drawCanvas);
        };
        drawCanvas();
    }
}