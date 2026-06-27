const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function main() {
  console.log('Fetching bottleData...');
  const snap = await db.collection('bottleData').get();

  const nomHasBottle = new Set();
  const nomHasJapanBottle = new Set();

  snap.docs.forEach(function(doc) {
    var bd = doc.data();
    if (!bd.brandId) return;
    var nom = String(bd.brandId).slice(0, 4);
    nomHasBottle.add(nom);
    if (String(bd.importType || '') === '0' || bd.importType === 0) {
      nomHasJapanBottle.add(nom);
    }
  });

  await db.collection('settings').doc('nomCache').set({
    nomHasBottle: Array.from(nomHasBottle),
    nomHasJapanBottle: Array.from(nomHasJapanBottle),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    docCount: snap.size
  });

  console.log(
    'Done. nomHasBottle:', nomHasBottle.size,
    '/ nomHasJapanBottle:', nomHasJapanBottle.size,
    '/ total bottleData docs:', snap.size
  );
}

main().catch(function(e) { console.error(e); process.exit(1); });
