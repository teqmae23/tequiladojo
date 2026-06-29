/**
 * ロールバック用リストアスクリプト
 * 使い方: BACKUP_DIR="scripts/backup/2026-..." node restore-member-data.js
 *
 * 指定バックアップディレクトリのJSONから全ドキュメントをFirestoreに上書き復元します。
 * settings/memberCounter も削除します。
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

var BACKUP_DIR = process.env.BACKUP_DIR;
if (!BACKUP_DIR) {
  console.error('BACKUP_DIR 環境変数を指定してください');
  console.error('例: BACKUP_DIR="scripts/backup/2026-..." node restore-member-data.js');
  process.exit(1);
}

var BATCH_SIZE = 400;

async function restoreCollection(name) {
  var file = path.join(BACKUP_DIR, name + '.json');
  if (!fs.existsSync(file)) {
    console.log('  ' + name + ': ファイルなし、スキップ');
    return;
  }
  var docs = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log('Restoring ' + name + ': ' + docs.length + ' docs...');

  // Firestoreの既存ドキュメントを全削除してから復元
  var existingSnap = await db.collection(name).get();
  var toDelete = existingSnap.docs.map(function(d) { return d.ref; });
  for (var i = 0; i < toDelete.length; i += BATCH_SIZE) {
    var batch = db.batch();
    toDelete.slice(i, i + BATCH_SIZE).forEach(function(ref) { batch.delete(ref); });
    await batch.commit();
  }

  // バックアップから復元
  for (var j = 0; j < docs.length; j += BATCH_SIZE) {
    var batch2 = db.batch();
    docs.slice(j, j + BATCH_SIZE).forEach(function(entry) {
      batch2.set(db.collection(name).doc(entry.id), entry.data);
    });
    await batch2.commit();
  }
  console.log('  done.');
}

async function main() {
  console.log('=== ロールバック開始 ===');
  console.log('バックアップ: ' + BACKUP_DIR);
  console.log('');

  var collections = ['members', 'memberIndex', 'visits', 'blindResults', 'tempRegistrations'];
  for (var i = 0; i < collections.length; i++) {
    await restoreCollection(collections[i]);
  }

  // memberCounter を削除（移行前の状態に戻す）
  await db.collection('settings').doc('memberCounter').delete();
  console.log('settings/memberCounter を削除しました');

  console.log('\n=== ロールバック完了 ===');
}

main().catch(function(e) { console.error(e); process.exit(1); });
