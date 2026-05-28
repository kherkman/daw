// signalflow.js - Advanced Node-Based Visual Signal Flow & Chainer
window.CustomAudioEffect = class SignalFlowEffect {
    constructor(audioCtx) {
        this.ctx = audioCtx;
        this.input = audioCtx.createGain();
        this.output = audioCtx.createGain();
        
        // Sisältää kaikki noodit (Masterit ja FX:t)
        this.nodes = {}; 
        this.connections = []; // Muodossa: { id, from: nodeId, fromPort: portId, to: nodeId, toPort: portId }
        
        this.activeEditorId = null;
        this.isWiring = false;
        this.wireStart = null;

        this.setupMasterNodes();

        // OLETUSKYTKENTÄ: Master In kytkettynä Master Outiin (jotta ääni kuuluu oletuksena)
        this.connections = [
            { id: Date.now() + 1, from: 'master_in', fromPort: 'out1', to: 'master_out', toPort: 'in1' },
            { id: Date.now() + 2, from: 'master_in', fromPort: 'out2', to: 'master_out', toPort: 'in2' }
        ];
    }

    setupMasterNodes() {
        // Master IN
        this.nodes['master_in'] = {
            id: 'master_in', type: 'master', name: 'AUDIO IN', x: 50, y: 150,
            ports: { out1: this.ctx.createGain(), out2: this.ctx.createGain() }
        };

        // Master OUT
        this.nodes['master_out'] = {
            id: 'master_out', type: 'master', name: 'AUDIO OUT', x: 600, y: 150,
            ports: { in1: this.ctx.createGain(), in2: this.ctx.createGain() }
        };
    }

    rebuildRouting() {
        // 1. Katkaistaan kaikki sisäiset kytkennät varmuuden vuoksi
        Object.values(this.nodes).forEach(node => {
            try { if (node.ports.out1) node.ports.out1.disconnect(); } catch(e){}
            try { if (node.ports.out2) node.ports.out2.disconnect(); } catch(e){}
            try { if (node.ports.sc_in) node.ports.sc_in.disconnect(); } catch(e){} // Sidechain irrotus
            
            // FX:n omat kytkennät
            if (node.type === 'fx' && node.instance && typeof node.instance.getNodes === 'function') {
                const fxNodes = node.instance.getNodes();
                if (fxNodes.input) {
                    try { node.ports.in1.disconnect(); } catch(e){}
                    try { node.ports.in2.disconnect(); } catch(e){}
                    node.ports.in1.connect(fxNodes.input);
                    node.ports.in2.connect(fxNodes.input); 
                }
                // UUSI: Sidechain kytkentä FX:n sisäiseen sidechain-noodiin, jos se on olemassa
                if (fxNodes.sidechain && node.ports.sc_in) {
                    node.ports.sc_in.connect(fxNodes.sidechain);
                }
                if (fxNodes.output) {
                    try { fxNodes.output.disconnect(); } catch(e){}
                    fxNodes.output.connect(node.ports.out1);
                    fxNodes.output.connect(node.ports.out2); 
                }
            }
        });

        // Varmistetaan pääreititykset
        try { this.input.disconnect(); } catch(e){}
        this.input.connect(this.nodes['master_in'].ports.out1);
        this.input.connect(this.nodes['master_in'].ports.out2);

        try { this.nodes['master_out'].ports.in1.disconnect(); } catch(e){}
        try { this.nodes['master_out'].ports.in2.disconnect(); } catch(e){}
        this.nodes['master_out'].ports.in1.connect(this.output);
        this.nodes['master_out'].ports.in2.connect(this.output);

        // 2. Kytketään yhteydet connections-taulukon mukaisesti (Visuaaliset kaapelit)
        this.connections.forEach(conn => {
            const fromNode = this.nodes[conn.from];
            const toNode = this.nodes[conn.to];
            if (fromNode && toNode && fromNode.ports[conn.fromPort] && toNode.ports[conn.toPort]) {
                fromNode.ports[conn.fromPort].connect(toNode.ports[conn.toPort]);
            }
        });
    }

    getNodes() { return { input: this.input, output: this.output }; }

    getState() {
        return {
            nodes: Object.values(this.nodes)
                .filter(n => n.type === 'fx')
                .map(n => ({
                    id: n.id, name: n.name, x: n.x, y: n.y,
                    script: n._script, 
                    // Kutsuu instanssin getState() funktiota jos se on olemassa
                    state: (n.instance && typeof n.instance.getState === 'function') ? n.instance.getState() : {}
                })),
            connections: this.connections,
            masterIn: { x: this.nodes['master_in'].x, y: this.nodes['master_in'].y },
            masterOut: { x: this.nodes['master_out'].x, y: this.nodes['master_out'].y }
        };
    }

    setState(state) {
        if (!state) return;
        
        // Tuhoaa vanhat
        Object.values(this.nodes).forEach(n => {
            if (n.type === 'fx' && n.instance && typeof n.instance.destroy === 'function') n.instance.destroy();
        });

        this.nodes = {};
        this.connections = [];
        this.setupMasterNodes();
        if (this.canvasInner) this.canvasInner.innerHTML = '<svg id="sf-svg-layer" style="position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:1;"></svg>';
        this.svgLayer = this.canvasInner?.querySelector('#sf-svg-layer');
        if (this.editorPanel) { this.editorPanel.style.display = 'none'; this.editorPanel.innerHTML = ''; }
        this.activeEditorId = null;

        if (state.masterIn) { this.nodes['master_in'].x = state.masterIn.x; this.nodes['master_in'].y = state.masterIn.y; }
        if (state.masterOut) { this.nodes['master_out'].x = state.masterOut.x; this.nodes['master_out'].y = state.masterOut.y; }

        this.initCanvasNodes();

        // Passaa n.state parametrin eteenpäin addFXBox:lle palautusta varten
        if (state.nodes) { state.nodes.forEach(n => this.addFXBox(n.name, n.script, n.state, n.id, n.x, n.y)); }
        if (state.connections) { this.connections = state.connections; }
        
        this.rebuildRouting();
        setTimeout(() => this.drawWires(), 100);
    }

    destroy() {
        Object.values(this.nodes).forEach(n => {
            if (n.type === 'fx' && n.instance && typeof n.instance.destroy === 'function') n.instance.destroy();
        });
    }

    renderUI(containerElement) {
        containerElement.style.setProperty('--sf-bg', '#1e1e1e');
        containerElement.style.setProperty('--sf-box', '#2d2d3d');
        containerElement.style.setProperty('--sf-accent', '#00bcd4');
        containerElement.style.setProperty('--sf-text', '#fff');
        containerElement.style.setProperty('--sf-wire', '#ffeb3b');

        // Pääkäyttöliittymä
        containerElement.innerHTML = `
            <div id="sf-main-ui" style="background: var(--sf-bg); border-radius: 8px; padding: 15px; border: 1px solid #444; display:flex; flex-direction:column; height: 600px; transition: all 0.2s;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 15px; border-bottom: 1px solid #333; padding-bottom: 10px; flex-shrink:0;">
                    <div style="color: var(--sf-accent); font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">Advanced Flow Router</div>
                    <div style="display:flex; gap: 8px;">
                        <button id="sf-fullscreen-btn" style="background:#00bcd4; color:black; font-weight:bold; border:none; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:11px;">Kokoruutu</button>
                        <button id="sf-add-btn" style="background:#4caf50; color:white; border:none; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:11px;">+ Lisää FX</button>
                        <button id="sf-save-btn" style="background:#555; color:white; border:none; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:11px;">Save Flow</button>
                        <label style="background:#555; color:white; border:none; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:11px; display:inline-block; margin:0;">
                            Load Flow <input type="file" id="sf-load-btn" accept=".json" style="display:none;">
                        </label>
                    </div>
                </div>

                <!-- Scrollattava ulkoinen container -->
                <div id="sf-canvas-container" style="position:relative; flex-grow:1; background:#111; border: 1px solid #333; border-radius:8px; overflow:auto; user-select:none;">
                    <!-- Iso sisäinen kangas 2000x2000, johon laatikot sijoittuvat. Lisätty visuaalinen grid. -->
                    <div id="sf-canvas-inner" style="position:relative; width: 2000px; height: 2000px; background-image: radial-gradient(#333 1px, transparent 1px); background-size: 20px 20px;">
                        <svg id="sf-svg-layer" style="position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:1;"></svg>
                    </div>
                </div>

                <div id="sf-editor-panel" style="margin-top: 15px; padding: 15px; background: rgba(0,0,0,0.5); border: 1px dashed var(--sf-accent); border-radius: 8px; min-height: 120px; display:none; flex-shrink:0; overflow-y:auto; max-height: 250px;">
                </div>
            </div>
        `;

        this.mainUi = containerElement.querySelector('#sf-main-ui');
        this.canvasContainer = containerElement.querySelector('#sf-canvas-container');
        this.canvasInner = containerElement.querySelector('#sf-canvas-inner');
        this.svgLayer = containerElement.querySelector('#sf-svg-layer');
        this.editorPanel = containerElement.querySelector('#sf-editor-panel');

        // Tyylit kokoruututilalle ja porttien design
        const styleId = 'sf-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.innerHTML = `
                .sf-fullscreen-mode {
                    position: fixed !important; top: 0; left: 0;
                    width: 100vw !important; height: 100vh !important;
                    z-index: 999999 !important; border-radius: 0 !important; margin: 0 !important;
                    box-sizing: border-box;
                }
                .sf-node .port-row { display: flex; justify-content: space-between; align-items: center; position:relative; }
                .sf-node .port { width: 12px; height: 12px; background: #666; border-radius: 50%; cursor: crosshair; border: 2px solid #222; transition: background 0.2s; position:absolute; z-index: 15; }
                .sf-node .port:hover { background: var(--sf-wire); transform: scale(1.2); }
                .sf-node .port.in { left: -6px; }
                .sf-node .port.out { right: -6px; }
                .sf-node .port.sc { background: #9c27b0; border-color: #4a148c; } /* Sidechain portin väri */
                .sf-node .port.sc:hover { background: #e1bee7; }
                .sf-node .port-label { font-size: 9px; color: #888; width: 100%; text-align: center; pointer-events: none; }
                .sf-wire-path { stroke: var(--sf-wire); stroke-width: 3; fill: none; pointer-events: stroke; cursor: pointer; transition: stroke-width 0.1s, stroke 0.1s; }
                .sf-wire-path:hover { stroke-width: 6; stroke: #ff5722; }
            `;
            document.head.appendChild(style);
        }

        // Tapahtumankuuntelijat yläpalkkiin
        const fsBtn = containerElement.querySelector('#sf-fullscreen-btn');
        fsBtn.onclick = () => {
            this.mainUi.classList.toggle('sf-fullscreen-mode');
            if (this.mainUi.classList.contains('sf-fullscreen-mode')) {
                fsBtn.innerText = "Poistu kokoruudusta";
                this.mainUi.style.height = '100vh';
            } else {
                fsBtn.innerText = "Kokoruutu";
                this.mainUi.style.height = '600px';
            }
            setTimeout(() => this.drawWires(), 50); // Piirretään johdot uusiksi animaation jälkeen
        };

        containerElement.querySelector('#sf-add-btn').onclick = () => {
            // Lisätään uusi FX keskelle näkyvää aluetta
            const viewCenterX = this.canvasContainer.scrollLeft + (this.canvasContainer.clientWidth / 2) - 65;
            const viewCenterY = this.canvasContainer.scrollTop + (this.canvasContainer.clientHeight / 2) - 50;
            this.addFXBox("New FX", null, null, null, viewCenterX, viewCenterY); 
        };

        containerElement.querySelector('#sf-save-btn').onclick = () => {
            const blob = new Blob([JSON.stringify(this.getState(), null, 2)], {type: 'application/json'});
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = "advanced_flow.json";
            a.click();
        };

        containerElement.querySelector('#sf-load-btn').onchange = async (e) => {
            const file = e.target.files[0];
            if(!file) return;
            try { this.setState(JSON.parse(await file.text())); } 
            catch(err) { alert("Virhe ladattaessa JSONia: " + err.message); }
            e.target.value = '';
        };

        this.setupCanvasEvents();
        this.initCanvasNodes();
        this.rebuildRouting();
        setTimeout(() => this.drawWires(), 100);
    }

    initCanvasNodes() {
        this.createDOMNode(this.nodes['master_in']);
        this.createDOMNode(this.nodes['master_out']);
        
        Object.values(this.nodes).forEach(n => {
            if(n.type === 'fx') this.createDOMNode(n);
        });
    }

    addFXBox(presetName = "New FX", scriptContent = null, presetState = null, forceId = null, startX = 250, startY = 150) {
        const id = forceId || 'sf_fx_' + Date.now();
        
        const nodeData = {
            id, type: 'fx', name: presetName, x: startX, y: startY,
            instance: null, _script: scriptContent, domNode: null,
            ports: {
                in1: this.ctx.createGain(), in2: this.ctx.createGain(),
                sc_in: this.ctx.createGain(), // Sidechain Gain-noodi
                out1: this.ctx.createGain(), out2: this.ctx.createGain()
            }
        };
        this.nodes[id] = nodeData;
        this.createDOMNode(nodeData);

        const installScript = (jsText, fName, restoreState = null) => {
            // Otetaan alkuperäinen luokka talteen, jotta signalflow itse ei hajoa
            const oldEffectClass = window.CustomAudioEffect;
            window.CustomAudioEffect = null;
            
            const scriptTag = document.createElement('script');
            scriptTag.textContent = jsText;
            
            try {
                document.head.appendChild(scriptTag);
                const NewFXClass = window.CustomAudioEffect;

                if (NewFXClass) {
                    const inst = new NewFXClass(this.ctx);
                    
                    // Kutsuu instanssin setState:a jos se löytyy
                    if(restoreState && typeof inst.setState === 'function') inst.setState(restoreState);
                    
                    nodeData.instance = inst;
                    nodeData._script = jsText;
                    nodeData.name = fName.replace('.js', '');
                    
                    nodeData.domNode.querySelector('.box-title').innerText = nodeData.name;
                    nodeData.domNode.style.borderColor = 'var(--sf-accent)';
                    nodeData.domNode.querySelector('.btn-load').style.display = 'none';
                    nodeData.domNode.querySelector('.btn-edit').style.display = 'block';

                    this.rebuildRouting();
                    this.openEditor(id);
                } else {
                    alert("Virhe: Ladattu skripti ei asettanut window.CustomAudioEffect -luokkaa oikein.");
                }
            } catch(e) { 
                alert("Virhe JS suorituksessa: " + e.message); 
            } finally {
                // Varmistetaan EHDOTTOMASTI, että window.CustomAudioEffect palautuu,
                // tapahtui ladatussa koodissa mitä tahansa virheitä.
                window.CustomAudioEffect = oldEffectClass; 
                scriptTag.remove();
            }
        };

        if (scriptContent) installScript(scriptContent, presetName, presetState);
    }

    createDOMNode(node) {
        const el = document.createElement('div');
        el.className = 'sf-node';
        el.dataset.id = node.id;
        el.style = `
            position: absolute; left: ${node.x}px; top: ${node.y}px;
            background: var(--sf-box); border: 2px solid ${node.type==='master' ? '#888' : '#555'};
            border-radius: 8px; width: 130px; display:flex; flex-direction:column;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3); z-index: 10;
        `;

        let portsHTML = '';
        if (node.type === 'master' && node.id === 'master_in') {
            portsHTML = `<div class="port-row"><span class="port-label">Out 1</span> <div class="port out" data-port="out1"></div></div>
                         <div class="port-row"><span class="port-label">Out 2</span> <div class="port out" data-port="out2"></div></div>`;
        } else if (node.type === 'master' && node.id === 'master_out') {
            portsHTML = `<div class="port-row"><div class="port in" data-port="in1"></div> <span class="port-label">In 1</span></div>
                         <div class="port-row"><div class="port in" data-port="in2"></div> <span class="port-label">In 2</span></div>`;
        } else {
            // Lisätty Sidechain (SC) portti FX-noodiin
            portsHTML = `
                <div class="port-row"><div class="port in" data-port="in1"></div><span class="port-label">1</span><div class="port out" data-port="out1"></div></div>
                <div class="port-row"><div class="port in" data-port="in2"></div><span class="port-label">2</span><div class="port out" data-port="out2"></div></div>
                <div class="port-row" style="margin-top:4px;"><div class="port in sc" data-port="sc_in"></div><span class="port-label" style="color:#ba68c8;">SC</span><div style="width:12px;"></div></div>
            `;
        }

        let controlsHTML = '';
        if (node.type === 'fx') {
            controlsHTML = `
                <div style="display:flex; gap:5px; padding: 5px;">
                    <label class="btn-load" style="background:#444; color:white; font-size:9px; padding:3px; border-radius:3px; cursor:pointer; flex:1; text-align:center;">LOAD JS<input type="file" accept=".js" style="display:none;"></label>
                    <button class="btn-edit" style="background:var(--sf-accent); color:black; font-size:9px; padding:3px; border-radius:3px; cursor:pointer; flex:1; border:none; display:none; font-weight:bold;">EDIT</button>
                </div>
                <button class="btn-remove" style="position:absolute; top:-8px; right:-8px; width:18px; height:18px; border-radius:50%; background:#d32f2f; color:white; border:none; font-size:9px; cursor:pointer;">X</button>
            `;
        }

        el.innerHTML = `
            <div class="box-header" style="background:rgba(0,0,0,0.3); padding:5px; text-align:center; font-size:11px; font-weight:bold; cursor:grab; border-radius: 6px 6px 0 0; color: ${node.type==='master'?'#aaa':'#fff'};">
                <span class="box-title">${node.name}</span>
            </div>
            <div class="ports-container" style="display:flex; flex-direction:column; gap:8px; padding: 10px 0;">
                ${portsHTML}
            </div>
            ${controlsHTML}
        `;

        this.canvasInner.appendChild(el);
        node.domNode = el;

        if (node.type === 'fx') {
            el.querySelector('input').addEventListener('change', (e) => {
                const file = e.target.files[0];
                if(!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const x = node.x, y = node.y;
                    this.removeNode(node.id);
                    this.addFXBox(file.name.replace('.js',''), ev.target.result, null, node.id, x, y);
                };
                reader.readAsText(file);
                e.target.value = '';
            });
            el.querySelector('.btn-edit').addEventListener('click', () => this.openEditor(node.id));
            el.querySelector('.btn-remove').addEventListener('click', () => this.removeNode(node.id));
        }
    }

    removeNode(id) {
        const node = this.nodes[id];
        if(!node || node.type === 'master') return;
        
        if (node.instance && typeof node.instance.destroy === 'function') node.instance.destroy();
        node.domNode.remove();
        
        this.connections = this.connections.filter(c => c.from !== id && c.to !== id);
        delete this.nodes[id];
        
        if (this.activeEditorId === id) { this.editorPanel.style.display = 'none'; this.editorPanel.innerHTML=''; this.activeEditorId=null; }
        
        this.rebuildRouting();
        this.drawWires();
    }

    openEditor(id) {
        if(!this.editorPanel) return;
        Object.values(this.nodes).forEach(n => { if(n.domNode) n.domNode.style.boxShadow = '0 4px 6px rgba(0,0,0,0.3)'; });

        const node = this.nodes[id];
        if(!node || !node.instance) return;

        if (this.activeEditorId === id) {
            this.editorPanel.style.display = 'none'; this.activeEditorId = null; return;
        }

        node.domNode.style.boxShadow = '0 0 15px var(--sf-accent)';
        this.editorPanel.style.display = 'block';
        this.editorPanel.innerHTML = `<div style="text-align:center; font-size:12px; color:#aaa; margin-bottom:10px;">Muokataan: <span style="color:white; font-weight:bold;">${node.name}</span></div>`;
        
        const uiWrapper = document.createElement('div');
        if(typeof node.instance.renderUI === 'function') node.instance.renderUI(uiWrapper);
        else uiWrapper.innerHTML = "<div style='color:#888; text-align:center;'>Ei käyttöliittymää.</div>";
        
        this.editorPanel.appendChild(uiWrapper);
        this.activeEditorId = id;
    }

    // --- KANKAAN INTERAKTIOT JA KAAPELOINTI ---
    setupCanvasEvents() {
        let draggedNodeId = null;
        let dragOffset = {x:0, y:0};

        const getPortCenter = (nodeId, portId) => {
            const n = this.nodes[nodeId];
            if(!n || !n.domNode) return {x:0, y:0};
            const portEl = n.domNode.querySelector(`[data-port="${portId}"]`);
            if(!portEl) return {x:0, y:0};
            
            const rect = portEl.getBoundingClientRect();
            const innerRect = this.canvasInner.getBoundingClientRect(); // Otetaan huomioon scrollaus!
            return {
                x: rect.left - innerRect.left + rect.width/2,
                y: rect.top - innerRect.top + rect.height/2
            };
        };

        this.canvasInner.addEventListener('pointerdown', (e) => {
            if (e.target.classList.contains('port')) {
                e.preventDefault();
                const portEl = e.target;
                const nodeEl = portEl.closest('.sf-node');
                
                this.isWiring = true;
                this.wireStart = {
                    nodeId: nodeEl.dataset.id,
                    portId: portEl.dataset.port,
                    type: portEl.classList.contains('out') ? 'out' : 'in'
                };
            } else if (e.target.closest('.box-header')) {
                e.preventDefault();
                const nodeEl = e.target.closest('.sf-node');
                draggedNodeId = nodeEl.dataset.id;
                
                const rect = nodeEl.getBoundingClientRect();
                dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                nodeEl.style.zIndex = 100;
            }
        });

        window.addEventListener('pointermove', (e) => {
            if (draggedNodeId) {
                const innerRect = this.canvasInner.getBoundingClientRect();
                let x = e.clientX - innerRect.left - dragOffset.x;
                let y = e.clientY - innerRect.top - dragOffset.y;
                
                // Rajoita laatikot valtavan kankaan (2000x2000) sisälle
                x = Math.max(0, Math.min(2000 - 130, x));
                y = Math.max(0, Math.min(2000 - 50, y));

                this.nodes[draggedNodeId].x = x;
                this.nodes[draggedNodeId].y = y;
                this.nodes[draggedNodeId].domNode.style.left = x + 'px';
                this.nodes[draggedNodeId].domNode.style.top = y + 'px';
                this.drawWires();
            }

            if (this.isWiring) {
                const innerRect = this.canvasInner.getBoundingClientRect();
                const mouseX = e.clientX - innerRect.left;
                const mouseY = e.clientY - innerRect.top;
                const startPos = getPortCenter(this.wireStart.nodeId, this.wireStart.portId);
                
                this.drawWires(startPos, {x: mouseX, y: mouseY});
            }
        });

        window.addEventListener('pointerup', (e) => {
            if (draggedNodeId) {
                if(this.nodes[draggedNodeId]) this.nodes[draggedNodeId].domNode.style.zIndex = 10;
                draggedNodeId = null;
            }

            if (this.isWiring) {
                this.isWiring = false;
                const dropTarget = document.elementFromPoint(e.clientX, e.clientY);
                if (dropTarget && dropTarget.classList.contains('port')) {
                    const toNodeId = dropTarget.closest('.sf-node').dataset.id;
                    const toPortId = dropTarget.dataset.port;
                    const toType = dropTarget.classList.contains('out') ? 'out' : 'in';

                    if (this.wireStart.type !== toType && this.wireStart.nodeId !== toNodeId) {
                        const fromNode = this.wireStart.type === 'out' ? this.wireStart.nodeId : toNodeId;
                        const fromPort = this.wireStart.type === 'out' ? this.wireStart.portId : toPortId;
                        const toNode   = this.wireStart.type === 'in' ? this.wireStart.nodeId : toNodeId;
                        const toPort   = this.wireStart.type === 'in' ? this.wireStart.portId : toPortId;

                        // Yksi input-portti voi ottaa vain yhden kaapelin vastaan (selkeyden vuoksi)
                        this.connections = this.connections.filter(c => !(c.to === toNode && c.toPort === toPort));
                        this.connections.push({ id: Date.now(), from: fromNode, fromPort: fromPort, to: toNode, toPort: toPort });
                        this.rebuildRouting();
                    }
                }
                this.drawWires();
            }
        });

        // Kaapelin poistaminen sitä klikkaamalla
        this.svgLayer.addEventListener('click', (e) => {
            if (e.target.classList.contains('sf-wire-path')) {
                const connId = parseInt(e.target.dataset.connId);
                this.connections = this.connections.filter(c => c.id !== connId);
                this.rebuildRouting();
                this.drawWires();
            }
        });
    }

    drawWires(tempStart = null, tempEnd = null) {
        if (!this.svgLayer) return;
        this.svgLayer.innerHTML = ''; // Tyhjennä vanhat

        const getPortCenter = (nodeId, portId) => {
            const n = this.nodes[nodeId];
            if(!n || !n.domNode) return null;
            const portEl = n.domNode.querySelector(`[data-port="${portId}"]`);
            if(!portEl) return null;
            const rect = portEl.getBoundingClientRect();
            const innerRect = this.canvasInner.getBoundingClientRect();
            return { x: rect.left - innerRect.left + rect.width/2, y: rect.top - innerRect.top + rect.height/2 };
        };

        const createPath = (x1, y1, x2, y2, id) => {
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            const cpOffset = Math.max(Math.abs(x2 - x1) / 2, 50);
            path.setAttribute("d", `M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`);
            path.setAttribute("class", "sf-wire-path");
            if (id) path.setAttribute("data-conn-id", id);
            else path.style.pointerEvents = 'none'; // Väliaikainen johto ei blokkaa hiirtä
            this.svgLayer.appendChild(path);
        };

        this.connections.forEach(conn => {
            const start = getPortCenter(conn.from, conn.fromPort);
            const end = getPortCenter(conn.to, conn.toPort);
            if(start && end) createPath(start.x, start.y, end.x, end.y, conn.id);
        });

        if (tempStart && tempEnd) {
            if (this.wireStart.type === 'out') createPath(tempStart.x, tempStart.y, tempEnd.x, tempEnd.y, null);
            else createPath(tempEnd.x, tempEnd.y, tempStart.x, tempStart.y, null); 
        }
    }
}