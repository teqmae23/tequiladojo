// firebase-functions v6ではトップレベルがv2 APIのため、v1 APIを明示的に読み込む
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const { defineSecret } = require('firebase-functions/params');
admin.initializeApp();

const db = admin.firestore();
const auth = admin.auth();

// ── Stripe（決済） ────────────────────────────────────────────────
// stripeWebhook / createStripeCustomer 用のシークレット。値はGCP側で設定済み。
const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');
const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');
// StripeのPrice ID → 会員グレード対応
const PRICE_GRADE_MAP = {
  'price_1TUegc1PL3PJaVpo3Hc1vuH6': 1,
  'price_1TUei41PL3PJaVpoiiQn3Or0': 2,
};

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

// ── members.email 変更を memberIndex に同期（会員IDログインの解決用） ──
// memberIndexはスタッフ限定書き込みのため、会員本人のメール変更確定時は
// このトリガーがサーバー権限で反映する
exports.syncMemberIndex = functions.region('asia-northeast1')
  .firestore.document('members/{memberId}')
  .onWrite(async (change, context) => {
    const after = change.after.exists ? change.after.data() : null;
    if (!after) return null;
    const before = change.before.exists ? change.before.data() : {};
    const newEmail = after.email || '';
    if (!newEmail || newEmail === (before.email || '')) return null;
    try {
      await db.collection('memberIndex').doc(context.params.memberId)
        .set({ email: newEmail }, { merge: true });
    } catch (e) {
      console.error('syncMemberIndex error:', e);
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

// ── 会員本人のデポジット履歴を返す（depositData はスタッフ限定読み取りのため） ──
exports.getMyDepositHistory = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.firebase.sign_in_provider === 'anonymous') {
      throw new functions.https.HttpsError('unauthenticated', 'ログインが必要です');
    }
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
    const ds = await db.collection('depositData').where('memberId', '==', memberId).get();
    const items = ds.docs.map((d) => {
      const x = d.data();
      return {
        date: x.date || '', time: x.time || '',
        amount: x.amount || 0,
        balanceAfter: x.balanceAfter != null ? x.balanceAfter : null,
        kind: x.kind || '', source: x.source || '',
      };
    });
    items.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    const enabled = memberData.depositEnabled === 1 || memberData.depositEnabled === '1' || memberData.depositEnabled === true;
    return { enabled, balance: Number(memberData.depositBalance || 0), items };
  });

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

// ── 会員IDログイン: ID→メール解決とパスワード検証をサーバー側で行う ──
// memberIndexを公開読み取りにするとID総当たりで全会員のメールが列挙できてしまうため、
// メールアドレスを端末に返さずにログインを成立させる。
// 検証はIdentity Toolkitに委譲し、成功時のみカスタムトークンを返す。
exports.loginWithMemberId = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const memberId = ((data && data.memberId) || '').trim();
    const password = (data && data.password) || '';
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(memberId) || !password) {
      throw new functions.https.HttpsError('invalid-argument', 'IDとパスワードを入力してください');
    }
    // ID→メール解決（memberIndexに登録がなければ仮想ドメイン）
    let email = memberId + '@tequiladojo.member';
    try {
      const idx = await db.collection('memberIndex').doc(memberId).get();
      if (idx.exists && idx.data().email) email = idx.data().email;
    } catch (e) { /* noop */ }
    // パスワード検証（Web APIキーは公開情報のため秘匿対象ではない）
    const API_KEY = 'AIzaSyD6a3i-N1RyXyAfXmztPQrYtx4x62YGth0';
    const resp = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      }
    );
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok || !body.localId) {
      // 存在しないID・誤パスワードを区別せず同一メッセージ（列挙対策）
      throw new functions.https.HttpsError('unauthenticated', 'IDまたはパスワードが正しくありません');
    }
    const token = await auth.createCustomToken(body.localId);
    return { token };
  });

// ── 店頭ステータス（Firestore + RTDB）をスタッフ権限で更新 ──────
// RTDB側は「.write: false」にしてこの関数経由のみとする
// RTDBはデプロイ後に作成されてもよいようURLを明示し、失敗しても
// Firestore更新が成功していればエラーにしない（index.htmlはgetStoreStatusにフォールバックする）
const RTDB_URL = 'https://tequiladojo-default-rtdb.firebaseio.com';
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
    let rtdbOk = true;
    try {
      await admin.app().database(RTDB_URL).ref('storeStatus')
        .set(Object.assign({ status, updatedAt: Date.now() }, extra));
    } catch (e) {
      rtdbOk = false;
      console.warn('RTDB write failed (RTDB未作成の可能性。Firestore更新は成功):', e.message);
    }
    await writeServerJournal('update', 'storeStatus', 'current',
      prev.exists ? prev.data() : null, Object.assign({ status }, extra), 'setStoreStatus');
    return { ok: true, rtdb: rtdbOk };
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

// ── 孤児Auth検出 ──────────────────────────────────────────────────
// membersドキュメントに紐づかない（＝ログインできるのに会員マスタに存在しない）
// Firebase Authアカウントを洗い出す。ハード削除でAuthだけ残ったケース等の調査用。
exports.listOrphanAuthUsers = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', 'オーナー権限が必要です');
    }
    // members の authUid を収集（削除済みも含めて突合する）
    const memSnap = await db.collection('members').get();
    const linkedUids = new Set();
    memSnap.forEach((d) => { const u = d.data().authUid; if (u) linkedUids.add(u); });

    const orphans = [];
    let totalAuth = 0;
    let pageToken;
    do {
      const res = await auth.listUsers(1000, pageToken);
      res.users.forEach((u) => {
        totalAuth++;
        if (!linkedUids.has(u.uid)) {
          orphans.push({
            uid: u.uid,
            email: u.email || null,
            disabled: !!u.disabled,
            creationTime: (u.metadata && u.metadata.creationTime) || null,
            lastSignInTime: (u.metadata && u.metadata.lastSignInTime) || null,
          });
        }
      });
      pageToken = res.pageToken;
    } while (pageToken);

    return { orphans, totalAuth, totalMembers: memSnap.size, linkedCount: linkedUids.size };
  });

// ═══════════════════════════════════════════════════════════════════
// 以下は従来 us-central1 にデプロイされている関数（Stripe決済・旧admin系）。
// リージョン未指定のため us-central1 にデプロイされる（現状維持）。
// ※注意: setUserRole / getStaffList の旧版（staffコレクション使用）は
//   asia-northeast1 版（上部）が現行のため、ここには含めない。
// ═══════════════════════════════════════════════════════════════════

// ── Stripe Webhook（サブスク支払い状態を members に反映） ──
exports.stripeWebhook = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] })
  .https.onRequest(async (req, res) => {
    const stripe = require('stripe')(stripeSecretKey.value());
    const webhookSecret = stripeWebhookSecret.value();
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers['stripe-signature'],
        webhookSecret
      );
    } catch (err) {
      return res.status(400).send('Webhook Error: ' + err.message);
    }

    const obj = event.data.object;

    if (event.type === 'invoice.payment_succeeded') {
      const cid = obj.customer;
      const line = (obj.lines && obj.lines.data && obj.lines.data[0]) || {};
      // StripeのAPIバージョン差異に耐性を持たせる（旧: line.price / 新: line.pricing.price_details.price）
      let priceId = (line.price && line.price.id)
        || (line.pricing && line.pricing.price_details && line.pricing.price_details.price)
        || (line.plan && line.plan.id) || null;
      // subscription も旧 invoice.subscription / 新 parent.subscription_details.subscription 等に対応
      let subId = obj.subscription
        || (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription)
        || (line.parent && line.parent.subscription_item_details && line.parent.subscription_item_details.subscription)
        || null;
      let periodEnd = (line.period && line.period.end) || obj.period_end || null;
      // 請求書(invoice)の形はAPIバージョンで揺れるため、取れない項目はサブスク本体から補完する
      // （サブスクの items.data[0].price.id は版に依らず安定して取得できる）
      if ((!priceId || !periodEnd) && subId) {
        try {
          const sub = await stripe.subscriptions.retrieve(subId);
          const it = sub.items && sub.items.data && sub.items.data[0];
          if (!priceId && it && it.price) priceId = it.price.id;
          if (!periodEnd) periodEnd = sub.current_period_end || (it && it.current_period_end) || null;
        } catch (e) { /* ignore */ }
      }
      // plans コレクションから priceId→level を動的解決（無ければ旧マップにフォールバック）
      let grade = null;
      let planId = null;
      try {
        const psnap = await db.collection('plans')
          .where('stripePriceId', '==', priceId).limit(1).get();
        if (!psnap.empty) {
          grade = Number(psnap.docs[0].data().level) || 0;
          planId = psnap.docs[0].id;
        }
      } catch (e) { /* ignore */ }
      if (grade == null) grade = PRICE_GRADE_MAP[priceId];
      if (grade != null) {
        const snap = await db.collection('members')
          .where('stripeCustomerId', '==', cid).limit(1).get();
        if (!snap.empty) {
          await snap.docs[0].ref.update({
            grade: grade,
            subscriptionPlanId: planId,
            stripeSubscriptionId: subId,
            subscriptionStatus: 'active',
            subscriptionPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
          });
        }
      }
    } else if (event.type === 'invoice.payment_failed') {
      const cid = obj.customer;
      const snap = await db.collection('members')
        .where('stripeCustomerId', '==', cid).limit(1).get();
      if (!snap.empty) {
        await snap.docs[0].ref.update({ subscriptionStatus: 'past_due' });
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const cid = obj.customer;
      const snap = await db.collection('members')
        .where('stripeCustomerId', '==', cid).limit(1).get();
      if (!snap.empty) {
        await snap.docs[0].ref.update({
          grade: 0,
          subscriptionPlanId: null,
          stripeSubscriptionId: null,
          subscriptionStatus: 'canceled',
          subscriptionPeriodEnd: null,
          cancelAtPeriodEnd: false,
        });
      }
    } else if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      // サブスクの作成・変更（申込直後のグレード付与／プラン変更・期末解約予約・状態遷移）を反映する。
      // invoice.payment_succeeded の請求書パースはAPIバージョンで揺れるため、グレード付与は
      // price.id が安定して取れる customer.subscription.* を主経路にする（created を必ず購読すること）。
      const cid = obj.customer;
      const item = (obj.items && obj.items.data && obj.items.data[0]) || {};
      const priceId = (item.price && item.price.id) || (item.plan && item.plan.id) || null;
      let grade = null;
      let planId = null;
      if (priceId) {
        try {
          const psnap = await db.collection('plans')
            .where('stripePriceId', '==', priceId).limit(1).get();
          if (!psnap.empty) { grade = Number(psnap.docs[0].data().level) || 0; planId = psnap.docs[0].id; }
        } catch (e) { /* ignore */ }
        if (grade == null && PRICE_GRADE_MAP[priceId] != null) grade = PRICE_GRADE_MAP[priceId];
      }
      const status = obj.status; // active / trialing / past_due / canceled / unpaid / incomplete...
      const periodEnd = obj.current_period_end || item.current_period_end || null;
      const snap = await db.collection('members')
        .where('stripeCustomerId', '==', cid).limit(1).get();
      if (!snap.empty) {
        const upd = {
          stripeSubscriptionId: obj.id,
          subscriptionStatus: (status === 'trialing' ? 'active' : status),
          cancelAtPeriodEnd: !!obj.cancel_at_period_end,
        };
        if (periodEnd) upd.subscriptionPeriodEnd = new Date(periodEnd * 1000);
        // 有効な間はグレードを最新プランへ追随（プラン変更に対応）。
        // 失効（canceled/unpaid 等）は customer.subscription.deleted 側で grade=0 に落とす。
        if (grade != null && (status === 'active' || status === 'trialing' || status === 'past_due')) {
          upd.grade = grade;
          upd.subscriptionPlanId = planId;
        }
        await snap.docs[0].ref.update(upd);
      }
    } else if (event.type === 'checkout.session.completed') {
      // 単発購入（セミナー等）の完了 → 購入記録を書き込み
      const md = obj.metadata || {};
      if (md.type === 'seminar' && md.memberId && md.seminarId) {
        const pid = md.memberId + '_' + md.seminarId;
        await db.collection('seminarPurchases').doc(pid).set({
          memberId: md.memberId,
          seminarId: md.seminarId,
          amount: obj.amount_total || null,
          stripeSessionId: obj.id,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }

    res.json({ received: true });
  });

// ── サブスク Checkout / カスタマーポータル（会員向け・us-central1） ──
const SUBSCRIPTION_ALLOWED_ORIGINS = [
  'https://tequiladojo.com',
  'https://www.tequiladojo.com',
  'https://tequiladojo.web.app',
  'https://tequiladojo.firebaseapp.com',
];
function safeSubOrigin(o) {
  if (typeof o === 'string' && SUBSCRIPTION_ALLOWED_ORIGINS.indexOf(o) >= 0) return o;
  return SUBSCRIPTION_ALLOWED_ORIGINS[0];
}

// 有料会員サブスクの申込 Checkout セッションを作成
exports.createSubscriptionCheckout = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.firebase.sign_in_provider === 'anonymous') {
      throw new functions.https.HttpsError('unauthenticated', 'ログインが必要です');
    }
    const stripe = require('stripe')(stripeSecretKey.value());
    const planId = data && data.planId;
    if (!planId) throw new functions.https.HttpsError('invalid-argument', 'planId が必要です');
    const origin = safeSubOrigin(data && data.origin);

    const msnap = await db.collection('members')
      .where('authUid', '==', context.auth.uid).limit(1).get();
    if (msnap.empty) throw new functions.https.HttpsError('not-found', '会員情報が見つかりません');
    const memberRef = msnap.docs[0].ref;
    const member = msnap.docs[0].data();
    const memberId = msnap.docs[0].id;

    const pdoc = await db.collection('plans').doc(planId).get();
    if (!pdoc.exists) throw new functions.https.HttpsError('not-found', 'プランが見つかりません');
    const plan = pdoc.data();
    if (!plan.stripePriceId) {
      throw new functions.https.HttpsError('failed-precondition', 'このプランにはStripe Price IDが未設定です');
    }

    // Stripe顧客を作成して members に保存
    async function createAndSaveCustomer() {
      const customer = await stripe.customers.create({
        email: member.email || member.authEmail || undefined,
        name: member.name || '',
        metadata: { memberId: memberId },
      });
      await memberRef.update({ stripeCustomerId: customer.id });
      return customer.id;
    }
    function sessionParams(cust) {
      return {
        mode: 'subscription',
        customer: cust,
        line_items: [{ price: plan.stripePriceId, quantity: 1 }],
        client_reference_id: memberId,
        metadata: { memberId: memberId, planId: planId, level: String(plan.level != null ? plan.level : '') },
        success_url: origin + '/member_subscription.html?checkout=success',
        cancel_url: origin + '/member_subscription.html?checkout=cancel',
        allow_promotion_codes: true,
      };
    }

    // Stripe顧客を用意（無ければ作成して保存）
    let customerId = member.stripeCustomerId || (await createAndSaveCustomer());

    let session;
    try {
      session = await stripe.checkout.sessions.create(sessionParams(customerId));
    } catch (e) {
      // 保存済みの顧客IDが無効（別モード/削除済み等で No such customer）なら、
      // 顧客を作り直して members を更新し、1度だけ再試行する（手動でのID削除を不要に）。
      const missingCustomer = e && e.code === 'resource_missing'
        && (e.param === 'customer' || String(e.message || '').toLowerCase().indexOf('customer') >= 0);
      if (!missingCustomer) throw e;
      customerId = await createAndSaveCustomer();
      session = await stripe.checkout.sessions.create(sessionParams(customerId));
    }
    return { url: session.url };
  });

// 会員が自分でサブスクを管理・解約するためのカスタマーポータル
exports.createCustomerPortal = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.firebase.sign_in_provider === 'anonymous') {
      throw new functions.https.HttpsError('unauthenticated', 'ログインが必要です');
    }
    const stripe = require('stripe')(stripeSecretKey.value());
    const origin = safeSubOrigin(data && data.origin);
    const msnap = await db.collection('members')
      .where('authUid', '==', context.auth.uid).limit(1).get();
    if (msnap.empty) throw new functions.https.HttpsError('not-found', '会員情報が見つかりません');
    const member = msnap.docs[0].data();
    if (!member.stripeCustomerId) {
      throw new functions.https.HttpsError('failed-precondition', 'サブスク情報がありません');
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: member.stripeCustomerId,
      return_url: origin + '/member_subscription.html',
    });
    return { url: session.url };
  });

// ── 有料セミナー（動画）: 単発購入 / グレード連動 / 視聴アクセス ──

// 会員の有効プランを解決（手動plan > 有効サブスクgrade > 無料）
async function resolveMemberPlan(member) {
  if (member.plan) {
    const pd = await db.collection('plans').doc(member.plan).get();
    if (pd.exists) return pd.data();
  }
  if (member.subscriptionStatus === 'active' && member.grade != null && member.grade !== '') {
    const ps = await db.collection('plans').where('level', '==', Number(member.grade)).limit(1).get();
    if (!ps.empty) return ps.docs[0].data();
  }
  return null;
}

// セミナーへのアクセス可否を判定
async function memberHasSeminarAccess(memberId, member, seminar) {
  const mode = seminar.accessMode || 'purchase';
  if (mode === 'grade' || mode === 'both') {
    const feature = seminar.requiredFeature || 'seminar';
    const plan = await resolveMemberPlan(member);
    if (plan && plan.features && plan.features[feature]) return true;
  }
  if (mode === 'purchase' || mode === 'both') {
    const pd = await db.collection('seminarPurchases').doc(memberId + '_' + seminar.id).get();
    if (pd.exists) return true;
  }
  return false;
}

async function requireMember(context) {
  if (!context.auth || context.auth.token.firebase.sign_in_provider === 'anonymous') {
    throw new functions.https.HttpsError('unauthenticated', 'ログインが必要です');
  }
  const msnap = await db.collection('members').where('authUid', '==', context.auth.uid).limit(1).get();
  if (msnap.empty) throw new functions.https.HttpsError('not-found', '会員情報が見つかりません');
  return { ref: msnap.docs[0].ref, id: msnap.docs[0].id, data: msnap.docs[0].data() };
}

// 単発セミナーの購入 Checkout（mode: payment）
exports.createSeminarCheckout = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
    const m = await requireMember(context);
    const stripe = require('stripe')(stripeSecretKey.value());
    const seminarId = data && data.seminarId;
    if (!seminarId) throw new functions.https.HttpsError('invalid-argument', 'seminarId が必要です');
    const origin = safeSubOrigin(data && data.origin);

    const sdoc = await db.collection('seminars').doc(seminarId).get();
    if (!sdoc.exists) throw new functions.https.HttpsError('not-found', 'セミナーが見つかりません');
    const s = sdoc.data();

    // 既に購入済みなら二重購入を防ぐ
    const owned = await db.collection('seminarPurchases').doc(m.id + '_' + seminarId).get();
    if (owned.exists) throw new functions.https.HttpsError('already-exists', '既に購入済みです');

    let lineItem;
    if (s.stripePriceId) {
      lineItem = { price: s.stripePriceId, quantity: 1 };
    } else if (s.price != null && Number(s.price) > 0) {
      lineItem = {
        price_data: { currency: 'jpy', product_data: { name: s.title || 'セミナー' }, unit_amount: Math.round(Number(s.price)) },
        quantity: 1,
      };
    } else {
      throw new functions.https.HttpsError('failed-precondition', 'このセミナーには価格が設定されていません');
    }

    let customerId = m.data.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: m.data.email || m.data.authEmail || undefined,
        name: m.data.name || '',
        metadata: { memberId: m.id },
      });
      customerId = customer.id;
      await m.ref.update({ stripeCustomerId: customerId });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: [lineItem],
      client_reference_id: m.id,
      metadata: { type: 'seminar', memberId: m.id, seminarId: seminarId },
      success_url: origin + '/seminars.html?purchase=success',
      cancel_url: origin + '/seminars.html?purchase=cancel',
    });
    return { url: session.url };
  });

// 視聴アクセス検証つきで vimeoId を返す（アクセス不可なら locked）
exports.getSeminarVideo = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
    const m = await requireMember(context);
    const seminarId = data && data.seminarId;
    if (!seminarId) throw new functions.https.HttpsError('invalid-argument', 'seminarId が必要です');
    const sdoc = await db.collection('seminars').doc(seminarId).get();
    if (!sdoc.exists) throw new functions.https.HttpsError('not-found', 'セミナーが見つかりません');
    const s = Object.assign({ id: seminarId }, sdoc.data());
    const ok = await memberHasSeminarAccess(m.id, m.data, s);
    if (!ok) return { locked: true };
    const src = await db.collection('seminarSources').doc(seminarId).get();
    return { vimeoId: src.exists ? (src.data().vimeoId || '') : '' };
  });

// 会員が購入済みのセミナーID一覧（UI表示用）
exports.getMyPurchasedSeminars = functions
  .https.onCall(async (data, context) => {
    const m = await requireMember(context);
    const snap = await db.collection('seminarPurchases').where('memberId', '==', m.id).get();
    return { ids: snap.docs.map((d) => d.data().seminarId) };
  });

// ── 会員作成時に Stripe 顧客を作成 ──
exports.createStripeCustomer = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .firestore.document('members/{uid}')
  .onCreate(async (snap) => {
    const stripe = require('stripe')(stripeSecretKey.value());
    const data = snap.data();
    const email = data.email || data.authEmail;
    if (!email) return;
    try {
      const customer = await stripe.customers.create({
        email: email,
        name: data.name || '',
      });
      await snap.ref.update({ stripeCustomerId: customer.id });
    } catch (err) {
      console.error('Stripe顧客作成失敗:', err.message);
    }
  });

// ── 会員削除時にFirebase Authアカウントも削除 ──
// 実際のFirebase Auth UIDは members ドキュメントの authUid フィールドに入っている。
// ドキュメントID（現行モデルでは realId）はAuth UIDと一致しないため、authUid を優先し、
// 無い場合のみ従来どおりドキュメントIDにフォールバックする（旧データ互換）。
// これによりハード削除時にAuthアカウントが残る（孤児Auth）問題を防止する。
exports.deleteMemberAuth = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .firestore.document('members/{uid}')
  .onDelete(async (snap, context) => {
    const data = (snap && snap.data()) || {};
    const authUid = data.authUid || context.params.uid;
    try {
      await admin.auth().deleteUser(authUid);
      console.log('Auth削除成功:', authUid);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        console.log('Auth既に削除済み:', authUid);
      } else {
        console.error('Auth削除失敗:', err.message);
      }
    }
  });

// ── authEmailからauthUidを補完するHTTPS Function（旧データ移行用） ──
exports.fixMemberAuthUids = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onRequest(async (req, res) => {
    if (req.query.secret !== 'tequiladojo-admin-fix') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const snap = await db.collection('members').get();
    const results = [];
    for (const doc of snap.docs) {
      const d = doc.data();
      if (d.authEmail && !d.authUid) {
        try {
          const userRecord = await admin.auth().getUserByEmail(d.authEmail);
          await doc.ref.update({ authUid: userRecord.uid });
          results.push({ id: doc.id, authEmail: d.authEmail, uid: userRecord.uid, status: 'fixed' });
        } catch (e) {
          results.push({ id: doc.id, authEmail: d.authEmail, status: 'error', message: e.message });
        }
      }
    }
    res.json({ fixed: results.length, results });
  });

// ── 管理者によるAuth操作（作成・削除・メール/パスワード変更） ──
exports.adminAuthOperation = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です');
    }
    const callerDoc = await db.collection('members')
      .where('authUid', '==', context.auth.uid).limit(1).get();
    if (callerDoc.empty || callerDoc.docs[0].data().role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', '管理者権限が必要です');
    }

    const { operation, memberId, email, password, authUid } = data;

    if (operation === 'create') {
      const authEmail = email || (memberId + '@tequiladojo.member');
      try {
        const user = await admin.auth().createUser({ email: authEmail, password: password });
        await db.collection('members').doc(memberId).update({ authUid: user.uid });
        return { success: true, uid: user.uid };
      } catch (e) {
        throw new functions.https.HttpsError('already-exists', e.message);
      }
    } else if (operation === 'delete') {
      try {
        await admin.auth().deleteUser(authUid);
        return { success: true };
      } catch (e) {
        throw new functions.https.HttpsError('not-found', e.message);
      }
    } else if (operation === 'updateEmail') {
      try {
        await admin.auth().updateUser(authUid, { email: data.email });
        return { success: true };
      } catch (e) {
        throw new functions.https.HttpsError('not-found', e.message);
      }
    } else if (operation === 'updatePassword') {
      try {
        await admin.auth().updateUser(authUid, { password: password });
        return { success: true };
      } catch (e) {
        throw new functions.https.HttpsError('not-found', e.message);
      }
    }
    throw new functions.https.HttpsError('invalid-argument', '不明な操作です');
  });

// ── 管理者による強制本登録（emailVerifiedをtrueに設定） ──
exports.forceVerifyEmail = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です');
    }
    const callerSnap = await db.collection('members')
      .where('authUid', '==', context.auth.uid).limit(1).get();
    if (callerSnap.empty || callerSnap.docs[0].data().role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', '管理者権限が必要です');
    }
    const { authUid, email } = data;
    try {
      await admin.auth().updateUser(authUid, { emailVerified: true, email: email });
      return { success: true };
    } catch (e) {
      throw new functions.https.HttpsError('not-found', e.message);
    }
  });

// ═══════════════════════════════════════════════════════════════════
//  会員セルフ来店（QR）＆ オンライン注文
//  visits/orders はスタッフ限定書き込みのため、会員操作はここ経由で行う。
// ═══════════════════════════════════════════════════════════════════

// 認証済み会員本人を authUid から解決する
async function resolveMember(context) {
  if (!context.auth || context.auth.token.firebase.sign_in_provider === 'anonymous') {
    throw new functions.https.HttpsError('unauthenticated', 'ログインが必要です');
  }
  const snap = await db.collection('members')
    .where('authUid', '==', context.auth.uid).limit(1).get();
  if (snap.empty) throw new functions.https.HttpsError('not-found', '会員情報が見つかりません');
  return { id: snap.docs[0].id, data: snap.docs[0].data() };
}

// 現在の店頭ステータス（open判定・営業日）を取得
async function getStoreState() {
  const ss = await db.collection('storeStatus').doc('current').get();
  if (!ss.exists) return { open: false, sessionDate: null };
  const d = ss.data();
  return { open: d.status === 'open', sessionDate: d.sessionDate || null };
}

// 会員の「未退場」来店を営業日で探す（realId・旧displayId両対応）
async function findActiveVisit(member, sessionDate) {
  if (!sessionDate) return null;
  const idSet = [member.id];
  if (member.data.displayId) idSet.push(String(member.data.displayId));
  if (member.data.memberId) idSet.push(String(member.data.memberId));
  let visitKey = null;
  for (const mid of [...new Set(idSet)]) {
    const vs = await db.collection('visits')
      .where('memberId', '==', mid).where('visitDate', '==', sessionDate).get();
    vs.forEach((d) => { if (!d.data().checkoutTime) visitKey = d.id; });
  }
  return visitKey;
}

// ── 店舗来店QRトークンの再発行（スタッフ） ──
exports.rotateCheckinToken = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    await assertStaff(context);
    const token = 'CK' + Math.random().toString(36).slice(2, 10).toUpperCase()
      + Date.now().toString(36).toUpperCase();
    await db.collection('settings').doc('checkinConfig').set({
      token, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ok: true, token };
  });

// ── 会員のセルフ来店リクエスト（来店QRスキャン） ──
// トークン照合＋開店中チェックの上、承認待ちリクエストを作成する。
// 実際の来店確定・来店時刻はスタッフ承認時に確定する。
exports.requestCheckin = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const member = await resolveMember(context);
    const raw = (data && data.token ? String(data.token) : '').trim();
    // URL形式（...?checkin=xxx）で渡された場合はクエリを抽出
    let token = raw;
    const m = raw.match(/[?&]checkin=([^&\s]+)/);
    if (m) token = decodeURIComponent(m[1]);

    const cfg = await db.collection('settings').doc('checkinConfig').get();
    const validToken = cfg.exists ? (cfg.data().token || '') : '';
    if (!validToken) {
      throw new functions.https.HttpsError('failed-precondition', '来店QRが未設定です。スタッフにお知らせください。');
    }
    if (!token || token !== validToken) {
      throw new functions.https.HttpsError('invalid-argument', '来店QRが正しくありません。店舗のQRを読み取ってください。');
    }
    const store = await getStoreState();
    if (!store.open) {
      throw new functions.https.HttpsError('failed-precondition', '現在は営業時間外です。');
    }
    // 既に来店中（承認済み・未退場）なら成功として返す
    const active = await findActiveVisit(member, store.sessionDate);
    if (active) return { ok: true, status: 'checkedin', visitKey: active };
    // 承認待ちの重複を防ぐ
    const existReq = await db.collection('checkinRequests')
      .where('memberId', '==', member.id)
      .where('sessionDate', '==', store.sessionDate)
      .where('status', '==', 'pending').limit(1).get();
    if (!existReq.empty) return { ok: true, status: 'pending', requestId: existReq.docs[0].id };

    const name = member.data.nickname || member.data.name || member.data.displayId || member.id;
    const ref = await db.collection('checkinRequests').add({
      memberId: member.id,
      memberName: name,
      displayId: member.data.displayId || member.data.memberId || null,
      sessionDate: store.sessionDate,
      status: 'pending',
      source: 'qr',
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { ok: true, status: 'pending', requestId: ref.id };
  });

// ── 会員の現在の来店状況（注文可否判定用） ──
exports.getMyVisitStatus = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const member = await resolveMember(context);
    const store = await getStoreState();
    const visitKey = store.open ? await findActiveVisit(member, store.sessionDate) : null;
    let pending = false;
    if (store.open && store.sessionDate) {
      const pr = await db.collection('checkinRequests')
        .where('memberId', '==', member.id)
        .where('sessionDate', '==', store.sessionDate)
        .where('status', '==', 'pending').limit(1).get();
      pending = !pr.empty;
    }
    return {
      storeOpen: store.open,
      sessionDate: store.sessionDate,
      checkedIn: !!visitKey,
      visitKey: visitKey || null,
      pending,
      memberId: member.id,
      memberName: member.data.nickname || member.data.name || member.id,
    };
  });

// ── 会員のオンライン注文（来店確定者のみ） ──
// 商品マスタをサーバー側で検証し価格を確定して orders を作成する。
exports.placeMemberOrder = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const member = await resolveMember(context);
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    if (!items.length) throw new functions.https.HttpsError('invalid-argument', '注文内容がありません');
    if (items.length > 30) throw new functions.https.HttpsError('invalid-argument', '一度に注文できる品数を超えています');

    const store = await getStoreState();
    if (!store.open) throw new functions.https.HttpsError('failed-precondition', '現在は営業時間外です');
    if (!store.sessionDate) throw new functions.https.HttpsError('failed-precondition', '営業セッションが確認できません');
    const visitKey = await findActiveVisit(member, store.sessionDate);
    if (!visitKey) {
      throw new functions.https.HttpsError('failed-precondition',
        '来店登録が必要です。店舗のQRから来店手続きを行い、スタッフの承認をお待ちください。');
    }

    // 商品マスタ検証・価格算出（テキーラ／その他ドリンクのみ）
    const ALLOWED = { tequila: 'bottleData', other: 'otherBottles', misc: 'miscProducts' };
    const resolved = [];
    for (const it of items) {
      const pt = String(it.productType || '');
      const pid = String(it.productId || '');
      if (!ALLOWED[pt]) throw new functions.https.HttpsError('invalid-argument', '注文できない商品種別です: ' + pt);
      if (!pid) throw new functions.https.HttpsError('invalid-argument', '商品IDがありません');
      const doc = await db.collection(ALLOWED[pt]).doc(pid).get();
      if (!doc.exists) throw new functions.https.HttpsError('not-found', '商品が見つかりません');
      const p = doc.data();
      const isMl = (pt === 'tequila' || pt === 'other');
      let qty = Math.round(Number(it.qty || 0));
      if (isMl) {
        if (!(qty > 0) || qty > 500) throw new functions.https.HttpsError('invalid-argument', 'ml数が不正です');
      } else {
        if (!(qty > 0) || qty > 99) throw new functions.https.HttpsError('invalid-argument', '数量が不正です');
      }
      if (pt === 'tequila') {
        const vis = p.visibility;
        const orderable = (vis === '0' || vis === 0 || vis === false || vis === undefined || vis === null);
        if (!orderable) throw new functions.https.HttpsError('failed-precondition', 'この商品は現在注文できません');
      }
      const unitPrice = Number(p.price != null ? p.price
        : (p.unitPrice != null ? p.unitPrice : (p.price10 != null ? p.price10 : 0))) || 0;
      const name = (pt === 'tequila')
        ? (p.bottleEs || p.bottleEsBase || p.bottleJa || p.name || pid)
        : (pt === 'other')
          ? (p.bottleEn || p.bottleName || p.name || p.bottleJa || pid)
          : (p.name || p.productName || pid);
      resolved.push({ productType: pt, productId: pid, qty, unit: isMl ? 'ml' : '個', unitPrice, productName: name });
    }

    // 注文時刻（営業時間・日跨ぎは24h+表記に合わせる）
    let openHHMM = null;
    try {
      const sess = await db.collection('sessions').where('date', '==', store.sessionDate).limit(1).get();
      if (!sess.empty) {
        const ot = String(sess.docs[0].data().openTime || '');
        if (ot.length >= 4) openHHMM = parseInt(ot.slice(0, 4), 10);
      }
    } catch (e) { /* noop */ }
    const jd = new Date(Date.now() + 9 * 3600 * 1000); // JST
    let oh = jd.getUTCHours(); const omin = jd.getUTCMinutes(); const osec = jd.getUTCSeconds();
    if (openHHMM != null && (oh * 100 + omin) < openHHMM) oh += 24;
    const orderTime = String(oh).padStart(2, '0') + String(omin).padStart(2, '0') + String(osec).padStart(2, '0');

    // orderGroupId 採番（会員の来店内で連番）・batchId は本注文で一意
    const vkOrders = await db.collection('orders').where('visitKey', '==', visitKey).get();
    let maxG = 0;
    vkOrders.forEach((d) => {
      const g = d.data().orderGroupId || '';
      const n = parseInt(g.slice(visitKey.length), 10) || 0;
      if (n > maxG) maxG = n;
    });
    const orderGroupId = visitKey + String(maxG + 1).padStart(2, '0');
    const batchId = store.sessionDate + 'M' + Date.now().toString(36).slice(-5).toUpperCase();

    const batch = db.batch();
    const created = [];
    resolved.forEach((r, i) => {
      const ref = db.collection('orders').doc();
      const od = {
        orderDate: store.sessionDate, orderTime,
        customerId: member.id, visitKey, orderGroupId, batchId,
        itemSeq: i + 1, productCode: r.productId, productName: r.productName,
        productType: r.productType, qty: r.qty, unit: r.unit, unitPrice: r.unitPrice,
        blindId: 0, blindMarkId: null, served: 1, source: 'online',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      batch.set(ref, od);
      created.push({ id: ref.id, data: od });
    });
    await batch.commit();
    created.forEach((c) => writeServerJournal('create', 'orders', c.id, null, c.data, 'placeMemberOrder'));
    return { ok: true, count: created.length, orderGroupId, batchId };
  });
