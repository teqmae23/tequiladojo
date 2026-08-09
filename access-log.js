/**
 * access-log.js — 会員のページアクセス記録（共通・自動実行）
 *
 * 会員系ページの末尾で <script src="/access-log.js?v=..."></script> を読み込むだけで、
 * ログイン中の会員がそのページを開いたことを accessLogs コレクションへ1件記録する。
 *
 * accessLogs/{autoId}:
 *   memberId  会員ドキュメントID(realId)
 *   name      会員名（表示用の非正規化）
 *   page      ページキー（下の PAGE_KEYS）
 *   authUid   認証UID（ルールで request.auth.uid と一致を強制）
 *   at        serverTimestamp
 *
 * 間引き: 同一ページは THROTTLE_MS 以内は記録しない（端末のlocalStorageで判定）。
 * 権限: 会員は create のみ（読み取り不可）、閲覧はスタッフ/オーナー（firestore.rules）。
 */
(function () {
  var THROTTLE_MS = 10 * 60 * 1000; // 10分

  var PAGE_KEYS = {
    'member.html': 'member',
    'mypage.html': 'mypage',
    'menu.html': 'menu',
    'member_map.html': 'map',
    'tequila_movie.html': 'movie',
    'seminars.html': 'seminars',
    'member_ptd.html': 'ptd',
    'member_subscription.html': 'subscription',
    'member_collection.html': 'collection',
    'library.html': 'library'
  };

  var file = (location.pathname.split('/').pop() || '').toLowerCase().replace(/[?#].*$/, '');
  var page = PAGE_KEYS[file] || file.replace(/\.html$/, '') || 'page';
  var handled = false;

  // 直近に同一ページを記録済みなら true（記録しない）。未記録なら now を保存して false。
  function throttled() {
    try {
      var k = 'alog:' + page;
      var last = parseInt(localStorage.getItem(k) || '0', 10) || 0;
      if (Date.now() - last < THROTTLE_MS) return true;
      localStorage.setItem(k, String(Date.now()));
      return false;
    } catch (e) { return false; }
  }

  function waitForFirebase() {
    if (!window.firebase || !firebase.apps || !firebase.apps.length) {
      return setTimeout(waitForFirebase, 300);
    }
    var auth, db;
    try { auth = firebase.auth(); db = firebase.firestore(); } catch (e) { return; }
    auth.onAuthStateChanged(function (user) {
      if (handled) return;
      if (!user || user.isAnonymous) return;
      handled = true;               // このページ読み込みでは1回だけ処理
      if (throttled()) return;      // 間引き
      db.collection('members').where('authUid', '==', user.uid).limit(1).get()
        .then(function (snap) {
          if (snap.empty) return;   // 会員でなければ記録しない
          var m = snap.docs[0].data() || {};
          db.collection('accessLogs').add({
            memberId: snap.docs[0].id,
            name: m.name || '',
            page: page,
            authUid: user.uid,
            at: firebase.firestore.FieldValue.serverTimestamp()
          }).catch(function () {});
        })
        .catch(function () {});
    });
  }

  waitForFirebase();
})();
