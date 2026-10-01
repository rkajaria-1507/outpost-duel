#!/usr/bin/env node
/* ---------------------------------------------------------------------
   check-scripts — catch a forgotten <script> tag in CI, not in a browser.

   The game is plain classic scripts sharing one global scope, so a JS file
   that never gets a tag in index.html fails silently at runtime with a
   ReferenceError deep inside game.js. This asserts the two lists match.

   Rules:
     - every .js file under js/ except main.js must appear EXACTLY ONCE as a
       <script src="..."> in index.html
     - load order is verified too: each file's tag must come after the one
       for the file it depends on (ext < audio/fx/rules < features < game)

   Exit 0 = clean. Exit 1 = one or more offenders, each named.
--------------------------------------------------------------------- */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'index.html');
const JS_DIR = path.join(ROOT, 'js');

/* main.js is the historical entry point and is intentionally not referenced
   from index.html, so it is exempt from the tag requirement. */
const EXEMPT = new Set(['main.js']);

/* Hard dependency order. A file listed here must be tagged before any file
   that comes after it in this list. Unknown files are not order-checked
   (they own their own region of the page). */
const LOAD_ORDER = [
  'ext.js',
  'audio.js',
  'fx.js',
  'rules.js',
  'feature-wagers.js',
  'feature-chaos.js',
  'game.js',
];

function fail(message, lines){
  process.stderr.write('\n[check-scripts] FAIL\n');
  lines.forEach(l => process.stderr.write('  - ' + l + '\n'));
  process.stderr.write('\n' + message + '\n\n');
  process.exit(1);
}

function listJsFiles(dir){
  const out = [];
  const walk = (d) => {
    fs.readdirSync(d, {withFileTypes: true}).forEach(entry => {
      const full = path.join(d, entry.name);
      if(entry.isDirectory()) walk(full);
      else if(entry.isFile() && entry.name.endsWith('.js')) out.push(path.relative(dir, full).split(path.sep).join('/'));
    });
  };
  walk(dir);
  return out.sort();
}

function findTags(html, file){
  const re = new RegExp('<script[^>]*\\ssrc="js/' + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>', 'g');
  return html.match(re) || [];
}

function main(){
  if(!fs.existsSync(HTML_PATH)) fail('index.html not found at ' + HTML_PATH, []);
  if(!fs.existsSync(JS_DIR)) fail('js/ directory not found at ' + JS_DIR, []);

  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const files = listJsFiles(JS_DIR).filter(f => !EXEMPT.has(f));

  const problems = [];

  files.forEach(file => {
    const tags = findTags(html, file);
    if(tags.length === 0){
      problems.push('js/' + file + ' has NO <script> tag in index.html');
    } else if(tags.length > 1){
      problems.push('js/' + file + ' has ' + tags.length + ' <script> tags in index.html (expected exactly 1)');
    }
  });

  /* Order check: the tag position of each known file must increase along
     LOAD_ORDER. Only checked for files that are present and tagged. */
  const positions = new Map();
  LOAD_ORDER.forEach(file => {
    const idx = html.indexOf('src="js/' + file + '"');
    if(idx >= 0) positions.set(file, idx);
  });
  for(let i = 1; i < LOAD_ORDER.length; i++){
    const prev = LOAD_ORDER[i - 1], cur = LOAD_ORDER[i];
    if(positions.has(prev) && positions.has(cur) && positions.get(prev) >= positions.get(cur)){
      problems.push('load order: js/' + cur + ' must be tagged AFTER js/' + prev + ' in index.html');
    }
  }

  if(problems.length) fail(problems.length + ' script problem(s) found:', problems);

  process.stdout.write('[check-scripts] OK - ' + files.length + ' js file(s) tagged exactly once, load order valid.\n');
  process.stdout.write('[check-scripts]   ' + files.join(', ') + '\n');
  process.exit(0);
}

main();
