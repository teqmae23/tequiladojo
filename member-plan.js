/**
 * member-plan.js — 会員グレード（プラン）共通ロジック
 *
 * plans コレクション（管理画面 admin_plans.html で定義）と、
 * 会員の有効グレード判定・機能ゲートを、会員ページ／管理画面で共有する。
 *
 * plans/{id} の想定フィールド:
 *   name        表示名（例: 無料会員 / ブロンズ / シルバー / ゴールド）
 *   level       グレード段階（0=無料, 1,2,3...）。サブスクgradeとの対応にも使用
 *   priceLabel  価格表示（例: 無料 / ¥1,000/月）
 *   stripePriceId  Stripeの定期課金Price ID（サブスク実装フェーズで使用）
 *   features    { menu:true, map:true, ... } 解放する機能フラグ
 *   color       バッジ色（任意）
 *   active      有効フラグ
 *   order       同レベル内の並び順
 *
 * members/{id} の関連フィールド:
 *   plan                手動割当プランID（最優先。管理画面で「適時切替」）
 *   grade               サブスクのグレード（stripeWebhookが反映, level対応）
 *   subscriptionStatus  'active' 等
 */
var MemberPlan = (function(){
  // ゲート対象の機能レジストリ（管理画面のトグルと会員ページのゲートで共有）
  var FEATURES=[
    {key:'menu',    label:'オンラインメニュー', icon:'📖'},
    {key:'map',     label:'蒸留所マップ',       icon:'🗺'},
    {key:'library', label:'テキーラ書庫',       icon:'📚'},
    {key:'movie',   label:'テキーラ動画',       icon:'🎥'},
    {key:'seminar', label:'有料セミナー',       icon:'🎓'},
    {key:'ptd',     label:'PTDデータ閲覧',      icon:'📊'}
  ];

  function loadPlans(db){
    return db.collection('plans').get().then(function(snap){
      var arr=snap.docs.map(function(d){return Object.assign({id:d.id},d.data());});
      arr.sort(function(a,b){
        var la=Number(a.level)||0, lb=Number(b.level)||0;
        if(la!==lb) return la-lb;
        return (Number(a.order)||0)-(Number(b.order)||0);
      });
      return arr;
    });
  }

  function freePlan(plans){
    var f=(plans||[]).filter(function(p){return Number(p.level||0)===0;});
    return f.length?f[0]:null;
  }

  // 会員の有効プランを決定: 手動割当(plan) > 有効サブスク(grade→level) > 無料(level0)
  function effectivePlan(member, plans){
    member=member||{}; plans=plans||[];
    if(member.plan){
      var p=plans.find(function(x){return x.id===member.plan;});
      if(p) return p;
    }
    if(member.subscriptionStatus==='active' && member.grade!=null && member.grade!==''){
      var byLvl=plans.filter(function(x){return Number(x.level)===Number(member.grade);});
      if(byLvl.length) return byLvl[0];
    }
    return freePlan(plans);
  }

  function hasFeature(plan, key){
    return !!(plan && plan.features && plan.features[key]);
  }

  return {
    FEATURES:FEATURES, loadPlans:loadPlans,
    effectivePlan:effectivePlan, hasFeature:hasFeature, freePlan:freePlan
  };
})();
