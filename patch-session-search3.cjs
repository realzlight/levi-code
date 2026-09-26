const fs = require('fs');
const file = 'src/agent/session.js';
let src = fs.readFileSync(file, 'utf-8');

const oldStop = `const STOPWORDS = new Set(['the', 'a', 'an', 'about', 'what', 'did', 'we', 'decide', 'is', 'was', 'were', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'that', 'this', 'it', 'with']);

function keywordsOf(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}`;
const newStop = `const STOPWORDS = new Set(['the', 'a', 'an', 'about', 'what', 'did', 'we', 'decide', 'is', 'was', 'were', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'that', 'this', 'it', 'with', 'he', 'she', 'do', 'be', 'so', 'at', 'by', 'up', 'no', 'you', 'your']);

function keywordsOf(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}`;
if (!src.includes(oldStop)) { console.log('NO MATCH'); process.exit(1); }
src = src.replace(oldStop, newStop);
fs.writeFileSync(file, src);
console.log('patched');
