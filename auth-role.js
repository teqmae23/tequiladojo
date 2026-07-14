/**
 * auth-role.js — テキーラ道場 役割認証
 */
var AuthRole = (function() {

  // ページ読み込み時に画面を隠す
  (function hideOnLoad(){
    var style = document.createElement('style');
    style.id = 'auth-role-hide';
    style.textContent = '#login-screen, #app, #main-screen { visibility: hidden !important; }';
    document.head.appendChild(style);
  })();

  function showScreens(){
    var s = document.getElementById('auth-role-hide');
    if(s) s.remove();
  }

  function showLoginScreen(msg){
    showScreens();
    var ls = document.getElementById('login-screen');
    var app = document.getElementById('app');
    if(ls) ls.style.display = 'flex';
    if(app) app.style.display = 'none';
    if(msg){
      var err = document.getElementById('lerr');
      if(err) err.textContent = msg;
    }
  }

  function showDenied(msg){
    showScreens();
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#666;padding:20px;text-align:center;">' + (msg||'アクセス権限がありません') + '</div>';
  }

  // roleを取得
  async function getRole(user){
    var db = firebase.firestore();
    // 1. staffRoles/{uid} を直接取得（最も確実）
    try {
      var doc = await db.collection('staffRoles').doc(user.uid).get();
      if(doc.exists && doc.data().role) return doc.data().role;
    } catch(e){}
    // 2. Custom Claims
    try {
      var result = await user.getIdTokenResult(true);
      if(result.claims.role) return result.claims.role;
    } catch(e){}
    // 3. members/{memberId} をauthUidで検索
    try {
      var snap = await db.collection('members').where('authUid','==',user.uid).limit(1).get();
      if(!snap.empty && snap.docs[0].data().role) return snap.docs[0].data().role;
    } catch(e){}
    return null;
  }

  // 注: ロール判定（getRole）が完了するまで画面を表示解禁しない。
  // 冒頭で showScreens() すると、非同期判定の待ち時間にログイン画面が
  // 一瞬見えてしまう（遷移時のちらつき）ため、確定した分岐でのみ解禁する。
  function requireStaff(auth, onAllowed, onSignedOut){
    auth.onAuthStateChanged(async function(user){
      if(!user){
        showScreens();
        if(onSignedOut) onSignedOut();
        else showLoginScreen();
        return;
      }
      // 会員専用アドレスは拒否
      if(user.email && user.email.indexOf('@tequiladojo.member') >= 0){
        await auth.signOut();
        showDenied('スタッフ専用ページです');
        return;
      }
      var role = null;
      try { role = await getRole(user); } catch(e){}
      if(role === 'owner' || role === 'staff'){
        showScreens();
        onAllowed(user, role);
      } else {
        var msg = role ? 'アクセス権限がありません（role:' + role + '）' : '権限が設定されていません（email:' + user.email + '）';
        await auth.signOut();
        showLoginScreen(msg);
      }
    });
  }

  function requireOwner(auth, onAllowed, onSignedOut){
    auth.onAuthStateChanged(async function(user){
      if(!user){
        showScreens();
        if(onSignedOut) onSignedOut();
        else showLoginScreen();
        return;
      }
      var role = null;
      try { role = await getRole(user); } catch(e){}
      if(role === 'owner'){
        showScreens();
        onAllowed(user, role);
      } else {
        var msg = 'オーナー権限が必要です（role:' + role + '）';
        await auth.signOut();
        showLoginScreen(msg);
      }
    });
  }

  function requireMember(auth, onAllowed, onSignedOut){
    auth.onAuthStateChanged(async function(user){
      if(!user){
        showScreens();
        if(onSignedOut) onSignedOut();
        else showLoginScreen();
        return;
      }
      showScreens();
      onAllowed(user, null);
    });
  }

  // アクティブセッション取得
  async function getActiveSession(db){
    try{
      var snap=await db.collection('sessions').where('status','==','open').orderBy('openTime','desc').limit(1).get();
      if(!snap.empty){
        var ses={id:snap.docs[0].id};
        Object.assign(ses,snap.docs[0].data());
        // 古すぎるセッションは無視（日またぎ営業対応で最大2日以内）
        var sesDate=ses.openDate||ses.date;
        if(sesDate&&sesDate.length===6){
          var now=new Date();
          var validDates=[];
          for(var offset=0;offset<=2;offset++){
            var dd=new Date(now.getTime()-offset*86400000);
            validDates.push(String(dd.getFullYear()).slice(2)
              +String(dd.getMonth()+1).padStart(2,'0')
              +String(dd.getDate()).padStart(2,'0'));
          }
          if(validDates.indexOf(sesDate)<0) return null; // 2日以上前のセッションは無効
        }
        return ses;
      }
    }catch(e){}
    return null;
  }

  // 営業日付計算（深夜営業対応: openTime基準）
  function businessDate(openTime, openDate){
    if(openDate) return openDate;
    if(!openTime) return null;
    var d=openTime.toDate?openTime.toDate():new Date(openTime);
    return String(d.getFullYear()).slice(2).padStart(2,'0')
      +String(d.getMonth()+1).padStart(2,'0')
      +String(d.getDate()).padStart(2,'0');
  }

  // 現在時刻をHHMMSS文字列で返す（日またぎ時は24h+表記）
  function nowBusinessTime(openTime){
    var now=new Date();
    var nowH=now.getHours(), nowM=now.getMinutes(), nowS=now.getSeconds();
    // 日またぎ検出: 開店が午後（12時以降）で現在が午前（12時前）→ 24加算
    if(openTime && openTime.length>=4){
      var openH=parseInt(openTime.slice(0,2))||0;
      if(openH>=12 && nowH<12){ nowH+=24; }
    }
    return String(nowH).padStart(2,'0')
      +String(nowM).padStart(2,'0')
      +String(nowS).padStart(2,'0');
  }

  // HHMMSS → HH:MM 表示用フォーマット
  function formatBusinessTime(t){
    if(!t||t.length<4) return t||'';
    return t.slice(0,2)+':'+t.slice(2,4);
  }

  // masterMeta: Rev.+最終更新日時をアトミックにインクリメント
  async function bumpMeta(db, name){
    var ref=db.collection('masterMeta').doc(name);
    return db.runTransaction(async function(t){
      var snap=await t.get(ref);
      var rev=snap.exists?(snap.data().rev||0)+1:1;
      t.set(ref,{rev:rev,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
      return rev;
    });
  }

  async function getMeta(db, name){
    var snap=await db.collection('masterMeta').doc(name).get();
    return snap.exists?snap.data():null;
  }

  // ボトル名にsuffixを付加して返す
  function bdName(item, lang){
    var base;
    if(lang==='ja') base=item.bottleJaBase||item.bottleJa||item.bottleEsBase||item.bottleEs||item.bottleEn||item.name||item.id||'';
    else base=item.bottleEsBase||item.bottleEs||item.bottleJaBase||item.bottleJa||item.bottleEn||item.name||item.id||'';
    var sfx=(item.suffix||'').trim();
    if(!sfx) return base;
    base=base.replace(new RegExp(' ?\\('+sfx.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\)$'),'');
    return base+' ('+sfx+')';
  }

  // visitが現セッションに属するか判定
  function isVisitInSession(v, session){
    if(!session) return true;
    var sessionDate=session.openDate||session.date||businessDate(session.openTime,null);
    var visitDate=v.visitDate||(v.id?v.id.slice(0,6):'');
    if(!sessionDate||!visitDate) return true;
    if(visitDate!==sessionDate) return false;
    // 同一営業日: openTime以降のvisitのみ
    var visitTime=v.visitTime||'';
    if(!visitTime||!session.openTime) return true;
    var openTs=session.openTime.toDate?session.openTime.toDate():new Date(session.openTime);
    var openHHMM=String(openTs.getHours()).padStart(2,'0')+String(openTs.getMinutes()).padStart(2,'0');
    return visitTime.slice(0,4)>=openHHMM;
  }

  return { requireStaff: requireStaff, requireOwner: requireOwner, requireMember: requireMember,
           getActiveSession: getActiveSession, businessDate: businessDate,
           nowBusinessTime: nowBusinessTime, formatBusinessTime: formatBusinessTime,
           isVisitInSession: isVisitInSession, bdName: bdName,
           bumpMeta: bumpMeta, getMeta: getMeta };
})();
