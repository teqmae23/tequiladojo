/**
 * news-read.js — ニュースの既読/未読を会員ごとに管理する共通ロジック
 *
 * 保存先（会員ごとの「別ファイル」）: newsReads/{authUid}
 *   items: { [newsId]: "<既読にした時点の publishStart>" }
 *   updatedAt: serverTimestamp
 *
 * 未読判定の考え方:
 *   - 未読/既読の判別キーは publishStart（＝公開日時）。
 *     記事本文だけ更新しても publishStart は変わらないので既読のまま。
 *     公開日付を更新すると publishStart が変わり、保存値と食い違って再び未読になる。
 *   - BASELINE（2026-08-08）以前に公開されたニュースはすべて既読扱い。
 *   - 未ログイン時は未読表示しない（readsMap を渡さない/null）。
 *
 * firebase(compat) が読み込み済みのページで使う。window.NewsRead を公開する。
 */
(function (global) {
  var BASELINE = '2026-08-08'; // この日(以前)に公開されたニュースは既読扱い

  function pubKey(r) { return (r && (r.publishStart || r.createdAt)) || ''; }

  // 公開日が BASELINE より後で、かつ保存済みの既読キーと現在の publishStart が違えば未読
  function isUnread(r, readsMap) {
    if (!r || !readsMap) return false;
    var pub = pubKey(r);
    var d = pub.slice(0, 10);
    if (!d || d <= BASELINE) return false;
    return readsMap[r.id] !== pub;
  }

  function countUnread(list, readsMap) {
    if (!list || !readsMap) return 0;
    var n = 0;
    for (var i = 0; i < list.length; i++) { if (isUnread(list[i], readsMap)) n++; }
    return n;
  }

  // newsReads/{uid} を読み、items マップ（無ければ {}）を返す
  function load(db, uid) {
    if (!db || !uid) return Promise.resolve({});
    return db.collection('newsReads').doc(uid).get()
      .then(function (s) { return (s.exists && s.data() && s.data().items) || {}; })
      .catch(function () { return {}; });
  }

  // 記事を既読にする（現在の publishStart を保存）。readsMap を渡すと同期更新する。
  function markRead(db, uid, r, readsMap) {
    if (!db || !uid || !r || !r.id) return Promise.resolve();
    var pub = pubKey(r);
    if (readsMap) readsMap[r.id] = pub;
    var upd = { items: {}, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    upd.items[r.id] = pub;
    return db.collection('newsReads').doc(uid).set(upd, { merge: true }).catch(function () {});
  }

  // 目立つ未読バッジ（各ページのCSSに依存しないようインラインで指定）
  function badgeHtml() {
    return '<span class="news-unread-badge" style="display:inline-block;font-size:10px;font-weight:700;color:#fff;background:#e8130a;padding:1px 6px;border-radius:3px;letter-spacing:.04em;white-space:nowrap;box-shadow:0 0 0 2px rgba(232,19,10,.18);">未読</span>';
  }

  global.NewsRead = {
    BASELINE: BASELINE,
    pubKey: pubKey,
    isUnread: isUnread,
    countUnread: countUnread,
    load: load,
    markRead: markRead,
    badgeHtml: badgeHtml,
  };
})(window);
