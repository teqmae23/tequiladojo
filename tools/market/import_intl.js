// 海外店の <shop>_tequila_final.csv を Firestore marketIntl に取り込む。
//   ・マスタに無くても【全件】格納（マスタ紐付けは任意）
//   ・tequiladojo_master.csv があれば、英字ボトル名の一致で bottleId を軽く自動紐付け（道場にあるもの＝matched:true）
// 実行: cd ~/functions && node <repo>/tools/market/import_intl.js --shop oldtowntequila
//   CSVは実行ディレクトリの ~/<shop>_tequila_final.csv（と任意で ~/tequiladojo_master.csv）を読む。認証は ADC。
const admin = require('firebase-admin');
const fs = require('fs');
admin.initializeApp({ projectId: 'tequiladojo' });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

const shopArgIdx = process.argv.indexOf('--shop');
const SHOP = shopArgIdx >= 0 ? process.argv[shopArgIdx + 1] : null;
if (!SHOP) { console.error('使い方: node import_intl.js --shop <key>'); process.exit(1); }

const SHOP_NAMES = {
  oldtowntequila:'Old Town Tequila', siptequila:'Sip Tequila', sftequilashop:'SF Tequila Shop', hiproof:'Hi Proof', klwines:'K&L Wines',
  remedy:'Remedy Liquor', delmesa:'Del Mesa Liquor', uptown:'Uptown Spirits', thirdbase:'Third Base Market & Spirits',
  hitime:'Hi-Time Wine Cellars', montagave:'Montagave', chips:'Chips Liquor', frootbat:'Froot Bat', kegnbottles:'Keg N Bottle',
  hedonism:'Hedonism Wines', totalwine:'Total Wine & More', masterofmalt:'Master of Malt', whiskyexchange:'The Whisky Exchange',
  maisonduwhisky:'La Maison du Whisky', whiskysite:'Whiskysite.nl',
  ludwig:'Ludwig Fine Wine', beverlyhills:'Beverly Hills Liquor & Wine', elcerrito:'El Cerrito Liquor', roadrunner:'Road Runner Spirits'
};
const SHOP_COUNTRY = {
  oldtowntequila:'US', siptequila:'US', sftequilashop:'US', hiproof:'US', klwines:'US',
  remedy:'US', delmesa:'US', uptown:'US', thirdbase:'US', hitime:'US', montagave:'US', chips:'US', frootbat:'US', kegnbottles:'US',
  hedonism:'GB', totalwine:'US', masterofmalt:'GB', whiskyexchange:'GB', maisonduwhisky:'FR', whiskysite:'NL',
  ludwig:'US', beverlyhills:'US', elcerrito:'US', roadrunner:'US'
};

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
function num(v) { const s = String(v || '').trim(); return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null; }
function readCSV(name) { if (!fs.existsSync(name)) { console.error('見つかりません:', process.cwd() + '/' + name); process.exit(1); } return parseCSV(fs.readFileSync(name, 'utf8')); }
// アクセント（á/ñ/í 等）を畳んでから英数字のみに正規化。
// 例: "Años"→"anos" / "Tapatío"→"tapatio"。店側の英字表記と道場マスタを揃える。
function norm(s){ return String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,''); }
async function commitChunked(ops) { for (let i = 0; i < ops.length; i += 400) { const b = db.batch(); ops.slice(i, i + 400).forEach(o => b.set(o.ref, o.data, { merge: true })); await b.commit(); } }

(async () => {
  const items = readCSV(`${SHOP}_tequila_final.csv`).filter(r => r.is_drink === '1' && r.is_set !== '1');
  const shopName = SHOP_NAMES[SHOP] || SHOP;

  // 任意：マスタCSVがあれば英字名一致で紐付け（道場にあるもの）
  let masters = [];
  if (fs.existsSync('tequiladojo_master.csv')) {
    masters = parseCSV(fs.readFileSync('tequiladojo_master.csv', 'utf8'))
      .map(m => ({ bottleId: m.bottleId || m.id, key: norm(m.bottleEs), es: m.bottleEs || '' }))
      .filter(m => m.key.length >= 6); // 短すぎる名は誤マッチ防止で除外
    masters.sort((a, b) => b.key.length - a.key.length); // 長い名を優先
  }
  function matchMaster(name) {
    const n = norm(name); if (!n) return null;
    for (const m of masters) { if (n.indexOf(m.key) >= 0) return m; }
    return null;
  }

  let matched = 0;
  const ops = items.map(it => {
    const m = masters.length ? matchMaster(it.name) : null;
    if (m) matched++;
    return { ref: db.collection('marketIntl').doc(SHOP + '__' + it.id), data: {
      shop: SHOP, shopName, country: SHOP_COUNTRY[SHOP] || '', currency: it.currency || 'USD',
      name: it.name || '', brandGuess: it.brand_guess || '', classGuess: it.class_guess || '',
      price: num(it.price_yen), price750: num(it.price_750ml), volumeMl: num(it.volume_ml),
      availability: it.availability || '', url: it.url || '',
      bottleId: m ? m.bottleId : '', matched: !!m, matchedName: m ? m.es : '',
      source: 'crawl-intl', updatedAt: FV.serverTimestamp()
    } };
  });
  await commitChunked(ops);
  console.log(`[${SHOP}] marketIntl ${ops.length}件 取り込み（道場マッチ ${matched}件${masters.length ? '' : ' / master未読込のためマッチなし'}）`);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
