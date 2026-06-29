// journal.js — 全操作ジャーナル共通ヘルパー
// 各ページで window.JOURNAL_PAGE を設定してから読み込む
(function(){
  'use strict';

  window.writeJournal = function(op, col, docId, before, after){
    try{
      var _db  = firebase.firestore();
      var _u   = firebase.auth ? firebase.auth().currentUser : null;
      _db.collection('journals').add({
        op:     op,
        col:    col,
        docId:  String(docId),
        before: before || null,
        after:  after  || null,
        by:     _u ? (_u.email || _u.uid) : 'anon',
        at:     firebase.firestore.FieldValue.serverTimestamp(),
        page:   window.JOURNAL_PAGE || 'unknown'
      }).catch(function(e){ console.warn('[journal] write failed:', e.message); });
    }catch(e){ console.warn('[journal] error:', e.message); }
  };

  // 削除専用: 削除前にドキュメントを読み取ってからジャーナル記録 → 削除実行
  window.journaledDelete = function(col, docId){
    var _db = firebase.firestore();
    var ref = _db.collection(col).doc(docId);
    return ref.get().then(function(snap){
      var before = snap.exists ? snap.data() : null;
      return ref.delete().then(function(){
        window.writeJournal('delete', col, docId, before, null);
      });
    });
  };

  // 古いジャーナルを削除（14日超え、最大200件/回）
  window.cleanupOldJournals = function(){
    try{
      var _db = firebase.firestore();
      var cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 14);
      _db.collection('journals')
        .where('at', '<', cutoff)
        .limit(200)
        .get()
        .then(function(snap){
          if(snap.empty) return;
          var b = _db.batch();
          snap.docs.forEach(function(d){ b.delete(d.ref); });
          b.commit().catch(function(e){ console.warn('[journal] cleanup failed:', e.message); });
        })
        .catch(function(e){ console.warn('[journal] cleanup query failed:', e.message); });
    }catch(e){ console.warn('[journal] cleanup error:', e.message); }
  };

  // ページロード後5秒でクリーンアップを自動実行
  setTimeout(function(){
    try{ window.cleanupOldJournals(); }catch(e){}
  }, 5000);

})();
