const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const selection = script.match(/    function devotionalForToday\(\) \{[\s\S]*?\n    \}/)[0];
const context = vm.createContext({});
vm.runInContext(script.slice(0, script.indexOf('const KIDS_PUZZLE_PIECES')), context);
vm.runInContext(`
  let testDate;
  function currentBrisbaneYMD() { return testDate; }
  ${selection}
  globalThis.catalog = { existingDevotionals, additionalDevotionals, devotionals };
  globalThis.selectDay = (offset) => {
    const date = new Date(Date.UTC(2026, 0, 1 + offset));
    testDate = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    return devotionalForToday();
  };
`, context);
const { existingDevotionals, additionalDevotionals, devotionals } = context.catalog;
const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');

test('o catálogo oferece pelo menos 500 temas distintos, sem duplicar os novos', () => {
  const originalThemes = new Set(existingDevotionals.map(d => normalize(d.theme)));
  const newThemes = additionalDevotionals.map(d => normalize(d.theme));
  assert.equal(originalThemes.size, 67);
  assert.equal(newThemes.length, 570);
  assert.equal(new Set(newThemes).size, newThemes.length);
  assert.ok(newThemes.every(theme => !originalThemes.has(theme)));
  assert.equal(new Set(devotionals.map(d => normalize(d.theme))).size, 637);
  assert.ok(new Set(devotionals.map(d => normalize(d.theme))).size >= 500);
});

test('os 1.000 devocionais existentes permanecem completos e na mesma ordem relativa', () => {
  assert.equal(existingDevotionals.length, 1000);
  assert.equal(devotionals.length, 1570);
  const originals = new Set(existingDevotionals);
  assert.deepEqual(devotionals.filter(d => originals.has(d)), existingDevotionals);
  assert.equal(new Set(devotionals).size, devotionals.length);
  assert.equal(new Set(devotionals.map(d => d.title)).size, devotionals.length);
});

test('todos os devocionais têm referência, leitura, reflexão, pergunta e oração', () => {
  for (const d of devotionals) {
    for (const field of ['title', 'theme', 'reference', 'verse', 'question', 'prayer']) {
      assert.equal(typeof d[field], 'string', `${d.title}: ${field}`);
      assert.ok(d[field].trim().length > 0, `${d.title}: ${field} vazio`);
      assert.doesNotMatch(d[field], /<[^>]*>/, `${d.title}: marcação inesperada`);
    }
    assert.match(d.reference, /\d+:\d+/);
    for (const field of ['devotional', 'reflection']) {
      assert.ok(Array.isArray(d[field]) && d[field].length >= 2, `${d.title}: ${field}`);
      assert.ok(d[field].every(p => typeof p === 'string' && p.trim()), d.title);
    }
  }
});

test('a seleção diária alcança todos os itens e só reinicia ao terminar o catálogo', () => {
  for (let day = 0; day < devotionals.length; day++) {
    assert.equal(context.selectDay(day), devotionals[day], `dia ${day}`);
  }
  assert.equal(context.selectDay(1000), devotionals[1000]);
  assert.equal(context.selectDay(devotionals.length), devotionals[0]);
  assert.equal(context.selectDay(-1), devotionals.at(-1));
  assert.equal(context.selectDay(-devotionals.length), devotionals[0]);
});

test('novos temas estão distribuídos no ciclo, inclusive no primeiro mês', () => {
  const additions = new Set(additionalDevotionals);
  assert.ok(devotionals.slice(0, 31).some(d => additions.has(d)));
  let oldRun = 0;
  for (const d of devotionals) {
    oldRun = additions.has(d) ? 0 : oldRun + 1;
    assert.ok(oldRun <= 2, 'mais de dois devocionais antigos seguidos');
  }
});

test('todo o JavaScript embutido continua sintaticamente válido', () => {
  assert.doesNotThrow(() => new vm.Script(script));
});

test('a tela mostra uma ideia central curta acima, sem substituir ou repetir a leitura bíblica abaixo', async () => {
  const elements = new Map();
  context.$ = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', classList: { toggle() {} } });
    return elements.get(id);
  };
  context.formattedDate = () => '';
  context.dateKey = () => '';
  context.updateCounter = () => {};
  context.refreshRewardDisplay = async () => {};
  vm.runInContext('const db = null; const currentUserId = null;', context);
  vm.runInContext(script.match(/    function localBibleReading\(devotional\) \{[\s\S]*?\n    \}/)[0], context);
  vm.runInContext(script.match(/    async function renderToday\(\) \{[\s\S]*?\n    \}/)[0], context);

  for (let day = 0; day < devotionals.length; day++) {
    const d = context.selectDay(day);
    await context.renderToday();
    const idea = elements.get('verseIdea').textContent;
    assert.ok(typeof idea === 'string' && idea.trim(), `ideia ausente: ${d.title}`);
    assert.ok(idea.length <= 160, `ideia longa: ${d.title}`);
    assert.notEqual(idea, d.verse, `ideia repetiu a passagem: ${d.title}`);
    assert.equal(elements.get('verseText').textContent, d.verse, d.title);
    assert.equal(elements.get('verseRef').textContent, d.reference, d.title);
  }
});
