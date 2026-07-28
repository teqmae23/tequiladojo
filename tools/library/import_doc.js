// 書庫ドキュメント（libraryDocs + chapters）を JSON から取り込む。
//   入力: {doc:{docId,title,subtitle,order,published,toc:[...]}, chapters:[{key,data:{...rows[]}}]}
// 実行: cd ~/functions && node <repo>/tools/library/import_doc.js <repo>/tools/library/nom006.json
//   認証は ADC（Cloud Shell）。既定は「安全モード」で、既存の文書・章は上書きしません
//   （＝翻訳や編集を保護。新規の章だけ追加）。全上書きは末尾に --force を付けてください。
const admin = require('firebase-admin');
const fs = require('fs');

const file = process.argv[2];
const FORCE = process.argv.includes('--force');
if (!file) { console.error('使い方: node import_doc.js <doc.json> [--force]'); process.exit(1); }
if (!fs.existsSync(file)) { console.error('見つかりません:', file); process.exit(1); }

const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
const doc = payload.doc || {};
const chapters = payload.chapters || [];
if (!doc.docId) { console.error('doc.docId がありません'); process.exit(1); }

admin.initializeApp({ projectId: 'tequiladojo' });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

(async () => {
  const docRef = db.collection('libraryDocs').doc(doc.docId);
  const docSnap = await docRef.get();
  const docExists = docSnap.exists;

  // 文書本体（存在時は --force のときだけ上書き。無い場合は新規作成し published:false）
  if (!docExists) {
    await docRef.set({
      title: doc.title || doc.docId, subtitle: doc.subtitle || '',
      order: doc.order || 1, published: doc.published === true,
      toc: doc.toc || [], updatedAt: FV.serverTimestamp()
    }, { merge: true });
    console.log(`[doc] 新規作成: ${doc.docId}`);
  } else if (FORCE) {
    await docRef.set({
      title: doc.title || doc.docId, subtitle: doc.subtitle || '',
      order: doc.order || 1, toc: doc.toc || [], updatedAt: FV.serverTimestamp()
    }, { merge: true });
    console.log(`[doc] 上書き(--force): ${doc.docId}（published は保持）`);
  } else {
    console.log(`[doc] 既存のため本体はスキップ: ${doc.docId}（--force で上書き）`);
  }

  let created = 0, overwritten = 0, skipped = 0;
  for (const ch of chapters) {
    if (!ch.key || !ch.data) continue;
    const chRef = docRef.collection('chapters').doc(ch.key);
    const snap = await chRef.get();
    const hasRows = snap.exists && Array.isArray(snap.get('rows')) && snap.get('rows').length > 0;
    if (!snap.exists) {
      await chRef.set(Object.assign({}, ch.data, { updatedAt: FV.serverTimestamp() }));
      created++;
    } else if (FORCE) {
      await chRef.set(Object.assign({}, ch.data, { updatedAt: FV.serverTimestamp() }), { merge: true });
      overwritten++;
    } else {
      // 既存章：本文(rows)を持つものは保護。空章なら構造だけ補う
      const patch = { num: ch.data.num, titleEs: ch.data.titleEs, isFront: ch.data.isFront, order: ch.data.order, updatedAt: FV.serverTimestamp() };
      if (!hasRows) patch.rows = ch.data.rows || [];
      await chRef.set(patch, { merge: true });
      skipped++;
    }
  }
  console.log(`[chapters] 新規 ${created} / 上書き ${overwritten} / 既存保護 ${skipped}`);
  console.log(`完了。閲覧は下書き状態です。admin_library で内容確認・翻訳のうえ「公開」してください。`);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
