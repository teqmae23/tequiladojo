/**
 * 会員ID二重化 移行スクリプト
 *
 * 実行前に必ずバックアップを取ること:
 *   node backup-member-data.js
 *
 * 処理内容:
 *   1. 既存 members/* に realId = doc.id, displayId = doc.id を追加
 *   2. settings/memberCounter を新規作成（カウンター初期化）
 *
 * visits/orders/blindResults/tempRegistrations は変更しない。
 * 既存アカウントは realId = displayId = 現行doc ID のため、
 * visits.memberId は既に realId を指している状態になる。
 */
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

var BATCH_SIZE = 400;

async function main() {
  // ── 1. members に realId / displayId を追加 ──────────────────────
  console.log('Fetching members...');
  var snap = await db.collection('members').get();
  console.log('  ' + snap.size + ' docs found');

  var chunks = [];
  for (var i = 0; i < snap.docs.length; i += BATCH_SIZE) {
    chunks.push(snap.docs.slice(i, i + BATCH_SIZE));
  }

  for (var c = 0; c < chunks.length; c++) {
    var batch = db.batch();
    chunks[c].forEach(function(doc) {
      var d = doc.data();
      // realId / displayId が未設定の場合のみ追加（冪等）
      if (!d.realId || !d.displayId) {
        batch.update(doc.ref, {
          realId:    doc.id,
          displayId: d.displayId || d.memberId || doc.id
        });
      }
    });
    await batch.commit();
    console.log('  batch ' + (c + 1) + '/' + chunks.length + ' done');
  }

  // ── 2. カウンター初期値を計算 ─────────────────────────────────────
  var guestMax = 900000;
  var memberSeq = {};
  var currentYear = String(new Date().getFullYear()).slice(2);

  snap.docs.forEach(function(doc) {
    var id = doc.id;
    var n = parseInt(id) || 0;
    // ゲストID（900001〜999999）
    if (n >= 900001 && n <= 999999 && n > guestMax) guestMax = n;
    // 本会員ID（YY0001〜YY9999）
    var yy = id.slice(0, 2);
    var seq = parseInt(id.slice(2)) || 0;
    if (/^\d{2}$/.test(yy) && seq > 0 && seq < 9000) {
      if (!memberSeq[yy] || seq > memberSeq[yy]) memberSeq[yy] = seq;
    }
  });

  var counterData = {
    realSeq:   101,                            // 次のrealId = "000101"
    guestSeq:  guestMax + 1,                   // 次のゲストdisplayId
    memberSeq: memberSeq,                       // 年別 最終連番
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  // 既存カウンターがあれば realSeq だけ引き継ぐ（再実行時の冪等性）
  var existing = await db.collection('settings').doc('memberCounter').get();
  if (existing.exists) {
    var ex = existing.data();
    if (ex.realSeq && ex.realSeq > counterData.realSeq) {
      counterData.realSeq = ex.realSeq;
    }
  }

  await db.collection('settings').doc('memberCounter').set(counterData);

  console.log('\n=== 移行完了 ===');
  console.log('members 更新: ' + snap.size + ' docs');
  console.log('memberCounter:');
  console.log('  realSeq  :', counterData.realSeq, '→ 次のrealId:', String(counterData.realSeq).padStart(6, '0'));
  console.log('  guestSeq :', counterData.guestSeq);
  console.log('  memberSeq:', JSON.stringify(counterData.memberSeq));
}

main().catch(function(e) { console.error(e); process.exit(1); });
