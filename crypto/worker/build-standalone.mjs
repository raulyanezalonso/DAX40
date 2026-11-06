// Genera crypto/altcoin-tracker.html: una sola página con rules.js y data/bundle.js embebidos
// (sirve para abrirla con doble clic, enviarla al móvil o publicarla como artefacto; sin servidor).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const rules = readFileSync(join(ROOT, 'rules.js'), 'utf8');
const bundle = readFileSync(join(ROOT, 'data', 'bundle.js'), 'utf8');
const safe = s => s.replace(/<\/script/gi, '<\\/script');
// reemplazo por función: una cadena de reemplazo interpretaría $&, $' o $` presentes en los datos
html = html.replace('<script src="rules.js"></script>', () => '<script>' + safe(rules) + '</script>')
           .replace('<script src="data/bundle.js"></script>', () => '<script>' + safe(bundle) + '</script>');
// Página autónoma: sin esqueleto propio (lo pone el host al publicar; un navegador lo tolera igual)
html = html.replace(/^<!DOCTYPE html>\s*<html lang="es">\s*<head>\s*<meta charset="utf-8">\s*<meta name="viewport" content="width=device-width, initial-scale=1">\s*/i, '')
           .replace('<meta name="viewport" content="width=device-width, initial-scale=1">', '')
           .replace(/<\/head>\s*<body>/i, '').replace(/<\/body>\s*<\/html>\s*$/i, '');
html = html.replace('<title>Altcoin Tracker</title>', '<meta charset="utf-8">\n<title>Altcoin Tracker</title>\n<meta name="claude:viewport-fit-sides" content="cover">');
// Ajustes de contrato: color-scheme, márgenes laterales seguros, cabecera fija con safe-area, sin alert/confirm
html = html.replace(':root { --bg:#020617;', ':root { color-scheme:dark; --bg:#020617;')
           .replace('main { max-width:1500px; margin:0 auto; padding:14px 16px 80px; }', 'main { max-width:1500px; margin:0 auto; padding-block:14px 80px; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); }')
           .replace('header { position:sticky; top:0;', 'body::before { content:""; position:fixed; inset:0 0 auto; height:env(safe-area-inset-top, 0px); z-index:10; background:#020617; }\n  header { position:sticky; top:env(safe-area-inset-top, 0px);')
           .replace('border-bottom:1px solid var(--line); padding:10px 16px; display:flex;', 'border-bottom:1px solid var(--line); padding-block:10px; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); display:flex;')
           .replace("return alert('Indica importe y precio');", "return toast('Indica importe y precio');")
           .replace("if (confirm('¿Borrar el registro local de compras?')) { LS.set('compras',[]); build(); renderAll(); }", "LS.set('compras',[]); build(); renderAll(); toast('Registro de compras borrado');")
           .replace("$('#live-status').textContent = 'sin datos en vivo ('+e.message+') · usando snapshot';", "$('#live-status').textContent = 'precios en vivo no disponibles en esta vista · snapshot del worker';")
           .replace("function closeDrawer(){", "function toast(m){ let t=document.getElementById('toast'); if(!t){ t=document.createElement('div'); t.id='toast'; t.style.cssText='position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:#16283f;color:#e2e8f0;border:1px solid rgba(56,189,248,.5);border-radius:10px;padding:10px 14px;font-size:13px;z-index:50'; document.body.appendChild(t);} t.textContent=m; t.hidden=false; clearTimeout(t._h); t._h=setTimeout(()=>{t.hidden=true;},2500); }\nfunction closeDrawer(){");
writeFileSync(join(ROOT, 'altcoin-tracker.html'), html);
console.log('altcoin-tracker.html:', Math.round(html.length / 1024), 'kB');
