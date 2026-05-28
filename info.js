/* =========================================
   INFO & OHJEET (info.js)
========================================= */

window.loadDawInfo = function(container) {
    container.innerHTML = `
        <style>
            .info-section { margin-bottom: 25px; }
            .info-section h4 { color: #4caf50; border-bottom: 1px solid #444; padding-bottom: 5px; margin-bottom: 10px; margin-top:0; }
            .shortcut-grid { display: grid; grid-template-columns: 140px 1fr; gap: 8px; margin-bottom: 15px; }
            .shortcut-key { background: #333; padding: 3px 6px; border-radius: 4px; border: 1px solid #555; font-family: monospace; text-align: center; font-weight: bold; color: #ff9800; display: inline-block; }
            .shortcut-desc { align-self: center; }
            .info-text p { margin: 0 0 10px 0; line-height: 1.5; }
            .info-text ul { margin: 0 0 10px 0; padding-left: 20px; }
            .info-text li { margin-bottom: 5px; line-height: 1.4; }
        </style>

        <div class="info-section">
            <h4>Pikanäppäimet (Yleiset)</h4>
            <div class="shortcut-grid">
                <div><span class="shortcut-key">Space</span></div><div class="shortcut-desc">Toista / Tauko (Play/Pause)</div>
                <div><span class="shortcut-key">W</span></div><div class="shortcut-desc">Palaa alkuun (Stop kahdesti tekee saman)</div>
                <div><span class="shortcut-key">A</span> / <span class="shortcut-key">D</span></div><div class="shortcut-desc">Kelaa taakse / eteen (5 sekuntia)</div>
                <div><span class="shortcut-key">R</span></div><div class="shortcut-desc">Päälle/pois äänitys (Rec)</div>
                <div><span class="shortcut-key">M</span></div><div class="shortcut-desc">Päälle/pois metronomi (Metro)</div>
                <div><span class="shortcut-key">Ctrl</span> + <span class="shortcut-key">Z</span></div><div class="shortcut-desc">Kumoa (Undo)</div>
                <div><span class="shortcut-key">Ctrl</span> + <span class="shortcut-key">Y</span></div><div class="shortcut-desc">Tee uudelleen (Redo)</div>
                <div><span class="shortcut-key">Delete</span> / <span class="shortcut-key">Back</span></div><div class="shortcut-desc">Poista valitut raidat, ryhmät tai nuotit</div>
                <div><span class="shortcut-key">←</span> / <span class="shortcut-key">→</span></div><div class="shortcut-desc">Hyppää edelliseen / seuraavaan Markeriin</div>
                <div><span class="shortcut-key">End</span></div><div class="shortcut-desc">Hyppää projektin loppuun</div>
            </div>
        </div>

        <div class="info-section">
            <h4>Pikanäppäimet (Piano Roll)</h4>
            <div class="shortcut-grid">
                <div><span class="shortcut-key">Ctrl</span> + <span class="shortcut-key">A</span></div><div class="shortcut-desc">Valitse kaikki nuotit</div>
                <div><span class="shortcut-key">Ctrl</span> + <span class="shortcut-key">C</span></div><div class="shortcut-desc">Kopioi valitut nuotit</div>
                <div><span class="shortcut-key">Ctrl</span> + <span class="shortcut-key">V</span></div><div class="shortcut-desc">Liitä nuotit (Playheadin / kursorin kohtaan)</div>
                <div><span class="shortcut-key">Ctrl</span> + <span class="shortcut-key">X</span></div><div class="shortcut-desc">Leikkaa valitut nuotit</div>
                <div><span class="shortcut-key">Ctrl</span> + <span class="shortcut-key">Hiiri</span></div><div class="shortcut-desc">Lasso-valinta (maalaa nuotteja)</div>
                <div><span class="shortcut-key">Hiiren Oik.</span></div><div class="shortcut-desc">Poista klikattu nuotti</div>
                <div style="grid-column: 1 / -1; margin-top: 5px; color: #aaa; font-size: 0.85rem;">
                    <strong>Virtuaalikoskettimisto auki (Keys 🎹):</strong><br>
                    QWERTY... / ASDF... = Soita pianoa<br>
                    1 / 2 = Laske / Nosta oktaavia<br>
                    3 / 4 = Siirrä koskettimistoa puolisävelaskel kerrallaan (Shift)
                </div>
            </div>
        </div>

        <div class="info-section info-text">
            <h4>1. Raitojen hallinta ja Audion käsittely (Web Audio API)</h4>
            <p>Voit lisätä audio- ja MIDI-tiedostoja vetämällä ne suoraan selaimen ikkunaan tai käyttämällä yläpalkin "+ Audio" ja "+ MIDI File" -painikkeita.</p>
            <ul>
                <li><strong>Siirtäminen:</strong> Tartu klipin keskeltä ja raahaa vasemmalle tai oikealle.</li>
                <li><strong>Trimmaus:</strong> Tartu klipin reunoista (valkoinen viiva) lyhentääksesi tai pidentääksesi klippiä.</li>
                <li><strong>Valinta:</strong> Klikkaa raidan nimikentän vieressä olevaa valintaruutua. Valituille raidoille voi tehdä massatoimintoja (esim. poisto, ryhmitys, siirto) yläpalkin työkaluilla.</li>
                <li><strong>Ryhmät:</strong> Luo ryhmä ja siirrä raitoja siihen "Siirrä ryhmään" -pudotusvalikolla. Voit minimoida ryhmän [-] napista säästääksesi tilaa.</li>
            </ul>
            <p style="margin-top: 15px; padding: 10px; background: rgba(0, 240, 255, 0.05); border-left: 3px solid #00f0ff; border-radius: 4px;">
                <strong>Selain ja Audion käsittely (Web Audio API):</strong><br>
                Tämä ohjelmisto pohjautuu selaimen sisäänrakennettuun <i>Web Audio API</i> -rajapintaan. Kun lataat minkä tahansa audiotiedoston (esim. WAV 16-bit, MP3, FLAC), selain purkaa (dekoodaa) sen välittömästi muistiin pakkaamattomaksi <b>32-bit float (liukuluku)</b> -muotoiseksi audioksi. Näytteenottotaajuus (esim. 44100 Hz tai 48000 Hz) synkronoituu automaattisesti käyttöjärjestelmäsi ja äänikorttisi oletusasetuksiin. 
                <br><br>
                Tämä on sama laatu, jota raskaat ammattilais-DAWit käyttävät sisäisesti. 32-bittinen liukulukumuoto tarjoaa efekteille ja miksaukselle käytännössä loputtomasti "headroomia". Tämä tarkoittaa, että vaikka raitojen yhteisvolyymi ylittäisi punaisen nollarajan (0 dBFS) efektiketjun sisällä, ääni ei leikkaudu särölle (clipping), kunhan lasket lopullisen äänenvoimakkuuden sallitulle tasolle ennen Master-ulostuloa tai vientiä.
            </p>
        </div>

        <div class="info-section info-text">
            <h4>2. MIDI ja Piano Roll</h4>
            <p>Klikkaa MIDI-raidalla olevaa vihreää aluetta kahdesti tai paina "Roll" -nappia avataksesi Piano Rollin.</p>
            <ul>
                <li><strong>Piirtäminen:</strong> Klikkaa ruudukkoa luodaksesi nuotin.</li>
                <li><strong>Muokkaus:</strong> Raahaa nuotin reunoista pituutta tai siirrä tarttumalla keskeltä.</li>
                <li><strong>Instrumentti:</strong> Lataa ".WAV" sampleja Piano Rollin vasemmasta reunasta luodaksesi oman instrumentin, tai lataa JS-syntetisaattori "Lataa JS Inst." -napilla.</li>
                <li><strong>Automaatio:</strong> Klikkaa "Pitch", "Mod" tai "Pan" aktivoidaksesi automaatioraidan. Piirrä hiirellä käyriä nuottiruudukon alle ilmestyvään kenttään.</li>
            </ul>
        </div>

        <div class="info-section info-text">
            <h4>3. Efektit (FX), Ketjutus ja Sidechain</h4>
            <p>Jokaisella raidalla, ryhmällä ja Master-ulostulolla on oma FX-nappinsa, josta aukeaa efektivalikko.</p>
            <ul>
                <li><strong>Sisäänrakennetut:</strong> EQ, Delay, Reverb, Chorus yms. löytyvät suoraan valikosta. Kytke ne päälle "OFF" -> "ON" napeista.</li>
                <li><strong>JS-Pluginit (Syntetisaattorit ja efektit):</strong> Voit ladata ulkoisia JavaScriptillä koodattuja efektejä "+ Lataa FX (.JS)" napista.</li>
                <li><strong>Ketjutus (Chaining):</strong> Signaali kulkee aina ylhäältä alas. Jos asetat raitaan ensin syntetisaattorin ja sen perään Arpeggiaattorin tai särön, signaali prosessoidaan oikeassa järjestyksessä.</li>
                <li><strong>Sidechain (Sivuketju):</strong> Sidechainin avulla voit reitittää <i>toisen raidan audion tai MIDIn ohjaamaan toisen raidan efektiä</i>. 
                <br><b>Esimerkki (Ducking/Pumppaus):</b> Haluat, että Bassoraita vaimenee aina kun Kick-rumpu iskee. Avaa Bassoraidan FX-valikko, etsi "Routing & Sidechain" ja valitse lähderaidaksi "Kick". Nyt Kick-raidan ääni ohjataan Bassoraidan efektiketjun "sivuoveen". Jos lataat Bassoraidalle sidechain-yhteensopivan dynamiikkaefektin (esim. Kompressori Sidechain-tuella), se pystyy kuuntelemaan Kickiä ja vaimentamaan Bassoa sen mukaan. Sama toimii myös MIDI-signaalin siirtämisessä sointugeneraattorilta syntetisaattorille.</li>
            </ul>
        </div>

        <div class="info-section info-text">
            <h4>4. Äänittäminen</h4>
            <p>Paina <strong>Rec</strong>-nappia päälle ja kytke <strong>Play (Space)</strong>. Selaimen pitäisi pyytää mikrofonilupaa.</p>
            <ul>
                <li><strong>Rec FX:</strong> Yläpalkin "Rec FX" napista voit laittaa päälle monitorointiefektejä (esim. kaiku lauluun), jotka tallentuvat audiotiedostoon äänityksen yhteydessä.</li>
                <li><em>Varoitus:</em> Käytä kuulokkeita äänittäessäsi estääksesi äänen kiertämisen (feedback) kaiuttimista mikrofoniin!</li>
            </ul>
        </div>

        <div class="info-section info-text">
            <h4>5. Projektin Tallennus ja Vienti</h4>
            <ul>
                <li><strong>Export WAV:</strong> Renderöi koko kappaleesi yhdeksi kuunneltavaksi audiotiedostoksi. Äänenlaatu on alkuperäisessä 32-bit float muodossa (tai selaimen purkamassa häviöttömässä muodossa).</li>
                <li><strong>Export All MIDI:</strong> Kokoaa kaikkien projektin MIDI-raitojen nuotit yhteen tiedostoon (esim. ulkoiseen ohjelmaan vientiä varten). Eri raidat asetetaan eri MIDI-kanaville (1-16).</li>
                <li><strong>Save Project:</strong> Tallentaa selaimen latauksena "projekti.json" tiedoston sekä kaikki äänittämäsi audiot (WAV). Jos selaimesi tukee sitä, DAW pyytää sinua valitsemaan kansion, johon koko projekti ja audiot tallennetaan automaattisesti nätisti yhteen paikkaan.</li>
                <li><strong>Load Project:</strong> Lataa aiemmin tallennettu kansio tai projekti.json -tiedosto jatkaaksesi työtä.</li>
            </ul>
        </div>
    `;
};