const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const BACKUP_DIR = path.join(__dirname, 'backup');

async function exportCollection(name, docPath) {
  console.log('Exporting ' + name + '...');
  var snap;
  if (docPath) {
    // single document
    var doc = await db.doc(docPath).get();
    var data = doc.exists ? [{ id: doc.id, data: doc.data() }] : [];
    return data;
  }
  snap = await db.collection(name).get();
  return snap.docs.map(function(d) { return { id: d.id, data: d.data() }; });
}

async function main() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

  var timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  var dir = path.join(BACKUP_DIR, timestamp);
  fs.mkdirSync(dir);

  var collections = ['members', 'memberIndex', 'visits', 'blindResults', 'tempRegistrations'];
  for (var i = 0; i < collections.length; i++) {
    var name = collections[i];
    var docs = await exportCollection(name);
    fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(docs, null, 2));
    console.log('  ' + name + ': ' + docs.length + ' docs');
  }

  // settings/memberCounter も保存
  var counterDoc = await db.collection('settings').doc('memberCounter').get();
  var counterData = counterDoc.exists ? counterDoc.data() : null;
  fs.writeFileSync(path.join(dir, 'memberCounter.json'), JSON.stringify(counterData, null, 2));

  console.log('\nBackup saved to: ' + dir);
  console.log('To restore: BACKUP_DIR="' + dir + '" node restore-member-data.js');
}

main().catch(function(e) { console.error(e); process.exit(1); });
