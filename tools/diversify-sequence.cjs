// Rebuild only the daily order. Catalog entries and user data are never changed.
// Run: node tools/diversify-sequence.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const htmlPath = path.join(__dirname, '..', 'index.html');
const normalize = value => String(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const familyRules = [
  /fe\b|confi|fidel|lealda|promessa|esperanca/,
  /paz|ansie|preocupa|medo|corag|forca|socorro|intimida/,
  /perda|perdao|ferida|misericord|graca|recomec|nova vida|novidade|mudanca|transforma/,
  /amor|bondade|compaix|generos|servi|ajuda|cuida|cuidado|provis|solidari/,
  /sabedoria|aprend|escut|palavra|fala|verdade|sincer|orienta|consel|critica/,
  /humild|justica|integr|carater|obed|escolha|convicc|honest|dignidade|identidade/,
  /gratida|agradece|alegr|louvor|contenta|celebr|memoria/,
  /oracao|orar|presenca|silencio|comunhao|dependencia|entrega/,
  /descans|espera|pacien|tempo|processo|persever|persist|limite|estacoes/,
  /familia|amizade|amigo|relaciona|comunidade|unidade|hospital|cooper|pertenc|conviv|inclus/,
  /plano|planeja|direcao|priorida|proposito|trabalho|excelen|responsab|talento|dons/,
  /criacao|criou|cultiv|natureza|ambiente/
];

function features(d) {
  const theme = normalize(d.theme || (d.explanation[0].match(/sobre ([^.]+)/) || [])[1] || d.title);
  const parts = normalize(d.reference).split(';').map(part => part.trim());
  const chapters = parts.map(part => part.replace(/:\d+.*$/, ''));
  const book = chapters[0].replace(/\s+\d+$/, '');
  let families = 0;
  familyRules.forEach((rule, index) => { if (rule.test(theme)) families |= 1 << index; });
  const words = new Set(theme.split(/\W+/).filter(word => word.length >= 5));
  return { theme, chapters, book, families, words };
}

function buildOrder(catalog, cutover, passageGap = 28, themeGap = 21) {
  const n = catalog.length;
  const f = catalog.map(features);
  // A compact pair matrix keeps optimization out of the mobile app.
  const pairs = new Uint8Array(n * n);
  for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) {
    let flags = 0;
    if (f[a].chapters.some(chapter => f[b].chapters.includes(chapter))) flags |= 1;
    if (f[a].theme === f[b].theme) flags |= 2;
    if (f[a].families & f[b].families) flags |= 4;
    if (f[a].book === f[b].book) flags |= 8;
    const shared = [...f[a].words].filter(word => f[b].words.has(word)).length;
    if (shared && shared / (f[a].words.size + f[b].words.size - shared) >= 0.35) flags |= 16;
    pairs[a * n + b] = pairs[b * n + a] = flags;
  }
  function penalty(a, b, distance) {
    const flags = pairs[a * n + b];
    return ((flags & 1) && distance < passageGap ? (passageGap - distance) * 1000 : 0)
      + ((flags & 2) && distance < themeGap ? (themeGap - distance) * 1000 : 0)
      + ((flags & 4) && distance <= 5 ? (6 - distance) * 10 : 0)
      + ((flags & 8) && distance <= 2 ? (3 - distance) * 2 : 0)
      + ((flags & 16) && distance <= 7 ? (8 - distance) * 20 : 0);
  }
  let seed = 20261112;
  function random() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; }
  const order = [], remaining = new Set(catalog.map((_, i) => i));
  for (let day = 0; day < n; day++) {
    let best, bestScore = Infinity;
    for (const candidate of remaining) {
      // Previously displayed entries cannot reappear within 300 days of reading.
      if (day < 300 && candidate < cutover) continue;
      let score = random();
      for (let distance = 1; distance < Math.max(passageGap, themeGap); distance++) {
        const previous = day >= distance ? order[day - distance] : (cutover + day - distance + n) % n;
        score += penalty(candidate, previous, distance);
      }
      if (score < bestScore) { best = candidate; bestScore = score; }
    }
    if (best === undefined) throw new Error('Not enough unread entries to preserve the 300-day interval');
    order.push(best); remaining.delete(best);
  }
  function localCost(position) {
    let cost = 0;
    for (let distance = 1; distance < Math.max(passageGap, themeGap); distance++) {
      cost += penalty(order[position], order[(position + distance) % n], distance);
      cost += penalty(order[position], order[(position - distance + n) % n], distance);
      // Include both the transition from the old sequence and the circular seam.
      if (position < distance) cost += penalty(order[position], (cutover + position - distance + n) % n, distance);
    }
    return cost;
  }
  const iterations = 2000000;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const a = Math.floor(random() * n), b = Math.floor(random() * n);
    if (a === b || (a < 300 && order[b] < cutover) || (b < 300 && order[a] < cutover)) continue;
    const before = localCost(a) + localCost(b);
    // The pair (a,b) is counted twice but its cost is unchanged by swapping.
    [order[a], order[b]] = [order[b], order[a]];
    const delta = localCost(a) + localCost(b) - before;
    const temperature = 1500 * Math.pow(1 - iteration / iterations, 4);
    if (delta > 0 && random() >= Math.exp(-delta / temperature)) [order[a], order[b]] = [order[b], order[a]];
  }
  // Repair any residual close readings without trading them for softer preferences.
  const window = Math.max(passageGap, themeGap);
  function hardPenalty(a, b, distance) {
    const flags = pairs[a * n + b];
    return ((flags & 1) && distance < passageGap ? 1000 + passageGap - distance : 0)
      + ((flags & 2) && distance < themeGap ? 1000 + themeGap - distance : 0);
  }
  function hardCost(position) {
    let cost = 0;
    for (let d = 1; d < window; d++) {
      cost += hardPenalty(order[position], order[(position + d) % n], d);
      cost += hardPenalty(order[position], order[(position - d + n) % n], d);
      if (position < d) cost += hardPenalty(order[position], (cutover + position - d + n) % n, d);
    }
    return cost;
  }
  let repaired = false;
  for (let attempt = 0; attempt < 2000; attempt++) {
    const conflicts = [];
    for (let a = 0; a < n; a++) {
      for (let d = 1; d < window; d++) {
        if (hardPenalty(order[a], order[(a + d) % n], d)) conflicts.push(a, (a + d) % n);
        if (a < d && hardPenalty(order[a], (cutover + a - d + n) % n, d)) conflicts.push(a);
      }
    }
    if (!conflicts.length) { repaired = true; break; }
    const a = conflicts[Math.floor(random() * conflicts.length)];
    let bestB, bestDelta = Infinity;
    for (let sample = 0; sample < n; sample++) {
      const b = (sample + attempt * 37) % n;
      if (a === b || (a < 300 && order[b] < cutover) || (b < 300 && order[a] < cutover)) continue;
      const before = hardCost(a) + hardCost(b);
      [order[a], order[b]] = [order[b], order[a]];
      const delta = hardCost(a) + hardCost(b) - before;
      [order[a], order[b]] = [order[b], order[a]];
      if (delta < bestDelta) { bestDelta = delta; bestB = b; }
      if (bestDelta < 0) break;
    }
    if (bestB !== undefined && (bestDelta <= 0 || random() < 0.02)) {
      [order[a], order[bestB]] = [order[bestB], order[a]];
    }
  }
  if (!repaired) throw new Error('Could not meet the requested spacing; existing schedule has not been overwritten');
  return order;
}

function loadCatalogs(html) {
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const context = vm.createContext({});
  vm.runInContext(script.slice(0, script.indexOf('const KIDS_PUZZLE_PIECES'))
    + ';globalThis.catalog = devotionals;', context);
  return {
    adult: context.catalog,
    child: JSON.parse(html.match(/const childDevotionals = (\[[^\n]+\]);/)[1])
  };
}

if (require.main === module) {
  let html = fs.readFileSync(htmlPath, 'utf8');
  const catalogs = loadCatalogs(html);
  const cutover = 315; // 12 November 2026, Australia/Brisbane; epoch 1 January 2026.
  const adult = buildOrder(catalogs.adult, cutover, 28, 21);
  const child = buildOrder(catalogs.child, cutover, 18, 18);
  const block = `    // DAILY_SEQUENCE_START: generated by tools/diversify-sequence.cjs.\n`
    + `    // Keep this date and both permutations stable: dates also identify saved reflections.\n`
    + `    const DAILY_SEQUENCE_START = 315; // 2026-11-12 in Australia/Brisbane\n`
    + `    const adultDailyOrder = ${JSON.stringify(adult)};\n`
    + `    const childDailyOrder = ${JSON.stringify(child)};\n`
    + `    // DAILY_SEQUENCE_END`;
  if (html.includes('// DAILY_SEQUENCE_START:')) html = html.replace(/    \/\/ DAILY_SEQUENCE_START:[\s\S]*?    \/\/ DAILY_SEQUENCE_END/, block);
  else html = html.replace('    // Resumos do assunto, separados', block + '\n\n    // Resumos do assunto, separados');
  fs.writeFileSync(htmlPath, html);
  console.log('Updated adult and child daily permutations; all catalog entries preserved.');
}
module.exports = { features, buildOrder, loadCatalogs };
