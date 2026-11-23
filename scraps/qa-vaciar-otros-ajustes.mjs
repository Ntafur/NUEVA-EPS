// QA de las dos funcionalidades nuevas:
//   (A) Botón "∅ Vaciar seleccionadas" en la barra de bulk: deja numAutorizacion
//       en null en todas las filas seleccionadas (sin tocar row.original).
//   (B) Ajuste (6) en applyOtrosAjustes: numAutorizacion = null en otrosServicios
//       cuando tipoOS === "01" O codTecnologiaSalud ∈ SPECIAL_OS_CODES.
//
// Se ejercita el HTML real en Chromium contra los 3 RIPS provistos:
//   55724d74 (11492424), 27a20cb2 (11492432), a9a48b86 (11492418).

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = pathResolve(__dirname, '..');
const HTML = `file://${ROOT}/Editor_RIPS.html`;
const UPLOADS = '/root/.claude/uploads/d4b34822-0380-517a-ab4d-ae681926a7b6';
const FILES = [
  `${UPLOADS}/55724d74-860035992_11492424_rips.json`,
  `${UPLOADS}/27a20cb2-860035992_11492432_rips.json`,
  `${UPLOADS}/a9a48b86-860035992_11492418_rips.json`,
];
const SPECIAL_OS_CODES = new Set([
  '2DS002','2DS003','5DS002','5DS003','5DS004',
  '7DS001','7DS002','7DS003','7DS004','7DS005','7DS006',
]);

const rawJsons = FILES.map(p => ({ name: p.split('/').pop(), raw: JSON.parse(readFileSync(p, 'utf-8')) }));

let pass = 0, fail = 0;
const log = [];
function check(name, cond, info) {
  if (cond) { pass++; log.push(`  ✓ ${name}`); }
  else      { fail++; log.push(`  ✗ ${name}${info ? `\n      ${info}` : ''}`); }
}

// Inventario esperado (lo que "debería" nulificar el ajuste 6 por archivo).
function inventarioEsperado(files) {
  const map = {};
  files.forEach(({ name, raw }) => {
    let tipo01 = 0, cod = 0, both = 0, keep = 0;
    (raw.usuarios || []).forEach(u => {
      ((u.servicios || {}).otrosServicios || []).forEach(it => {
        if (!('numAutorizacion' in it)) return;
        if (it.numAutorizacion === null) return;
        const esT01 = String(it.tipoOS ?? '').trim() === '01';
        const c = String(it.codTecnologiaSalud ?? '').trim().toUpperCase();
        const esEsp = SPECIAL_OS_CODES.has(c);
        if (esT01 && esEsp) both++;
        else if (esT01) tipo01++;
        else if (esEsp) cod++;
        else keep++;
      });
    });
    map[name] = { tipo01, cod, both, keep, aNull: tipo01 + cod + both };
  });
  return map;
}

const esperado = inventarioEsperado(rawJsons);
console.log('\n=== Esperado por archivo ===');
console.log(JSON.stringify(esperado, null, 2));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
async function openPage() {
  const page = await browser.newContext().then(c => c.newPage());
  page.on('pageerror', err => console.error('PAGE ERROR:', err.message));
  page.on('console', msg => { if (msg.type() === 'error') console.error('CONSOLE ERROR:', msg.text()); });
  await page.addInitScript(() => {
    const fp = function () { return { destroy(){}, setDate(){}, clear(){} }; };
    fp.l10ns = { es: {} };
    window.flatpickr = fp;
  });
  await page.goto(HTML, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__bulkAuth, null, { timeout: 10000 });
  return page;
}

// ─────────────────────────────── A) applyOtrosAjustes — ajuste (6) ──
const pageA = await openPage();
await pageA.evaluate((files) => {
  const api = window.__bulkAuth;
  files.forEach((f, i) => {
    const key = `qa-${i}`;
    api.editorState.files[key] = {
      name: f.name,
      raw: JSON.parse(JSON.stringify(f.raw)),
      rows: api.buildRows ? api.buildRows(f.raw) : [],
      modified: false,
    };
  });
  api.editorState.activeFile = Object.keys(api.editorState.files)[0];
}, rawJsons);

const resA = await pageA.evaluate(() => {
  const api = window.__bulkAuth;
  api.applyOtrosAjustes();
  return Object.values(api.editorState.files).map(f => ({
    name: f.name,
    raw: f.raw,
    modified: f.modified,
  }));
});

// Verificar: toda otrosServicios con tipoOS=01 o codTS ∈ SPECIAL ahora tiene numAutorizacion = null.
let totalNulificados = 0;
let colateralChanges = 0;
const fallas = [];
resA.forEach(r => {
  const esp = esperado[r.name];
  const orig = rawJsons.find(x => x.name === r.name).raw;
  let nullif = 0;
  (r.raw.usuarios || []).forEach((u, uIdx) => {
    ((u.servicios || {}).otrosServicios || []).forEach((it, idx) => {
      if (!('numAutorizacion' in it)) return;
      const origIt = orig.usuarios?.[uIdx]?.servicios?.otrosServicios?.[idx];
      const origNumAut = origIt?.numAutorizacion;
      const esT01 = String(it.tipoOS ?? '').trim() === '01';
      const c = String(it.codTecnologiaSalud ?? '').trim().toUpperCase();
      const esEsp = SPECIAL_OS_CODES.has(c);
      if (esT01 || esEsp) {
        // debió quedar en null
        if (it.numAutorizacion !== null) fallas.push(`${r.name}/u${uIdx}/otrosServicios[${idx}] esperaba null, es ${JSON.stringify(it.numAutorizacion)}`);
        else nullif++;
      } else {
        // no era de los tipos a nulificar — numAutorizacion debe ser igual al original
        if (it.numAutorizacion !== origNumAut) {
          colateralChanges++;
          fallas.push(`${r.name}/u${uIdx}/otrosServicios[${idx}] NO debía cambiar (tipoOS=${it.tipoOS}, codTS=${it.codTecnologiaSalud}) pero pasó de ${JSON.stringify(origNumAut)} a ${JSON.stringify(it.numAutorizacion)}`);
        }
      }
    });
  });
  totalNulificados += nullif;
  console.log(` · ${r.name}: ${nullif} numAutorizacion nulificados (esperado ${esp.aNull}), modified=${r.modified}`);
  check(`[${r.name}] nulifica exactamente los esperados (${esp.aNull})`, nullif === esp.aNull,
    `nulificó ${nullif}, esperaba ${esp.aNull}`);
  check(`[${r.name}] archivo marcado como modified`, r.modified === true);
});
check('Sin cambios colaterales en otrosServicios que no eran del ajuste',
  colateralChanges === 0, fallas.slice(0,3).join(' // '));

// Serialización: null (literal) sin comillas.
if (totalNulificados > 0) {
  const sample = resA.find(r => {
    const esp = esperado[r.name];
    return esp && esp.aNull > 0;
  });
  const json = JSON.stringify(sample.raw, null, 2);
  check('Los null nulificados se serializan como `null` sin comillas',
    /"numAutorizacion"\s*:\s*null/.test(json));
}

// Idempotencia: segunda corrida no vuelve a cambiar nada.
const idemp = await pageA.evaluate(() => {
  const api = window.__bulkAuth;
  Object.values(api.editorState.files).forEach(f => { f.modified = false; });
  api.applyOtrosAjustes();
  return Object.values(api.editorState.files).map(f => ({ name: f.name, modified: f.modified }));
});
check('Idempotencia: 2ª corrida no vuelve a marcar modified',
  idemp.every(x => x.modified === false),
  JSON.stringify(idemp));
await pageA.close();

// ─────────────────────────────── B) botón bulkClear ───────────────────────────
const pageB = await openPage();
await pageB.evaluate((files) => {
  const api = window.__bulkAuth;
  files.forEach((f, i) => {
    const key = `qa-${i}`;
    api.editorState.files[key] = {
      name: f.name,
      raw: JSON.parse(JSON.stringify(f.raw)),
      rows: api.buildRows ? api.buildRows(f.raw) : [],
      modified: false,
    };
  });
  api.editorState.activeFile = Object.keys(api.editorState.files)[0]; // 11492424
  // Autoaceptar confirmaciones
  api.setConfirmDialogStub(async () => true);
}, rawJsons);

// B1) Sin filas seleccionadas → toast warn, no cambios.
const noSel = await pageB.evaluate(async () => {
  const api = window.__bulkAuth;
  api.editorState.selectedRows.clear();
  const f = api.editorState.files[api.editorState.activeFile];
  const antes = f.rows.length;
  await api.bulkClear();
  const changed = f.rows.filter(r => r.current !== r.original).length;
  return { antes, changed };
});
check('bulkClear sin selección no modifica nada', noSel.changed === 0);

// B2) Selecciono N filas y las vacío.
const b2 = await pageB.evaluate(async () => {
  const api = window.__bulkAuth;
  const f = api.editorState.files[api.editorState.activeFile];
  // Selecciono las primeras 5 filas no vacías.
  const toSelect = f.rows.filter(r => r.current != null).slice(0, 5);
  api.editorState.selectedRows.clear();
  toSelect.forEach(r => api.editorState.selectedRows.add(`${r.tipo}__${r.idx}`));
  const originals = toSelect.map(r => ({ tipo: r.tipo, idx: r.idx, original: r.original, antes: r.current }));
  await api.bulkClear();
  const after = toSelect.map(r => {
    const upd = f.rows.find(x => x.tipo === r.tipo && x.idx === r.idx);
    const rawVal = f.raw.usuarios[0].servicios[r.tipo][r.idx].numAutorizacion;
    return { tipo: r.tipo, idx: r.idx, current: upd.current, original: upd.original, rawNum: rawVal };
  });
  return { originals, after, modified: f.modified, selSize: api.editorState.selectedRows.size };
});
console.log('\n=== bulkClear 5 filas ===');
console.log(JSON.stringify(b2.after, null, 2));
check('bulkClear: filas seleccionadas quedan con current=null', b2.after.every(r => r.current === null));
check('bulkClear: raw.numAutorizacion queda en null en cada item', b2.after.every(r => r.rawNum === null));
check('bulkClear: row.original NO fue tocado', b2.after.every((r, i) => r.original === b2.originals[i].original));
check('bulkClear: archivo marcado como modified', b2.modified === true);
check('bulkClear: selectedRows se limpia tras aplicar', b2.selSize === 0);

// B3) Luego bulkReset debería restaurar los valores.
const b3 = await pageB.evaluate(async () => {
  const api = window.__bulkAuth;
  const f = api.editorState.files[api.editorState.activeFile];
  const toSel = f.rows.filter(r => r.current === null && r.original != null).slice(0, 5);
  api.editorState.selectedRows.clear();
  toSel.forEach(r => api.editorState.selectedRows.add(`${r.tipo}__${r.idx}`));
  api.bulkReset();
  return toSel.map(r => {
    const upd = f.rows.find(x => x.tipo === r.tipo && x.idx === r.idx);
    return { tipo: r.tipo, idx: r.idx, current: upd.current, original: upd.original };
  });
});
check('bulkReset tras bulkClear restaura current === original',
  b3.every(r => r.current === r.original), JSON.stringify(b3.slice(0,2)));

// B4) Ejecutar bulkClear con confirmación RECHAZADA → no debe cambiar nada.
const b4 = await pageB.evaluate(async () => {
  const api = window.__bulkAuth;
  api.setConfirmDialogStub(async () => false);  // el usuario cancela
  const f = api.editorState.files[api.editorState.activeFile];
  const toSel = f.rows.filter(r => r.current != null).slice(0, 3);
  api.editorState.selectedRows.clear();
  toSel.forEach(r => api.editorState.selectedRows.add(`${r.tipo}__${r.idx}`));
  const before = toSel.map(r => ({ tipo: r.tipo, idx: r.idx, current: r.current }));
  await api.bulkClear();
  const after = toSel.map(r => {
    const u = f.rows.find(x => x.tipo === r.tipo && x.idx === r.idx);
    return { tipo: r.tipo, idx: r.idx, current: u.current };
  });
  return { before, after, selStillSet: api.editorState.selectedRows.size > 0 };
});
check('bulkClear con confirm=NO no modifica current',
  b4.after.every((r, i) => r.current === b4.before[i].current));
check('bulkClear con confirm=NO conserva la selección', b4.selStillSet === true);

await pageB.close();
await browser.close();

console.log('\n=== Resultados QA ===');
console.log(log.join('\n'));
console.log(`\nPass: ${pass}  Fail: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
