/* ============================================================================
 * keepbottle.js — キープボトル差し込みモジュール
 *
 * 方針: 通常の注文/会計フローには一切手を入れず、キープボトル関連のデータを
 *       orders / keepBottles / keepBottleLog へ「差し込む」独立処理として実装する。
 *
 * Phase 1: キープボトル購入
 *   KB.openPurchase(ctx) … 購入モーダルを開き、確定で
 *     - keepBottles を作成（オーナー最大6人）
 *     - 在庫ボトル(bottleData)を選んだ場合は status を ended に更新
 *     - keepBottleLog に purchase を記録
 *     - 支払者の来店へ購入注文(productType:'keep', 定価)を差し込む
 *
 * 依存: firebase(compat), bottle-weight.js(BottleWeight), (任意) window.writeJournal
 * ============================================================================ */
window.KB = (function () {
  'use strict';
  var MAX_OWNERS = 6;

  function db() { return firebase.firestore(); }
  function FV() { return firebase.firestore.FieldValue; }
  function pad(n, l) { n = String(n); while (n.length < l) n = '0' + n; return n; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function nowDate() { var d = new Date(); return '' + d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2); }
  function nowTime() { var d = new Date(); return pad(d.getHours(), 2) + pad(d.getMinutes(), 2); }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }

  // ── ボトル情報の取り出し（bottleData の項目名ゆれに耐性を持たせる） ──
  function bName(b) {
    return b.bottleEs || b.bottleEsBase || b.nameEs || b.bottleJa || b.bottleJaBase || b.nameJa || b.name || b.id || '(名称不明)';
  }
  function bEmptyWeight(b) {
    if (b.emptyWeight != null) return num(b.emptyWeight);
    var fw = num(b.fullWeight), vol = num(b.volume), abv = num(b.abv);
    if (fw != null && vol != null && abv != null && window.BottleWeight) {
      try { return Math.round(BottleWeight.emptyWeight(fw, vol, abv)); } catch (e) { }
    }
    return null;
  }
  // 実測重量(g) → 残量(ml)。10ml単位に丸める。
  function remainingFromWeight(b, weightG) {
    var abv = num(b.abv), ew = bEmptyWeight(b);
    if (weightG == null || abv == null || ew == null || !window.BottleWeight) {
      return b.volume != null ? num(b.volume) : null;
    }
    try {
      var ml = BottleWeight.remainingMl(weightG, ew, abv);
      return Math.max(0, Math.round(ml / 10) * 10);
    } catch (e) { return b.volume != null ? num(b.volume) : null; }
  }

  // ── 注文差し込み（ID採番は通常注文と衝突しないよう counters/orderSeq を使用） ──
  async function injectOrders(useDate, entries) {
    if (!entries || !entries.length) return [];
    var _db = db();
    var counterRef = _db.collection('counters').doc('orderSeq');
    var maxSeq = 0;
    try {
      var snap = await _db.collection('orders')
        .orderBy(firebase.firestore.FieldPath.documentId())
        .startAt(useDate).endAt(useDate + '~').get();
      snap.docs.forEach(function (d) {
        var s = /^\d{9}$/.test(d.id) ? (parseInt(d.id.slice(6)) || 0) : 0;
        if (s > maxSeq) maxSeq = s;
      });
    } catch (e) { /* 取得失敗時は counter 側のみで採番 */ }
    var needed = entries.length;
    var seqStart = await _db.runTransaction(async function (tx) {
      var cs = await tx.get(counterRef);
      var cur = cs.exists ? (cs.data()[useDate] || 0) : 0;
      var start = Math.max(cur, maxSeq);
      var upd = {}; upd[useDate] = start + needed;
      tx.set(counterRef, upd, { merge: true });
      return start;
    });
    var c = seqStart, batch = _db.batch(), written = [];
    entries.forEach(function (e) {
      var docId = useDate + pad(++c, 3);
      var data = Object.assign({ orderDate: useDate }, e);
      batch.set(_db.collection('orders').doc(docId), data);
      written.push({ docId: docId, data: data });
    });
    await batch.commit();
    written.forEach(function (w) { if (window.writeJournal) try { window.writeJournal('create', 'orders', w.docId, null, w.data); } catch (e) { } });
    return written;
  }

  async function nextOrderGroupId(visitKey) {
    var mx = 0;
    try {
      var snap = await db().collection('orders').where('visitKey', '==', visitKey).get();
      snap.docs.forEach(function (d) { var g = d.data().orderGroupId || ''; var n = parseInt(g.slice(visitKey.length)) || 0; if (n > mx) mx = n; });
    } catch (e) { }
    return visitKey + pad(mx + 1, 2);
  }
  async function nextBatchId(useDate) {
    var mx = 0;
    try {
      var snap = await db().collection('orders').where('orderDate', '==', useDate).get();
      snap.docs.forEach(function (d) { var b = d.data().batchId || ''; if (b.slice(0, 6) === useDate) { var n = parseInt(b.slice(6)) || 0; if (n > mx) mx = n; } });
    } catch (e) { }
    return useDate + pad(mx + 1, 3);
  }

  // ========================================================================
  // 購入モーダル
  // ========================================================================
  var _ctx = null;      // openPurchase の引数
  var _owners = [];     // [{id, name}]
  var _mode = 'stock';  // 'stock' | 'direct'

  function ensureModal() {
    if (document.getElementById('kb-purchase-modal')) return;
    var wrap = document.createElement('div');
    wrap.id = 'kb-purchase-modal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(24,17,10,.5);z-index:9000;display:none;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto;font-family:inherit';
    wrap.innerHTML =
      '<div style="width:100%;max-width:520px;background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.3);margin-top:24px">' +
      '<div style="display:flex;align-items:center;padding:14px 18px;border-bottom:1px solid #eee;font-weight:700;font-size:16px">🍾 キープボトル購入<button id="kb-x" style="margin-left:auto;border:none;background:none;font-size:20px;cursor:pointer;color:#999">✕</button></div>' +
      '<div style="padding:16px 18px;max-height:70vh;overflow-y:auto">' +
        '<div style="font-size:12px;color:#666;margin-bottom:4px">支払者（この来店の伝票に購入代金を計上）</div>' +
        '<select id="kb-payer" style="width:100%;padding:9px;border:1px solid #ccc;border-radius:6px;font-size:14px;margin-bottom:14px"></select>' +

        '<div style="font-size:12px;color:#666;margin-bottom:4px">ボトル</div>' +
        '<div style="display:flex;gap:14px;margin-bottom:8px;font-size:13px">' +
          '<label><input type="radio" name="kb-mode" value="stock" checked> 在庫から選ぶ</label>' +
          '<label><input type="radio" name="kb-mode" value="direct"> 直接登録</label>' +
        '</div>' +
        '<div id="kb-stock-box">' +
          '<select id="kb-bottle" style="width:100%;padding:9px;border:1px solid #ccc;border-radius:6px;font-size:14px"></select>' +
        '</div>' +
        '<div id="kb-direct-box" style="display:none">' +
          '<input id="kb-d-name" placeholder="ボトル名（例: Herradura Silver）" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:13px;margin-bottom:6px">' +
          '<div style="display:flex;gap:6px;margin-bottom:6px">' +
            '<input id="kb-d-abv" type="number" placeholder="度数%" style="flex:1;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:13px">' +
            '<input id="kb-d-vol" type="number" placeholder="容量ml" style="flex:1;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:13px">' +
            '<input id="kb-d-cost" type="number" placeholder="仕入れ価格" style="flex:1;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:13px">' +
          '</div>' +
          '<div style="display:flex;gap:6px">' +
            '<input id="kb-d-full" type="number" placeholder="満載重量g(任意)" style="flex:1;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:13px">' +
            '<input id="kb-d-empty" type="number" placeholder="空瓶重量g(任意)" style="flex:1;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:13px">' +
          '</div>' +
        '</div>' +

        '<div style="display:flex;gap:10px;margin-top:12px">' +
          '<div style="flex:1"><div style="font-size:12px;color:#666;margin-bottom:4px">販売価格（円）</div><input id="kb-price" type="number" style="width:100%;padding:9px;border:1px solid #ccc;border-radius:6px;font-size:14px"><div id="kb-price-hint" style="font-size:10px;color:#999;margin-top:2px"></div></div>' +
          '<div style="flex:1"><div style="font-size:12px;color:#666;margin-bottom:4px">初回重量（g・任意）</div><input id="kb-weight" type="number" style="width:100%;padding:9px;border:1px solid #ccc;border-radius:6px;font-size:14px"><div id="kb-remain-hint" style="font-size:10px;color:#999;margin-top:2px"></div></div>' +
        '</div>' +

        '<div style="font-size:12px;color:#666;margin:14px 0 4px">オーナー（最大' + MAX_OWNERS + '人）<span id="kb-owner-cnt" style="color:#999"></span></div>' +
        '<div id="kb-owner-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px"></div>' +
        '<div style="font-size:11px;color:#888;margin-bottom:3px">当日来場者から追加：</div>' +
        '<div id="kb-visit-owners" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px"></div>' +
        '<input id="kb-owner-search" placeholder="会員ID・氏名で検索して追加..." style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:13px">' +
        '<div id="kb-owner-results" style="border:1px solid #eee;border-radius:6px;margin-top:4px;max-height:160px;overflow-y:auto;display:none"></div>' +

        '<div id="kb-err" style="color:#c0392b;font-size:12px;min-height:16px;margin-top:10px"></div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;padding:12px 18px;border-top:1px solid #eee;justify-content:flex-end">' +
        '<button id="kb-cancel" style="padding:9px 16px;border:1px solid #ccc;background:#f5f5f5;border-radius:6px;cursor:pointer;font-size:13px">キャンセル</button>' +
        '<button id="kb-confirm" style="padding:9px 18px;border:none;background:#7a5610;color:#fff;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">購入を確定</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    document.getElementById('kb-x').addEventListener('click', close);
    document.getElementById('kb-cancel').addEventListener('click', close);
    document.getElementById('kb-confirm').addEventListener('click', doPurchase);
    Array.prototype.forEach.call(wrap.querySelectorAll('input[name="kb-mode"]'), function (r) {
      r.addEventListener('change', function () {
        _mode = this.value;
        document.getElementById('kb-stock-box').style.display = _mode === 'stock' ? '' : 'none';
        document.getElementById('kb-direct-box').style.display = _mode === 'direct' ? '' : 'none';
        recalcPriceDefault();
      });
    });
    document.getElementById('kb-bottle').addEventListener('change', function () { recalcPriceDefault(); recalcRemainHint(); });
    document.getElementById('kb-weight').addEventListener('input', recalcRemainHint);
    document.getElementById('kb-d-abv').addEventListener('input', recalcRemainHint);
    document.getElementById('kb-d-empty').addEventListener('input', recalcRemainHint);
    document.getElementById('kb-d-cost').addEventListener('input', recalcPriceDefault);
    var srch = document.getElementById('kb-owner-search');
    srch.addEventListener('input', renderOwnerResults);
  }

  function selectedStockBottle() {
    var id = document.getElementById('kb-bottle').value;
    return (_ctx.stockBottles || []).find(function (b) { return b.id === id; }) || null;
  }
  function currentBottleInfo() {
    if (_mode === 'stock') {
      var b = selectedStockBottle();
      return b ? { src: b, name: bName(b), abv: num(b.abv), volume: num(b.volume), cost: num(b.cost), sourceId: b.id, bottleId: b.bottleId || (b.id || '').slice(0, 12), classId: b.classId || null, emptyWeight: bEmptyWeight(b), bottleEs: b.bottleEs || null, bottleJa: b.bottleJa || null, location: b.location || null } : null;
    }
    var nm = (document.getElementById('kb-d-name').value || '').trim();
    if (!nm) return null;
    var abv = num(document.getElementById('kb-d-abv').value);
    var vol = num(document.getElementById('kb-d-vol').value);
    var cost = num(document.getElementById('kb-d-cost').value);
    var full = num(document.getElementById('kb-d-full').value);
    var empty = num(document.getElementById('kb-d-empty').value);
    if (empty == null && full != null && vol != null && abv != null && window.BottleWeight) {
      try { empty = Math.round(BottleWeight.emptyWeight(full, vol, abv)); } catch (e) { }
    }
    return { src: null, name: nm, abv: abv, volume: vol, cost: cost, sourceId: null, bottleId: null, classId: null, emptyWeight: empty, bottleEs: nm, bottleJa: null, location: null };
  }
  function recalcPriceDefault() {
    var info = currentBottleInfo();
    var hint = document.getElementById('kb-price-hint');
    var priceEl = document.getElementById('kb-price');
    if (info && info.cost != null) {
      // 仕入れ価格の2倍を既定に（未入力/自動値のときのみ更新）
      if (priceEl.value === '' || priceEl.dataset.auto === '1') { priceEl.value = Math.round(info.cost * 2); priceEl.dataset.auto = '1'; }
      hint.textContent = '既定=仕入れ' + info.cost.toLocaleString() + '×2';
    } else {
      hint.textContent = '仕入れ価格が無いため手入力';
    }
    priceEl.oninput = function () { priceEl.dataset.auto = '0'; };
  }
  function recalcRemainHint() {
    var info = currentBottleInfo();
    var w = num(document.getElementById('kb-weight').value);
    var hint = document.getElementById('kb-remain-hint');
    if (!info) { hint.textContent = ''; return; }
    if (w == null) { hint.textContent = info.volume != null ? ('未入力→満量 ' + info.volume + 'ml') : ''; return; }
    var b = { abv: info.abv, volume: info.volume, emptyWeight: info.emptyWeight, fullWeight: null };
    var ml = remainingFromWeight(b, w);
    hint.textContent = ml != null ? ('残量 ≒ ' + ml + 'ml') : '換算不可(度数/空瓶重量不足)';
  }

  function renderOwnerChips() {
    var box = document.getElementById('kb-owner-chips');
    document.getElementById('kb-owner-cnt').textContent = ' ' + _owners.length + '/' + MAX_OWNERS;
    box.innerHTML = _owners.map(function (o) {
      return '<span style="display:inline-flex;align-items:center;gap:4px;background:#efe3d4;color:#7a5610;border-radius:14px;padding:3px 10px;font-size:12px">' + esc(o.name) + '<b data-rm="' + esc(o.id) + '" style="cursor:pointer;color:#a06a20">×</b></span>';
    }).join('') || '<span style="font-size:12px;color:#bbb">未選択</span>';
    Array.prototype.forEach.call(box.querySelectorAll('[data-rm]'), function (x) {
      x.addEventListener('click', function () { removeOwner(this.getAttribute('data-rm')); });
    });
  }
  function addOwner(id, name) {
    if (!id) return;
    if (_owners.find(function (o) { return o.id === id; })) return;
    if (_owners.length >= MAX_OWNERS) { setErr('オーナーは最大' + MAX_OWNERS + '人までです'); return; }
    _owners.push({ id: id, name: name || id });
    setErr(''); renderOwnerChips();
  }
  function removeOwner(id) { _owners = _owners.filter(function (o) { return o.id !== id; }); renderOwnerChips(); }

  function memberDisp(m) { return m.nickname || m.name || m.displayId || m.memberId || m.id; }
  function renderVisitOwnerButtons() {
    var box = document.getElementById('kb-visit-owners');
    var vs = (_ctx.visits || []).filter(function (v) { return v.memberId; });
    if (!vs.length) { box.innerHTML = '<span style="font-size:11px;color:#bbb">会員の来場者なし</span>'; return; }
    box.innerHTML = vs.map(function (v) {
      return '<button type="button" data-add="' + esc(v.memberId) + '" data-nm="' + esc(v.name || v.memberId) + '" style="border:1px solid #ccc;background:#fafafa;border-radius:14px;padding:3px 10px;font-size:12px;cursor:pointer">＋' + esc(v.name || v.memberId) + '</button>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-add]'), function (b) {
      b.addEventListener('click', function () { addOwner(this.getAttribute('data-add'), this.getAttribute('data-nm')); });
    });
  }
  function renderOwnerResults() {
    var q = (document.getElementById('kb-owner-search').value || '').trim().toLowerCase();
    var box = document.getElementById('kb-owner-results');
    if (!q) { box.style.display = 'none'; return; }
    var list = (_ctx.members || []).filter(function (m) {
      return (String(m.id) + ' ' + (m.memberId || '') + ' ' + (m.nickname || '') + ' ' + (m.name || '')).toLowerCase().indexOf(q) >= 0;
    }).slice(0, 30);
    box.innerHTML = list.length ? list.map(function (m) {
      return '<div data-mid="' + esc(m.id) + '" data-nm="' + esc(memberDisp(m)) + '" style="padding:7px 10px;border-bottom:1px solid #f0f0f0;cursor:pointer;font-size:13px">' + esc(memberDisp(m)) + ' <span style="color:#aaa;font-size:11px">' + esc(m.memberId || m.id) + '</span></div>';
    }).join('') : '<div style="padding:8px;color:#aaa;font-size:12px">該当なし</div>';
    box.style.display = 'block';
    Array.prototype.forEach.call(box.querySelectorAll('[data-mid]'), function (r) {
      r.addEventListener('click', function () {
        addOwner(this.getAttribute('data-mid'), this.getAttribute('data-nm'));
        document.getElementById('kb-owner-search').value = ''; box.style.display = 'none';
      });
    });
  }

  function setErr(m) { var e = document.getElementById('kb-err'); if (e) e.textContent = m || ''; }
  function close() { var w = document.getElementById('kb-purchase-modal'); if (w) w.style.display = 'none'; }

  function openPurchase(ctx) {
    _ctx = ctx || {};
    ensureModal();
    _owners = [];
    _mode = 'stock';
    // 支払者
    var payerSel = document.getElementById('kb-payer');
    var payVisits = (_ctx.visits || []);
    payerSel.innerHTML = payVisits.length
      ? payVisits.map(function (v) { return '<option value="' + esc(v.id) + '">' + esc(v.name || v.id) + '</option>'; }).join('')
      : '<option value="">（来場者がいません）</option>';
    // 在庫ボトル
    var bsel = document.getElementById('kb-bottle');
    var stock = (_ctx.stockBottles || []);
    bsel.innerHTML = stock.length
      ? stock.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(bName(b)) + (b.abv != null ? ' ' + b.abv + '%' : '') + (b.cost != null ? ' / 仕入' + Number(b.cost).toLocaleString() : '') + '</option>'; }).join('')
      : '<option value="">（在庫ボトルなし）</option>';
    Array.prototype.forEach.call(document.querySelectorAll('input[name="kb-mode"]'), function (r) { r.checked = (r.value === 'stock'); });
    document.getElementById('kb-stock-box').style.display = '';
    document.getElementById('kb-direct-box').style.display = 'none';
    ['kb-d-name', 'kb-d-abv', 'kb-d-vol', 'kb-d-cost', 'kb-d-full', 'kb-d-empty', 'kb-weight'].forEach(function (id) { var el = document.getElementById(id); if (el) el.value = ''; });
    var priceEl = document.getElementById('kb-price'); priceEl.value = ''; priceEl.dataset.auto = '1';
    setErr('');
    document.getElementById('kb-owner-search').value = '';
    document.getElementById('kb-owner-results').style.display = 'none';
    renderVisitOwnerButtons();
    renderOwnerChips();
    recalcPriceDefault();
    recalcRemainHint();
    document.getElementById('kb-purchase-modal').style.display = 'flex';
  }

  async function doPurchase() {
    setErr('');
    var payerId = document.getElementById('kb-payer').value;
    if (!payerId) { setErr('支払者を選択してください'); return; }
    var payer = (_ctx.visits || []).find(function (v) { return v.id === payerId; });
    var info = currentBottleInfo();
    if (!info) { setErr(_mode === 'stock' ? 'ボトルを選択してください' : 'ボトル名を入力してください'); return; }
    var price = num(document.getElementById('kb-price').value);
    if (price == null || price < 0) { setErr('販売価格を入力してください'); return; }
    if (!_owners.length) { setErr('オーナーを1人以上選択してください'); return; }
    var weight = num(document.getElementById('kb-weight').value);
    var remaining = remainingFromWeight({ abv: info.abv, volume: info.volume, emptyWeight: info.emptyWeight }, weight);

    var btn = document.getElementById('kb-confirm'); btn.disabled = true;
    try {
      var _db = db();
      var useDate = _ctx.useDate || nowDate();
      var orderTime = _ctx.orderTime || nowTime();
      var staffUid = _ctx.staffUid || (firebase.auth().currentUser && firebase.auth().currentUser.uid) || null;
      var keepRef = _db.collection('keepBottles').doc();
      var ownerIds = _owners.map(function (o) { return o.id; });

      var keepData = {
        bottleId: info.bottleId || null,
        bottleEs: info.bottleEs || null, bottleJa: info.bottleJa || null,
        classId: info.classId || null, abv: info.abv != null ? info.abv : null,
        volume: info.volume != null ? info.volume : null, emptyWeight: info.emptyWeight != null ? info.emptyWeight : null,
        remaining: remaining, lastWeight: weight,
        purchasePrice: price, userMemberIds: ownerIds,
        status: 'active', location: info.location || null, note: null,
        sourceBottleDataId: info.sourceId || null, purchaseDate: nowDate(), createdAt: FV().serverTimestamp()
      };

      // keepBottles / bottleData(在庫→ended) / keepBottleLog をまとめて書き込み
      var batch = _db.batch();
      batch.set(keepRef, keepData);
      if (info.sourceId) batch.update(_db.collection('bottleData').doc(info.sourceId), { status: 'ended', visibility: '1' });
      batch.set(_db.collection('keepBottleLog').doc(), {
        keepBottleId: keepRef.id, type: 'purchase', date: nowDate(), time: nowTime(),
        memberId: ownerIds[0] || null, weight: weight, remainingMl: remaining, amount: price,
        note: '購入登録（' + (info.sourceId ? '在庫' : '直接登録') + '）', staffUid: staffUid, createdAt: FV().serverTimestamp()
      });
      await batch.commit();
      if (window.writeJournal) { try { window.writeJournal('create', 'keepBottles', keepRef.id, null, keepData); } catch (e) { } }

      // 支払者の来店へ購入注文(定価)を差し込む
      var ogid = await nextOrderGroupId(payer.id);
      var bid = await nextBatchId(useDate);
      await injectOrders(useDate, [{
        orderTime: orderTime, customerId: payer.memberId || null, visitKey: payer.id,
        orderGroupId: ogid, batchId: bid, itemSeq: 1,
        productCode: keepRef.id, productName: info.name + '（キープ購入）', productType: 'keep',
        qty: 1, unit: '本', unitPrice: price,
        blindId: 0, blindMarkId: null, served: 1, keepBottleId: keepRef.id, kbPurchase: true
      }]);

      close();
      if (typeof _ctx.onDone === 'function') _ctx.onDone({ keepBottleId: keepRef.id });
    } catch (e) {
      setErr('登録失敗: ' + (e && e.message ? e.message : e));
    } finally {
      btn.disabled = false;
    }
  }

  return {
    openPurchase: openPurchase,
    injectOrders: injectOrders,
    nextOrderGroupId: nextOrderGroupId,
    nextBatchId: nextBatchId,
    remainingFromWeight: remainingFromWeight
  };
})();
