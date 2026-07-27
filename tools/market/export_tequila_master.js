// tequiladojo のテキーラ・ボトルマスタ(bottleData + brands) を CSV に書き出す
// 実行: cd ~/functions && node <repo>/tools/market/export_tequila_master.js
//   （firebase-admin は ~/functions/node_modules を利用。認証は Cloud Shell の ADC）
const admin = require('firebase-admin');
const fs = require('fs');
admin.initializeApp({ projectId: 'tequiladojo' });
const db = admin.firestore();
function esc(s){ s=String(s==null?'':s); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }
(async () => {
  const [bs, brs] = await Promise.all([db.collection('bottleData').get(), db.collection('brands').get()]);
  const brands={}; brs.forEach(d=>brands[d.id]=d.data());
  const rows=[];
  bs.forEach(d=>{ const b=d.data(); const v=b.visibility;
    const shown=(v==='0'||v===0||v===false||v==null)?1:0;
    const bid=String(b.bottleId||''); const brandId=b.brandId||(bid.length>=7?bid.slice(0,7):'');
    const br=brands[brandId]||{};
    rows.push({id:d.id,bottleId:bid,bottleEs:b.bottleEs||b.bottleEsBase||'',bottleJa:b.bottleJa||b.bottleJaBase||'',
      bottleEn:b.bottleEn||'',nom:b.nom||(bid.length>=4?bid.slice(0,4):''),brandId,brandJa:br.brandJa||'',
      brandEs:br.brandEs||'',classId:b.classId||'',abv:b.abv!=null?b.abv:'',
      price10:(b.price!=null?b.price:(b.unitPrice!=null?b.unitPrice:'')),shown}); });
  const cols=['id','bottleId','bottleEs','bottleJa','bottleEn','nom','brandId','brandJa','brandEs','classId','abv','price10','shown'];
  const out=[cols.join(',')].concat(rows.map(r=>cols.map(c=>esc(r[c])).join(','))).join('\n');
  fs.writeFileSync('tequiladojo_master.csv', '﻿'+out);
  console.log(`書き出し完了: ${process.cwd()}/tequiladojo_master.csv  総${rows.length}件（掲載中 ${rows.filter(r=>r.shown).length}件）`);
})().catch(e=>{console.error('失敗:',e.message);process.exit(1);});
