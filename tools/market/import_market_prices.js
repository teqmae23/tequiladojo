// matched.csv / unmatched_musashiya.csv を Firestore に取り込む。
//   - brand+class マッチ(high/mid) → marketPrices（正しいボトルに紐付いた参考相場）
//   - それ以外(brand-only/low) と 未マッチ → marketStaging（照合UI用の保留リスト）
// 実行: cd ~/functions && node <repo>/tools/market/import_market_prices.js
//   CSVは ~/matched.csv, ~/unmatched_musashiya.csv を読む。認証は Cloud Shell の ADC。
const admin = require('firebase-admin');
const fs = require('fs');
const os = require('os');
admin.initializeApp({ projectId: 'tequiladojo' });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const HOME = os.homedir();
const SHOP = 'musashiya', SHOP_NAME = '武蔵屋';

function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* skip */ }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length && r.some(x => x !== ''))
    .map(r => Object.fromEntries(head.map((h, i) => [h, r[i] != null ? r[i] : ''])));
}
function num(v) { const s = String(v || '').trim(); return /^\d+$/.test(s) ? parseInt(s, 10) : null; }
function readCSV(name) {
  const p = HOME + '/' + name;
  if (!fs.existsSync(p)) { console.error('見つかりません:', p); process.exit(1); }
  return parseCSV(fs.readFileSync(p, 'utf8'));
}

async function commitChunked(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    ops.slice(i, i + 400).forEach(o => batch.set(o.ref, o.data, { merge: true }));
    await batch.commit();
  }
}

(async () => {
  const matched = readCSV('matched.csv');
  const unmatched = readCSV('unmatched_musashiya.csv');

  // 1) brand+class(high/mid) → marketPrices（bottleId別に750ml換算 最安・在庫優先）
  const bestByBottle = {};
  const staging = [];
  for (const m of matched) {
    const linkable = (m.match_type === 'brand+class') && (m.confidence === 'high' || m.confidence === 'mid');
    if (linkable && m.teq_bottle_id) {
      const p750 = num(m.m_price_750ml) || num(m.m_price_yen) || 0;
      const inStock = m.availability === '在庫あり';
      const cur = bestByBottle[m.teq_bottle_id];
      const better = !cur || (inStock && !cur._inStock) ||
        (inStock === cur._inStock && p750 && p750 < cur._p750);
      if (better) bestByBottle[m.teq_bottle_id] = {
        _p750: p750, _inStock: inStock,
        shop: SHOP, shopName: SHOP_NAME, bottleId: m.teq_bottle_id,
        teqBottleJa: m.teq_bottleJa || '', teqBrandJa: m.teq_brandJa || '',
        name: m.musashiya_name || '', price: num(m.m_price_yen), price750: p750,
        availability: m.availability || '', url: m.musashiya_url || '',
        matchType: m.match_type, confidence: m.confidence,
        brandScore: parseFloat(m.brand_score) || null,
        source: 'musashiya_scrape', updatedAt: FV.serverTimestamp(),
      };
    } else {
      staging.push({
        shop: SHOP, shopName: SHOP_NAME, musashiyaId: m.musashiya_id, name: m.musashiya_name || '',
        brandGuess: m.teq_brandJa || '', classGuess: m.m_class || '',
        price: num(m.m_price_yen), price750: num(m.m_price_750ml),
        availability: m.availability || '', url: m.musashiya_url || '',
        reason: m.match_type === 'brand-only' ? 'brand-only' : 'low-confidence',
        suggestedBottleId: m.teq_bottle_id || '', suggestedBrandJa: m.teq_brandJa || '',
        status: 'pending', source: 'musashiya_scrape', updatedAt: FV.serverTimestamp(),
      });
    }
  }
  // 2) 未マッチ → marketStaging
  for (const u of unmatched) {
    staging.push({
      shop: SHOP, shopName: SHOP_NAME, musashiyaId: u.id, name: u.name || '',
      brandGuess: u.brand_guess || '', classGuess: u.class_guess || '',
      price: num(u.price_yen), price750: num(u.price_750ml),
      availability: u.availability || '', url: u.url || '',
      reason: 'unmatched', suggestedBottleId: '', suggestedBrandJa: '',
      status: 'pending', source: 'musashiya_scrape', updatedAt: FV.serverTimestamp(),
    });
  }

  const priceOps = Object.values(bestByBottle).map(v => {
    const { _p750, _inStock, ...data } = v;
    return { ref: db.collection('marketPrices').doc(SHOP + '__' + data.bottleId), data };
  });
  const stageOps = staging.map(s => ({
    ref: db.collection('marketStaging').doc(SHOP + '__' + s.musashiyaId), data: s,
  }));

  await commitChunked(priceOps);
  await commitChunked(stageOps);
  console.log(`取り込み完了:`);
  console.log(`  marketPrices  : ${priceOps.length}件（ボトル紐付け済みの参考相場）`);
  console.log(`  marketStaging : ${stageOps.length}件（照合UI用の保留: 未マッチ＋brand-only/low）`);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
