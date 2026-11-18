// Det Andre Teatret – produktfeed
// Henter alle forestillinger fra detandreteatret.no/program, detaljer fra hver forestillingsside
// og billettstatus fra Tickster. Skriver docs/feed.csv (publiseres via GitHub Pages).
//
// Kjør lokalt:  node src/build-feed.mjs
//
// Regler:
//  - ticket_status = "in stock" hvis minst én kommende spilletid kan kjøpes i Tickster, ellers "out of stock".
//  - Forestillinger som forsvinner fra programmet blir liggende i feeden som "out of stock".
//  - Manuelle justeringer per forestilling legges i src/overrides.json.
//  - Feiler noe underveis, avsluttes scriptet med feil og feed.csv blir ikke endret.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEED_PATH = join(ROOT, 'docs', 'feed.csv');
const OVERRIDES_PATH = join(ROOT, 'src', 'overrides.json');

const SITE = 'https://detandreteatret.no';
const TICKSTER_ORGANIZER = 'https://www.tickster.com/no/nb/events/by/19r5084l1llp6f9/det-andre-teatret';
const USER_AGENT = 'Mozilla/5.0 (compatible; dat-feed/1.0)';

export const COLUMNS = ['id', 'title', 'subtitle', 'description', 'price', 'ticket_status', 'scene', 'spilles',
  'text_color', 'bg_color', 'accent_color', 'Klokkeslett', 'url', 'image_url', 'categories', 'promo',
  'google_product_category'];

const DEFAULTS = { promo: 'yes', google_product_category: '499969' };

/* ------------------------------------------------------------------ */
/* Henting                                                             */
/* ------------------------------------------------------------------ */

async function get(url, { allowFail = false, tries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
      if (res.ok) return await res.text();
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
      if (res.status === 404) break;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  if (allowFail) return null;
  throw lastErr;
}

/** Kjører fn over items med begrenset samtidighet */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/** { slug: [{ spilletid, kode }] } fra alle sidene i /program */
export async function hentProgram() {
  const program = {};
  let url = `${SITE}/program`;
  for (let side = 1; side <= 30 && url; side++) {
    const h = await get(url);
    for (const k of h.split('<div class="show-card border-radius--sm">').slice(1)) {
      const m = k.match(/\/forestillinger\/([^"?#]+)\?spilletid=(\d+)/);
      if (!m) continue;
      const slug = safeDecode(m[1]);
      const kode = (k.match(/<a href="https?:\/\/[^"]*?\/([a-z0-9]{15})"[^>]*class="btn/) || [])[1] || null;
      (program[slug] ||= []).push({ spilletid: m[2], kode });
    }
    url = h.includes(`/program/side/${side + 1}"`) ? `${SITE}/program/side/${side + 1}` : null;
  }
  return program;
}

/** { tickster-kode: true/false } – true hvis "Kjøp"-knapp vises i arrangørlisten */
export async function hentTicksterStatus() {
  const status = {};
  for (let skip = 0; skip < 2400; skip += 24) {
    const h = dekod(await get(`${TICKSTER_ORGANIZER}?skip=${skip}&take=24`));
    const kort = h.split('<div class="c-card c-card--overlay">').slice(1);
    for (const k of kort) {
      const m = k.match(/\/events\/([a-z0-9]{15})\//);
      if (!m) continue;
      const fot = k.slice(k.indexOf('c-card__foot'));
      status[m[1]] = /class="c-button[^"]*"[^>]*>\s*Kjøp\s*</.test(fot);
    }
    if (kort.length === 0 || !h.includes('Neste side')) break;
  }
  return status;
}

/** Sjekker enkeltarrangementer som ikke står i arrangørlisten */
async function sjekkTicksterEvent(kode) {
  const h = await get(`https://www.tickster.com/no/nb/events/${kode}`, { allowFail: true });
  if (h === null) return true; // usikkert → ikke sett utsolgt på feil grunnlag
  return !/ikke mulig å kjøpe billetter|utsolgt|slutsåld|sold out/i.test(dekod(h));
}

/** { tema: { bg, fg, btn } } fra nettsidens CSS */
async function hentTemafarger() {
  const css = await get(`${SITE}/css/main.css`);
  const t = {};
  for (const m of css.matchAll(/\.theme--([a-z-]+)\{background-color:(#[0-9A-Fa-f]+);color:(#[0-9A-Fa-f]+)\}/g)) {
    t[m[1]] = { bg: m[2].toUpperCase(), fg: m[3].toUpperCase() };
  }
  for (const m of css.matchAll(/\.theme--([a-z-]+) \.btn--primary\{background-color:(#[0-9A-Fa-f]+);/g)) {
    if (t[m[1]]) t[m[1]].btn = m[2].toUpperCase();
  }
  return t;
}

/* ------------------------------------------------------------------ */
/* Parsing av forestillingsside                                        */
/* ------------------------------------------------------------------ */

const UKEDAGER = ['Søndag', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag'];
const MND = { 'jan.': 0, 'feb.': 1, 'mar.': 2, 'apr.': 3, mai: 4, 'jun.': 5, 'jul.': 6, 'aug.': 7, 'sep.': 8, 'okt.': 9, 'nov.': 10, 'des.': 11 };
const MND_NAVN = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];

export function parseForestilling(slug, h, farger) {
  const main = h.slice(h.indexOf('<main'));

  const tema = (main.match(/^<main[^>]*>\s*<div class="theme--([a-z-]+)"/) || [])[1] || 'white';
  const f = farger[tema] || farger.white || { bg: '#FFFFFF', fg: '#000000', btn: '#D9D9D9' };

  const infoStart = main.indexOf('show-top__info');
  const info = main.slice(infoStart, main.indexOf('show-content', infoStart));
  const title = rens((info.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '');
  const subtitle = rens((info.match(/<span class="accent--md">([\s\S]*?)<\/span>/) || [])[1] || '');
  const tid = (info.match(/<b>\s*(\d{1,2}:\d{2})\s*<\/b>/) || [])[1] || '';
  const heroScene = rens((info.match(/<div>([^<]+)<\/div>/) || [])[1] || '');

  const body = main.slice(main.indexOf('show-content__body'));
  const tagStart = body.indexOf('show-content__body__tags');
  const tags = [];
  if (tagStart !== -1) {
    const tagSec = body.slice(tagStart, body.indexOf('</div>', tagStart));
    for (const m of tagSec.matchAll(/class="tag tag--link">\s*<span>([\s\S]*?)<\/span>/g)) tags.push(rens(m[1]));
  }

  let tc = body.slice(body.indexOf('text-container'));
  tc = tc.slice(0, tc.indexOf('</div>'));
  const avsnitt = [...tc.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => rens(m[1])).filter(Boolean);
  let description = '';
  for (const p of avsnitt) {
    description = `${description} ${p}`.trim();
    if (description.length >= 100) break;
  }

  const img = (main.match(/<source media="\(min-width: 521px\)" srcset="([^"]+)"/) || [])[1] || '';

  const si = main.slice(main.indexOf('show-info'));
  const kv = {};
  for (const m of si.matchAll(/<li>\s*<b>([\s\S]*?)<\/b>([\s\S]*?)<\/li>\s*(?=<li>\s*<b>|<\/ul>\s*<\/div>)/g)) {
    kv[rens(m[1])] = rens(m[2]);
  }
  const pris = ((kv.Pris || '').match(/(?:Ordinær|Voksen)\s*:\s*(\d+)/) || [])[1] || '';

  let up = main.slice(main.indexOf('Kommende forestillinger'));
  up = up.slice(0, up.indexOf('<h5', 10));
  const datoer = [];
  for (const m of up.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)) {
    const d = rens(m[1]).split(' - ')[0].split(' ');
    if (d.length !== 3 || !(d[1] in MND)) continue;
    const dato = new Date(+d[2], MND[d[1]], parseInt(d[0], 10));
    if (!datoer.some((x) => x.getTime() === dato.getTime())) datoer.push(dato);
  }

  const fg = f.fg === '#000000' ? '#000' : f.fg === '#FFFFFF' ? '#FFF' : f.fg;

  return {
    id: tilId(slug),
    title,
    subtitle,
    description,
    price: pris,
    scene: kv.Scene || heroScene,
    spilles: kv.Spilles || lagSpilles(datoer, tid),
    text_color: fg,
    bg_color: f.bg,
    accent_color: f.btn || f.bg,
    Klokkeslett: tid,
    url: `${SITE}/forestillinger/${encodeURIComponent(slug)}`,
    image_url: img ? SITE + encodeURI(safeDecode(rens(img))) : '',
    categories: tags[0] || '',
  };
}

export function lagSpilles(datoer, tid) {
  if (!datoer.length) return '';
  const kl = `kl ${tid.endsWith(':00') ? String(parseInt(tid, 10)) : tid.replace(/^0/, '')}`;
  const ukedager = new Set(datoer.map((d) => d.getDay()));
  if (datoer.length >= 5 && ukedager.size === 1) return `${UKEDAGER[[...ukedager][0]]}er ${kl}`;

  const mnd = [];
  for (const d of datoer) {
    const navn = MND_NAVN[d.getMonth()];
    if (mnd.length && mnd.at(-1).navn === navn) mnd.at(-1).dager.push(`${d.getDate()}.`);
    else mnd.push({ navn, dager: [`${d.getDate()}.`] });
  }
  if (datoer.length <= 4) return `${liste(mnd.map((x) => `${liste(x.dager)} ${x.navn}`))} ${kl}`;
  return mnd.length === 1 ? `Utvalgte datoer i ${mnd[0].navn}` : `Utvalgte datoer ${mnd[0].navn}–${mnd.at(-1).navn}`;
}

const liste = (xs) => (xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(', ')} og ${xs.at(-1)}`);

/** URL-slug → id uten æøå (samme regel som GTM-scriptet) */
export const tilId = (slug) => slug.toLowerCase().replaceAll('æ', 'ae').replaceAll('ø', 'o').replaceAll('å', 'a');

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

const rens = (s) => dekod(String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

const NAMED = { nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', aring: 'å', Aring: 'Å', oslash: 'ø', Oslash: 'Ø', aelig: 'æ', AElig: 'Æ', hellip: '…', ndash: '–', mdash: '—', amp: '&' };
function dekod(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => NAMED[n] ?? m);
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
export const toCsv = (rows) => [COLUMNS, ...rows.map((r) => COLUMNS.map((c) => r[c]))].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/* ------------------------------------------------------------------ */
/* Hovedjobb                                                           */
/* ------------------------------------------------------------------ */

async function main() {
  const [program, kjøpbar, farger] = await Promise.all([hentProgram(), hentTicksterStatus(), hentTemafarger()]);
  const slugs = Object.keys(program);
  if (slugs.length === 0) throw new Error('Fant ingen forestillinger i programmet – avbryter.');
  if (Object.keys(kjøpbar).length === 0) throw new Error('Fant ingen arrangementer hos Tickster – avbryter.');

  // Koder som ikke står i arrangørlisten: sjekk arrangementssiden direkte
  const ukjente = [...new Set(slugs.flatMap((s) => program[s].map((st) => st.kode)).filter((k) => k && !(k in kjøpbar)))];
  const ukjentStatus = await mapLimit(ukjente, 5, sjekkTicksterEvent);
  ukjente.forEach((k, i) => { kjøpbar[k] = ukjentStatus[i]; });

  const sider = await mapLimit(slugs, 5, (s) => get(`${SITE}/forestillinger/${encodeURIComponent(s)}`));

  let overrides = {};
  try { overrides = JSON.parse(await readFile(OVERRIDES_PATH, 'utf8')); } catch { /* ingen overrides */ }
  delete overrides._forklaring;

  let forrige = [];
  try { forrige = parseCsv(await readFile(FEED_PATH, 'utf8')); } catch { /* første kjøring */ }

  const rader = slugs.map((slug, i) => {
    const rad = parseForestilling(slug, sider[i], farger);
    const iSalg = program[slug].some((st) => (st.kode ? kjøpbar[st.kode] === true : true));
    return { ...DEFAULTS, ...rad, ticket_status: iSalg ? 'in stock' : 'out of stock' };
  });

  // Forestillinger som ikke lenger ligger i programmet beholdes som "out of stock"
  const nyeIder = new Set(rader.map((r) => r.id));
  const borte = forrige.filter((r) => r.id && !nyeIder.has(r.id)).map((r) => ({ ...r, ticket_status: 'out of stock' }));

  // Behold rekkefølgen fra forrige feed, nye forestillinger legges til nederst
  const rekkefølge = new Map(forrige.map((r, i) => [r.id, i]));
  const alle = [...rader, ...borte]
    .map((r) => ({ ...r, ...(overrides[r.id] || {}) }))
    .sort((a, b) => (rekkefølge.get(a.id) ?? 1e9) - (rekkefølge.get(b.id) ?? 1e9));

  await mkdir(dirname(FEED_PATH), { recursive: true });
  await writeFile(FEED_PATH, toCsv(alle));

  const forrigeIder = new Set(forrige.map((r) => r.id));
  const nye = rader.filter((r) => !forrigeIder.has(r.id)).map((r) => r.id);
  const utsolgt = alle.filter((r) => r.ticket_status === 'out of stock').map((r) => r.id);
  console.log(`Forestillinger i programmet: ${rader.length}`);
  console.log(`Nye: ${nye.join(', ') || '–'}`);
  console.log(`Ikke lenger i programmet: ${borte.map((r) => r.id).join(', ') || '–'}`);
  console.log(`Out of stock: ${utsolgt.join(', ') || '–'}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
