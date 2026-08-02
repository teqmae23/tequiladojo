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
// 正規化トークナイザ:
//  ・クラス同義を正準化（silver=plata=blanco / gold=oro=joven）
//  ・容量(750ml等)・度数(40%/80proof)は除去、既知の裸容量数(750等)も除外
//  ・その他の数字(48 / No 7 / 1942 等)は【識別子として保持】＝限定と定番を区別する肝
//  ・クラス語(blanco/reposado/anejo…)はボトル区別に必要なので保持
const CLASS = { silver:'blanco', plata:'blanco', plateado:'blanco', gold:'joven', oro:'joven', dorado:'joven' };
const STOP = new Set(['tequila','the','and','with','for','de','la','el','los','las','con','por','ml','cl','liter','litre','bottle','no']);
const VOLNUM = new Set(['50','100','180','200','330','375','500','700','720','750','1000','1500','1750']);
function tokens(s){
  let t = String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
  t = t.replace(/\d+(?:\.\d+)?\s*(?:ml|cl|l|liter|litre)\b/g,' ').replace(/\d+(?:\.\d+)?\s*%/g,' ').replace(/\d+\s*proof/g,' ');
  const out = [];
  t.split(/[^a-z0-9]+/).forEach(x => {
    if (!x) return;
    if (/^\d+$/.test(x)) { if (!VOLNUM.has(x)) out.push(x); return; }
    if (x.length >= 3 && !STOP.has(x)) out.push(CLASS[x] || x);
  });
  return out;
}
async function commitChunked(ops) { for (let i = 0; i < ops.length; i += 400) { const b = db.batch(); ops.slice(i, i + 400).forEach(o => { if (o.del) b.delete(o.ref); else b.set(o.ref, o.data, { merge: true }); }); await b.commit(); } }

(async () => {
  const items = readCSV(`${SHOP}_tequila_final.csv`).filter(r => r.is_drink === '1' && r.is_set !== '1');
  const shopName = SHOP_NAMES[SHOP] || SHOP;

  // 道場マスタ（brands / bottles）を読み込み、ブランド→ボトルの2段階照合に使う。
  //   1) 店名からブランドを特定（brand語 ⊆ 店名語・最長ブランド優先）
  //   2) そのブランドの bottles で集合一致 → 道場銘柄(matched)
  //   3) ブランドは判ったがボトル一致なし → newBottle（ブランド既知の新商品候補）
  //   4) ブランド不明 → unknown
  let brands = [], bottlesByBrand = {};
  if (fs.existsSync('tequiladojo_master.csv')) {
    const rows = parseCSV(fs.readFileSync('tequiladojo_master.csv', 'utf8'));
    const brSeen = {}, boSeen = {};
    rows.forEach(m => {
      const bid = String(m.bottleId || m.id || '');
      const brandId = String(m.brandId || (bid.length >= 7 ? bid.slice(0, 7) : ''));
      if (brandId && m.brandEs && !brSeen[brandId]) {
        const tk = tokens(m.brandEs);
        if (tk.length && tk.join('').length >= 3) { brSeen[brandId] = true; brands.push({ brandId, es: m.brandEs, tk, tkLen: tk.join('').length }); }
      }
      if (bid && m.bottleEs && !boSeen[bid]) {
        const tk = tokens(m.bottleEs);
        if (tk.length) { boSeen[bid] = true;
          (bottlesByBrand[brandId] = bottlesByBrand[brandId] || []).push({ bottleId: bid, es: m.bottleEs, tk, tku: new Set(tk).size, tkLen: tk.join('').length }); }
      }
    });
    brands.sort((a, b) => b.tkLen - a.tkLen); // 長いブランド優先（Don Julio > Don）
  }
  function classifyItem(name) {
    const it = new Set(tokens(name));
    if (!it.size) return { status: 'unknown', brandId: '', bottleId: '', matchedName: '' };
    let br = null;
    for (const b of brands) { if (b.tk.every(t => it.has(t)) && (!br || b.tkLen > br.tkLen)) br = b; }
    if (!br) return { status: 'unknown', brandId: '', bottleId: '', matchedName: '' };
    let bo = null;
    for (const c of (bottlesByBrand[br.brandId] || [])) {
      if (c.tku === it.size && c.tk.every(t => it.has(t)) && (!bo || c.tkLen > bo.tkLen)) bo = c;
    }
    if (bo) return { status: 'matched', brandId: br.brandId, bottleId: bo.bottleId, matchedName: bo.es };
    return { status: 'newBottle', brandId: br.brandId, bottleId: '', matchedName: '' };
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

  // 履歴の蓄積は --history を付けた時のみ（週次自動の月初回のみ想定・手動は蓄積しない）。
  //   日付（JST）。--date YYYY-MM-DD で上書き可。
  const HIST = process.argv.indexOf('--history') >= 0;
  const dateArgIdx = process.argv.indexOf('--date');
  const DAY = dateArgIdx >= 0 ? process.argv[dateArgIdx + 1] : new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const inStock = av => /在庫あり|in ?stock|available|true/i.test(String(av || ''));

  let matched = 0, newBottle = 0, dropped = 0, kept = 0;
  const ops = [];
  items.forEach(it => {
    const ref = db.collection('marketIntl').doc(SHOP + '__' + it.id);
    const href = db.collection('marketIntlHistory').doc(SHOP + '__' + it.id);
    if (!passFilter(it.name)) {                        // NG: 現行を削除。履歴は蓄積時のみ削除（手動実行は履歴に触れない）
      dropped++; ops.push({ ref, del: true }); if (HIST) ops.push({ ref: href, del: true }); return;
    }
    kept++;
    const cls = brands.length ? classifyItem(it.name) : { status: 'unknown', brandId: '', bottleId: '', matchedName: '' };
    if (cls.status === 'matched') matched++; else if (cls.status === 'newBottle') newBottle++;
    ops.push({ ref, data: {
      shop: SHOP, shopName, country: SHOP_COUNTRY[SHOP] || '', currency: it.currency || 'USD',
      name: it.name || '', brandGuess: it.brand_guess || '', classGuess: it.class_guess || '',
      price: num(it.price_yen), price750: num(it.price_750ml), volumeMl: num(it.volume_ml), abv: num(it.abv),
      availability: it.availability || '', url: it.url || '',
      bottleId: cls.bottleId, matched: cls.status === 'matched', matchedName: cls.matchedName || '',
      brandId: cls.brandId || '', matchStatus: cls.status,
      source: 'crawl-intl', updatedAt: FV.serverTimestamp()
    } });
    // 履歴: 日付キーのマップに当日値を追記（merge。同日再実行は上書き）。--history 指定時のみ。
    const p750 = num(it.price_750ml);
    if (HIST && p750 != null) ops.push({ ref: href, data: {
      shop: SHOP, shopName, name: it.name || '', bottleId: cls.bottleId,
      currency: it.currency || 'USD', itemKey: SHOP + '__' + it.id,
      hist: { [DAY]: { p: p750, s: inStock(it.availability) ? 1 : 0 } }
    } });
  });
  await commitChunked(ops);
  console.log(`[${SHOP}] marketIntl 取込 ${kept}件 / 除外 ${dropped}件 / 道場マッチ ${matched}件 / 新商品候補(ブランド既知) ${newBottle}件 / 履歴 ${HIST ? '記録(' + DAY + ')' : '無し'}${brands.length ? '' : ' / master未読込'}`);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
