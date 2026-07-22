/**
 * CatonLandingPage.tsx — traducción 1:1 del mockup aprobado caton-landing-v7-ojo.html
 * Inline styles y CSS inyectado. Sin Tailwind.
 */
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

const CSS = `
/* ---------- RESET + VARS ---------- */
:root {
  --papel: #F5F1E8;
  --papel-2: #EFEAE0;
  --tinta: #0A2E22;
  --tinta-70: rgba(10,46,34,0.72);
  --tinta-45: rgba(10,46,34,0.48);
  --linea: rgba(10,46,34,0.14);
  --linea-oro: rgba(150,113,42,0.4);
  --sello: #96712A;
  --sello-fuerte: #7C5C1F;
  --hallazgo: #B0392C;
  --ok: #1E7F4E;
  --pantalla: #0A241A;
  --pantalla-linea: rgba(237,232,220,0.10);
  --pantalla-texto: #EDE8DC;
  --pantalla-texto-60: rgba(237,232,220,0.6);
  --pantalla-texto-40: rgba(237,232,220,0.4);
  --oro-claro: #E3C57E;
  --ok-claro: #5FBF8C;
  --rojo-claro: #E4756A;
}
#caton-landing * { margin:0; padding:0; box-sizing:border-box; }
#caton-landing { scroll-behavior:smooth; background:var(--papel); color:var(--tinta); font-family:'Inter',sans-serif; -webkit-font-smoothing:antialiased; overflow-x:hidden; }
#caton-landing ::selection { background:var(--sello); color:var(--papel); }
#caton-landing .roman { font-family:'Marcellus',serif; }

/* ---------- NAV ---------- */
#caton-landing nav {
  position:fixed; top:0; left:0; right:0; z-index:100;
  display:flex; align-items:center; justify-content:space-between;
  padding:18px 48px;
  background:rgba(245,241,232,0.9);
  backdrop-filter:blur(8px);
  border-bottom:1px solid var(--linea);
}
#caton-landing .logo {
  font-family:'Marcellus',serif; font-size:24px; letter-spacing:0.34em;
  color:var(--tinta); text-transform:uppercase; line-height:1;
}
#caton-landing .logo .o-gold { color:var(--sello); }
#caton-landing .nav-right { display:flex; align-items:center; gap:32px; }
#caton-landing .nav-link {
  font-family:'Inter'; font-weight:600; font-size:12px; letter-spacing:0.16em;
  color:var(--tinta-70); text-decoration:none; text-transform:uppercase;
  transition:color .2s;
}
#caton-landing .nav-link:hover { color:var(--sello-fuerte); }
#caton-landing .btn-ingresar {
  font-family:'Marcellus',serif; font-size:14px; letter-spacing:0.18em; text-transform:uppercase;
  color:var(--papel); background:var(--tinta);
  padding:12px 26px; border:none; cursor:pointer;
  transition:background .2s;
}
#caton-landing .btn-ingresar:hover { background:#123D2E; }

/* ---------- HERO ---------- */
#caton-landing .hero {
  min-height:100vh;
  display:grid; grid-template-columns:0.92fr 1.08fr;
  align-items:center; gap:52px;
  padding:140px 56px 90px;
  position:relative;
}
#caton-landing .hero::before {
  content:'SPQR·CLXXXIV';
  position:absolute; right:-40px; bottom:-30px;
  font-family:'Marcellus',serif; font-size:190px; letter-spacing:0.08em;
  color:rgba(10,46,34,0.032);
  pointer-events:none; white-space:nowrap; line-height:1;
}
#caton-landing .hero-copy { position:relative; z-index:2; }
#caton-landing .eyebrow {
  display:inline-flex; align-items:center; gap:12px;
  font-family:'Inter'; font-weight:600; font-size:11px; letter-spacing:0.24em; text-transform:uppercase;
  color:var(--sello-fuerte);
  padding:0 0 14px; margin-bottom:30px;
  border-bottom:1px solid var(--linea-oro);
}
#caton-landing .eyebrow .dot { width:6px; height:6px; background:var(--hallazgo); border-radius:50%; animation:c-pulse 1.6s infinite; }
@keyframes c-pulse { 0%,100%{opacity:1} 50%{opacity:.25} }

#caton-landing h1.roman {
  font-size:clamp(42px,4.4vw,66px); font-weight:400;
  line-height:1.06; letter-spacing:0.015em; color:var(--tinta);
}
#caton-landing h1 .gold { color:var(--sello); }
#caton-landing .hero-sub {
  margin-top:26px; max-width:460px;
  font-size:16px; line-height:1.7; color:var(--tinta-70);
}
#caton-landing .hero-ctas { display:flex; gap:16px; margin-top:40px; }
#caton-landing .btn-primary {
  font-family:'Marcellus',serif; font-size:16px; letter-spacing:0.14em; text-transform:uppercase;
  background:var(--tinta); color:var(--papel);
  padding:17px 36px; border:none; cursor:pointer;
  box-shadow:inset 0 2px 0 var(--sello);
  transition:background .2s,transform .2s;
}
#caton-landing .btn-primary:hover { background:#123D2E; transform:translateY(-1px); }
#caton-landing .btn-ghost {
  font-family:'Marcellus',serif; font-size:16px; letter-spacing:0.14em; text-transform:uppercase;
  background:transparent; color:var(--tinta);
  padding:17px 36px; border:none; border-bottom:1px solid var(--linea);
  cursor:pointer; transition:border-color .2s,color .2s;
}
#caton-landing .btn-ghost:hover { border-color:var(--sello); color:var(--sello-fuerte); }

/* ---------- GRAFO ---------- */
#caton-landing .grafo-panel {
  position:relative; z-index:2;
  background:var(--pantalla);
  border:1px solid rgba(10,46,34,0.25);
  box-shadow:0 30px 70px rgba(10,46,34,0.22);
}
#caton-landing .grafo-bar {
  display:flex; align-items:center; justify-content:space-between;
  padding:13px 18px; border-bottom:1px solid var(--pantalla-linea);
}
#caton-landing .grafo-bar .title { font-family:'IBM Plex Mono'; font-size:11px; letter-spacing:0.18em; color:var(--pantalla-texto-40); text-transform:uppercase; }
#caton-landing .grafo-bar .live { display:flex; align-items:center; gap:8px; font-family:'IBM Plex Mono'; font-size:11px; color:var(--ok-claro); letter-spacing:0.14em; }
#caton-landing .grafo-bar .live::before { content:''; width:7px; height:7px; border-radius:50%; background:var(--ok-claro); animation:c-pulse 1.4s infinite; }
#caton-landing .grafo-canvas { position:relative; }
#caton-landing .grafo-canvas svg { display:block; width:100%; height:auto; }
#caton-landing .dotfield { fill:rgba(237,232,220,0.06); }

/* aristas */
#caton-landing .edge {
  stroke:rgba(237,232,220,0.28); stroke-width:1;
  stroke-dasharray:260; stroke-dashoffset:260;
  transition:stroke-dashoffset .7s ease,stroke .4s;
}
#caton-landing .edge.draw { stroke-dashoffset:0; }
#caton-landing .edge.hot { stroke:var(--oro-claro); stroke-width:1.4; }
#caton-landing .edge.red { stroke:var(--rojo-claro); stroke-width:1.4; }

/* nodos */
#caton-landing .node { opacity:0; transform:scale(.5); transform-origin:center; transform-box:fill-box; transition:opacity .45s ease,transform .45s cubic-bezier(.2,.9,.3,1.3); }
#caton-landing .node.in { opacity:1; transform:scale(1); }
#caton-landing .node circle.core { fill:var(--pantalla); stroke:rgba(237,232,220,0.75); stroke-width:1.4; }
#caton-landing .node.gold circle.core { stroke:var(--oro-claro); }
#caton-landing .node.red circle.core { stroke:var(--rojo-claro); }
#caton-landing .node circle.halo { fill:none; stroke:rgba(237,232,220,0.18); stroke-width:1; }
#caton-landing .node.gold circle.halo { stroke:rgba(227,197,126,0.3); }
#caton-landing .node.red circle.halo { stroke:rgba(228,117,106,0.35); }
#caton-landing .node.alert circle.halo { animation:c-halo 1.2s infinite; }
@keyframes c-halo { 0%{transform:scale(1);opacity:1} 100%{transform:scale(1.8);opacity:0} }
#caton-landing .node .glyph { font-family:'Marcellus',serif; font-size:11px; fill:var(--pantalla-texto); text-anchor:middle; }
#caton-landing .node .lbl { font-family:'IBM Plex Mono'; font-size:9.5px; fill:var(--pantalla-texto-60); text-anchor:middle; letter-spacing:0.04em; }
#caton-landing .node .lbl2 { font-family:'IBM Plex Mono'; font-size:9px; fill:var(--pantalla-texto-40); text-anchor:middle; }
#caton-landing .node.red .lbl { fill:var(--rojo-claro); }

/* tracer */
#caton-landing .tracer { fill:var(--oro-claro); opacity:0; filter:drop-shadow(0 0 4px rgba(227,197,126,0.9)); }
#caton-landing .tracer.red { fill:var(--rojo-claro); filter:drop-shadow(0 0 4px rgba(228,117,106,0.9)); }

/* sello */
#caton-landing .stamp {
  position:absolute; left:50%; top:44%;
  transform:translate(-50%,-50%) rotate(-5deg) scale(2.2);
  opacity:0;
  border:2px solid var(--oro-claro);
  color:var(--oro-claro);
  font-family:'Marcellus',serif; font-size:20px; letter-spacing:0.22em; text-transform:uppercase;
  padding:14px 28px; text-align:center; line-height:1.5;
  background:rgba(10,36,26,0.82);
  pointer-events:none;
  transition:opacity .18s ease,transform .18s cubic-bezier(.2,.9,.3,1.2);
}
#caton-landing .stamp small { display:block; font-family:'IBM Plex Mono'; font-size:10px; letter-spacing:0.14em; color:var(--pantalla-texto-60); }
#caton-landing .stamp.in { opacity:1; transform:translate(-50%,-50%) rotate(-5deg) scale(1); }

/* grafo log */
#caton-landing .grafo-log {
  border-top:1px solid var(--pantalla-linea);
  padding:10px 18px; height:84px; overflow:hidden;
  font-family:'IBM Plex Mono'; font-size:11.5px; line-height:2;
  display:flex; flex-direction:column; justify-content:flex-end;
}
#caton-landing .log-line { color:var(--pantalla-texto-60); opacity:0; animation:c-rowIn .3s forwards; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#caton-landing .log-line b { color:var(--oro-claro); font-weight:600; }
#caton-landing .log-line.red { color:var(--rojo-claro); }
@keyframes c-rowIn { from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;} }

#caton-landing .grafo-foot {
  display:flex; gap:26px; padding:12px 18px;
  border-top:1px solid var(--pantalla-linea);
  font-family:'IBM Plex Mono'; font-size:11px; letter-spacing:0.1em; color:var(--pantalla-texto-40); text-transform:uppercase;
}
#caton-landing .grafo-foot b { color:var(--oro-claro); font-weight:600; }

/* ---------- TICKER ---------- */
#caton-landing .ticker {
  border-top:1px solid var(--linea); border-bottom:1px solid var(--linea);
  overflow:hidden; padding:16px 0; background:var(--papel-2);
}
#caton-landing .ticker-track {
  display:flex; gap:72px; white-space:nowrap;
  font-family:'Inter'; font-weight:500; font-size:12px; letter-spacing:0.22em; text-transform:uppercase;
  color:var(--tinta-45);
  animation:c-ticker 36s linear infinite;
  width:max-content;
}
#caton-landing .ticker-track b { font-family:'Marcellus',serif; font-size:14px; color:var(--sello-fuerte); font-weight:400; letter-spacing:0.08em; }
@keyframes c-ticker { from{transform:translateX(0);}to{transform:translateX(-50%);} }

/* ---------- PARA QUIÉN ---------- */
#caton-landing .pq-grid {
  display:grid; grid-template-columns:repeat(3,1fr); gap:28px; margin-top:56px;
}
#caton-landing .pq-card {
  padding:40px 32px; border:1px solid var(--linea); position:relative;
  background:var(--papel); transition:border-color .2s,box-shadow .2s;
}
#caton-landing .pq-card:hover { border-color:var(--linea-oro); box-shadow:0 12px 40px rgba(10,46,34,0.08); }
#caton-landing .pq-card::before {
  content:attr(data-num);
  position:absolute; top:-1px; left:28px;
  font-family:'Marcellus',serif; font-size:58px; letter-spacing:-0.02em;
  color:rgba(10,46,34,0.06); line-height:1; pointer-events:none;
}
#caton-landing .pq-icon {
  font-size:28px; margin-bottom:20px; display:block;
}
#caton-landing .pq-card h3 {
  font-family:'Marcellus',serif; font-weight:400; font-size:22px;
  color:var(--tinta); margin-bottom:12px; letter-spacing:0.01em;
}
#caton-landing .pq-tag {
  display:inline-block; margin-bottom:16px;
  font-family:'Inter'; font-weight:600; font-size:10px; letter-spacing:0.22em;
  text-transform:uppercase; color:var(--sello-fuerte);
  background:rgba(150,113,42,0.08); padding:4px 10px;
}
#caton-landing .pq-card p { color:var(--tinta-70); font-size:14.5px; line-height:1.7; }
#caton-landing .pq-features { margin-top:20px; display:flex; flex-direction:column; gap:8px; }
#caton-landing .pq-feature { display:flex; gap:10px; font-size:13.5px; color:var(--tinta-70); }
#caton-landing .pq-feature::before { content:'·'; color:var(--sello); flex-shrink:0; font-size:18px; line-height:1.2; }
@media (max-width:1000px) { #caton-landing .pq-grid { grid-template-columns:1fr; } }

/* ---------- SECTIONS ---------- */
#caton-landing section { padding:110px 64px; position:relative; }
#caton-landing .section-label {
  display:flex; align-items:center; gap:16px;
  font-family:'Inter'; font-weight:600; font-size:11px; letter-spacing:0.3em; text-transform:uppercase;
  color:var(--sello-fuerte); margin-bottom:24px;
}
#caton-landing .section-label::after { content:''; height:1px; width:64px; background:var(--linea-oro); }
#caton-landing h2.roman {
  font-size:clamp(34px,3.6vw,54px); font-weight:400;
  line-height:1.1; max-width:800px; color:var(--tinta);
  letter-spacing:0.01em;
}
#caton-landing .section-sub { margin-top:20px; max-width:560px; color:var(--tinta-70); font-size:16px; line-height:1.7; }

/* METRICS */
#caton-landing .metrics {
  display:grid; grid-template-columns:repeat(4,1fr);
  margin-top:64px;
  border-top:1px solid var(--tinta);
}
#caton-landing .metric { padding:36px 32px 36px 0; border-top:3px double var(--linea); margin-top:6px; }
#caton-landing .metric + .metric { padding-left:32px; border-left:1px solid var(--linea); }
#caton-landing .metric .num {
  font-family:'Marcellus',serif; font-size:clamp(38px,3.4vw,52px);
  color:var(--tinta); line-height:1;
}
#caton-landing .metric .num span { color:var(--sello); }
#caton-landing .metric .lbl {
  margin-top:14px; font-family:'Inter'; font-weight:500; font-size:11px; letter-spacing:0.18em;
  text-transform:uppercase; color:var(--tinta-45); line-height:1.8;
}

/* PIPELINE */
#caton-landing .pipeline {
  margin-top:72px; position:relative;
  display:grid; grid-template-columns:repeat(4,1fr); gap:40px;
  --pline: 0%;
}
#caton-landing .pipeline::before {
  content:''; position:absolute; top:30px; left:2%; right:2%;
  height:1px; background:linear-gradient(90deg,var(--sello) var(--pline,0%),var(--linea) var(--pline,0%));
  transition:background 1s ease;
}
#caton-landing .step { position:relative; padding-top:76px; }
#caton-landing .step .numeral {
  position:absolute; top:0; left:0;
  font-family:'Marcellus',serif; font-size:44px; line-height:60px;
  color:var(--sello); background:var(--papel-2);
  padding-right:18px;
}
#caton-landing .step .s-label { font-family:'Inter'; font-weight:600; font-size:11px; letter-spacing:0.22em; color:var(--sello-fuerte); text-transform:uppercase; }
#caton-landing .step h3 { font-family:'Marcellus',serif; font-weight:400; font-size:23px; margin:10px 0 12px; color:var(--tinta); letter-spacing:0.01em; }
#caton-landing .step p { color:var(--tinta-70); font-size:14.5px; line-height:1.7; }
#caton-landing .step .s-time { margin-top:14px; font-family:'Inter'; font-weight:600; font-size:12.5px; color:var(--sello-fuerte); letter-spacing:0.04em; }

/* VIGILANCIA */
#caton-landing .vigilancia { display:grid; grid-template-columns:0.9fr 1.1fr; gap:56px; align-items:center; }
#caton-landing .terminal {
  background:var(--pantalla);
  border:1px solid rgba(10,46,34,0.25);
  box-shadow:0 30px 70px rgba(10,46,34,0.22);
}
#caton-landing .terminal-bar {
  display:flex; align-items:center; justify-content:space-between;
  padding:13px 18px; border-bottom:1px solid var(--pantalla-linea);
}
#caton-landing .terminal-bar .title { font-family:'IBM Plex Mono'; font-size:11px; letter-spacing:0.18em; color:var(--pantalla-texto-40); text-transform:uppercase; }
#caton-landing .terminal-bar .live { display:flex; align-items:center; gap:8px; font-family:'IBM Plex Mono'; font-size:11px; color:var(--ok-claro); letter-spacing:0.14em; }
#caton-landing .terminal-bar .live::before { content:''; width:7px; height:7px; border-radius:50%; background:var(--ok-claro); animation:c-pulse 1.4s infinite; }
#caton-landing .terminal-body {
  height:340px; overflow:hidden; position:relative;
  padding:18px 18px 0;
  font-family:'IBM Plex Mono'; font-size:12.5px; line-height:2.05;
  color:var(--pantalla-texto);
  mask-image:linear-gradient(to bottom,transparent 0,black 24px,black calc(100% - 12px),transparent 100%);
}
#caton-landing .t-row { display:flex; gap:14px; white-space:nowrap; opacity:0; animation:c-rowIn .35s forwards; }
#caton-landing .t-id { color:var(--pantalla-texto-40); }
#caton-landing .t-ent { color:var(--pantalla-texto-60); overflow:hidden; text-overflow:ellipsis; max-width:220px; }
#caton-landing .t-val { color:var(--pantalla-texto-40); margin-left:auto; }
#caton-landing .t-ok { color:var(--ok-claro); }
#caton-landing .t-flag { color:var(--rojo-claro); font-weight:600; }
#caton-landing .t-action { color:var(--oro-claro); font-weight:600; }
#caton-landing .t-row.flagged { background:rgba(228,117,106,0.08); margin:0 -18px; padding:0 18px; border-left:2px solid var(--rojo-claro); }
#caton-landing .t-row.action  { background:rgba(227,197,126,0.08); margin:0 -18px; padding:0 18px; border-left:2px solid var(--oro-claro); }
#caton-landing .scanline {
  position:absolute; left:0; right:0; height:64px; top:-64px;
  background:linear-gradient(to bottom,transparent,rgba(227,197,126,0.06),transparent);
  animation:c-scan 5.5s linear infinite; pointer-events:none;
}
@keyframes c-scan { from{top:-64px;}to{top:360px;} }
#caton-landing .terminal-foot {
  display:flex; gap:26px; padding:13px 18px;
  border-top:1px solid var(--pantalla-linea);
  font-family:'IBM Plex Mono'; font-size:11px; letter-spacing:0.1em; color:var(--pantalla-texto-40); text-transform:uppercase;
}
#caton-landing .terminal-foot b { color:var(--oro-claro); font-weight:600; }
#caton-landing .vig-puntos { margin-top:36px; display:flex; flex-direction:column; gap:18px; }
#caton-landing .vig-punto { display:flex; gap:16px; align-items:baseline; font-size:15px; color:var(--tinta-70); line-height:1.6; }
#caton-landing .vig-punto .roman { color:var(--sello); font-size:17px; flex-shrink:0; }
#caton-landing .vig-punto b { color:var(--tinta); font-weight:600; }

/* DOCTRINA */
#caton-landing .doctrina {
  text-align:center; padding:130px 64px 150px;
  background:radial-gradient(ellipse 60% 50% at 50% 45%,rgba(201,162,75,0.08),transparent 70%),var(--pantalla);
  color:var(--pantalla-texto);
}
#caton-landing .ojo-wrap { margin:0 auto 52px; width:210px; }
#caton-landing .ojo-wrap svg { display:block; width:100%; height:auto; overflow:visible; }
#caton-landing .ojo-trazo { fill:none; stroke:var(--oro-claro); stroke-width:1.6; }
#caton-landing .ojo-fino  { fill:none; stroke:rgba(227,197,126,0.5); stroke-width:1; }
#caton-landing .ojo-rayo  { stroke:rgba(227,197,126,0.55); stroke-width:1.2; stroke-linecap:round; stroke-dasharray:30; stroke-dashoffset:30; animation:c-rayoIn 1s ease forwards; }
#caton-landing .ojo-rayo:nth-child(odd) { animation-delay:.15s; }
@keyframes c-rayoIn { to{stroke-dashoffset:0;} }
#caton-landing #iris-grp { transition:transform .18s ease-out; }
#caton-landing .iris-tick { stroke:rgba(227,197,126,0.6); stroke-width:1; }
#caton-landing .pupila { fill:var(--pantalla); stroke:var(--oro-claro); stroke-width:1.4; }
#caton-landing .pupila-brillo { fill:var(--oro-claro); }
#caton-landing #ojo-parpado { transform-origin:105px 62px; }
#caton-landing .parpadeo { animation:c-blink 6s infinite; }
@keyframes c-blink {
  0%,94%,100%{transform:scaleY(1);}
  96.5%{transform:scaleY(0.05);}
}
#caton-landing .inscripcion {
  font-family:'Marcellus',serif; font-size:14px; letter-spacing:0.55em;
  color:var(--oro-claro); text-transform:uppercase; margin-bottom:48px;
}
#caton-landing .doctrina blockquote {
  font-family:'Marcellus',serif; font-weight:400;
  font-size:clamp(36px,4.4vw,64px); line-height:1.12;
  max-width:940px; margin:0 auto;
}
#caton-landing .doctrina blockquote .gold { color:var(--oro-claro); }
#caton-landing .doctrina .attr {
  margin-top:42px; color:var(--pantalla-texto-60); font-size:15.5px; max-width:540px;
  margin-left:auto; margin-right:auto; line-height:1.75;
}
#caton-landing .doctrina .sello-linea {
  margin:56px auto 0; width:240px; text-align:center;
  border-top:1px solid rgba(227,197,126,0.35);
  padding-top:18px;
  font-family:'Inter'; font-weight:500; font-size:11px; letter-spacing:0.28em; text-transform:uppercase;
  color:var(--pantalla-texto-60);
}

/* CAPACIDADES */
#caton-landing .caps { display:grid; grid-template-columns:repeat(2,1fr); gap:0 72px; margin-top:56px; max-width:1100px; }
#caton-landing .cap {
  display:flex; gap:18px; align-items:flex-start;
  padding:22px 0; border-bottom:1px solid var(--linea);
  font-size:15px; color:var(--tinta-70); line-height:1.55;
}
#caton-landing .cap .marca { color:var(--sello); font-size:15px; flex-shrink:0; line-height:1.55; }
#caton-landing .cap b { color:var(--tinta); font-weight:600; }

/* CTA FINAL */
#caton-landing .final {
  text-align:center; padding:160px 64px;
  background:var(--papel-2); border-top:1px solid var(--linea);
  position:relative; overflow:hidden;
}
#caton-landing .final::before {
  content:'CATÓN'; position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  font-family:'Marcellus',serif; font-size:300px; letter-spacing:0.1em;
  color:rgba(10,46,34,0.028); pointer-events:none; line-height:1;
}
#caton-landing .final h2 { margin:0 auto; position:relative; }
#caton-landing .final .hero-ctas { justify-content:center; position:relative; }

/* FOOTER */
#caton-landing footer {
  display:flex; justify-content:space-between; align-items:center;
  padding:30px 48px; border-top:1px solid var(--linea);
  font-family:'Inter'; font-weight:500; font-size:11.5px; letter-spacing:0.1em;
  color:var(--tinta-45); background:var(--papel); text-transform:uppercase;
}
#caton-landing footer .logo { font-size:17px; }
#caton-landing footer .logo small { font-family:'Inter'; font-weight:500; letter-spacing:0.14em; font-size:10.5px; color:var(--tinta-45); margin-left:12px; }

/* REVEALS */
#caton-landing .reveal { opacity:0; transform:translateY(22px); transition:opacity .7s ease,transform .7s ease; }
#caton-landing .reveal.in { opacity:1; transform:none; }

/* RESPONSIVE */
@media (prefers-reduced-motion:reduce) {
  #caton-landing *,#caton-landing *::before,#caton-landing *::after { animation:none !important; transition:none !important; }
  #caton-landing .reveal { opacity:1; transform:none; }
  #caton-landing .edge { stroke-dashoffset:0; }
  #caton-landing .node { opacity:1; transform:none; }
}
@media (max-width:1000px) {
  #caton-landing .hero { grid-template-columns:1fr; padding:120px 28px 60px; }
  #caton-landing section { padding:80px 28px; }
  #caton-landing .metrics,#caton-landing .pipeline,#caton-landing .caps { grid-template-columns:1fr 1fr; }
  #caton-landing nav { padding:16px 24px; }
  #caton-landing .hero::before { font-size:110px; }
  #caton-landing .vigilancia { grid-template-columns:1fr; }
}
@media (max-width:640px) {
  #caton-landing .metrics,#caton-landing .pipeline,#caton-landing .caps { grid-template-columns:1fr; }
  #caton-landing .pipeline::before { display:none; }
  #caton-landing .metric + .metric { padding-left:0; border-left:none; }
}
`

export function CatonLandingPage() {
  const navigate = useNavigate()

  useEffect(() => {
    // ── Fonts ──
    if (!document.getElementById('caton-fonts')) {
      const link = document.createElement('link')
      link.id = 'caton-fonts'
      link.rel = 'preconnect'
      document.head.appendChild(link)
      const link2 = document.createElement('link')
      link2.id = 'caton-fonts'
      link2.rel = 'stylesheet'
      link2.href = 'https://fonts.googleapis.com/css2?family=Marcellus&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap'
      document.head.appendChild(link2)
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const $ = (id: string) => document.getElementById(id)

    // ── Ticker: duplicar para loop continuo ──
    const tk = $('caton-ticker')
    if (tk) tk.innerHTML += tk.innerHTML

    // ── Grafo de investigación ──
    const glog = $('glog')
    let nodes = 0, links = 0, flags = 0, dens = 0
    const fmt = (n: number) => n.toLocaleString('es-CO')

    function log(html: string, red = false) {
      if (!glog) return
      const d = document.createElement('div')
      d.className = 'log-line' + (red ? ' red' : '')
      d.innerHTML = html
      glog.appendChild(d)
      while (glog.children.length > 3) glog.removeChild(glog.children[0])
    }

    function setFoot() {
      const fn = $('f-nodes'); if (fn) fn.textContent = fmt(nodes)
      const fl = $('f-links'); if (fl) fl.textContent = fmt(links)
      const ff = $('f-flags'); if (ff) ff.textContent = fmt(flags)
      const fd = $('f-den');   if (fd) fd.textContent = fmt(dens)
    }

    function nodeIn(id: string, alert = false) {
      const n = $(id); if (!n) return
      n.classList.add('in')
      if (alert) n.classList.add('alert')
      nodes++; setFoot()
    }

    function edgeDraw(id: string, cls = 'hot') {
      const e = $(id); if (!e) return
      e.classList.add('draw', cls)
      links++; setFoot()
    }

    function chase(edgeId: string, red = false) {
      const e = $(edgeId) as unknown as SVGLineElement | null; if (!e) return
      const path = `M ${e.getAttribute('x1')} ${e.getAttribute('y1')} L ${e.getAttribute('x2')} ${e.getAttribute('y2')}`
      const am = $(red ? 'am-red' : 'am-gold') as unknown as SVGAnimateMotionElement | null
      const tr = $(red ? 'tr-red' : 'tr-gold') as unknown as SVGElement | null
      if (!am || !tr) return
      am.setAttribute('path', path)
      tr.style.opacity = '1'
      am.beginElement()
      setTimeout(() => { tr.style.opacity = '0' }, 700)
    }

    const steps: Array<[number, () => void]> = [
      [0,    () => { nodeIn('n0'); log('Analizando <b>CT-2026-04311</b> · Secretaría de Salud · $4.2B') }],
      [900,  () => { edgeDraw('e01'); chase('e01') }],
      [1550, () => { nodeIn('n1'); log('Contratista identificado: <b>Construcciones AZ SAS</b>') }],
      [2300, () => { edgeDraw('e12'); chase('e12') }],
      [2950, () => { nodeIn('n2') }],
      [3200, () => { edgeDraw('e13'); chase('e13') }],
      [3850, () => { nodeIn('n3'); log('<b>3 contratos</b> con el mismo NIT en 2 entidades') }],
      [4700, () => { edgeDraw('e14'); chase('e14') }],
      [5350, () => { nodeIn('n4'); log('Representante legal compartido detectado') }],
      [6100, () => { edgeDraw('e45', 'red'); chase('e45', true) }],
      [6750, () => { nodeIn('n5', true); flags++; setFoot(); log('⚑ HALLAZGO · <b>Ferrovial del Sur SAS</b> — creada 8 días antes de la firma', true) }],
      [7600, () => { edgeDraw('e53', 'red'); chase('e53', true) }],
      [8250, () => { $('n3')?.classList.add('alert'); log('⚑ Vínculo oculto entre oferentes del mismo proceso', true) }],
      [9200, () => { $('stamp')?.classList.add('in'); dens++; setFoot(); log('→ <b>Denuncia generada</b> · derecho de petición listo para firmar') }],
    ]
    const CYCLE = 13000
    const graphTimeouts: ReturnType<typeof setTimeout>[] = []
    let graphCancelled = false

    function resetGraph() {
      document.querySelectorAll('#caton-landing .node').forEach(n => n.classList.remove('in', 'alert'))
      document.querySelectorAll('#caton-landing .edge').forEach(e => e.classList.remove('draw', 'hot', 'red'))
      $('stamp')?.classList.remove('in')
    }

    function runTimeline() {
      if (graphCancelled) return
      steps.forEach(([t, fn]) => {
        const id = setTimeout(fn, t)
        graphTimeouts.push(id)
      })
      const id = setTimeout(() => {
        resetGraph()
        const id2 = setTimeout(runTimeline, 900)
        graphTimeouts.push(id2)
      }, CYCLE)
      graphTimeouts.push(id)
    }

    if (!reduced) {
      runTimeline()
    } else {
      ;['n0','n1','n2','n3','n4','n5'].forEach(id => $(id)?.classList.add('in'))
      ;['e01','e12','e13','e14'].forEach(id => $(id)?.classList.add('draw','hot'))
      ;['e45','e53'].forEach(id => $(id)?.classList.add('draw','red'))
      $('stamp')?.classList.add('in')
      nodes=6; links=6; flags=1; dens=1; setFoot()
      log('⚑ HALLAZGO · empresa fachada creada 8 días antes de la firma', true)
      log('→ <b>Denuncia generada</b> · lista para firmar')
    }

    // ── Terminal de vigilancia ──
    const entidades = ['Secretaría de Salud de Bogotá','Alcaldía de Medellín','Gobernación del Valle','INVÍAS','Ministerio de Educación','ICBF Regional Cauca','ESE Hospital San Rafael','Alcaldía de Barranquilla','UNGRD','Gobernación de Antioquia','Secretaría de Movilidad','IDU']
    const hallazgosT = ['sobrecosto 340% vs. precio de referencia','contratista creado 8 días antes de firma','fraccionamiento de contrato detectado','adición supera el 50% del valor inicial','único oferente en licitación pública','objeto contractual duplicado en 3 entidades']
    let tCount=0, tFlags=0, tDens=0, seq=4310, termOn=false
    const termTimeouts: ReturnType<typeof setTimeout>[] = []
    let termCancelled = false
    const money = () => '$'+(Math.random()*9+0.3).toFixed(1)+(Math.random()>0.5?'MM':'B')

    function addRow(html: string, cls = '') {
      const tbody = $('tbody'); if (!tbody) return
      const d = document.createElement('div')
      d.className = 't-row ' + cls
      d.innerHTML = html
      tbody.appendChild(d)
      while (tbody.children.length > 15) tbody.removeChild(tbody.children[1])
    }

    function termTick() {
      if (termCancelled) return
      const flagged = Math.random() < 0.22
      seq++
      const ent = entidades[Math.floor(Math.random()*entidades.length)]
      if (flagged) {
        tFlags++
        addRow(`<span class="t-id">CT-2026-0${seq}</span><span class="t-ent">${ent}</span><span class="t-flag">⚑ HALLAZGO</span><span class="t-val">${money()}</span>`,'flagged')
        const id1 = setTimeout(() => {
          addRow(`<span class="t-flag">└ ${hallazgosT[Math.floor(Math.random()*hallazgosT.length)]}</span>`,'flagged')
          const id2 = setTimeout(() => {
            tDens++
            addRow(`<span class="t-action">→ Denuncia generada · derecho de petición listo para firmar · 00:02:41</span>`,'action')
            const ftDen = $('ft-den'); if (ftDen) ftDen.textContent = fmt(tDens)
          }, 900)
          termTimeouts.push(id2)
        }, 600)
        termTimeouts.push(id1)
      } else {
        addRow(`<span class="t-id">CT-2026-0${seq}</span><span class="t-ent">${ent}</span><span class="t-ok">✓ sin hallazgos</span><span class="t-val">${money()}</span>`)
      }
      tCount++
      const ftCount = $('ft-count'); if (ftCount) ftCount.textContent = fmt(tCount)
      const ftFlags = $('ft-flags'); if (ftFlags) ftFlags.textContent = fmt(tFlags)
      const id = setTimeout(termTick, flagged ? 2400 : 500 + Math.random()*700)
      termTimeouts.push(id)
    }

    function startTerminal() {
      if (termOn) return; termOn = true
      if (!reduced) { termTick() }
      else {
        addRow(`<span class="t-id">CT-2026-04311</span><span class="t-ent">Secretaría de Salud de Bogotá</span><span class="t-flag">⚑ HALLAZGO</span><span class="t-val">$4.2B</span>`,'flagged')
        addRow(`<span class="t-action">→ Denuncia generada · lista para firmar</span>`,'action')
        const ftCount = $('ft-count'); if (ftCount) ftCount.textContent = '1'
        const ftFlags = $('ft-flags'); if (ftFlags) ftFlags.textContent = '1'
        const ftDen = $('ft-den'); if (ftDen) ftDen.textContent = '1'
      }
    }

    const vigEl = $('caton-vigilancia')
    const ioTerm = vigEl ? new IntersectionObserver(es => {
      es.forEach(e => { if (e.isIntersecting) { startTerminal(); ioTerm.disconnect() } })
    }, { threshold: 0.25 }) : null
    if (vigEl && ioTerm) ioTerm.observe(vigEl)

    // ── El ojo ──
    const ticks = $('iris-ticks')
    if (ticks) {
      let tickSvg = ''
      for (let i = 0; i < 24; i++) {
        const a = (i/24)*Math.PI*2
        const x1 = 105+Math.cos(a)*19, y1 = 62+Math.sin(a)*19
        const x2 = 105+Math.cos(a)*25, y2 = 62+Math.sin(a)*25
        tickSvg += `<line class="iris-tick" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`
      }
      ticks.innerHTML = tickSvg
    }

    let onMouseMove: ((e: MouseEvent) => void) | null = null
    if (!reduced) {
      const wrap = document.querySelector('#caton-landing .ojo-wrap') as HTMLElement | null
      const iris = $('iris-grp') as unknown as SVGGElement | null
      const MAXX = 13, MAXY = 7
      if (wrap && iris) {
        onMouseMove = (e: MouseEvent) => {
          const r = wrap.getBoundingClientRect()
          const cx = r.left + r.width/2, cy = r.top + r.height/2
          const dx = e.clientX - cx, dy = e.clientY - cy
          const d = Math.hypot(dx, dy) || 1
          const f = Math.min(1, d/420)
          iris.style.transform = `translate(${(dx/d)*MAXX*f}px,${(dy/d)*MAXY*f}px)`
        }
        window.addEventListener('mousemove', onMouseMove, { passive: true })
      }
    }

    // ── Reveals + count-up + pipeline ──
    function animateNum(el: HTMLElement) {
      if (el.dataset.done) return
      el.dataset.done = '1'
      const target = parseFloat(el.dataset.count!)
      const pre = el.dataset.prefix || ''
      const suf = el.dataset.suffix || ''
      const dec = String(el.dataset.count).includes('.') ? 1 : 0
      if (reduced) {
        el.textContent = pre + target.toLocaleString('es-CO', { minimumFractionDigits: dec }) + suf
        return
      }
      const t0 = performance.now(), dur = 1400
      function step(t: number) {
        const p = Math.min((t-t0)/dur, 1), eased = 1-Math.pow(1-p,3)
        el.innerHTML = pre + (target*eased).toLocaleString('es-CO', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf
        if (p < 1) requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }

    const io = new IntersectionObserver(es => {
      es.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('in')
          ;(e.target as HTMLElement).querySelectorAll('.num[data-count]').forEach(el => animateNum(el as HTMLElement))
          if ((e.target as HTMLElement).id === 'pipe') {
            ;(e.target as HTMLElement).style.setProperty('--pline','100%')
          }
          io.unobserve(e.target)
        }
      })
    }, { threshold: 0.2 })
    document.querySelectorAll('#caton-landing .reveal').forEach(el => io.observe(el))

    return () => {
      graphCancelled = true
      termCancelled = true
      graphTimeouts.forEach(clearTimeout)
      termTimeouts.forEach(clearTimeout)
      if (onMouseMove) window.removeEventListener('mousemove', onMouseMove)
      io.disconnect()
      ioTerm?.disconnect()
    }
  }, [])

  return (
    <div id="caton-landing">
      <style>{CSS}</style>

      {/* ── NAV ── */}
      <nav>
        <div className="logo">CAT<span className="o-gold">Ó</span>N</div>
        <div className="nav-right">
          <a className="nav-link" href="#para-quien">Para quién</a>
          <a className="nav-link" href="#pipeline">Cómo funciona</a>
          <a className="nav-link" href="#capacidades">Capacidades</a>
          <button className="btn-ingresar" onClick={() => navigate('/app')}>Ingresar</button>
        </div>
      </nav>

      {/* ── HERO ── */}
      <div className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="dot"></span> Control fiscal · Colombia</div>
          <h1 className="roman">Sigue la plata.<br /><span className="gold">Hasta el fallo judicial.</span></h1>
          <p className="hero-sub">CATÓN conecta 65 millones de contratos SECOP en un grafo de investigación: contratistas, representantes legales, empresas fachada. Detecta el vínculo oculto, redacta el hallazgo y da seguimiento hasta el fallo. Para veedores ciudadanos, contralorías y auditores.</p>
          <div className="hero-ctas">
            <button className="btn-primary" onClick={() => navigate('/app')}>Comenzar ahora</button>
            <button className="btn-ghost" onClick={() => document.getElementById('para-quien')?.scrollIntoView({ behavior: 'smooth' })}>¿Para quién?</button>
          </div>
        </div>

        <div className="grafo-panel">
          <div className="grafo-bar">
            <span className="title">CATÓN · Grafo de investigación</span>
            <span className="live">Rastreando</span>
          </div>
          <div className="grafo-canvas">
            <svg viewBox="0 0 560 400" xmlns="http://www.w3.org/2000/svg" aria-label="Grafo de investigación">
              <defs>
                <pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse">
                  <circle className="dotfield" cx="1" cy="1" r="1"/>
                </pattern>
              </defs>
              <rect width="560" height="400" fill="url(#dots)"/>

              {/* aristas */}
              <line id="e01" className="edge" x1="130" y1="210" x2="290" y2="130"/>
              <line id="e12" className="edge" x1="290" y1="130" x2="430" y2="70"/>
              <line id="e13" className="edge" x1="290" y1="130" x2="470" y2="185"/>
              <line id="e14" className="edge" x1="290" y1="130" x2="290" y2="290"/>
              <line id="e45" className="edge" x1="290" y1="290" x2="445" y2="325"/>
              <line id="e53" className="edge" x1="445" y1="325" x2="470" y2="185"/>

              {/* tracers */}
              <circle id="tr-gold" className="tracer" r="3.2">
                <animateMotion id="am-gold" dur="0.65s" begin="indefinite" fill="freeze"/>
              </circle>
              <circle id="tr-red" className="tracer red" r="3.2">
                <animateMotion id="am-red" dur="0.65s" begin="indefinite" fill="freeze"/>
              </circle>

              {/* nodos */}
              <g id="n0" className="node">
                <circle className="halo" cx="130" cy="210" r="26"/>
                <circle className="core" cx="130" cy="210" r="17"/>
                <text className="glyph" x="130" y="214">CT</text>
                <text className="lbl" x="130" y="248">CT-2026-04311</text>
                <text className="lbl2" x="130" y="261">Sec. Salud · $4.2B</text>
              </g>
              <g id="n1" className="node gold">
                <circle className="halo" cx="290" cy="130" r="26"/>
                <circle className="core" cx="290" cy="130" r="17"/>
                <text className="glyph" x="290" y="134">NIT</text>
                <text className="lbl" x="290" y="98">Construcciones AZ SAS</text>
              </g>
              <g id="n2" className="node">
                <circle className="halo" cx="430" cy="70" r="22"/>
                <circle className="core" cx="430" cy="70" r="14"/>
                <text className="glyph" x="430" y="74">CT</text>
                <text className="lbl" x="430" y="44">CT-2025-08122 · INVÍAS</text>
              </g>
              <g id="n3" className="node">
                <circle className="halo" cx="470" cy="185" r="22"/>
                <circle className="core" cx="470" cy="185" r="14"/>
                <text className="glyph" x="470" y="189">CT</text>
                <text className="lbl" x="470" y="217">CT-2026-01277 · Sec. Salud</text>
              </g>
              <g id="n4" className="node gold">
                <circle className="halo" cx="290" cy="290" r="24"/>
                <circle className="core" cx="290" cy="290" r="15"/>
                <text className="glyph" x="290" y="294">RL</text>
                <text className="lbl" x="238" y="294" textAnchor="end">Rep. legal compartido</text>
              </g>
              <g id="n5" className="node red">
                <circle className="halo" cx="445" cy="325" r="24"/>
                <circle className="core" cx="445" cy="325" r="15"/>
                <text className="glyph" x="445" y="329">SAS</text>
                <text className="lbl" x="445" y="359">Ferrovial del Sur SAS</text>
                <text className="lbl2" x="445" y="372">creada 8 días antes</text>
              </g>
            </svg>
            <div className="stamp" id="stamp">Denuncia generada<small>derecho de petición · listo para firmar · 00:02:41</small></div>
          </div>
          <div className="grafo-log" id="glog"></div>
          <div className="grafo-foot">
            <span>Nodos <b id="f-nodes">0</b></span>
            <span>Vínculos <b id="f-links">0</b></span>
            <span>Hallazgos <b id="f-flags">0</b></span>
            <span>Denuncias <b id="f-den">0</b></span>
          </div>
        </div>
      </div>

      {/* ── TICKER ── */}
      <div className="ticker">
        <div className="ticker-track" id="caton-ticker">
          <span><b>65.4M</b> contratos accesibles</span>
          <span><b>+2.400</b> entidades públicas</span>
          <span><b>$300 billones COP</b> bajo vigilancia</span>
          <span><b>24/7</b> seguimiento en Rama Judicial</span>
          <span><b>Veeduría ciudadana</b> · Contraloría · Auditoría General</span>
          <span><b>0</b> abogados requeridos para radicar</span>
          <span><b>Ley 1755/2015</b> · plazos con festivos colombianos</span>
          <span><b>Control fiscal</b> determinista · sin alucinaciones</span>
        </div>
      </div>

      {/* ── PARA QUIÉN ── */}
      <section id="para-quien" style={{ background:'var(--papel-2)', borderTop:'1px solid var(--linea)', borderBottom:'1px solid var(--linea)' }}>
        <div className="section-label reveal">Para quién</div>
        <h2 className="roman reveal">La misma herramienta.<br />Tres tipos de auditor.</h2>
        <p className="section-sub reveal">CATÓN fue diseñado para que cualquier persona con autoridad o responsabilidad sobre el gasto público lo sienta propio.</p>

        <div className="pq-grid reveal">
          {/* Veedor ciudadano */}
          <div className="pq-card" data-num="I">
            <span className="pq-icon">🔍</span>
            <span className="pq-tag">Veeduría ciudadana</span>
            <h3>Veedor ciudadano</h3>
            <p>Cualquier ciudadano puede ejercer control social sobre la contratación pública. CATÓN elimina la barrera técnica y jurídica.</p>
            <div className="pq-features">
              <div className="pq-feature">Denuncia lista para firmar en minutos</div>
              <div className="pq-feature">Derecho de petición con trazabilidad</div>
              <div className="pq-feature">Tutela automática si no hay respuesta</div>
              <div className="pq-feature">Sin abogado requerido para radicar</div>
            </div>
          </div>

          {/* Contraloría */}
          <div className="pq-card" data-num="II">
            <span className="pq-icon">🏛️</span>
            <span className="pq-tag">Contraloría · Nacional · Departamental · Municipal</span>
            <h3>Contraloría</h3>
            <p>Para auditores y funcionarios de control fiscal que necesitan analizar grandes volúmenes de contratación con evidencia sólida.</p>
            <div className="pq-features">
              <div className="pq-feature">Grafo de investigación sobre 65M contratos</div>
              <div className="pq-feature">Hallazgos con respaldo jurídico y referencia SECOP</div>
              <div className="pq-feature">Expediente de auditoría por proceso</div>
              <div className="pq-feature">Múltiples auditores bajo una misma organización</div>
            </div>
          </div>

          {/* Auditoría General */}
          <div className="pq-card" data-num="III">
            <span className="pq-icon">⚖️</span>
            <span className="pq-tag">Auditoría General de la Nación</span>
            <h3>Auditoría General</h3>
            <p>Instrumento de apoyo para la vigilancia de la gestión fiscal del Estado y el seguimiento a procesos de responsabilidad.</p>
            <div className="pq-features">
              <div className="pq-feature">Seguimiento a Rama Judicial 24/7</div>
              <div className="pq-feature">Informe de hallazgos descargable por proceso</div>
              <div className="pq-feature">Plazos procesales con festivos colombianos</div>
              <div className="pq-feature">Consecutivo y trazabilidad de cada actuación</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── MÉTRICAS ── */}
      <section>
        <div className="section-label reveal">Cobertura</div>
        <h2 className="roman reveal">Todo el gasto público, bajo un solo lente.</h2>
        <div className="metrics reveal">
          <div className="metric">
            <div className="num" data-count="65.4" data-suffix="M">0</div>
            <div className="lbl">Contratos SECOP accesibles</div>
          </div>
          <div className="metric">
            <div className="num" data-count="2400" data-prefix="+">0</div>
            <div className="lbl">Entidades públicas cubiertas</div>
          </div>
          <div className="metric">
            <div className="num" data-count="300" data-prefix="$" data-suffix="B">0</div>
            <div className="lbl">COP bajo vigilancia ciudadana</div>
          </div>
          <div className="metric">
            <div className="num">3 días <span>→</span> 5 min</div>
            <div className="lbl">Vs. proceso manual con abogado</div>
          </div>
        </div>
      </section>

      {/* ── PIPELINE ── */}
      <section id="pipeline" style={{ background:'var(--papel-2)', borderTop:'1px solid var(--linea)', borderBottom:'1px solid var(--linea)' }}>
        <div className="section-label reveal">Pipeline de acción</div>
        <h2 className="roman reveal">Del contrato sospechoso al fallo judicial.</h2>
        <p className="section-sub reveal">No solo alertas — instrumentos jurídicos listos para usar. Cuatro documentos generados sin que el veedor escriba una línea.</p>

        <div className="pipeline reveal" id="pipe">
          <div className="step">
            <div className="numeral">I</div>
            <div className="s-label">Detección</div>
            <h3>Busca en SECOP</h3>
            <p>Acceso a 65 millones de contratos públicos. El sistema identifica indicios de irregularidad automáticamente.</p>
            <div className="s-time">&lt; 30 seg a primeros hallazgos</div>
          </div>
          <div className="step">
            <div className="numeral">II</div>
            <div className="s-label">Denuncia</div>
            <h3>Audita y redacta</h3>
            <p>El motor analiza documentos, detecta hallazgos con respaldo legal y redacta el derecho de petición.</p>
            <div className="s-time">&lt; 3 min lista para firmar</div>
          </div>
          <div className="step">
            <div className="numeral">III</div>
            <div className="s-label">Radicación</div>
            <h3>Envía con trazabilidad</h3>
            <p>Cada envío queda registrado con número de consecutivo, pixel de apertura y contador de 15 días hábiles.</p>
            <div className="s-time">100% de plazos monitoreados</div>
          </div>
          <div className="step">
            <div className="numeral">IV</div>
            <div className="s-label">Escalamiento</div>
            <h3>Tutela si no responden</h3>
            <p>Si la entidad guarda silencio, el sistema genera automáticamente la tutela y da seguimiento al proceso judicial.</p>
            <div className="s-time">&lt; 60 seg generada al vencer plazo</div>
          </div>
        </div>
      </section>

      {/* ── VIGILANCIA ── */}
      <section id="caton-vigilancia">
        <div className="vigilancia">
          <div>
            <div className="section-label reveal">Vigilancia continua</div>
            <h2 className="roman reveal">El motor audita mientras duermes.</h2>
            <p className="section-sub reveal">Cada contrato nuevo que entra a SECOP pasa por el motor de reglas jurídicas. Cada plazo corre con festivos colombianos. Cada actuación en Rama Judicial queda reportada.</p>
            <div className="vig-puntos reveal">
              <div className="vig-punto"><span className="roman">I</span><span><b>100% de plazos monitoreados</b> — ninguna fecha se pasa, alerta antes de cada vencimiento.</span></div>
              <div className="vig-punto"><span className="roman">II</span><span><b>15 días hábiles calculados</b> con festivos colombianos incluidos (Ley 1755/2015).</span></div>
              <div className="vig-punto"><span className="roman">III</span><span><b>24/7 en Rama Judicial</b> — el sistema reporta cuando hay actuaciones nuevas.</span></div>
            </div>
          </div>
          <div className="terminal reveal">
            <div className="terminal-bar">
              <span className="title">CATÓN · Motor de auditoría</span>
              <span className="live">Vigilancia activa</span>
            </div>
            <div className="terminal-body" id="tbody"><div className="scanline"></div></div>
            <div className="terminal-foot">
              <span>Contratos hoy <b id="ft-count">0</b></span>
              <span>Hallazgos <b id="ft-flags">0</b></span>
              <span>Denuncias <b id="ft-den">0</b></span>
            </div>
          </div>
        </div>
      </section>

      {/* ── DOCTRINA ── */}
      <section className="doctrina" id="doctrina">
        <div className="ojo-wrap reveal" aria-hidden="true">
          <svg viewBox="0 0 210 124" xmlns="http://www.w3.org/2000/svg">
            <g id="ojo-rayos">
              <line className="ojo-rayo" x1="105" y1="18" x2="105" y2="0"/>
              <line className="ojo-rayo" x1="62"  y1="26" x2="50"  y2="10"/>
              <line className="ojo-rayo" x1="148" y1="26" x2="160" y2="10"/>
              <line className="ojo-rayo" x1="30"  y1="46" x2="12"  y2="36"/>
              <line className="ojo-rayo" x1="180" y1="46" x2="198" y2="36"/>
              <line className="ojo-rayo" x1="18"  y1="70" x2="0"   y2="68"/>
              <line className="ojo-rayo" x1="192" y1="70" x2="210" y2="68"/>
            </g>
            <g id="ojo-parpado" className="parpadeo">
              <path className="ojo-trazo" d="M 20 62 Q 105 8 190 62 Q 105 116 20 62 Z"/>
              <path className="ojo-fino"  d="M 30 62 Q 105 20 180 62"/>
              <g id="iris-grp">
                <circle className="ojo-trazo" cx="105" cy="62" r="26"/>
                <g id="iris-ticks"></g>
                <circle className="pupila" cx="105" cy="62" r="11"/>
                <circle className="pupila-brillo" cx="109" cy="58" r="2.4"/>
              </g>
            </g>
          </svg>
        </div>
        <div className="inscripcion reveal">Cato · Censorius · Roma · CLXXXIV a.C.</div>
        <blockquote className="reveal">"Fiscalicé los contratos del Estado.<br/><span className="gold">Ahora lo haces tú."</span></blockquote>
        <p className="attr reveal">Marco Porcio Catón auditó a los publicanos romanos. CATÓN hace lo mismo con SECOP — con reglas jurídicas deterministas, no IA generativa, e instrumentos legales reales.</p>
        <div className="sello-linea reveal">Determinista · Verificable · Sin alucinaciones</div>
      </section>

      {/* ── CAPACIDADES ── */}
      <section id="capacidades">
        <div className="section-label reveal">Capacidades</div>
        <h2 className="roman reveal">Todo lo que necesita una veeduría seria.</h2>
        <div className="caps reveal">
          <div className="cap"><span className="marca">·</span><span><b>Grafo de investigación</b> sobre 65M+ contratos SECOP II</span></div>
          <div className="cap"><span className="marca">·</span><span><b>Auditoría determinista</b> por reglas jurídicas (no IA generativa)</span></div>
          <div className="cap"><span className="marca">·</span><span><b>Denuncias y derechos de petición</b> generados automáticamente</span></div>
          <div className="cap"><span className="marca">·</span><span><b>Contador de 15 días hábiles</b> con festivos colombianos (Ley 1755/2015)</span></div>
          <div className="cap"><span className="marca">·</span><span><b>Tutela pre-generada</b> si no hay respuesta de la entidad</span></div>
          <div className="cap"><span className="marca">·</span><span><b>Seguimiento procesal automático</b> en Rama Judicial, 24/7</span></div>
          <div className="cap"><span className="marca">·</span><span><b>Múltiples auditores y coordinadores</b> por organización</span></div>
          <div className="cap"><span className="marca">·</span><span><b>Panel de control</b> para directores de veeduría</span></div>
        </div>
      </section>

      {/* ── CTA FINAL ── */}
      <section className="final">
        <div className="section-label reveal" style={{ justifyContent:'center' }}>Empieza hoy</div>
        <h2 className="roman reveal">El Estado contrata.<br/><span style={{ color:'var(--sello)' }}>Tú fiscalizas.</span></h2>
        <p className="section-sub reveal" style={{ margin:'24px auto 0', textAlign:'center' }}>Para el veedor que quiere actuar, el contralor que necesita evidencia y el auditor que da seguimiento hasta el fallo.</p>
        <div className="hero-ctas reveal" style={{ marginTop:44, justifyContent:'center' }}>
          <button className="btn-primary" onClick={() => navigate('/app')}>Crear cuenta gratuita</button>
          <button className="btn-ghost" onClick={() => window.location.href = 'mailto:caton@numa.la?subject=Demo institucional CATÓN'}>Solicitar demo institucional</button>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer>
        <div className="logo">CAT<span className="o-gold">Ó</span>N<small>by NUMA</small></div>
        <div>© 2026 Auron System SAS · Todos los derechos reservados</div>
      </footer>
    </div>
  )
}
