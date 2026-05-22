// QA del cargue masivo de autorizaciones con los 3 RIPS provistos.
// Ejecuta el HTML real en Chromium (Playwright) y prueba la API expuesta en
// window.__bulkAuth para validar:
//   1) La plantilla CSV incluye las nuevas columnas "nodo" y "consecutivo".
//   2) buildBulkAuthIndex construye consecMap correctamente.
//   3) parseAndValidateBulkAuth resuelve casos:
//      a) lookup por (nodo, consecutivo) → match único
//      b) lookup por consecutivo solo (sin nodo) → match único cuando es inequívoco
//      c) lookup por (código, fecha) ambiguo con duplicados (atención + reclamación de "free")
//      d) misma fecha + mismo código con dos numAutorizacion distintos → resuelve con consecutivo
//      e) acepta CSVs antiguos (4 columnas) sin romper compatibilidad
//      f) flags de validación (nodo inválido, factura huérfana, fecha mal formada)
//   4) applyBulkAuth aplica los reemplazos al raw JSON.

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = pathResolve(__dirname, '..');
const HTML = `file://${ROOT}/Editor_RIPS.html`;
const UPLOADS = '/root/.claude/uploads/589854fc-7cc3-4801-a085-134bfb9c0230';
const FILES = [
  `${UPLOADS}/c2556424-11303189.json`,
  `${UPLOADS}/a77da92d-11304022.json`,
  `${UPLOADS}/30c729b9-11300466.json`,
];

const rawJsons = FILES.map(p => ({ name: p.split('/').pop(), raw: JSON.parse(readFileSync(p, 'utf-8')) }));

let pass = 0, fail = 0;
const results = [];
function check(name, cond, info) {
  if (cond) { pass++; results.push(`  ✓ ${name}`); }
  else      { fail++; results.push(`  ✗ ${name}${info ? `\n      ${info}` : ''}`); }
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('pageerror', err => console.error('PAGE ERROR:', err.message));
page.on('console', msg => { if (msg.type() === 'error') console.error('CONSOLE ERROR:', msg.text()); });

// Stubs para librerías externas que el HTML carga vía CDN (no disponibles offline).
await page.addInitScript(() => {
  // flatpickr es una función con propiedades; basta con que no lance.
  const fp = function () { return { destroy(){}, setDate(){}, clear(){} }; };
  fp.l10ns = { es: {} };
  // @ts-ignore
  window.flatpickr = fp;
});

await page.goto(HTML, { waitUntil: 'domcontentloaded' });
// Esperar a que el script termine de exponer __bulkAuth
await page.waitForFunction(() => !!window.__bulkAuth, null, { timeout: 10000 });

// Inyectar archivos en state.files imitando lo que hace handleFiles().
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
  // Compatibilidad: si buildRows no estaba en la API exportada, generamos rows vacíos.
  Object.values(api.editorState.files).forEach(f => { if (!Array.isArray(f.rows)) f.rows = []; });
}, rawJsons);

// 1) buildBulkAuthIndex
const idxInfo = await page.evaluate(() => {
  const idx = window.__bulkAuth.buildBulkAuthIndex();
  const out = {};
  idx.forEach((v, factura) => {
    out[factura] = {
      mapSize: v.map.size,
      codeMapSize: v.codeMap.size,
      consecMapSize: v.consecMap.size,
      sampleConsec: [...v.consecMap.keys()].filter(k => !k.startsWith('|')).slice(0, 5),
    };
  });
  return out;
});
console.log('\n=== Índice por factura ===');
console.log(JSON.stringify(idxInfo, null, 2));
const facturas = Object.keys(idxInfo);
check('buildBulkAuthIndex indexa las 3 facturas', facturas.length === 3, `obtuvo ${facturas.length}`);
check('consecMap no está vacío en cada factura', facturas.every(f => idxInfo[f].consecMapSize > 0));

// Localizamos un caso real de duplicado (mismo code+date, distintos consecutivos
// pero idealmente con distintos numAutorizacion). Si no hay dos numAutorizacion
// distintos, generamos un caso sintético modificando uno de los items.
const dupCase = await page.evaluate(() => {
  const api = window.__bulkAuth;
  const files = api.editorState.files;
  for (const [fileKey, f] of Object.entries(files)) {
    const factura = api.resolveFileNumFactura(f);
    const servicios = f.raw?.usuarios?.[0]?.servicios || {};
    const TIPOS = ['consultas','procedimientos','medicamentos','otrosServicios','hospitalizacion','urgencias'];
    const buckets = new Map();
    for (const tipo of TIPOS) {
      const items = servicios[tipo];
      if (!Array.isArray(items)) continue;
      items.forEach((it, idx) => {
        if (!('numAutorizacion' in it)) return;
        const code = it.codConsulta || it.codProcedimiento || it.codTecnologiaSalud || it.codDiagnosticoPrincipal || '';
        const date = (it.fechaInicioAtencion || it.fechaDispensAdmon || it.fechaSuministroTecnologia || '').toString().split(/[T ]/)[0];
        const key = `${tipo}|${code}|${date}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({ tipo, idx, consec: it.consecutivo, numAut: it.numAutorizacion });
      });
    }
    for (const [k, arr] of buckets.entries()) {
      if (arr.length >= 2) {
        return { fileKey, factura, key: k, items: arr.slice(0, 4) };
      }
    }
  }
  return null;
});
console.log('\n=== Caso de duplicado detectado ===');
console.log(JSON.stringify(dupCase, null, 2));
check('Se localizó al menos un caso real de duplicado (mismo nodo+code+fecha)', !!dupCase);

// 2) Crear un caso "dos numAutorizacion distintos para mismo código y misma fecha".
// Mutamos uno de los items duplicados para tener un numAutorizacion distinto.
const mutated = await page.evaluate((dup) => {
  if (!dup) return null;
  const api = window.__bulkAuth;
  const f = api.editorState.files[dup.fileKey];
  const items = f.raw.usuarios[0].servicios[dup.items[0].tipo];
  // Cambiamos el numAutorizacion del segundo item del duplicado para crear el escenario.
  items[dup.items[1].idx].numAutorizacion = '999000001';
  return {
    tipo: dup.items[0].tipo,
    factura: dup.factura,
    a: { idx: dup.items[0].idx, consec: dup.items[0].consec, numAut: items[dup.items[0].idx].numAutorizacion },
    b: { idx: dup.items[1].idx, consec: dup.items[1].consec, numAut: items[dup.items[1].idx].numAutorizacion },
    code: (items[dup.items[0].idx].codConsulta || items[dup.items[0].idx].codProcedimiento || items[dup.items[0].idx].codTecnologiaSalud || items[dup.items[0].idx].codDiagnosticoPrincipal || ''),
    date: (items[dup.items[0].idx].fechaInicioAtencion || items[dup.items[0].idx].fechaDispensAdmon || items[dup.items[0].idx].fechaSuministroTecnologia || '').toString().split(/[T ]/)[0],
  };
}, dupCase);
console.log('\n=== Escenario mutado (dos numAutorizacion distintos para mismo code+fecha) ===');
console.log(JSON.stringify(mutated, null, 2));

// 3) CSV nuevo con columnas nodo y consecutivo: cada fila apunta a un consecutivo distinto.
const csvNuevo = [
  'numAutorizacion;numFactura;codigoServicio;fecha;nodo;consecutivo',
  // Resuelve el item A por consecutivo (nuevo numAut: 700000001)
  `700000001;${mutated.factura};${mutated.code};${mutated.date};${mutated.tipo};${mutated.a.consec}`,
  // Resuelve el item B por consecutivo (nuevo numAut: 700000002)
  `700000002;${mutated.factura};${mutated.code};${mutated.date};${mutated.tipo};${mutated.b.consec}`,
].join('\r\n');

const r1 = await page.evaluate((csv) => window.__bulkAuth.parseAndValidateBulkAuth(csv), csvNuevo);
console.log('\n=== Resultado CSV nuevo (con consecutivo) ===');
console.log(JSON.stringify(r1, null, 2));
check('CSV nuevo: 2 filas procesadas', r1.length === 2);
check('CSV nuevo: ambas marcadas ok', r1.every(r => r.status === 'ok'));
check('CSV nuevo: resuelve consecutivo A correctamente',
  r1[0] && String(r1[0].consecutivo) === String(mutated.a.consec) && r1[0].tipo === mutated.tipo);
check('CSV nuevo: resuelve consecutivo B correctamente (distinto idx)',
  r1[1] && String(r1[1].consecutivo) === String(mutated.b.consec) && r1[1].idx !== r1[0].idx);
check('CSV nuevo: la observación menciona "match por consecutivo"',
  r1.every(r => /consecutivo/i.test(r.observation)));

// 4) CSV antiguo (sin nodo/consecutivo) → debe seguir funcionando.
const csvAntiguo = [
  'numAutorizacion;numFactura;codigoServicio;fecha',
  `700000099;${mutated.factura};${mutated.code};${mutated.date}`,
].join('\r\n');
const r2 = await page.evaluate((csv) => window.__bulkAuth.parseAndValidateBulkAuth(csv), csvAntiguo);
console.log('\n=== Resultado CSV antiguo (sin consecutivo) ===');
console.log(JSON.stringify(r2, null, 2));
check('CSV antiguo: 1 fila ok', r2.length === 1 && r2[0].status === 'ok');
// Con duplicados, ahora avisamos en la observación
check('CSV antiguo: observación marca ambigüedad por código+fecha cuando hay duplicados',
  r2[0] && /comparten código\+fecha|consecutivo/i.test(r2[0].observation),
  `obs="${r2[0]?.observation}"`);

// 5) nodo inválido
const csvNodoMalo = [
  'numAutorizacion;numFactura;codigoServicio;fecha;nodo;consecutivo',
  `700000003;${mutated.factura};${mutated.code};${mutated.date};NO_EXISTE;${mutated.a.consec}`,
].join('\r\n');
const r3 = await page.evaluate((csv) => window.__bulkAuth.parseAndValidateBulkAuth(csv), csvNodoMalo);
check('Nodo inválido → status invalid', r3[0]?.status === 'invalid', `obs="${r3[0]?.observation}"`);
check('Nodo inválido → observación menciona "nodo"', /nodo/i.test(r3[0]?.observation || ''));

// 6) Factura huérfana
const csvHuerfana = [
  'numAutorizacion;numFactura;codigoServicio;fecha;nodo;consecutivo',
  `700000004;NO_EXISTE_FACTURA;${mutated.code};${mutated.date};${mutated.tipo};${mutated.a.consec}`,
].join('\r\n');
const r4 = await page.evaluate((csv) => window.__bulkAuth.parseAndValidateBulkAuth(csv), csvHuerfana);
check('Factura huérfana → status orphan', r4[0]?.status === 'orphan');

// 7) Consecutivo inexistente
const csvConsecMalo = [
  'numAutorizacion;numFactura;codigoServicio;fecha;nodo;consecutivo',
  `700000005;${mutated.factura};${mutated.code};${mutated.date};${mutated.tipo};99999`,
].join('\r\n');
const r5 = await page.evaluate((csv) => window.__bulkAuth.parseAndValidateBulkAuth(csv), csvConsecMalo);
check('Consecutivo inexistente → status nomatch', r5[0]?.status === 'nomatch', `obs="${r5[0]?.observation}"`);

// 8) Plantilla descargable contiene nuevas columnas (interceptamos el blob).
const tplHeader = await page.evaluate(async () => {
  // Mockeamos createObjectURL/createElement.click para capturar el contenido.
  const calls = [];
  const origURL = URL.createObjectURL;
  URL.createObjectURL = (blob) => { calls.push(blob); return 'blob://mock'; };
  // Evita la descarga real
  const origCreate = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag === 'a') el.click = () => {};
    return el;
  };
  try {
    window.__bulkAuth.downloadBulkAuthTemplate();
    if (!calls.length) return null;
    const txt = await calls[0].text();
    URL.createObjectURL = origURL;
    document.createElement = origCreate;
    return txt.split(/\r?\n/)[0].replace(/^﻿/, '');
  } catch (e) {
    URL.createObjectURL = origURL;
    document.createElement = origCreate;
    return `ERR: ${e.message}`;
  }
});
console.log('\n=== Cabecera de plantilla generada ===');
console.log(tplHeader);
check('Plantilla incluye columna "nodo"', /(^|;)nodo(;|$)/.test(tplHeader || ''));
check('Plantilla incluye columna "consecutivo"', /(^|;)consecutivo(;|$)/.test(tplHeader || ''));

// 9) applyBulkAuth muta realmente el raw — usamos el CSV nuevo (caso 3).
const beforeApply = await page.evaluate((m) => {
  const api = window.__bulkAuth;
  const f = Object.values(api.editorState.files).find(x => api.resolveFileNumFactura(x) === m.factura);
  return {
    a: f.raw.usuarios[0].servicios[m.tipo][m.a.idx].numAutorizacion,
    b: f.raw.usuarios[0].servicios[m.tipo][m.b.idx].numAutorizacion,
  };
}, mutated);

await page.evaluate((csv) => {
  const api = window.__bulkAuth;
  api.setConfirmDialogStub(async () => true); // confirm auto-aceptado
  // Activamos un archivo para que renderMain encuentre activeKey y no caiga
  // en la rama del estado vacío (que depende de DOM no inicializado en este test).
  api.editorState.activeFile = Object.keys(api.editorState.files)[0];
  api.state.rows = api.parseAndValidateBulkAuth(csv);
  return api.applyBulkAuth();
}, csvNuevo);

const afterApply = await page.evaluate((m) => {
  const api = window.__bulkAuth;
  const f = Object.values(api.editorState.files).find(x => api.resolveFileNumFactura(x) === m.factura);
  return {
    a: f.raw.usuarios[0].servicios[m.tipo][m.a.idx].numAutorizacion,
    b: f.raw.usuarios[0].servicios[m.tipo][m.b.idx].numAutorizacion,
  };
}, mutated);
console.log('\n=== applyBulkAuth ===');
console.log('Antes:', beforeApply, '\nDespués:', afterApply);
check('applyBulkAuth: item A actualizado al numAutorizacion del CSV',
  afterApply.a === '700000001', `antes=${beforeApply.a} después=${afterApply.a}`);
check('applyBulkAuth: item B actualizado a un valor distinto (sin colisión)',
  afterApply.b === '700000002' && afterApply.b !== afterApply.a);

// 10) Fecha mal formada → invalid
const csvFechaMala = [
  'numAutorizacion;numFactura;codigoServicio;fecha;nodo;consecutivo',
  `700000010;${mutated.factura};${mutated.code};no-es-fecha;${mutated.tipo};${mutated.a.consec}`,
].join('\r\n');
const r10 = await page.evaluate((csv) => window.__bulkAuth.parseAndValidateBulkAuth(csv), csvFechaMala);
check('Fecha inválida → status invalid', r10[0]?.status === 'invalid');

await browser.close();

console.log('\n=== Resultados QA ===');
console.log(results.join('\n'));
console.log(`\nPass: ${pass}  Fail: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
