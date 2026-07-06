// journal.js — 全操作ジャーナル共通ヘルパー
// 各ページで window.JOURNAL_PAGE を設定してから読み込む
(function(){
  'use strict';

  // FieldValueセンチネル（serverTimestamp等）はjournalドキュメントの
  // ネストマップに書けないため文字列に置換する
  function sanitize(v, depth){
    if(v==null) return v;
    if(depth>6) return '[depth]';
    var t=typeof v;
    if(t==='string'||t==='number'||t==='boolean') return v;
    if(v.toDate && typeof v.toDate==='function') return v; // Firestore Timestamp
    if(v instanceof Date) return v;
    if(v._methodName || (v.constructor&&v.constructor.name==='FieldValue')) return '[FieldValue]';
    if(Array.isArray(v)) return v.map(function(x){ return sanitize(x, (depth||0)+1); });
    if(t==='object'){
      var o={};
      Object.keys(v).forEach(function(k){ o[k]=sanitize(v[k], (depth||0)+1); });
      return o;
    }
    return String(v);
  }

  window.writeJournal = function(op, col, docId, before, after){
    try{
      var _db  = firebase.firestore();
      var _u   = firebase.auth ? firebase.auth().currentUser : null;
      _db.collection('journals').add({
        op:     op,
        col:    col,
        docId:  String(docId),
        before: before ? sanitize(before,0) : null,
        after:  after  ? sanitize(after,0)  : null,
        by:     _u ? (_u.email || _u.uid) : 'anon',
        at:     firebase.firestore.FieldValue.serverTimestamp(),
        page:   window.JOURNAL_PAGE || 'unknown'
      }).catch(function(e){ console.warn('[journal] write failed:', e.message); });
    }catch(e){ console.warn('[journal] error:', e.message); }
  };

  // 更新専用: 更新前にドキュメントを読み取り、before/after両方をジャーナル記録
  // beforeObj を渡すと読み取りを省略（呼び出し側キャッシュ利用）
  window.journaledUpdate = function(col, docId, data, beforeObj){
    var _db = firebase.firestore();
    var ref = _db.collection(col).doc(docId);
    var pre = (beforeObj!==undefined)
      ? Promise.resolve(beforeObj)
      : ref.get().then(function(s){ return s.exists ? s.data() : null; }).catch(function(){ return null; });
    return pre.then(function(before){
      return ref.update(data).then(function(){
        var after = before ? Object.assign({}, before, data) : data;
        window.writeJournal('update', col, docId, before, after);
      });
    });
  };

  // set専用（全置換/merge両対応）: 既存ドキュメントを読み取ってbeforeを記録
  window.journaledSet = function(col, docId, data, opts){
    var _db = firebase.firestore();
    var ref = _db.collection(col).doc(docId);
    return ref.get().catch(function(){ return null; }).then(function(snap){
      var before = (snap && snap.exists) ? snap.data() : null;
      return ref.set(data, opts||{}).then(function(){
        var after = (opts && opts.merge && before) ? Object.assign({}, before, data) : data;
        window.writeJournal(before ? 'update' : 'create', col, docId, before, after);
      });
    });
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

  // 古いジャーナルを削除（90日超え、最大200件/回）
  // 注: 自動実行は廃止。admin_data.html のジャーナルタブから手動実行する。
  //     （データ消失調査中に証跡が自動消去されるのを防ぐため）
  window.cleanupOldJournals = function(days){
    try{
      var _db = firebase.firestore();
      var cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - (days || 90));
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

})();
