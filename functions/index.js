const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const db = admin.firestore();
const auth = admin.auth();

// ── roleをCustom Claimsに設定 ──────────────────────────────────
// Firestoreのmembers/{memberId}.roleをCustom Claimsに同期する
exports.setCustomClaims = functions.region('asia-northeast1')
  .firestore.document('members/{memberId}')
  .onWrite(async (change, context) => {
    const data = change.after.exists ? change.after.data() : null;
    if (!data) return null;

    const role = data.role || null;
    const authUid = data.authUid || null;
    if (!authUid) return null;

    try {
      const currentUser = await auth.getUser(authUid);
      const currentClaims = currentUser.customClaims || {};
      if (currentClaims.role === role) return null; // 変更なし

      await auth.setCustomUserClaims(authUid, { role: role });
      console.log(`Set role=${role} for uid=${authUid} (memberId=${context.params.memberId})`);
    } catch (e) {
      console.error('setCustomClaims error:', e);
    }
    return null;
  });

// ── 既存会員のClaims一括設定（初回セットアップ用） ─────────────
exports.syncAllRoles = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    // ownerのみ実行可能
    if (!context.auth || context.auth.token.role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', 'オーナー権限が必要です');
    }
    const snap = await db.collection('members').where('role', '!=', null).get();
    const results = [];
    for (const doc of snap.docs) {
      const d = doc.data();
      if (!d.authUid || !d.role) continue;
      try {
        await auth.setCustomUserClaims(d.authUid, { role: d.role });
        results.push({ memberId: doc.id, authUid: d.authUid, role: d.role, ok: true });
      } catch (e) {
        results.push({ memberId: doc.id, authUid: d.authUid, error: e.message });
      }
    }
    return { results };
  });

// ── スタッフ管理（home.htmlから呼び出し） ─────────────────────
exports.setUserRole = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', 'オーナー権限が必要です');
    }
    const { uid, role } = data;
    if (!uid) throw new functions.https.HttpsError('invalid-argument', 'uidが必要です');

    if (role === null || role === undefined) {
      await auth.setCustomUserClaims(uid, {});
    } else {
      await auth.setCustomUserClaims(uid, { role });
    }
    // Firestoreのmembersも更新
    const snap = await db.collection('members').where('authUid', '==', uid).limit(1).get();
    if (!snap.empty) {
      await snap.docs[0].ref.update({ role: role || null });
    }
    return { ok: true };
  });

exports.getStaffList = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', 'オーナー権限が必要です');
    }
    const listResult = await auth.listUsers(1000);
    const staff = listResult.users
      .filter(u => u.customClaims && u.customClaims.role)
      .map(u => ({
        uid: u.uid,
        email: u.email,
        role: u.customClaims.role
      }));
    return { staff };
  });

// ── オーナーによる会員メールアドレス変更 ──────────────────────────
exports.adminUpdateEmail = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', 'オーナー権限が必要です');
    }
    const { memberId, newEmail } = data;
    if (!memberId) throw new functions.https.HttpsError('invalid-argument', 'memberIdが必要です');
    if (!newEmail || !newEmail.includes('@')) throw new functions.https.HttpsError('invalid-argument', '有効なメールアドレスを入力してください');

    const memberDoc = await db.collection('members').doc(memberId).get();
    if (!memberDoc.exists) throw new functions.https.HttpsError('not-found', '会員が見つかりません');
    const memberData = memberDoc.data();
    if (!memberData.authUid) throw new functions.https.HttpsError('failed-precondition', 'Auth連携がありません');

    // メールアドレスの重複確認
    try {
      const existing = await auth.getUserByEmail(newEmail);
      if (existing.uid !== memberData.authUid) {
        throw new functions.https.HttpsError('already-exists', 'そのメールアドレスは既に使用されています');
      }
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }

    await auth.updateUser(memberData.authUid, { email: newEmail, emailVerified: true });

    const batch = db.batch();
    batch.update(db.collection('members').doc(memberId), {
      email: newEmail,
      pendingEmail: admin.firestore.FieldValue.delete(),
      status: 'active'
    });
    batch.set(db.collection('memberIndex').doc(memberId), { email: newEmail });
    await batch.commit();

    return { ok: true };
  });
