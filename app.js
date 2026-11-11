'use strict';
/* TSC88 Wörth an der Isar – Eisstock-Vereinsseite
   Trainingsplan, Zielschießen (Zielwettbewerb nach IER 11. Aufl. 2022), Auswertung. */

const CFG = window.TSC88_CONFIG;

// ---------------------------------------------------------------- Speicher
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* egal */ } },
  json(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } }
};

const S = {
  token: LS.get('tsc88_token'),
  ich: Number(LS.get('tsc88_ich')) || null,
  tab: LS.get('tsc88_tab') || 'training',
  gedreht: LS.get('tsc88_umgedreht') !== '1', // Standard: Spielrichtung von oben nach unten
  daten: null,
  stand: null,
  offline: false,
  vergangene: false,
  filterAnlass: 'alle',
  nurVoll: true,
  editor: null,      // { id, mitglied_id, datum, anlass, punkte[24], cursor, geaendert }
  installPrompt: null
};

// ---------------------------------------------------------------- Hilfen
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, el = document) => el.querySelector(sel);
const TAGE = ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'];
const pad = (n) => String(n).padStart(2, '0');
function isoHeute() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function alsDatum(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
function fmtDatum(iso, mitTag = true) {
  const d = alsDatum(iso);
  return `${mitTag ? TAGE[d.getDay()] + ', ' : ''}${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}
function fmtKurz(iso) { const d = alsDatum(iso); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`; }
const mitglied = (id) => S.daten?.mitglieder.find((m) => m.id === id);
const nameVon = (id) => mitglied(id)?.name ?? 'Unbekannt';
const aktiveMitglieder = () => (S.daten?.mitglieder || []).filter((m) => m.aktiv);

let toastTimer;
function toast(text, art = '') {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'zeigen ' + art;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = art; }, art === 'fehler' ? 4200 : 2400);
}

// ---------------------------------------------------------------- Server
async function rpc(fn, args = {}) {
  let res;
  try {
    res = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: CFG.supabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
  } catch {
    const e = new Error('Keine Verbindung. Bitte Internet prüfen.');
    e.code = 'offline';
    throw e;
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
  if (!res.ok) {
    const e = new Error(body?.message || `Fehler ${res.status}`);
    e.code = body?.code;
    if (e.code === '28000') { abgemeldet('Bitte neu anmelden.'); }
    throw e;
  }
  return body;
}
const call = (fn, args = {}) => rpc(fn, { p_token: S.token, ...args });

async function laden(still = false) {
  if (!S.token) return;
  try {
    S.daten = await call('tsc88_daten');
    S.stand = new Date();
    S.offline = false;
    LS.set('tsc88_cache', JSON.stringify({ daten: S.daten, stand: S.stand.toISOString() }));
  } catch (e) {
    if (e.code === '28000') return;
    const c = LS.json('tsc88_cache');
    if (c && !S.daten) { S.daten = c.daten; S.stand = new Date(c.stand); }
    S.offline = true;
    if (!still) toast(e.message, 'fehler');
  }
  render();
}

// Aktion ausführen, danach neu laden
async function aktion(fn, args, erfolg) {
  try {
    const r = await call(fn, args);
    if (erfolg) toast(erfolg);
    await laden(true);
    return r ?? true;
  } catch (e) {
    if (e.code !== '28000') toast(e.message, 'fehler');
    return null;
  }
}

function abgemeldet(meldung) {
  S.token = null; S.daten = null; S.editor = null;
  LS.set('tsc88_token', null);
  LS.set('tsc88_cache', null);
  render();
  if (meldung) toast(meldung, 'fehler');
}

// ---------------------------------------------------------------- Dialoge
function dialog(html, { onOpen } = {}) {
  return new Promise((resolve) => {
    const s = document.createElement('div');
    s.className = 'schleier';
    s.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">${html}</div>`;
    const zu = (wert) => { s.remove(); document.removeEventListener('keydown', taste); resolve(wert); };
    const taste = (e) => { if (e.key === 'Escape') zu(null); };
    s.addEventListener('click', (e) => {
      if (e.target === s) return zu(null);
      const b = e.target.closest('[data-wert]');
      if (b) zu(b.dataset.wert);
    });
    const form = s.querySelector('form');
    if (form) form.addEventListener('submit', (e) => {
      e.preventDefault();
      zu(Object.fromEntries(new FormData(form).entries()));
    });
    document.addEventListener('keydown', taste);
    document.body.appendChild(s);
    if (onOpen) onOpen(s);
    const f = s.querySelector('[autofocus]');
    if (f) setTimeout(() => f.focus(), 60);
  });
}

async function frage(titel, text, ja = 'Ja', gefahr = false) {
  const r = await dialog(`<h3>${esc(titel)}</h3>${text ? `<p>${esc(text)}</p>` : ''}
    <div class="knopf-reihe"><button class="knopf" data-wert="nein">Abbrechen</button>
    <button class="knopf ${gefahr ? 'gefahr' : 'haupt'}" data-wert="ja">${esc(ja)}</button></div>`);
  return r === 'ja';
}

async function auswahl(titel, optionen) {
  if (!optionen.length) { toast('Keine Auswahl möglich.'); return null; }
  const r = await dialog(`<h3>${esc(titel)}</h3><div class="namen-raster">
    ${optionen.map((o) => `<button class="knopf" data-wert="${esc(o.wert)}">${esc(o.text)}</button>`).join('')}
    </div><div class="knopf-reihe"><button class="knopf leise" data-wert="">Abbrechen</button></div>`);
  return r || null;
}

async function nameEingeben(titel, vorgabe = '') {
  const r = await dialog(`<h3>${esc(titel)}</h3><form class="formular">
    <label><span class="feld-label">Name</span>
    <input class="eingabe" name="name" maxlength="40" required autocomplete="off" value="${esc(vorgabe)}" autofocus></label>
    <div class="knopf-reihe"><button type="button" class="knopf" data-wert="">Abbrechen</button>
    <button class="knopf haupt">Speichern</button></div></form>`);
  return r && typeof r === 'object' ? r.name.trim() : null;
}

// ---------------------------------------------------------------- Zielwettbewerb (IER Regel 501–532, Abb. 4)
// Maße in cm. x = von links, y = von der hinteren Linie (oben). Gespielt wird von unten nach oben.
const POS = {
  M: [150, 300], L: [15, 60], R: [285, 60],
  A: [15, 485], B: [285, 485], G: [85, 485], H: [215, 485],
  C: [15, 115], D: [285, 115], E: [50, 300], F: [250, 300]
};
const RING_PUNKTE = [10, 8, 6, 4, 2, 0];
const SCHUSS_PUNKTE = [10, 5, 2, 0];
const SCHUSS_TEXT = { 10: 'Zielstock raus, eigener bleibt drin', 5: 'beide raus', 2: 'getroffen, Zielstock bleibt drin', 0: 'nicht getroffen' };

const DURCHGAENGE = [
  { nr: 1, name: 'Mitte', kurz: 'In die mittleren Ringe spielen.' },
  { nr: 2, name: 'Schießen', kurz: 'Zielstöcke aus dem Feld schießen.' },
  { nr: 3, name: 'Hinten', kurz: 'In die hinteren Ringe spielen, je 3× links und rechts.' },
  { nr: 4, name: 'Kombinieren', kurz: 'Ablenken und Bringen mit dem Zielstock.' }
];

// Reihenfolge der Zielstock-Positionen je Durchgang (in der App als Nummer 1–6 angezeigt)
const REIHENFOLGE = { 2: ['A', 'B', 'C', 'D', 'E', 'F'], 4: ['A', 'B', 'G', 'H', 'E', 'F'] };

// Jeder der 24 Versuche: was zu tun ist, wie das Zielfeld aussieht und welcher Weg eingezeichnet wird
// pfad: 'ziel' = eigener Stock ins Ziel · 'raus' = Zielstock aus dem Feld · 'ablenken' = eigener Stock über den Zielstock ins Ziel
//       'bringen' = Zielstock ins Ziel
const VERSUCHE = (() => {
  const v = [];
  for (let i = 0; i < 6; i++) v.push({ durchgang: 1, daube: 'M', ziel: 'M', stock: null, wertung: 'ring', pfad: null,
    text: 'Spiele deinen Stock in die mittleren Ringe – so nah wie möglich an die Daube.' });
  REIHENFOLGE[2].forEach((b, i) => v.push({ durchgang: 2, daube: 'M', ziel: null, stock: b, wertung: 'schuss', pfad: 'raus',
    text: `Schieße den Zielstock auf Position ${i + 1} aus dem Zielfeld. Am meisten gibt es, wenn dein eigener Stock im Feld bleibt.` }));
  for (let i = 0; i < 3; i++) v.push({ durchgang: 3, daube: 'L', ziel: 'L', stock: null, wertung: 'ring', pfad: 'ziel',
    text: 'Spiele deinen Stock in die linken hinteren Ringe – so nah wie möglich an die Daube.' });
  for (let i = 0; i < 3; i++) v.push({ durchgang: 3, daube: 'R', ziel: 'R', stock: null, wertung: 'ring', pfad: 'ziel',
    text: 'Spiele deinen Stock in die rechten hinteren Ringe – so nah wie möglich an die Daube.' });
  const d4 = (stock, ziel, daube, pfad, titel, text) => v.push({ durchgang: 4, daube, ziel, stock, wertung: 'ring', pfad, titel, text });
  d4('A', 'M', 'M', 'ablenken', 'Ablenken', 'Triff den Zielstock auf Position 1 so, dass dein eigener Stock in die mittleren Ringe abgelenkt wird. Gewertet wird dein Stock.');
  d4('B', 'M', 'M', 'ablenken', 'Ablenken', 'Triff den Zielstock auf Position 2 so, dass dein eigener Stock in die mittleren Ringe abgelenkt wird. Gewertet wird dein Stock.');
  d4('G', 'M', 'M', 'bringen', 'Bringen', 'Bringe den Zielstock von Position 3 in die mittleren Ringe. Gewertet wird der Zielstock.');
  d4('H', 'M', 'M', 'bringen', 'Bringen', 'Bringe den Zielstock von Position 4 in die mittleren Ringe. Gewertet wird der Zielstock.');
  d4('E', 'L', 'L', 'bringen', 'Bringen hinten', 'Bringe den Zielstock von Position 5 in die linken hinteren Ringe. Gewertet wird der Zielstock.');
  d4('F', 'R', 'R', 'bringen', 'Bringen hinten', 'Bringe den Zielstock von Position 6 in die rechten hinteren Ringe. Gewertet wird der Zielstock.');
  return v;
})();

// Hilfen für die Wege (Maße in cm)
const START = [150, 662]; // Richtung Abspielstelle, mittig vor dem Feld
function richtungsPunkt(a, b, abstand, vonB = true) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
  return vonB ? [b[0] - dx / l * abstand, b[1] - dy / l * abstand] : [a[0] + dx / l * abstand, a[1] + dy / l * abstand];
}
function rausPunkt(a, z) {
  // vom Zielstock in Stoßrichtung weiter, bis außerhalb des Feldes
  const dx = z[0] - a[0], dy = z[1] - a[1];
  const s = [dx < 0 ? (-32 - z[0]) / dx : dx > 0 ? (332 - z[0]) / dx : Infinity, dy < 0 ? (-32 - z[1]) / dy : Infinity];
  const k = Math.min(...s);
  return [z[0] + dx * k, z[1] + dy * k];
}

let svgNr = 0;
// o: daube, ziel ('M'|'L'|'R'), stock (Position A–H), durchgang, erledigt (Nummern 1–6 mit Wert), pfad
function zielfeldSvg(o = {}) {
  const { daube = 'M', ziel = null, stock = null, durchgang = null, erledigt = [], pfad = null } = o;
  const gedreht = S.gedreht;
  const id = 'zf' + (++svgNr);
  const t = ([x, y]) => (gedreht ? [300 - x, 600 - y] : [x, y]);
  const radien = [130, 100, 70, 40, 10];
  const nummern = REIHENFOLGE[durchgang] || null;

  const ringGruppe = (key) => {
    const [cx, cy] = t(POS[key]);
    const klasse = ziel ? (ziel === key ? 'aktiv' : 'grau') : '';
    const clip = key === 'M' ? '' : `clip-path="url(#${id}-${cx < 150 ? 'l' : 'r'})"`;
    const kreise = radien.map((r, i) => `<circle class="ring ${i % 2 ? 'ring-b' : 'ring-a'}" cx="${cx}" cy="${cy}" r="${r}"/>`).join('');
    // Ringpunkte entlang der Querachse, bei den hinteren Ringen zur Feldmitte hin
    const innen = key === 'M' ? -1 : (cx < 150 ? 1 : -1);
    const y = key === 'M' ? cy - 20 : cy - 8;
    const zahlen = [2, 4, 6, 8].map((p, i) => `<text class="zahl" x="${cx + innen * [115, 85, 55, 25][i]}" y="${y}">${p}</text>`).join('')
      + `<text class="zahl" x="${key === 'M' ? cx : cx + innen * 2}" y="${key === 'M' ? cy - 20 : cy - 13}">10</text>`;
    return `<g class="${klasse}" ${clip}>${kreise}${zahlen}</g>`;
  };

  let stoecke = '';
  for (const b of 'ABCDEFGH') {
    if (b === stock) continue;
    const [x, y] = t(POS[b]);
    const nr = nummern ? nummern.indexOf(b) + 1 : 0;
    if (nr) {
      const fertig = erledigt.includes(nr);
      stoecke += `<g class="stockpos ${fertig ? 'fertig' : ''}"><circle cx="${x}" cy="${y}" r="15"/><text x="${x}" y="${y}">${fertig ? '✓' : nr}</text></g>`;
    } else {
      stoecke += `<circle class="stockkreis" cx="${x}" cy="${y}" r="15"/>`;
    }
  }
  let zielstock = '';
  if (stock) {
    const [x, y] = t(POS[stock]);
    const nr = nummern ? nummern.indexOf(stock) + 1 : '';
    zielstock = `<circle class="zielstock" cx="${x}" cy="${y}" r="15"/><text class="zielstock-text" x="${x}" y="${y}">${nr}</text>`;
  }

  // Wege: wohin der Stock muss
  let wege = '';
  if (pfad) {
    const linie = (a, b, kl) => {
      const [x1, y1] = t(a), [x2, y2] = t(b);
      return `<line class="${kl}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" marker-end="url(#${id}-${kl})"/>`;
    };
    const Z = stock ? POS[stock] : null;
    const ZIEL = ziel ? POS[ziel] : null;
    if (pfad === 'ziel' && ZIEL) wege += linie(START, richtungsPunkt(START, ZIEL, 14), 'weg-eigen');
    if (Z) {
      wege += linie(START, richtungsPunkt(START, Z, 19), 'weg-eigen');
      if (pfad === 'raus') wege += linie(richtungsPunkt(Z, rausPunkt(START, Z), 19, false), rausPunkt(START, Z), 'weg-ziel');
      if (pfad === 'ablenken') wege += linie(richtungsPunkt(Z, ZIEL, 19, false), richtungsPunkt(Z, ZIEL, 14), 'weg-eigen');
      if (pfad === 'bringen') wege += linie(richtungsPunkt(Z, ZIEL, 19, false), richtungsPunkt(Z, ZIEL, 14), 'weg-ziel');
    }
  }

  const [dx, dy] = t(POS[daube]);
  // Spielrichtung: Pfeil auf der Seite der Abspielstelle
  const [ax1, ay1] = t([22, 692]), [ax2, ay2] = t([22, 630]);
  const textX = gedreht ? ax1 - 12 : ax1 + 12;
  const textY = (ay1 + ay2) / 2 + 5;
  const marker = (name, kl) => `<marker id="${id}-${name}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path class="${kl}" d="M0 0 L10 5 L0 10 z"/></marker>`;
  return `<svg class="zielfeld" viewBox="${gedreht ? '-40 -100 380 720' : '-40 -20 380 720'}" role="img" aria-label="Zielfeld Zielwettbewerb">
    <defs>
      <clipPath id="${id}-l"><rect x="0" y="0" width="150" height="600"/></clipPath>
      <clipPath id="${id}-r"><rect x="150" y="0" width="150" height="600"/></clipPath>
      ${marker('pfeil', 'pfeilspitze')}${marker('weg-eigen', 'spitze-eigen')}${marker('weg-ziel', 'spitze-ziel')}
    </defs>
    <rect class="feldrand" x="0" y="0" width="300" height="600"/>
    ${ringGruppe('L')}${ringGruppe('R')}${ringGruppe('M')}
    <line class="hilfslinie" x1="150" y1="0" x2="150" y2="600"/>
    <line class="hilfslinie" x1="-20" y1="300" x2="320" y2="300"/>
    <line class="kreuz" x1="132.5" y1="300" x2="167.5" y2="300"/><line class="kreuz" x1="150" y1="282.5" x2="150" y2="317.5"/>
    <rect x="0" y="0" width="300" height="600" fill="none" stroke="#0e2a47" stroke-width="2"/>
    ${stoecke}${wege}${zielstock}
    <circle class="daube" cx="${dx}" cy="${dy}" r="7"/>
    <line class="pfeil" x1="${ax1}" y1="${ay1}" x2="${ax2}" y2="${ay2}" marker-end="url(#${id}-pfeil)"/>
    <text class="richtung" x="${textX}" y="${textY}" text-anchor="${gedreht ? 'end' : 'start'}">Spielrichtung</text>
  </svg>`;
}

function feldDrehenKnopf() {
  return `<div class="feld-werkzeug"><button class="knopf leise" data-a="feld-drehen">⇅ Feld drehen</button></div>`;
}
function legende() {
  return '<p class="legende"><span class="l-eigen"></span>dein Stock <span class="l-ziel"></span>Zielstock <i class="l-wartet"></i>wartet</p>';
}

const summe = (arr) => arr.reduce((a, b) => a + (b ?? 0), 0);
const durchgang = (punkte, d) => punkte.slice((d - 1) * 6, d * 6);
const vollstaendig = (punkte) => punkte.every((p) => p !== null && p !== undefined);
const gefuellt = (punkte) => punkte.filter((p) => p !== null && p !== undefined).length;

// ---------------------------------------------------------------- Ansichten
const ICONS = {
  training: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/><path d="M8 14l2.5 2.5L16 12"/></svg>',
  ziel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>',
  auswertung: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  mehr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>'
};

function render() {
  const app = $('#app');
  if (!S.token) return renderAnmeldung(app);
  if (!S.daten) { app.innerHTML = '<div class="laden">Lädt …</div>'; return; }
  if (!S.ich || !mitglied(S.ich)) return renderWerBistDu(app);
  if (S.editor) return renderEditor(app);

  const seiten = { training: renderTraining, ziel: renderZiel, auswertung: renderAuswertung, mehr: renderMehr };
  const titel = { training: 'Training', ziel: 'Zielschießen', auswertung: 'Auswertung', mehr: 'Mehr' };
  const scroll = window.scrollY;
  const gleicheSeite = app.dataset.tab === S.tab;
  app.dataset.tab = S.tab;
  app.innerHTML = `
    <header class="kopf">
      <div class="marke"><span class="logo">88</span><div><b>TSC88 Eisstock</b><small>Wörth an der Isar</small></div></div>
      <button class="ich-knopf" data-a="wer-bin-ich" aria-label="Name wechseln">👤 ${esc(nameVon(S.ich))}</button>
    </header>
    ${S.offline ? `<div class="offline-band">Offline – Stand ${S.stand ? S.stand.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'unbekannt'}. Änderungen gehen erst wieder mit Internet.</div>` : ''}
    <main>${seiten[S.tab]()}</main>
    <nav class="tabs">
      ${Object.keys(seiten).map((k) => `<button class="${S.tab === k ? 'aktiv' : ''}" data-a="tab" data-tab="${k}" aria-current="${S.tab === k ? 'page' : 'false'}">${ICONS[k]}<span>${titel[k]}</span></button>`).join('')}
    </nav>`;
  if (gleicheSeite) window.scrollTo(0, scroll);
}

// ---------- Anmeldung
function renderAnmeldung(app) {
  delete app.dataset.tab;
  app.innerHTML = `
    <div class="anmeldung">
      <div class="wappen">88</div>
      <h1>TSC88 Eisstock</h1>
      <p class="unter">Wörth an der Isar · nur für Mitglieder</p>
      <form class="karte" id="anmelde-form">
        <label for="pw" class="feld-label">Vereinspasswort</label>
        <input class="eingabe" id="pw" type="password" autocomplete="current-password" required>
        <p class="fehler-text" id="pw-fehler"></p>
        <button class="knopf haupt breit" id="pw-knopf">Anmelden</button>
      </form>
    </div>`;
  const form = $('#anmelde-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const knopf = $('#pw-knopf');
    knopf.disabled = true; knopf.textContent = 'Prüfe …';
    $('#pw-fehler').textContent = '';
    try {
      const token = await rpc('tsc88_anmelden', { p_passwort: $('#pw').value });
      S.token = token;
      LS.set('tsc88_token', token);
      await laden();
    } catch (err) {
      $('#pw-fehler').textContent = err.code === '28P01' ? 'Das Passwort stimmt nicht.' : err.message;
      knopf.disabled = false; knopf.textContent = 'Anmelden';
    }
  });
}

// ---------- Wer bist du?
function renderWerBistDu(app) {
  delete app.dataset.tab;
  app.innerHTML = `
    <header class="kopf"><div class="marke"><span class="logo">88</span><div><b>TSC88 Eisstock</b><small>Wörth an der Isar</small></div></div></header>
    <main>
      <div class="seitenkopf"><div><h2>Wer bist du?</h2><p class="klein">Einmal auswählen – das Handy merkt sich deinen Namen.</p></div></div>
      <div class="namen-raster">
        ${aktiveMitglieder().map((m) => `<button class="knopf" data-a="ich-setzen" data-id="${m.id}">${esc(m.name)}</button>`).join('')}
      </div>
      <p style="margin-top:18px"><button class="knopf leise" data-a="ich-neu">＋ Mein Name fehlt</button></p>
    </main>`;
}

// ---------- Training
function renderTraining() {
  const heute = isoHeute();
  const alle = S.daten.trainings;
  const kommend = alle.filter((t) => t.datum >= heute);
  const vorbei = alle.filter((t) => t.datum < heute).reverse();
  const meine = kommend.filter((t) => t.eingetragen.includes(S.ich)).length;
  return `
    <div class="seitenkopf">
      <div><h2>Eisstocktraining</h2><p class="klein">${kommend.length} kommende Termine · du bist bei ${meine} eingetragen</p></div>
      <button class="knopf" data-a="termin-neu">＋ Termin</button>
    </div>
    <div class="stapel">
      ${kommend.length ? kommend.map((t) => terminKarte(t, false)).join('') : '<div class="karte leer">Keine kommenden Termine. Lege mit „＋ Termin“ einen an.</div>'}
    </div>
    ${vorbei.length ? `
      <p style="margin-top:18px"><button class="knopf leise" data-a="vergangene">${S.vergangene ? '▾ Vergangene ausblenden' : `▸ Vergangene Termine (${vorbei.length})`}</button></p>
      ${S.vergangene ? `<div class="stapel">${vorbei.map((t) => terminKarte(t, true)).join('')}</div>` : ''}` : ''}`;
}

function terminKarte(t, vorbei) {
  const ichDabei = t.eingetragen.includes(S.ich);
  const voll = t.eingetragen.length >= t.plaetze;
  const plaetze = [];
  for (let i = 0; i < t.plaetze; i++) {
    const mid = t.eingetragen[i];
    if (mid !== undefined) {
      plaetze.push(`<li><button class="platz ${mid === S.ich ? 'ich' : ''}" data-a="platz-belegt" data-t="${t.id}" data-m="${mid}"><span class="nr">${i + 1}</span>${esc(nameVon(mid))}</button></li>`);
    } else {
      plaetze.push(`<li><button class="platz frei" data-a="platz-frei" data-t="${t.id}" ${vorbei ? 'disabled' : ''}><span class="nr">${i + 1}</span>frei</button></li>`);
    }
  }
  let fuss = '';
  if (!vorbei) {
    if (ichDabei) fuss = `<button class="knopf" data-a="austragen" data-t="${t.id}" data-m="${S.ich}">Mich austragen</button>`;
    else if (!voll) fuss = `<button class="knopf haupt" data-a="eintragen" data-t="${t.id}" data-m="${S.ich}">Mich eintragen</button>`;
    else fuss = '<button class="knopf" disabled>Termin ist voll</button>';
  }
  return `
    <article class="karte termin ${ichDabei ? 'meins' : ''} ${vorbei ? 'vorbei' : ''}">
      <div class="termin-kopf">
        <div><div class="tag">${fmtDatum(t.datum)}</div><div class="zeit">${esc(t.beginn)}–${esc(t.ende)} Uhr</div></div>
        <div style="display:flex;align-items:center;gap:4px">
          <span class="belegung ${voll ? 'voll' : ''}">${t.eingetragen.length}/${t.plaetze}</span>
          <button class="icon-knopf" data-a="termin-menue" data-t="${t.id}" aria-label="Termin bearbeiten">⋯</button>
        </div>
      </div>
      ${t.notiz ? `<div class="notiz">${esc(t.notiz)}</div>` : ''}
      <ol class="plaetze">${plaetze.join('')}</ol>
      ${fuss ? `<div class="termin-fuss">${fuss}</div>` : ''}
    </article>`;
}

async function terminFormular(t) {
  const r = await dialog(`<h3>${t ? 'Termin bearbeiten' : 'Neuer Termin'}</h3>
    <form class="formular">
      <label><span class="feld-label">Datum</span><input class="eingabe" type="date" name="datum" required value="${esc(t?.datum || '')}"></label>
      <div class="zwei">
        <label><span class="feld-label">Beginn</span><input class="eingabe" type="time" name="beginn" required value="${esc(t?.beginn || '19:40')}"></label>
        <label><span class="feld-label">Ende</span><input class="eingabe" type="time" name="ende" required value="${esc(t?.ende || '22:30')}"></label>
      </div>
      <label><span class="feld-label">Plätze</span><input class="eingabe" type="number" name="plaetze" min="1" max="30" required value="${esc(t?.plaetze || 4)}"></label>
      <label><span class="feld-label">Notiz (freiwillig)</span><input class="eingabe" name="notiz" maxlength="200" value="${esc(t?.notiz || '')}" placeholder="z. B. Bahn 2, Turnier, …"></label>
      <div class="knopf-reihe"><button type="button" class="knopf" data-wert="">Abbrechen</button><button class="knopf haupt">Speichern</button></div>
    </form>`);
  if (!r || typeof r !== 'object') return;
  await aktion('tsc88_training_speichern', {
    p_id: t?.id ?? null, p_datum: r.datum, p_beginn: r.beginn, p_ende: r.ende,
    p_plaetze: Number(r.plaetze), p_notiz: r.notiz
  }, t ? 'Termin gespeichert.' : 'Termin angelegt.');
}

// ---------- Zielschießen
function renderZiel() {
  const entwurf = LS.json('tsc88_entwurf');
  const letzte = S.daten.wertungen.slice(0, 12);
  return `
    <div class="seitenkopf"><div><h2>Zielschießen</h2><p class="klein">Zielwettbewerb · 4 Durchgänge × 6 Versuche · max. 240 Punkte</p></div></div>
    ${entwurf ? `<div class="karte" style="background:var(--gelb-hell)"><b>Angefangene Wertung</b>
      <p class="klein">${esc(nameVon(entwurf.mitglied_id))} · ${gefuellt(entwurf.punkte)} von 24 Versuchen · noch nicht gespeichert</p>
      <div class="termin-fuss"><button class="knopf" data-a="entwurf-weg">Verwerfen</button><button class="knopf haupt" data-a="entwurf-weiter">Weitermachen</button></div></div>` : ''}
    <button class="knopf haupt breit" data-a="wertung-neu" style="min-height:56px;margin-top:${entwurf ? 12 : 0}px">＋ Neue Wertung starten</button>

    <h3 class="abschnitt-titel">So geht’s</h3>
    <div class="karte anleitung">
      <p>Jeder Schütze spielt <b>4 Durchgänge mit je 6 Versuchen</b>. Pro Versuch gibt es höchstens 10 Punkte, also 60 pro Durchgang und <b>240 insgesamt</b>.</p>
      <p>In die Ringe zählt der <b>innerste Ring, den der Stock berührt</b>: 10 · 8 · 6 · 4 · 2 Punkte, außerhalb 0. Die Linie gehört zum Ring.</p>
      ${feldDrehenKnopf()}${zielfeldSvg({})}
      <p class="klein" style="text-align:center">Zielfeld 3 × 6 m · Ringe Ø 0,2 / 0,8 / 1,4 / 2,0 / 2,6 m · ● = Daube · ○ = Zielstock-Positionen</p>
      ${DURCHGAENGE.map((d) => anleitungDurchgang(d)).join('')}
      <p class="klein" style="margin-top:12px">Ein falsch ausgeführter Versuch (z. B. falscher Zielstock) zählt 0 Punkte. Bei Gleichstand entscheidet der 4., dann der 3., dann der 2. Durchgang.
      Grundlage: IFI-Regelbuch (IER), 11. Auflage 2022, Regeln 501–532.</p>
    </div>

    <h3 class="abschnitt-titel">Letzte Wertungen</h3>
    ${letzte.length ? letzte.map(wertungZeile).join('') : '<div class="karte leer">Noch keine Wertungen. Starte die erste!</div>'}`;
}

function anleitungDurchgang(d) {
  const beispiele = {
    1: [VERSUCHE[0]],
    2: [VERSUCHE[6], VERSUCHE[8]],
    3: [VERSUCHE[12], VERSUCHE[15]],
    4: [VERSUCHE[18], VERSUCHE[20], VERSUCHE[22]]
  }[d.nr];
  const texte = {
    1: '<p>Alle 6 Versuche in die <b>mittleren Ringe</b>. Die Daube liegt auf dem Mittelkreuz.</p>',
    2: `<p>Auf den Positionen <b>1 bis 6</b> steht nacheinander je ein Zielstock, der aus dem Zielfeld geschossen wird.</p>
        <ul><li><b>10</b> – ${SCHUSS_TEXT[10]}</li><li><b>5</b> – ${SCHUSS_TEXT[5]}</li><li><b>2</b> – ${SCHUSS_TEXT[2]}</li><li><b>0</b> – ${SCHUSS_TEXT[0]}</li></ul>`,
    3: '<p>Versuch 1–3 in die <b>linken</b>, Versuch 4–6 in die <b>rechten hinteren Ringe</b> (links/rechts vom Abspielplatz aus gesehen). Die Daube liegt jeweils in der Ringmitte.</p>',
    4: `<ol><li><b>Ablenken</b> über Zielstock 1, dann 2: dein eigener Stock soll in die mittleren Ringe – er wird gewertet.</li>
        <li><b>Bringen</b> von 3, dann 4: den Zielstock in die mittleren Ringe bringen – der Zielstock wird gewertet.</li>
        <li><b>Bringen hinten:</b> Zielstock 5 in die linken, 6 in die rechten hinteren Ringe.</li></ol>
        <p class="klein">Die Nummern gelten nur für den jeweiligen Durchgang – im 2. Durchgang stehen die Positionen anders.</p>`
  }[d.nr];
  return `<details><summary>${d.nr}. Durchgang · ${esc(d.name)}</summary>${texte}
    <div style="display:grid;grid-template-columns:repeat(${beispiele.length},1fr);gap:6px">${beispiele.map((b) => zielfeldSvg(b)).join('')}</div>${d.nr > 1 ? legende() : ''}</details>`;
}

function wertungZeile(w) {
  const voll = vollstaendig(w.punkte);
  return `<button class="wertung-zeile" data-a="wertung-oeffnen" data-id="${w.id}">
    <div class="wer"><b>${esc(nameVon(w.mitglied_id))}${voll ? '' : `<span class="marke-unvoll">${gefuellt(w.punkte)}/24</span>`}</b>
    <span class="klein">${fmtDatum(w.datum)} · ${esc(w.anlass)}</span></div>
    <div class="summe">${summe(w.punkte)} <small>/240</small></div></button>`;
}

// ---------- Editor
function editorStarten(w) {
  S.editor = w ? {
    id: w.id, mitglied_id: w.mitglied_id, datum: w.datum, anlass: w.anlass,
    punkte: w.punkte.map((p) => (p === null ? null : Number(p))), cursor: 0, geaendert: false
  } : {
    id: null, mitglied_id: S.ich, datum: isoHeute(), anlass: 'Training',
    punkte: Array(24).fill(null), cursor: 0, geaendert: false
  };
  const erstesLeeres = S.editor.punkte.findIndex((p) => p === null);
  S.editor.cursor = erstesLeeres === -1 ? 0 : erstesLeeres;
  window.scrollTo(0, 0);
  render();
}

function entwurfSichern() {
  const e = S.editor;
  if (e && e.geaendert) LS.set('tsc88_entwurf', JSON.stringify(e));
}

function renderEditor(app) {
  delete app.dataset.tab;
  const e = S.editor;
  const anlaesse = [...new Set(['Training', 'Vereinsmeisterschaft', 'Turnier', ...S.daten.wertungen.map((w) => w.anlass)])];
  const v = VERSUCHE[e.cursor];
  const dNr = Math.floor(e.cursor / 6) + 1;
  const vNr = (e.cursor % 6) + 1;
  const optionen = v.wertung === 'schuss' ? SCHUSS_PUNKTE : RING_PUNKTE;
  const aktuell = e.punkte[e.cursor];
  const scroll = window.scrollY;

  const raster = DURCHGAENGE.map((d) => {
    const zellen = [];
    for (let i = 0; i < 6; i++) {
      const idx = (d.nr - 1) * 6 + i;
      const p = e.punkte[idx];
      const kl = ['zelle', p === null ? 'leer' : '', p === 0 ? 'null' : '', p === 10 ? 'zehn' : '', idx === e.cursor ? 'cursor' : ''].join(' ');
      zellen.push(`<button class="${kl}" data-a="zelle" data-i="${idx}" aria-label="Durchgang ${d.nr} Versuch ${i + 1}">${p === null ? '·' : p}</button>`);
    }
    return `<div class="raster-zeile"><span class="dg">D${d.nr}</span>${zellen.join('')}<span class="zs">${summe(durchgang(e.punkte, d.nr))}</span></div>`;
  }).join('');

  app.innerHTML = `
    <div class="editor-kopf">
      <button class="knopf leise" data-a="ed-zurueck">‹ Zurück</button>
      <b>${e.id ? 'Wertung bearbeiten' : 'Neue Wertung'}</b>
      <button class="knopf haupt" data-a="ed-speichern" style="min-height:38px;padding:0 14px">Speichern</button>
    </div>
    <main style="padding-bottom:calc(32px + var(--unten))">
      <div class="karte">
        <div class="meta">
          <label class="ganz"><span class="feld-label">Schütze</span>
            <select class="eingabe" id="ed-mitglied">${S.daten.mitglieder.filter((m) => m.aktiv || m.id === e.mitglied_id)
              .map((m) => `<option value="${m.id}" ${m.id === e.mitglied_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
          <label><span class="feld-label">Datum</span><input class="eingabe" type="date" id="ed-datum" value="${esc(e.datum)}"></label>
          <label><span class="feld-label">Anlass</span><input class="eingabe" id="ed-anlass" list="anlaesse" maxlength="60" value="${esc(e.anlass)}">
            <datalist id="anlaesse">${anlaesse.map((a) => `<option value="${esc(a)}">`).join('')}</datalist></label>
        </div>
        <div class="raster">${raster}</div>
        <div class="gesamt-leiste"><span class="klein">${gefuellt(e.punkte)} von 24 Versuchen</span><span><span class="gross">${summe(e.punkte)}</span> <span class="klein">/ 240</span></span></div>
      </div>

      <div class="karte">
        <div class="versuch-titel"><h3>${dNr}. Durchgang · Versuch ${vNr}</h3><span class="tag-klein">${esc(v.titel || DURCHGAENGE[dNr - 1].name)}</span></div>
        <p>${esc(v.text)}</p>
        <div class="punkt-tasten ${optionen.length === 4 ? 'vier' : ''}">
          ${optionen.map((p) => `<button class="punkt-taste ${aktuell === p ? 'gewaehlt' : ''}" data-a="punkte" data-p="${p}">${p}${v.wertung === 'schuss' ? `<small>${SCHUSS_TEXT[p]}</small>` : (p === 0 ? '<small>außerhalb / ungültig</small>' : '')}</button>`).join('')}
        </div>
        <div class="navi-zeile">
          <button class="knopf leise" data-a="ed-schritt" data-d="-1" ${e.cursor === 0 ? 'disabled' : ''}>‹ Zurück</button>
          ${aktuell !== null ? '<button class="knopf leise" data-a="ed-leeren">Wert löschen</button>' : ''}
          <button class="knopf leise" data-a="ed-schritt" data-d="1" ${e.cursor === 23 ? 'disabled' : ''}>Weiter ›</button>
        </div>
        ${feldDrehenKnopf()}
        ${zielfeldSvg({ ...v, erledigt: [1, 2, 3, 4, 5, 6].filter((n) => (dNr - 1) * 6 + n - 1 !== e.cursor && e.punkte[(dNr - 1) * 6 + n - 1] !== null), pfad: aktuell === null ? v.pfad : null })}
        ${aktuell === null && v.pfad ? legende() : ''}
      </div>
      ${e.id ? '<p style="text-align:center;margin-top:18px"><button class="knopf gefahr" data-a="ed-loeschen">Wertung löschen</button></p>' : ''}
    </main>`;
  window.scrollTo(0, scroll);

  $('#ed-mitglied').addEventListener('change', (ev) => { e.mitglied_id = Number(ev.target.value); e.geaendert = true; entwurfSichern(); });
  $('#ed-datum').addEventListener('change', (ev) => { e.datum = ev.target.value || isoHeute(); e.geaendert = true; entwurfSichern(); });
  $('#ed-anlass').addEventListener('input', (ev) => { e.anlass = ev.target.value; e.geaendert = true; entwurfSichern(); });
}

async function editorSpeichern() {
  const e = S.editor;
  if (!gefuellt(e.punkte)) { toast('Noch keine Punkte eingetragen.', 'fehler'); return; }
  if (!vollstaendig(e.punkte) && !(await frage('Noch nicht vollständig', `Es sind erst ${gefuellt(e.punkte)} von 24 Versuchen eingetragen. Trotzdem speichern? Du kannst später weitermachen.`, 'Speichern'))) return;
  const id = await aktion('tsc88_wertung_speichern', {
    p_id: e.id, p_mitglied_id: e.mitglied_id, p_datum: e.datum, p_anlass: e.anlass, p_punkte: e.punkte
  }, `Gespeichert: ${summe(e.punkte)} Punkte.`);
  if (id) {
    LS.set('tsc88_entwurf', null);
    S.editor = null;
    S.tab = 'ziel';
    render();
    window.scrollTo(0, 0);
  }
}

// ---------- Auswertung
function rangliste(wertungen) {
  const proPerson = new Map();
  for (const w of wertungen) {
    if (!proPerson.has(w.mitglied_id)) proPerson.set(w.mitglied_id, []);
    proPerson.get(w.mitglied_id).push(w);
  }
  const vergleich = (a, b) => summe(b.punkte) - summe(a.punkte)
    || summe(durchgang(b.punkte, 4)) - summe(durchgang(a.punkte, 4))
    || summe(durchgang(b.punkte, 3)) - summe(durchgang(a.punkte, 3))
    || summe(durchgang(b.punkte, 2)) - summe(durchgang(a.punkte, 2));
  const zeilen = [...proPerson.entries()].map(([mid, ws]) => {
    const best = [...ws].sort(vergleich)[0];
    return { mid, best, anzahl: ws.length, schnitt: summe(ws.map((w) => summe(w.punkte))) / ws.length };
  });
  zeilen.sort((a, b) => vergleich(a.best, b.best));
  let platz = 0;
  zeilen.forEach((z, i) => { if (i === 0 || vergleich(zeilen[i - 1].best, z.best) !== 0) platz = i + 1; z.platz = platz; });
  return zeilen;
}

function gefilterteWertungen() {
  return S.daten.wertungen.filter((w) =>
    (S.filterAnlass === 'alle' || w.anlass === S.filterAnlass) && (!S.nurVoll || vollstaendig(w.punkte)));
}

function renderAuswertung() {
  const anlaesse = [...new Set(S.daten.wertungen.map((w) => w.anlass))].sort();
  const ws = gefilterteWertungen();
  const rl = rangliste(ws);
  return `
    <div class="seitenkopf"><div><h2>Auswertung</h2><p class="klein">${ws.length} Wertungen · Rangliste nach bestem Ergebnis</p></div></div>
    <div class="karte filter">
      <label><span class="feld-label">Anlass</span>
        <select class="eingabe" data-a="filter-anlass">
          <option value="alle">Alle Anlässe</option>
          ${anlaesse.map((a) => `<option value="${esc(a)}" ${S.filterAnlass === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
        </select></label>
      <label class="schalter"><input type="checkbox" data-a="filter-voll" ${S.nurVoll ? 'checked' : ''}> Nur vollständige Wertungen (24 Versuche)</label>
    </div>
    <h3 class="abschnitt-titel">Rangliste</h3>
    <div class="karte" style="padding:6px 10px">
      ${rl.length ? `<table class="rangliste">
        <thead><tr><th>#</th><th>Schütze</th><th>Bestes</th><th>Schnitt</th><th>Anz.</th></tr></thead>
        <tbody>${rl.map((z) => `<tr class="klickbar" data-a="person" data-id="${z.mid}">
          <td class="platz-nr ${z.platz <= 3 ? 'podest' : ''}">${z.platz}.</td>
          <td><b>${esc(nameVon(z.mid))}</b>${z.mid === S.ich ? ' <span class="klein">(du)</span>' : ''}</td>
          <td class="best">${summe(z.best.punkte)}</td>
          <td>${z.schnitt.toFixed(1).replace('.', ',')}</td>
          <td>${z.anzahl}</td></tr>`).join('')}</tbody></table>`
        : `<p class="leer">${S.daten.wertungen.length ? 'Keine Wertungen für diesen Filter.' : 'Noch keine Wertungen vorhanden.'}</p>`}
    </div>
    <p class="klein" style="margin-top:8px">Gleichstand: entscheidend sind der 4., dann der 3., dann der 2. Durchgang. Tippe auf einen Namen für den Verlauf.</p>
    ${S.daten.wertungen.length ? `<p style="margin-top:14px"><button class="knopf breit" data-a="csv">Alle Wertungen als Tabelle (CSV) herunterladen</button></p>` : ''}`;
}

async function personDetails(mid) {
  const ws = gefilterteWertungen().filter((w) => w.mitglied_id === mid).sort((a, b) => (a.datum < b.datum ? 1 : -1));
  if (!ws.length) return;
  const n = ws.length;
  const best = Math.max(...ws.map((w) => summe(w.punkte)));
  const schnitt = summe(ws.map((w) => summe(w.punkte))) / n;
  const dSchnitt = [1, 2, 3, 4].map((d) => summe(ws.map((w) => summe(durchgang(w.punkte, d)))) / n);
  const zahl = (x) => x.toFixed(1).replace('.', ',');
  const r = await dialog(`<h3>${esc(nameVon(mid))}</h3>
    <div class="kacheln">
      <div class="kachel"><div class="wert">${best}</div><div class="was">Bestes Ergebnis</div></div>
      <div class="kachel"><div class="wert">${zahl(schnitt)}</div><div class="was">Schnitt aus ${n} Wertung${n === 1 ? '' : 'en'}</div></div>
    </div>
    <p class="feld-label">Schnitt je Durchgang (max. 60)</p>
    <div class="kacheln" style="grid-template-columns:repeat(4,1fr)">
      ${dSchnitt.map((s, i) => `<div class="kachel"><div class="wert" style="font-size:1.15rem">${zahl(s)}</div><div class="was">D${i + 1} ${esc(DURCHGAENGE[i].name)}</div></div>`).join('')}
    </div>
    <p class="feld-label" style="margin-top:12px">Verlauf</p>
    <table class="verlauf"><thead><tr><th>Datum</th><th>D1</th><th>D2</th><th>D3</th><th>D4</th><th>Ges.</th></tr></thead>
    <tbody>${ws.map((w) => `<tr><td>${fmtKurz(w.datum)} <span class="klein">${esc(w.anlass)}</span></td>
      ${[1, 2, 3, 4].map((d) => `<td>${summe(durchgang(w.punkte, d))}</td>`).join('')}<td><b>${summe(w.punkte)}</b></td></tr>`).join('')}</tbody></table>
    <div class="knopf-reihe"><button class="knopf" data-wert="zu">Schließen</button></div>`);
  return r;
}

function csvHerunterladen() {
  const kopf = ['Datum', 'Schütze', 'Anlass', ...[1, 2, 3, 4].flatMap((d) => [1, 2, 3, 4, 5, 6].map((v) => `D${d}V${v}`)), 'D1', 'D2', 'D3', 'D4', 'Gesamt'];
  const zeilen = [...S.daten.wertungen].sort((a, b) => (a.datum < b.datum ? -1 : 1)).map((w) => [
    fmtDatum(w.datum, false), nameVon(w.mitglied_id), w.anlass, ...w.punkte.map((p) => (p === null ? '' : p)),
    ...[1, 2, 3, 4].map((d) => summe(durchgang(w.punkte, d))), summe(w.punkte)
  ]);
  const csv = [kopf, ...zeilen].map((z) => z.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `TSC88-Zielschiessen-${isoHeute()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- Mehr
function renderMehr() {
  const istIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const installiert = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return `
    <div class="seitenkopf"><div><h2>Mehr</h2></div></div>

    <h3 class="abschnitt-titel">Mitglieder</h3>
    <div class="karte">
      ${S.daten.mitglieder.map((m) => `<div class="liste-zeile">
        <span class="name ${m.aktiv ? '' : 'inaktiv'}">${esc(m.name)}${m.id === S.ich ? ' <span class="klein">(du)</span>' : ''}</span>
        <button class="icon-knopf" data-a="mitglied-menue" data-id="${m.id}" aria-label="${esc(m.name)} bearbeiten">⋯</button></div>`).join('')}
      <button class="knopf breit" data-a="mitglied-neu" style="margin-top:10px">＋ Mitglied hinzufügen</button>
    </div>

    <h3 class="abschnitt-titel">Als App aufs Handy</h3>
    <div class="karte">
      ${installiert ? '<p>✅ Die App ist auf diesem Gerät installiert.</p>' : istIOS
        ? '<p><b>iPhone:</b> In Safari unten auf <b>Teilen</b> (Quadrat mit Pfeil) tippen, dann <b>„Zum Home-Bildschirm“</b>.</p>'
        : `<p><b>Android:</b> Im Chrome-Menü (⋮) auf <b>„App installieren“</b> bzw. <b>„Zum Startbildschirm hinzufügen“</b> tippen.</p>
           ${S.installPrompt ? '<button class="knopf navy breit" data-a="installieren">Jetzt installieren</button>' : ''}
           <p class="klein"><b>iPhone:</b> in Safari öffnen → Teilen → „Zum Home-Bildschirm“.</p>`}
    </div>

    <h3 class="abschnitt-titel">Zugang</h3>
    <div class="karte stapel">
      <button class="knopf breit" data-a="wer-bin-ich">Name wechseln (gerade: ${esc(nameVon(S.ich))})</button>
      <button class="knopf breit" data-a="passwort">Vereinspasswort ändern</button>
      <button class="knopf breit" data-a="aktualisieren">Daten neu laden</button>
      <button class="knopf gefahr breit" data-a="abmelden">Abmelden</button>
    </div>
    <p class="klein" style="text-align:center;margin-top:18px">TSC88 Wörth an der Isar · Eisstock<br>${S.stand ? `Stand: ${S.stand.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr` : ''}</p>`;
}

// ---------------------------------------------------------------- Klicks
const AKTIONEN = {
  tab(b) { S.tab = b.dataset.tab; LS.set('tsc88_tab', S.tab); window.scrollTo(0, 0); render(); },
  'wer-bin-ich'() { S.ich = null; LS.set('tsc88_ich', null); render(); },
  'ich-setzen'(b) { S.ich = Number(b.dataset.id); LS.set('tsc88_ich', String(S.ich)); render(); toast(`Hallo ${nameVon(S.ich)}!`); },
  async 'ich-neu'() {
    const name = await nameEingeben('Neues Mitglied');
    if (!name) return;
    const id = await aktion('tsc88_mitglied_speichern', { p_id: null, p_name: name, p_aktiv: true }, `${name} hinzugefügt.`);
    if (id) { S.ich = id; LS.set('tsc88_ich', String(id)); render(); }
  },
  vergangene() { S.vergangene = !S.vergangene; render(); },
  'termin-neu'() { terminFormular(null); },
  async 'termin-menue'(b) {
    const t = S.daten.trainings.find((x) => x.id === Number(b.dataset.t));
    const r = await dialog(`<h3>${fmtDatum(t.datum)}</h3><div class="stapel">
      <button class="knopf breit" data-wert="bearbeiten">Termin bearbeiten</button>
      <button class="knopf breit" data-wert="anderen">Jemand anderen eintragen</button>
      <button class="knopf gefahr breit" data-wert="loeschen">Termin löschen</button>
      <button class="knopf leise breit" data-wert="">Abbrechen</button></div>`);
    if (r === 'bearbeiten') terminFormular(t);
    if (r === 'anderen') AKTIONEN['platz-frei']({ dataset: { t: String(t.id) } });
    if (r === 'loeschen' && await frage('Termin löschen?', `${fmtDatum(t.datum)} mit ${t.eingetragen.length} Eintragungen wird gelöscht.`, 'Löschen', true)) {
      aktion('tsc88_training_loeschen', { p_id: t.id }, 'Termin gelöscht.');
    }
  },
  eintragen(b) { aktion('tsc88_eintragen', { p_training_id: Number(b.dataset.t), p_mitglied_id: Number(b.dataset.m) }, 'Eingetragen.'); },
  async austragen(b) {
    const t = S.daten.trainings.find((x) => x.id === Number(b.dataset.t));
    if (await frage('Austragen?', `Du wirst für ${fmtDatum(t.datum)} ausgetragen.`, 'Austragen', true)) {
      aktion('tsc88_austragen', { p_training_id: t.id, p_mitglied_id: Number(b.dataset.m) }, 'Ausgetragen.');
    }
  },
  async 'platz-frei'(b) {
    const t = S.daten.trainings.find((x) => x.id === Number(b.dataset.t));
    if (t.eingetragen.length >= t.plaetze) { toast('Der Termin ist schon voll.', 'fehler'); return; }
    const frei = aktiveMitglieder().filter((m) => !t.eingetragen.includes(m.id));
    frei.sort((a, c) => (a.id === S.ich ? -1 : c.id === S.ich ? 1 : 0));
    const wahl = await auswahl(`Wer kommt am ${fmtDatum(t.datum)}?`, frei.map((m) => ({ wert: m.id, text: m.id === S.ich ? `${m.name} (ich)` : m.name })));
    if (wahl) aktion('tsc88_eintragen', { p_training_id: t.id, p_mitglied_id: Number(wahl) }, `${nameVon(Number(wahl))} eingetragen.`);
  },
  async 'platz-belegt'(b) {
    const t = S.daten.trainings.find((x) => x.id === Number(b.dataset.t));
    const mid = Number(b.dataset.m);
    if (t.datum < isoHeute()) return;
    const wer = mid === S.ich ? 'Dich' : nameVon(mid);
    if (await frage(`${nameVon(mid)} austragen?`, `${wer} für ${fmtDatum(t.datum)} austragen.`, 'Austragen', true)) {
      aktion('tsc88_austragen', { p_training_id: t.id, p_mitglied_id: mid }, 'Ausgetragen.');
    }
  },

  'wertung-neu'() {
    if (LS.json('tsc88_entwurf')) {
      frage('Angefangene Wertung verwerfen?', 'Es gibt noch eine nicht gespeicherte Wertung.', 'Verwerfen', true).then((ja) => {
        if (ja) { LS.set('tsc88_entwurf', null); editorStarten(null); }
      });
      return;
    }
    editorStarten(null);
  },
  'wertung-oeffnen'(b) { editorStarten(S.daten.wertungen.find((w) => w.id === Number(b.dataset.id))); },
  'entwurf-weiter'() { S.editor = LS.json('tsc88_entwurf'); window.scrollTo(0, 0); render(); },
  async 'entwurf-weg'() { if (await frage('Verwerfen?', 'Die angefangene Wertung wird gelöscht.', 'Verwerfen', true)) { LS.set('tsc88_entwurf', null); render(); } },
  zelle(b) { S.editor.cursor = Number(b.dataset.i); render(); },
  punkte(b) {
    const e = S.editor;
    e.punkte[e.cursor] = Number(b.dataset.p);
    e.geaendert = true;
    entwurfSichern();
    // zum nächsten leeren Versuch springen (erst dahinter, dann von vorn)
    let naechster = e.punkte.findIndex((p, i) => i > e.cursor && p === null);
    if (naechster === -1) naechster = e.punkte.findIndex((p) => p === null);
    if (naechster !== -1) e.cursor = naechster;
    render();
    if (naechster === -1) toast(`Alle 24 Versuche: ${summe(e.punkte)} Punkte. Jetzt speichern!`);
  },
  'ed-schritt'(b) { S.editor.cursor = Math.min(23, Math.max(0, S.editor.cursor + Number(b.dataset.d))); render(); },
  'feld-drehen'() { S.gedreht = !S.gedreht; LS.set('tsc88_umgedreht', S.gedreht ? null : '1'); render(); },
  'ed-leeren'() { S.editor.punkte[S.editor.cursor] = null; S.editor.geaendert = true; entwurfSichern(); render(); },
  'ed-speichern'() { editorSpeichern(); },
  async 'ed-zurueck'() {
    const e = S.editor;
    if (e.geaendert && !(await frage('Ohne Speichern zurück?', 'Die Eingaben bleiben als angefangene Wertung auf diesem Handy erhalten.', 'Zurück'))) return;
    if (!e.geaendert) LS.set('tsc88_entwurf', null);
    S.editor = null; render(); window.scrollTo(0, 0);
  },
  async 'ed-loeschen'() {
    const e = S.editor;
    if (!(await frage('Wertung löschen?', `${nameVon(e.mitglied_id)}, ${fmtDatum(e.datum)} – ${summe(e.punkte)} Punkte. Das lässt sich nicht rückgängig machen.`, 'Löschen', true))) return;
    if (await aktion('tsc88_wertung_loeschen', { p_id: e.id }, 'Wertung gelöscht.')) {
      LS.set('tsc88_entwurf', null); S.editor = null; render();
    }
  },

  person(b) { personDetails(Number(b.dataset.id)); },
  csv() { csvHerunterladen(); },

  async 'mitglied-neu'() {
    const name = await nameEingeben('Mitglied hinzufügen');
    if (name) aktion('tsc88_mitglied_speichern', { p_id: null, p_name: name, p_aktiv: true }, `${name} hinzugefügt.`);
  },
  async 'mitglied-menue'(b) {
    const m = mitglied(Number(b.dataset.id));
    const r = await dialog(`<h3>${esc(m.name)}</h3><div class="stapel">
      <button class="knopf breit" data-wert="umbenennen">Umbenennen</button>
      <button class="knopf breit" data-wert="aktiv">${m.aktiv ? 'Deaktivieren (ausgetreten)' : 'Wieder aktivieren'}</button>
      <button class="knopf leise breit" data-wert="">Abbrechen</button></div>
      ${m.aktiv ? '<p class="klein" style="margin-top:10px">Deaktivierte Mitglieder erscheinen nicht mehr bei der Auswahl, ihre Wertungen bleiben erhalten.</p>' : ''}`);
    if (r === 'umbenennen') {
      const name = await nameEingeben('Umbenennen', m.name);
      if (name && name !== m.name) aktion('tsc88_mitglied_speichern', { p_id: m.id, p_name: name, p_aktiv: m.aktiv }, 'Name geändert.');
    }
    if (r === 'aktiv') aktion('tsc88_mitglied_speichern', { p_id: m.id, p_name: m.name, p_aktiv: !m.aktiv }, m.aktiv ? `${m.name} deaktiviert.` : `${m.name} aktiviert.`);
  },
  async passwort() {
    const r = await dialog(`<h3>Vereinspasswort ändern</h3>
      <form class="formular">
        <label><span class="feld-label">Bisheriges Passwort</span><input class="eingabe" type="password" name="alt" required autocomplete="current-password"></label>
        <label><span class="feld-label">Neues Passwort (mind. 8 Zeichen)</span><input class="eingabe" type="text" name="neu" minlength="8" required autocomplete="new-password"></label>
        <p class="klein">Danach müssen sich alle anderen Geräte mit dem neuen Passwort anmelden. Gib es allen Mitgliedern weiter.</p>
        <div class="knopf-reihe"><button type="button" class="knopf" data-wert="">Abbrechen</button><button class="knopf haupt">Ändern</button></div>
      </form>`);
    if (r && typeof r === 'object') aktion('tsc88_passwort_aendern', { p_alt: r.alt, p_neu: r.neu }, 'Passwort geändert.');
  },
  aktualisieren() { laden().then(() => toast('Aktualisiert.')); },
  async abmelden() {
    if (!(await frage('Abmelden?', 'Danach brauchst du auf diesem Gerät wieder das Vereinspasswort.', 'Abmelden', true))) return;
    try { await call('tsc88_abmelden'); } catch { /* egal */ }
    abgemeldet();
  },
  async installieren() {
    if (!S.installPrompt) return;
    S.installPrompt.prompt();
    await S.installPrompt.userChoice;
    S.installPrompt = null; render();
  }
};

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]');
  if (!b || b.disabled || b.tagName === 'SELECT' || b.type === 'checkbox') return;
  const f = AKTIONEN[b.dataset.a];
  if (f) f(b);
});
document.addEventListener('change', (e) => {
  const a = e.target.dataset?.a;
  if (a === 'filter-anlass') { S.filterAnlass = e.target.value; render(); }
  if (a === 'filter-voll') { S.nurVoll = e.target.checked; render(); }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.token && !S.editor) laden(true);
});
window.addEventListener('online', () => { if (S.token) laden(true); });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installPrompt = e; if (S.tab === 'mehr' && !S.editor) render(); });

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---------------------------------------------------------------- Start
(function start() {
  if (S.token) {
    const c = LS.json('tsc88_cache');
    if (c) { S.daten = c.daten; S.stand = new Date(c.stand); }
    render();
    laden(true);
  } else {
    render();
  }
})();
