const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const selection = script.match(/    function devotionalForToday\(\) \{[\s\S]*?\n    \}/)[0];
const dailySelection = script.match(/    function dailyDevotional\(catalog, order, dayNumber\) \{[\s\S]*?\n    \}/)[0];
const childSelection = script.match(/    function childDevotionalForToday\(\) \{[\s\S]*?\n    \}/)[0];
const children = JSON.parse(html.match(/const childDevotionals = (\[[^\n]+\]);/)[1]);
const context = vm.createContext({});
vm.runInContext(script.slice(0, script.indexOf('const KIDS_PUZZLE_PIECES')), context);
vm.runInContext(`
  let testDate;
  function currentBrisbaneYMD() { return testDate; }
  ${selection}
  ${dailySelection}
  ${childSelection}
  const childDevotionals = ${JSON.stringify(children)};
  globalThis.catalog = { existingDevotionals, additionalDevotionals, devotionals };
  globalThis.orders = { adult: adultDailyOrder, child: childDailyOrder };
  globalThis.selectDay = (offset, child = false) => {
    const date = new Date(Date.UTC(2026, 0, 1 + offset));
    testDate = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    return child ? childDevotionalForToday() : devotionalForToday();
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

test('datas até 11/11/2026 preservam as leituras anteriores', () => {
  for (let day = -1570; day < 315; day++) {
    const index = ((day % devotionals.length) + devotionals.length) % devotionals.length;
    assert.equal(context.selectDay(day), devotionals[index], `dia ${day}`);
    const childIndex = ((day % children.length) + children.length) % children.length;
    assert.equal(context.selectDay(day, true).title, children[childIndex].title);
  }
});

test('a partir de 12/11 cada ciclo usa todos os itens uma vez, com ordem estável', () => {
  for (const [name, catalog] of [['adult', devotionals], ['child', children]]) {
    const order = context.orders[name];
    assert.equal(order.length, catalog.length);
    assert.deepEqual([...order].sort((a, b) => a - b), Array.from(catalog, (_, i) => i));
    const titles = new Set();
    for (let day = 0; day < catalog.length; day++) {
      const selected = context.selectDay(315 + day, name === 'child');
      assert.equal(selected.title, catalog[order[day]].title);
      assert.equal(context.selectDay(315 + day, name === 'child'), selected);
      assert.equal(context.selectDay(315 + day + catalog.length, name === 'child'), selected);
      titles.add(selected.title);
    }
    assert.equal(titles.size, catalog.length);
  }
});

test('o mesmo devocional fica a pelo menos 300 dias de distância, inclusive na transição', () => {
  for (const [child, total] of [[false, devotionals.length], [true, children.length]]) {
    const lastRead = new Map();
    for (let day = 15; day < 315 + 2 * total; day++) {
      const d = context.selectDay(day, child);
      if (lastRead.has(d.title)) assert.ok(day - lastRead.get(d.title) >= 300, `${d.title}: dia ${day}`);
      lastRead.set(d.title, day);
    }
  }
});

test('passagens do mesmo capítulo ficam separadas por 28 dias no adulto e 18 no infantil', () => {
  const chapters = d => normalize(d.reference).split(';').map(p => p.trim().replace(/:\d+.*$/, ''));
  for (const [child, total, gap] of [[false, devotionals.length, 28], [true, children.length, 18]]) {
    for (let day = 315; day < 315 + total + gap; day++) {
      const current = chapters(context.selectDay(day, child));
      for (let distance = 1; distance < gap; distance++) {
        const previous = chapters(context.selectDay(day - distance, child));
        assert.ok(!current.some(ch => previous.includes(ch)), `capítulo próximo: dia ${day}, distância ${distance}`);
      }
    }
  }
});

test('temas iguais ficam separados por 21 dias no adulto e 18 no infantil', () => {
  const theme = d => normalize(d.theme || d.explanation[0].match(/sobre ([^.]+)/)[1]);
  for (const [child, total, gap] of [[false, devotionals.length, 21], [true, children.length, 18]]) {
    for (let day = 315; day < 315 + total + gap; day++) {
      for (let distance = 1; distance < gap; distance++) {
        assert.notEqual(theme(context.selectDay(day, child)), theme(context.selectDay(day - distance, child)), `tema próximo: dia ${day}`);
      }
    }
  }
});

test('o catálogo permanece indexado na ordem original para preservar suas referências', () => {
  for (let day = 0; day < 315; day++) {
    assert.equal(context.selectDay(day), devotionals[day], `dia ${day}`);
  }
  assert.equal(context.selectDay(-1), devotionals.at(-1));
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
  vm.runInContext('let db = null; let currentUserId = null;', context);
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

test('uma reflexão já salva é carregada intacta, sem escrita no banco', async () => {
  const saved = { reflection_text: 'Minha reflexão pessoal — preservar exatamente.' };
  const calls = [];
  context.savedDb = {
    from(table) {
      calls.push(['from', table]);
      return {
        select(fields) { calls.push(['select', fields]); return this; },
        eq(field, value) { calls.push(['eq', field, value]); return this; },
        async maybeSingle() { return { data: saved }; }
      };
    }
  };
  vm.runInContext('db = savedDb; currentUserId = "test-user";', context);
  context.selectDay(315);
  await context.renderToday();
  assert.equal(context.$('journal').value, saved.reflection_text);
  assert.deepEqual(calls, [
    ['from', 'reflections'], ['select', 'reflection_text'],
    ['eq', 'user_id', 'test-user'], ['eq', 'devotional_date', '']
  ]);
  vm.runInContext('db = null; currentUserId = null;', context);
});

