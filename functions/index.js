// firebase-functions v6ではトップレベルがv2 APIのため、v1 APIを明示的に読み込む
const functions = require('firebase-functions/v1');
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

// ── 共通: スタッフ/オーナー権限チェック ─────────────────────────
// claims → staffRoles/{uid} → members(authUid).role の順で確認する
async function resolveStaffRole(context) {
  if (!context.auth) return null;
  const claimRole = context.auth.token.role;
  if (claimRole === 'owner' || claimRole === 'staff') return claimRole;
  try {
    const sr = await db.collection('staffRoles').doc(context.auth.uid).get();
    if (sr.exists && ['owner', 'staff'].includes(sr.data().role)) return sr.data().role;
  } catch (e) { /* noop */ }
  try {
    const ms = await db.collection('members').where('authUid', '==', context.auth.uid).limit(1).get();
    if (!ms.empty && ['owner', 'staff'].includes(ms.docs[0].data().role)) return ms.docs[0].data().role;
  } catch (e) { /* noop */ }
  return null;
}

async function assertStaff(context) {
  const role = await resolveStaffRole(context);
  if (!role) throw new functions.https.HttpsError('permission-denied', 'スタッフ権限が必要です');
  return role;
}

// ── 会員本人の来店・注文・ブラインド結果を返す ─────────────────
// visits/orders はセキュリティルールでスタッフ限定読み取りのため、
// 会員向けページ（mypage/tastinglog/member_map）はここ経由で本人分のみ取得する
exports.getMemberActivity = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.firebase.sign_in_provider === 'anonymous') {
      throw new functions.https.HttpsError('unauthenticated', 'ログインが必要です');
    }
    // 対象会員の解決（previewMemberId はスタッフのみ指定可能）
    let memberId = null;
    let memberData = null;
    const preview = data && data.previewMemberId ? String(data.previewMemberId) : null;
    if (preview) {
      await assertStaff(context);
      const mDoc = await db.collection('members').doc(preview).get();
      if (!mDoc.exists) throw new functions.https.HttpsError('not-found', '会員が見つかりません');
      memberId = mDoc.id; memberData = mDoc.data();
    } else {
      const snap = await db.collection('members').where('authUid', '==', context.auth.uid).limit(1).get();
      if (snap.empty) throw new functions.https.HttpsError('not-found', '会員情報が見つかりません');
      memberId = snap.docs[0].id; memberData = snap.docs[0].data();
    }

    // visits: realId（docID）と旧displayIdの両方で紐づく可能性がある
    const idSet = new Set([memberId]);
    if (memberData.memberId) idSet.add(String(memberData.memberId));
    if (memberData.displayId) idSet.add(String(memberData.displayId));
    const visitsMap = {};
    for (const mid of idSet) {
      const vs = await db.collection('visits').where('memberId', '==', mid).get();
      vs.forEach((d) => { visitsMap[d.id] = Object.assign({ id: d.id }, d.data()); });
    }
    const visits = Object.values(visitsMap);
    const visitIds = visits.map((v) => v.id);

    // orders: visitKey（新）/visitId（旧）両対応
    const ordersMap = {};
    for (let i = 0; i < visitIds.length; i += 30) {
      const chunk = visitIds.slice(i, i + 30);
      const s1 = await db.collection('orders').where('visitKey', 'in', chunk).get();
      s1.forEach((d) => { ordersMap[d.id] = Object.assign({ id: d.id }, d.data()); });
      const s2 = await db.collection('orders').where('visitId', 'in', chunk).get();
      s2.forEach((d) => { ordersMap[d.id] = Object.assign({ id: d.id }, d.data()); });
    }
    const orders = Object.values(ordersMap);

    // blindResults: 自分の注文が属するバッチ全員分（正解表示・同席者表示に必要）
    const batchIds = [...new Set(orders.map((o) => o.batchId).filter(Boolean))];
    const blindResults = [];
    for (let i = 0; i < batchIds.length; i += 30) {
      const s = await db.collection('blindResults').where('batchId', 'in', batchIds.slice(i, i + 30)).get();
      s.forEach((d) => {
        const r = Object.assign({ id: d.id }, d.data());
        if (r.answeredAt && r.answeredAt.toMillis) r.answeredAt = r.answeredAt.toMillis();
        blindResults.push(r);
      });
    }

    // 同席情報: 同一バッチ内の他会員の注文（visitKey/batchIdのみ返す）
    const myVkSet = new Set(visitIds);
    const batchOrders = [];
    for (let i = 0; i < batchIds.length; i += 30) {
      const s = await db.collection('orders').where('batchId', 'in', batchIds.slice(i, i + 30)).get();
      s.forEach((d) => {
        const o = d.data();
        const vk = o.visitKey || o.visitId;
        if (vk && !myVkSet.has(vk)) batchOrders.push({ visitKey: vk, batchId: o.batchId });
      });
    }

    // 他visitKey → memberId、memberId → ニックネーム
    const otherVks = [...new Set([
      ...batchOrders.map((b) => b.visitKey),
      ...blindResults.map((r) => r.visitKey || r.visitId).filter((vk) => vk && !myVkSet.has(vk)),
    ])];
    const visitMemberMap = {};
    for (let i = 0; i < otherVks.length; i += 100) {
      const refs = otherVks.slice(i, i + 100).map((vk) => db.collection('visits').doc(String(vk)));
      const snaps = await db.getAll(...refs);
      snaps.forEach((s) => { if (s.exists && s.data().memberId) visitMemberMap[s.id] = s.data().memberId; });
    }
    const otherMids = [...new Set([
      ...Object.values(visitMemberMap),
      ...blindResults.map((r) => r.customerId).filter(Boolean),
    ])].filter((m) => m && m !== memberId);
    const memberNames = {};
    for (let i = 0; i < otherMids.length; i += 100) {
      const refs = otherMids.slice(i, i + 100).map((m) => db.collection('members').doc(String(m)));
      const snaps = await db.getAll(...refs);
      snaps.forEach((s) => {
        if (s.exists) { const md = s.data(); memberNames[s.id] = md.nickname || md.name || s.id; }
      });
    }

    return { memberId, visits, orders, blindResults, batchOrders, visitMemberMap, memberNames };
  });

// ── 会員登録（新規・引継コード共通） ─────────────────────────────
// カウンター採番・アカウント作成・会員ドキュメント作成をサーバー側で行う
function allocDisplayId() {
  const year = String(new Date().getFullYear()).slice(2);
  const ref = db.collection('settings').doc('memberCounter');
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const d = doc.exists ? doc.data() : {};
    const seqMap = d.memberSeq || {};
    const next = (seqMap[year] || 0) + 1;
    seqMap[year] = next;
    tx.set(ref, { memberSeq: seqMap }, { merge: true });
    return year + String(next).padStart(4, '0');
  });
}
function allocRealId() {
  const ref = db.collection('settings').doc('memberCounter');
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const d = doc.exists ? doc.data() : {};
    const realSeq = d.realSeq || 101;
    tx.set(ref, { realSeq: realSeq + 1 }, { merge: true });
    return String(realSeq).padStart(6, '0');
  });
}
function regError(e) {
  if (e && e.code === 'auth/email-already-exists') {
    return new functions.https.HttpsError('already-exists', 'このメールアドレスは既に登録されています');
  }
  if (e && e.code === 'auth/invalid-email') {
    return new functions.https.HttpsError('invalid-argument', 'メールアドレスの形式が正しくありません');
  }
  if (e && e.code === 'auth/invalid-password') {
    return new functions.https.HttpsError('invalid-argument', 'パスワードは8文字以上にしてください');
  }
  return new functions.https.HttpsError('internal', (e && e.message) || '登録に失敗しました');
}
function writeServerJournal(op, col, docId, before, after, page) {
  return db.collection('journals').add({
    op, col, docId: String(docId),
    before: before || null, after: after || null,
    by: 'functions:' + page, at: admin.firestore.FieldValue.serverTimestamp(), page,
  }).catch(() => {});
}

exports.registerMember = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const nickname = ((data && data.nickname) || '').trim();
    const email = ((data && data.email) || '').trim();
    const password = (data && data.password) || '';
    const transferCode = ((data && data.transferCode) || '').trim().toUpperCase();
    const wantStatus = (data && data.status) === 'active' ? 'active' : 'pending';
    if (!password || password.length < 8) {
      throw new functions.https.HttpsError('invalid-argument', 'パスワードは8文字以上にしてください');
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new functions.https.HttpsError('invalid-argument', 'メールアドレスの形式が正しくありません');
    }
    const today = new Date().toISOString().slice(0, 10);

    if (transferCode) {
      // ── 引継コードによる本登録 ──
      if (!email) throw new functions.https.HttpsError('invalid-argument', 'メールアドレスを入力してください');
      const codeRef = db.collection('tempRegistrations').doc(transferCode);
      const codeSnap = await codeRef.get();
      if (!codeSnap.exists) throw new functions.https.HttpsError('not-found', '引継コードが見つかりません');
      const cd = codeSnap.data();
      if (cd.used) throw new functions.https.HttpsError('failed-precondition', '引継コードは既に使用済みです');
      if (cd.expiresAt && new Date(cd.expiresAt) < new Date()) {
        throw new functions.https.HttpsError('failed-precondition', '引継コードの有効期限が切れています');
      }
      const realId = String(cd.tempId || '');
      const memRef = db.collection('members').doc(realId);
      const memSnap = await memRef.get();
      if (!memSnap.exists) throw new functions.https.HttpsError('not-found', '引継対象の会員が見つかりません');
      const memBefore = memSnap.data();
      if (memBefore.authUid) {
        throw new functions.https.HttpsError('already-exists', 'この会員は既にアカウント連携済みです');
      }
      let user;
      try { user = await auth.createUser({ email, password }); } catch (e) { throw regError(e); }
      try {
        const displayId = await allocDisplayId();
        const upd = {
          authUid: user.uid, email, nickname: nickname || cd.nickname || memBefore.nickname || null,
          status: 'pending', isGuest: false, registeredAt: today,
          displayId, memberId: displayId,
        };
        const batch = db.batch();
        batch.update(memRef, upd);
        batch.set(db.collection('memberIndex').doc(realId), { email });
        batch.update(codeRef, { used: true });
        await batch.commit();
        await writeServerJournal('update', 'members', realId, memBefore, Object.assign({}, memBefore, upd), 'registerMember');
        return { memberId: displayId, realId, authEmail: email, transfer: true };
      } catch (e) {
        await auth.deleteUser(user.uid).catch(() => {});
        throw new functions.https.HttpsError('internal', '登録処理に失敗しました: ' + e.message);
      }
    }

    // ── 新規登録 ──
    if (!nickname) throw new functions.https.HttpsError('invalid-argument', 'ニックネームを入力してください');
    const realId = await allocRealId();
    const displayId = await allocDisplayId();
    const authEmail = email || (displayId + '@tequiladojo.member');
    let user;
    try { user = await auth.createUser({ email: authEmail, password }); } catch (e) { throw regError(e); }
    try {
      const memberDoc = {
        authUid: user.uid, realId, displayId, memberId: displayId,
        email: email || null,
        status: email ? wantStatus : 'active',
        nickname, registeredAt: today,
        visitCount: 0, totalAmount: 0, totalTequila: 0,
      };
      const batch = db.batch();
      batch.set(db.collection('members').doc(realId), memberDoc);
      batch.set(db.collection('memberIndex').doc(realId), { email: authEmail });
      await batch.commit();
      await writeServerJournal('create', 'members', realId, null, memberDoc, 'registerMember');
      return { memberId: displayId, realId, authEmail, transfer: false };
    } catch (e) {
      await auth.deleteUser(user.uid).catch(() => {});
      throw new functions.https.HttpsError('internal', '登録処理に失敗しました: ' + e.message);
    }
  });

// ── 店頭ステータス（Firestore + RTDB）をスタッフ権限で更新 ──────
// RTDB側は「.write: false」にしてこの関数経由のみとする
exports.setStoreStatus = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    await assertStaff(context);
    const status = (data && data.status) || 'closed';
    if (!['open', 'closed', 'break'].includes(status)) {
      throw new functions.https.HttpsError('invalid-argument', 'statusはopen/closed/breakのいずれかです');
    }
    const extraIn = (data && data.extra) || {};
    const extra = {};
    ['layoutId', 'sessionDate', 'breakResumeTime'].forEach((k) => {
      if (extraIn[k] !== undefined && extraIn[k] !== null) extra[k] = extraIn[k];
    });
    const fsData = Object.assign({ status, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, extra);
    const prev = await db.collection('storeStatus').doc('current').get();
    await db.collection('storeStatus').doc('current').set(fsData);
    await admin.database().ref('storeStatus').set(Object.assign({ status, updatedAt: Date.now() }, extra));
    await writeServerJournal('update', 'storeStatus', 'current',
      prev.exists ? prev.data() : null, Object.assign({ status }, extra), 'setStoreStatus');
    return { ok: true };
  });

// ── 公開: 店頭ステータス＋来店数を返す（index.html用・認証不要） ──
exports.getStoreStatus = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const doc = await db.collection('storeStatus').doc('current').get();
    if (!doc.exists) return { status: 'closed' };
    const sd = doc.data();
    const out = { status: sd.status || 'closed' };
    if (out.status === 'break') {
      out.breakResumeTime = sd.breakResumeTime || null;
      return out;
    }
    if (out.status === 'open') {
      if (sd.sessionDate) {
        const vs = await db.collection('visits').where('visitDate', '==', sd.sessionDate).get();
        out.active = vs.docs.filter((d) => !d.data().checkoutTime && !d.data().isStaff).length;
      }
      if (sd.layoutId) {
        const l = await db.collection('layouts').doc(String(sd.layoutId)).get();
        if (l.exists) out.seats = l.data().seats;
      }
    }
    return out;
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
