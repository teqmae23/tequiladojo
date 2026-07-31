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
// 語順違いの照合用トークン列。アクセント畳込み後、3文字未満と一般語のみ除外。
// ※ クラス語（blanco/reposado/anejo 等）はボトルを区別する重要トークンなので【残す】
//    （落とすとブランコとレポサドが同一視され誤マッチになる）。
const STOP = new Set(['tequila','the','and','with','for','de','la','el','los','las','con','por','ml','cl','liter','litre','bottle']);
function tokens(s){ return String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOP.has(t) && !/^\d+ml$/.test(t)); }
async function commitChunked(ops) { for (let i = 0; i < ops.length; i += 400) { const b = db.batch(); ops.slice(i, i + 400).forEach(o => { if (o.del) b.delete(o.ref); else b.set(o.ref, o.data, { merge: true }); }); await b.commit(); } }

(async () => {
  const items = readCSV(`${SHOP}_tequila_final.csv`).filter(r => r.is_drink === '1' && r.is_set !== '1');
  const shopName = SHOP_NAMES[SHOP] || SHOP;

  // 任意：マスタCSVがあれば英字名一致で紐付け（道場にあるもの）
  let masters = [];
  if (fs.existsSync('tequiladojo_master.csv')) {
    masters = parseCSV(fs.readFileSync('tequiladojo_master.csv', 'utf8'))
      .map(m => { const tk = tokens(m.bottleEs);
        return { bottleId: m.bottleId || m.id, key: norm(m.bottleEs), es: m.bottleEs || '', tk, tkLen: tk.join('').length }; })
      .filter(m => m.key.length >= 6); // 短すぎる名は誤マッチ防止で除外
    masters.sort((a, b) => b.key.length - a.key.length); // 長い名を優先
  }
  function matchMaster(name) {
    const n = norm(name); if (!n) return null;
    // 1) 連続部分一致（厳密・最優先）: 店名の中にマスタ名がそのまま含まれる
    for (const m of masters) { if (n.indexOf(m.key) >= 0) return m; }
    // 2) トークン全一致（語順違い・語間挿入を吸収。例: "100 ANOS TEQUILA BLANCO"）
    //    ガード: マスタ語数>=2 かつ 有効文字合計>=8 の時のみ（誤マッチ抑制）。
    //    マスタの全トークンが店名トークンに存在すれば一致。最も特徴の多い（合計長最大）候補を採用。
    const itemToks = new Set(tokens(name));
    if (!itemToks.size) return null;
    let best = null;
    for (const m of masters) {
      if (m.tk.length < 2 || m.tkLen < 8) continue;
      if (m.tk.every(t => itemToks.has(t)) && (!best || m.tkLen > best.tkLen)) best = m;
    }
    return best;
  }

  // NG/OKワード（settings/marketFilter）。NG語を含み、かつOK語を含まないものを除外。
  let ng = [], ok = [];
  try {
    const fdoc = await db.doc('settings/marketFilter').get();
    if (fdoc.exists) { const d = fdoc.data() || {};
      ng = (d.ng || []).map(s => String(s).toLowerCase().trim()).filter(Boolean);
      ok = (d.ok || []).map(s => String(s).toLowerCase().trim()).filter(Boolean);
    }
  } catch (e) { console.warn('marketFilter 読込失敗（除外なしで継続）:', e.message); }
  function passFilter(name) {
    const n = String(name || '').toLowerCase();
    if (ng.length && ng.some(w => n.indexOf(w) >= 0)) return ok.some(w => n.indexOf(w) >= 0);
    return true;
  }

  // 履歴の日付（JST）。--date YYYY-MM-DD で上書き可。
  const dateArgIdx = process.argv.indexOf('--date');
  const DAY = dateArgIdx >= 0 ? process.argv[dateArgIdx + 1] : new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const inStock = av => /在庫あり|in ?stock|available|true/i.test(String(av || ''));

  let matched = 0, dropped = 0, kept = 0;
  const ops = [];
  items.forEach(it => {
    const ref = db.collection('marketIntl').doc(SHOP + '__' + it.id);
    const href = db.collection('marketIntlHistory').doc(SHOP + '__' + it.id);
    if (!passFilter(it.name)) {                        // NG: 現行・履歴とも削除（いらないものは蓄積しない）
      dropped++; ops.push({ ref, del: true }); ops.push({ ref: href, del: true }); return;
    }
    kept++;
    const m = masters.length ? matchMaster(it.name) : null;
    if (m) matched++;
    ops.push({ ref, data: {
      shop: SHOP, shopName, country: SHOP_COUNTRY[SHOP] || '', currency: it.currency || 'USD',
      name: it.name || '', brandGuess: it.brand_guess || '', classGuess: it.class_guess || '',
      price: num(it.price_yen), price750: num(it.price_750ml), volumeMl: num(it.volume_ml), abv: num(it.abv),
      availability: it.availability || '', url: it.url || '',
      bottleId: m ? m.bottleId : '', matched: !!m, matchedName: m ? m.es : '',
      source: 'crawl-intl', updatedAt: FV.serverTimestamp()
    } });
    // 履歴: 日付キーのマップに当日値を追記（merge。同日再実行は上書き）
    const p750 = num(it.price_750ml);
    if (p750 != null) ops.push({ ref: href, data: {
      shop: SHOP, shopName, name: it.name || '', bottleId: m ? m.bottleId : '',
      currency: it.currency || 'USD', itemKey: SHOP + '__' + it.id,
      hist: { [DAY]: { p: p750, s: inStock(it.availability) ? 1 : 0 } }
    } });
  });
  await commitChunked(ops);
  console.log(`[${SHOP}] marketIntl 取込 ${kept}件 / 除外 ${dropped}件 / 道場マッチ ${matched}件 / 履歴日 ${DAY}${masters.length ? '' : ' / master未読込'}`);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
