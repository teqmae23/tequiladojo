// <shop>_matched.csv / <shop>_unmatched.csv を Firestore に取り込む（マルチショップ対応）。
//   brand+class(high/mid) → marketPrices/{shop}__{bottleId}
//   それ以外(brand-only/low)＋未マッチ → marketStaging/{shop}__{item_id}
// 実行: cd ~/functions && node <repo>/tools/market/import_market.js --shop wazawaza
//   CSVは ~/<shop>_matched.csv, ~/<shop>_unmatched.csv を読む。認証は ADC。
const admin = require('firebase-admin');
const fs = require('fs');
admin.initializeApp({ projectId: 'tequiladojo' });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

const shopArgIdx = process.argv.indexOf('--shop');
const SHOP = shopArgIdx >= 0 ? process.argv[shopArgIdx + 1] : null;
if (!SHOP) { console.error('使い方: node import_market.js --shop <key>'); process.exit(1); }

function parseCSV(text) {
  text = text.replace(/^﻿/, ''); const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c === '\r') {} else cur += c; }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length && r.some(x => x !== '')).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] != null ? r[i] : ''])));
}
function num(v) { const s = String(v || '').trim(); return /^\d+$/.test(s) ? parseInt(s, 10) : null; }
function readCSV(name) { if (!fs.existsSync(name)) { console.error('見つかりません:', process.cwd() + '/' + name); process.exit(1); } return parseCSV(fs.readFileSync(name, 'utf8')); }
async function commitChunked(ops) { for (let i = 0; i < ops.length; i += 400) { const b = db.batch(); ops.slice(i, i + 400).forEach(o => b.set(o.ref, o.data, { merge: true })); await b.commit(); } }

(async () => {
  const matched = readCSV(`${SHOP}_matched.csv`);
  const unmatched = readCSV(`${SHOP}_unmatched.csv`);
  const shopName = (matched[0] && matched[0].shopName) || (unmatched[0] && unmatched[0].shopName) || SHOP;
  const bestByBottle = {}; const staging = [];
  for (const m of matched) {
    const linkable = m.match_type === 'brand+class' && (m.confidence === 'high' || m.confidence === 'mid');
    if (linkable && m.teq_bottle_id) {
      const p750 = num(m.price750) || num(m.price) || 0;
      const inStock = m.availability === '在庫あり';
      const cur = bestByBottle[m.teq_bottle_id];
      const better = !cur || (inStock && !cur._inStock) || (inStock === cur._inStock && p750 && p750 < cur._p750);
      if (better) bestByBottle[m.teq_bottle_id] = { _p750: p750, _inStock: inStock,
        shop: SHOP, shopName, bottleId: m.teq_bottle_id, teqBottleJa: m.teq_bottleJa || '',
        name: m.name || '', price: num(m.price), price750: p750, availability: m.availability || '', url: m.url || '',
        matchType: m.match_type, confidence: m.confidence, brandScore: parseFloat(m.brand_score) || null,
        source: 'crawl', updatedAt: FV.serverTimestamp() };
    } else {
      staging.push({ shop: SHOP, shopName, itemId: m.item_id, name: m.name || '', brandGuess: m.teq_bottleJa || '',
        classGuess: m.m_class || '', price: num(m.price), price750: num(m.price750), availability: m.availability || '',
        url: m.url || '', reason: m.match_type === 'brand-only' ? 'brand-only' : 'low-confidence',
        suggestedBottleId: m.teq_bottle_id || '', status: 'pending', source: 'crawl', updatedAt: FV.serverTimestamp() });
    }
  }
  for (const u of unmatched) {
    staging.push({ shop: SHOP, shopName, itemId: u.item_id, name: u.name || '', brandGuess: u.brand_guess || '',
      classGuess: u.class_guess || '', price: num(u.price), price750: num(u.price750), availability: u.availability || '',
      url: u.url || '', reason: 'unmatched', suggestedBottleId: '', status: 'pending', source: 'crawl', updatedAt: FV.serverTimestamp() });
  }
  const priceOps = Object.values(bestByBottle).map(v => { const { _p750, _inStock, ...data } = v; return { ref: db.collection('marketPrices').doc(SHOP + '__' + data.bottleId), data }; });
  const stageOps = staging.map(s => ({ ref: db.collection('marketStaging').doc(SHOP + '__' + s.itemId), data: s }));
  await commitChunked(priceOps); await commitChunked(stageOps);
  console.log(`[${SHOP}] marketPrices ${priceOps.length} / marketStaging ${stageOps.length}`);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
