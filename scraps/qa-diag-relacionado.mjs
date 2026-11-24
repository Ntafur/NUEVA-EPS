// QA del ajuste "codDiagnosticoRelacionado* = null cuando duplica al principal".
// Carga el HTML real en Chromium y ejecuta applyOtrosAjustes contra los 3 RIPS
// provistos por el usuario (11492424, 11492432, 11492418).

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

const rawJsons = FILES.map(p => ({ name: p.split('/').pop(), raw: JSON.parse(readFileSync(p, 'utf-8')) }));

let pass = 0, fail = 0;
const log = [];
function check(name, cond, info) {
  if (cond) { pass++; log.push(`  ✓ ${name}`); }
  else      { fail++; log.push(`  ✗ ${name}${info ? `\n      ${info}` : ''}`); }
}

// Inventario de duplicados ANTES de ejecutar el ajuste. Nos sirve de valor
// esperado para la comparación posterior.
function inventariarDuplicados(files) {
  const REL_KEYS = ['codDiagnosticoRelacionado','codDiagnosticoRelacionado1','codDiagnosticoRelacionado2','codDiagnosticoRelacionado3'];
  const TIPOS = ['consultas','procedimientos','medicamentos','otrosServicios','urgencias','hospitalizacion'];
  const casos = [];
  files.forEach(({ name, raw }) => {
    (raw.usuarios || []).forEach((u, uIdx) => {
      TIPOS.forEach(tipo => {
        const items = (u.servicios || {})[tipo];
        if (!Array.isArray(items)) return;
        items.forEach((it, idx) => {
          const princ = it?.codDiagnosticoPrincipal;
          if (princ == null) return;
          REL_KEYS.forEach(k => {
            if (!(k in it)) return;
            if (it[k] === null) return;
            if (String(it[k]).trim().toUpperCase() === String(princ).trim().toUpperCase()) {
              casos.push({ file: name, uIdx, tipo, idx, key: k, princ, rel: it[k] });
            }
          });
        });
      });
    });
  });
  return casos;
}

const dupPre = inventariarDuplicados(rawJsons);
console.log('\n=== Duplicados detectados en los RIPS ANTES del ajuste ===');
dupPre.forEach(c => console.log(` · ${c.file} / u${c.uIdx} / ${c.tipo}[${c.idx}].${c.key}="${c.rel}" (= principal "${c.princ}")`));
check('Al menos un duplicado presente en los RIPS provistos', dupPre.length > 0);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('pageerror', err => console.error('PAGE ERROR:', err.message));
page.on('console', msg => { if (msg.type() === 'error') console.error('CONSOLE ERROR:', msg.text()); });

// Stub de flatpickr (CDN no disponible offline).
await page.addInitScript(() => {
  const fp = function () { return { destroy(){}, setDate(){}, clear(){} }; };
  fp.l10ns = { es: {} };
  window.flatpickr = fp;
});

await page.goto(HTML, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__bulkAuth, null, { timeout: 10000 });

// Inyectar los 3 RIPS en state.files.
await page.evaluate((files) => {
  const api = window.__bulkAuth;
  files.forEach((f, i) => {
    const key = `qa-${i}`;
    api.editorState.files[key] = {
      name: f.name,
      raw: f.raw,
      rows: api.buildRows ? api.buildRows(f.raw) : [],
      modified: false,
    };
  });
  // Habilita activeFile para que renderMain no caiga en la rama vacía.
  api.editorState.activeFile = Object.keys(api.editorState.files)[0];
}, rawJsons);

// Ejecutar applyOtrosAjustes y traer el snapshot resultante.
const result = await page.evaluate(() => {
  const api = window.__bulkAuth;
  api.applyOtrosAjustes();
  // Devuelve los 3 raws post-ajuste.
  return Object.values(api.editorState.files).map(f => ({ name: f.name, raw: f.raw, modified: f.modified }));
});
await browser.close();

// Verificar que cada duplicado previo quedó en null.
const stillDup = [];
const nulled = [];
dupPre.forEach(c => {
  const file = result.find(r => r.name === c.file);
  const item = file.raw.usuarios[c.uIdx].servicios[c.tipo][c.idx];
  if (item[c.key] === null) nulled.push(c);
  else stillDup.push({ ...c, actual: item[c.key] });
});
console.log('\n=== Después del ajuste ===');
nulled.forEach(c => console.log(` ✓ ${c.file} / u${c.uIdx} / ${c.tipo}[${c.idx}].${c.key} ahora es null (antes "${c.rel}")`));
stillDup.forEach(c => console.log(` ✗ ${c.file} / u${c.uIdx} / ${c.tipo}[${c.idx}].${c.key} sigue "${c.actual}"`));
check('Cada duplicado previo quedó en null', stillDup.length === 0, stillDup.length ? `${stillDup.length} casos sin nulificar` : '');

// Verificar que el principal NO fue tocado.
let principalIntacto = true;
let principalErr = null;
dupPre.forEach(c => {
  const file = result.find(r => r.name === c.file);
  const item = file.raw.usuarios[c.uIdx].servicios[c.tipo][c.idx];
  if (item.codDiagnosticoPrincipal !== c.princ) {
    principalIntacto = false;
    principalErr = `${c.file} / ${c.tipo}[${c.idx}]: era "${c.princ}", ahora "${item.codDiagnosticoPrincipal}"`;
  }
});
check('codDiagnosticoPrincipal NO fue modificado', principalIntacto, principalErr);

// Verificar que relacionados NO duplicados se mantuvieron intactos.
// Caminamos los 3 raws y comparamos con el original.
const originalMap = Object.fromEntries(rawJsons.map(f => [f.name, f]));
let colateralOk = true;
let colateralErr = null;
const REL_KEYS = ['codDiagnosticoRelacionado','codDiagnosticoRelacionado1','codDiagnosticoRelacionado2','codDiagnosticoRelacionado3'];
const TIPOS = ['consultas','procedimientos','medicamentos','otrosServicios','urgencias','hospitalizacion'];
result.forEach(r => {
  const orig = originalMap[r.name].raw;
  (r.raw.usuarios || []).forEach((u, uIdx) => {
    TIPOS.forEach(tipo => {
      const items = (u.servicios || {})[tipo];
      if (!Array.isArray(items)) return;
      items.forEach((it, idx) => {
        const origIt = orig.usuarios?.[uIdx]?.servicios?.[tipo]?.[idx];
        if (!origIt) return;
        REL_KEYS.forEach(k => {
          if (!(k in origIt)) return;
          const origVal = origIt[k];
          const newVal = it[k];
          const princ = origIt.codDiagnosticoPrincipal;
          const esDup = origVal != null && princ != null &&
            String(origVal).trim().toUpperCase() === String(princ).trim().toUpperCase();
          if (esDup) {
            // Ya se cubre arriba; no re-verifiques colateral.
            return;
          }
          if (newVal !== origVal) {
            colateralOk = false;
            colateralErr = `${r.name} / ${tipo}[${idx}].${k} cambió "${origVal}" → "${newVal}" (no era duplicado)`;
          }
        });
      });
    });
  });
});
check('Relacionados NO duplicados se mantuvieron sin cambios', colateralOk, colateralErr);

// Confirmar que el valor nulificado es null literal (no la cadena "null").
// Lo verificamos serializando a JSON y buscando el patrón.
if (nulled.length) {
  const file = result.find(r => r.name === nulled[0].file);
  const json = JSON.stringify(file.raw, null, 2);
  check('El valor nulificado se serializa como `null` sin comillas',
    /"codDiagnosticoRelacionado"\s*:\s*null|"codDiagnosticoRelacionado1"\s*:\s*null|"codDiagnosticoRelacionado2"\s*:\s*null|"codDiagnosticoRelacionado3"\s*:\s*null/.test(json));
}

// Idempotencia: ejecutar una segunda vez no debe nulificar nada ni marcar el archivo como modificado adicionalmente.
const browser2 = await chromium.launch({ args: ['--no-sandbox'] });
const page2 = await browser2.newContext().then(c => c.newPage());
await page2.addInitScript(() => {
  const fp = function () { return { destroy(){}, setDate(){}, clear(){} }; };
  fp.l10ns = { es: {} };
  window.flatpickr = fp;
});
await page2.goto(HTML, { waitUntil: 'domcontentloaded' });
await page2.waitForFunction(() => !!window.__bulkAuth, null, { timeout: 10000 });
await page2.evaluate((files) => {
  const api = window.__bulkAuth;
  files.forEach((f, i) => {
    api.editorState.files[`qa-${i}`] = {
      name: f.name, raw: JSON.parse(JSON.stringify(f.raw)),
      rows: api.buildRows ? api.buildRows(f.raw) : [], modified: false,
    };
  });
  api.editorState.activeFile = Object.keys(api.editorState.files)[0];
}, rawJsons);
const idempot = await page2.evaluate(() => {
  const api = window.__bulkAuth;
  // Primera corrida
  api.applyOtrosAjustes();
  const after1 = Object.values(api.editorState.files).map(f => ({ name: f.name, mod1: f.modified }));
  // Resetear "modified" para medir si la 2a corrida la vuelve a mover
  Object.values(api.editorState.files).forEach(f => f.modified = false);
  // Segunda corrida
  api.applyOtrosAjustes();
  const after2 = Object.values(api.editorState.files).map(f => ({ name: f.name, mod2: f.modified }));
  return after1.map((a, i) => ({ ...a, ...after2[i] }));
});
await browser2.close();
console.log('\n=== Idempotencia ===');
console.log(JSON.stringify(idempot, null, 2));
check('2ª corrida no vuelve a marcar como modificado (idempotente)',
  idempot.every(x => x.mod2 === false));

console.log('\n=== Resultados QA ===');
console.log(log.join('\n'));
console.log(`\nPass: ${pass}  Fail: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
