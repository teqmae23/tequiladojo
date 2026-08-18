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

  // ========================================================================
  // Phase 2: 来店時プロンプト（オーナー来店 → このキープを使う？ → 使用前重量）
  // ========================================================================
  var _ci = null; // onCheckin の ctx

  function ciMemberName(id) {
    var arr = (_ci && _ci.members) || [];
    var m = arr.find ? arr.find(function (x) { return x.id === id || x.memberId === id; }) : null;
    return m ? (m.nickname || m.name || m.displayId || m.memberId || m.id) : id;
  }
  function presentMemberSet(ctx) {
    var s = {};
    (ctx.allVisits || []).forEach(function (v) { if (v.memberId && !v.checkoutTime) s[v.memberId] = 1; });
    (ctx.checkedIn || []).forEach(function (e) { if (e.memberId) s[e.memberId] = 1; });
    return s;
  }
  // 実測重量(g) → 残量(ml,10ml単位)。換算不可なら null。
  function remainFromWeightKeep(k, wG) {
    if (wG == null || k.abv == null || k.emptyWeight == null || !window.BottleWeight) return null;
    try { return Math.max(0, Math.round(BottleWeight.remainingMl(wG, k.emptyWeight, k.abv) / 10) * 10); } catch (e) { return null; }
  }
  function weightFromRemainKeep(k, ml) {
    if (ml == null || k.abv == null || k.emptyWeight == null || !window.BottleWeight) return null;
    try { return Math.round(BottleWeight.weightFromMl(ml, k.emptyWeight, k.abv)); } catch (e) { return null; }
  }

  // 来店フック: 新規来店した会員が所有する未開封(今セッション)のキープを探して確認画面を出す
  async function onCheckin(ctx) {
    try {
      ctx = ctx || {};
      var checked = (ctx.checkedIn || []).map(function (e) { return e.memberId; }).filter(Boolean);
      if (!checked.length || !window.KB) return;
      var bizDate = ctx.bizDate || nowDate();
      var snap = await db().collection('keepBottles').where('status', '==', 'active').get();
      var cands = [];
      snap.docs.forEach(function (d) {
        var k = Object.assign({ id: d.id }, d.data());
        var owners = k.userMemberIds || [];
        if (!owners.some(function (o) { return checked.indexOf(o) >= 0; })) return;
        if (k.sessionActive && k.sessionDate === bizDate) return; // 今セッションで開封済み
        cands.push(k);
      });
      if (!cands.length) return;
      _ci = ctx; _ci.bizDate = bizDate;
      showCheckinPrompt(cands);
    } catch (e) { /* 来店処理を妨げない */ }
  }

  function ensureCheckinModal() {
    if (document.getElementById('kb-checkin-modal')) return;
    var w = document.createElement('div');
    w.id = 'kb-checkin-modal';
    w.style.cssText = 'position:fixed;inset:0;background:rgba(24,17,10,.5);z-index:9100;display:none;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto;font-family:inherit';
    w.innerHTML =
      '<div style="width:100%;max-width:500px;background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.3);margin-top:24px">' +
      '<div style="padding:14px 18px;border-bottom:1px solid #eee;font-weight:700;font-size:16px">🍾 このキープボトルを使用しますか？</div>' +
      '<div id="kb-ci-body" style="padding:14px 18px;max-height:70vh;overflow-y:auto"></div>' +
      '<div id="kb-ci-err" style="color:#c0392b;font-size:12px;padding:0 18px;min-height:14px"></div>' +
      '<div style="display:flex;gap:8px;padding:12px 18px;border-top:1px solid #eee;justify-content:flex-end">' +
        '<button id="kb-ci-no" style="padding:9px 16px;border:1px solid #ccc;background:#f5f5f5;border-radius:6px;cursor:pointer;font-size:13px">いいえ（使わない）</button>' +
        '<button id="kb-ci-yes" style="padding:9px 18px;border:none;background:#7a5610;color:#fff;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">はい（開封する）</button>' +
      '</div></div>';
    document.body.appendChild(w);
    document.getElementById('kb-ci-no').addEventListener('click', function () { w.style.display = 'none'; });
    document.getElementById('kb-ci-yes').addEventListener('click', confirmCheckinUse);
  }

  var _ciCands = [];
  function showCheckinPrompt(cands) {
    ensureCheckinModal();
    _ciCands = cands;
    var present = presentMemberSet(_ci);
    var body = document.getElementById('kb-ci-body');
    body.innerHTML = cands.map(function (k, i) {
      var owners = (k.userMemberIds || []);
      var presentOwners = owners.filter(function (o) { return present[o]; });
      var ownerHtml = owners.map(function (o) {
        var here = present[o];
        return '<label style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;font-size:12px;color:' + (here ? '#333' : '#bbb') + '">' +
          '<input type="checkbox" class="kb-ci-owner" data-i="' + i + '" data-mid="' + esc(o) + '"' + (here ? ' checked' : ' disabled') + '> ' + esc(ciMemberName(o)) + (here ? '' : '（不在）') + '</label>';
      }).join('');
      var nm = k.bottleEs || k.bottleJa || k.bottleId || k.id;
      return '<div style="border:1px solid #eee;border-radius:8px;padding:10px 12px;margin-bottom:10px">' +
        '<label style="display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px"><input type="checkbox" class="kb-ci-use" data-i="' + i + '"' + (presentOwners.length ? ' checked' : '') + '> ' + esc(nm) + '</label>' +
        '<div style="font-size:11px;color:#888;margin:6px 0 4px">オーナー：' + (ownerHtml || '—') + '</div>' +
        '<div style="font-size:11px;color:#888;margin-bottom:2px">記録残量：' + (k.remaining != null ? k.remaining + 'ml' : '—') + '</div>' +
        '<div style="display:flex;align-items:center;gap:6px"><span style="font-size:12px;color:#666">使用前重量(g)</span>' +
        '<input type="number" class="kb-ci-weight" data-i="' + i + '" placeholder="測定値(任意)" style="width:130px;padding:7px;border:1px solid #ccc;border-radius:6px;font-size:13px"></div>' +
        '</div>';
    }).join('');
    document.getElementById('kb-ci-err').textContent = '';
    document.getElementById('kb-checkin-modal').style.display = 'flex';
  }

  async function confirmCheckinUse() {
    var errEl = document.getElementById('kb-ci-err'); errEl.textContent = '';
    var uses = document.querySelectorAll('.kb-ci-use');
    var chosen = [];
    Array.prototype.forEach.call(uses, function (u) { if (u.checked) chosen.push(parseInt(u.getAttribute('data-i'))); });
    if (!chosen.length) { document.getElementById('kb-checkin-modal').style.display = 'none'; return; }

    var present = presentMemberSet(_ci);
    var _db = db(), batch = _db.batch(), logs = [], journals = [];
    var bizDate = _ci.bizDate || nowDate();
    var staffUid = _ci.staffUid || (firebase.auth().currentUser && firebase.auth().currentUser.uid) || null;

    for (var ci = 0; ci < chosen.length; ci++) {
      var i = chosen[ci];
      var k = _ciCands[i];
      var wEl = document.querySelector('.kb-ci-weight[data-i="' + i + '"]');
      var wG = wEl && wEl.value !== '' ? (parseFloat(wEl.value) || 0) : null;
      var stored = k.remaining != null ? Number(k.remaining) : null;
      var startWeight = wG, startRemaining = stored, newRemaining = stored, newLastWeight = k.lastWeight != null ? k.lastWeight : null;

      if (wG != null) {
        var measured = remainFromWeightKeep(k, wG);
        if (measured != null && stored != null && Math.abs(measured - stored) > 10) {
          var adoptMeasured = window.confirm(
            (k.bottleEs || k.bottleJa || 'キープ') + '\n残量が記録と異なります。\n\n測定値: 残 ' + measured + 'ml\n記録　: 残 ' + stored + 'ml\n\n［OK］測定値を採用 ／ ［キャンセル］記録を採用');
          if (adoptMeasured) { startRemaining = measured; newRemaining = measured; startWeight = wG; newLastWeight = wG; }
          else { startRemaining = stored; newRemaining = stored; startWeight = weightFromRemainKeep(k, stored); }
        } else {
          startRemaining = (measured != null ? measured : stored);
          newRemaining = startRemaining;
          startWeight = wG; newLastWeight = wG;
        }
      } else {
        startRemaining = stored;
        startWeight = (k.lastWeight != null ? k.lastWeight : weightFromRemainKeep(k, stored));
      }

      var presentOwners = (k.userMemberIds || []).filter(function (o) { return present[o]; });
      var upd = {
        sessionActive: true, sessionDate: bizDate,
        sessionStartWeight: startWeight, sessionStartRemaining: startRemaining,
        sessionOwnerIds: presentOwners, sessionOpenedAt: FV().serverTimestamp(),
        remaining: newRemaining, lastWeight: newLastWeight
      };
      batch.update(_db.collection('keepBottles').doc(k.id), upd);
      journals.push({ id: k.id, before: { remaining: k.remaining, lastWeight: k.lastWeight, sessionActive: k.sessionActive || false }, after: upd });
      batch.set(_db.collection('keepBottleLog').doc(), {
        keepBottleId: k.id, type: 'open', date: bizDate, time: nowTime(),
        memberId: presentOwners[0] || null, weight: startWeight, remainingMl: startRemaining, amount: 0,
        note: '来店時に開封（今セッション使用開始）', staffUid: staffUid, createdAt: FV().serverTimestamp()
      });
    }
    var btn = document.getElementById('kb-ci-yes'); btn.disabled = true;
    try {
      await batch.commit();
      journals.forEach(function (j) { if (window.writeJournal) try { window.writeJournal('update', 'keepBottles', j.id, j.before, j.after); } catch (e) { } });
      document.getElementById('kb-checkin-modal').style.display = 'none';
      if (_ci && typeof _ci.onDone === 'function') _ci.onDone();
    } catch (e) {
      errEl.textContent = '保存失敗: ' + (e && e.message ? e.message : e);
    } finally { btn.disabled = false; }
  }

  function kbOrderName(k, extra) { return (k.bottleEs || k.bottleJa || 'キープ') + ' (KB)' + (extra ? ' ' + extra : ''); }

  // ========================================================================
  // Phase 3: KB注文（飲用・¥0）。cart へ差し込む item を作って onAdd で渡す。
  // ========================================================================
  var _drinkCtx = null, _drinkKeeps = [];
  function ensureDrinkModal() {
    if (document.getElementById('kb-drink-modal')) return;
    var w = document.createElement('div');
    w.id = 'kb-drink-modal';
    w.style.cssText = 'position:fixed;inset:0;background:rgba(24,17,10,.5);z-index:9100;display:none;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto;font-family:inherit';
    w.innerHTML =
      '<div style="width:100%;max-width:440px;background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.3);margin-top:24px">' +
      '<div style="display:flex;align-items:center;padding:14px 18px;border-bottom:1px solid #eee;font-weight:700;font-size:16px">🍾 キープを飲む（¥0）<button id="kb-dk-x" style="margin-left:auto;border:none;background:none;font-size:20px;cursor:pointer;color:#999">✕</button></div>' +
      '<div style="padding:16px 18px">' +
        '<div style="font-size:12px;color:#666;margin-bottom:4px">キープボトル（使用中）</div>' +
        '<select id="kb-dk-keep" style="width:100%;padding:9px;border:1px solid #ccc;border-radius:6px;font-size:14px;margin-bottom:12px"></select>' +
        '<div style="display:flex;gap:10px;align-items:flex-end">' +
          '<div style="flex:1"><div style="font-size:12px;color:#666;margin-bottom:4px">数量（ml・10ml単位）</div><input id="kb-dk-qty" type="number" step="10" min="10" value="30" style="width:100%;padding:9px;border:1px solid #ccc;border-radius:6px;font-size:14px"></div>' +
          '<label style="display:flex;align-items:center;gap:5px;font-size:13px;padding-bottom:10px"><input type="checkbox" id="kb-dk-soda"> ソーダ割り</label>' +
        '</div>' +
        '<div style="font-size:11px;color:#999;margin-top:8px">価格は¥0（キープ消費）。奢りは通常どおり注文確定時に設定できます。</div>' +
        '<div id="kb-dk-err" style="color:#c0392b;font-size:12px;min-height:14px;margin-top:8px"></div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;padding:12px 18px;border-top:1px solid #eee;justify-content:flex-end">' +
        '<button id="kb-dk-cancel" style="padding:9px 16px;border:1px solid #ccc;background:#f5f5f5;border-radius:6px;cursor:pointer;font-size:13px">キャンセル</button>' +
        '<button id="kb-dk-add" style="padding:9px 18px;border:none;background:#7a5610;color:#fff;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">カートに追加</button>' +
      '</div></div>';
    document.body.appendChild(w);
    function cl() { w.style.display = 'none'; }
    document.getElementById('kb-dk-x').addEventListener('click', cl);
    document.getElementById('kb-dk-cancel').addEventListener('click', cl);
    document.getElementById('kb-dk-add').addEventListener('click', addDrink);
    w.addEventListener('click', function (e) { if (e.target === w) cl(); });
  }
  async function openDrink(ctx) {
    ctx = ctx || {}; _drinkCtx = ctx;
    var bizDate = ctx.bizDate || nowDate();
    var keeps = [];
    try {
      var snap = await db().collection('keepBottles').where('status', '==', 'active').get();
      snap.docs.forEach(function (d) { var k = Object.assign({ id: d.id }, d.data()); if (k.sessionActive && k.sessionDate === bizDate) keeps.push(k); });
    } catch (e) { }
    _drinkKeeps = keeps;
    ensureDrinkModal();
    var sel = document.getElementById('kb-dk-keep');
    sel.innerHTML = keeps.length
      ? keeps.map(function (k) { return '<option value="' + esc(k.id) + '">' + esc(k.bottleEs || k.bottleJa || k.id) + '（残' + (k.remaining != null ? k.remaining + 'ml' : '—') + '）</option>'; }).join('')
      : '<option value="">今セッションで使用中のキープがありません</option>';
    document.getElementById('kb-dk-qty').value = '30';
    document.getElementById('kb-dk-soda').checked = false;
    document.getElementById('kb-dk-err').textContent = '';
    document.getElementById('kb-drink-modal').style.display = 'flex';
  }
  function addDrink() {
    var errEl = document.getElementById('kb-dk-err'); errEl.textContent = '';
    var kid = document.getElementById('kb-dk-keep').value;
    var k = _drinkKeeps.find(function (x) { return x.id === kid; });
    if (!k) { errEl.textContent = 'キープを選択してください'; return; }
    var qty = Math.round((parseInt(document.getElementById('kb-dk-qty').value) || 0) / 10) * 10;
    if (qty <= 0) { errEl.textContent = '数量(ml)を入力してください'; return; }
    var soda = document.getElementById('kb-dk-soda').checked;
    var item = {
      productId: k.id, productName: kbOrderName(k, soda ? 'ソーダ' : ''), productType: 'keep',
      qty: qty, unit: 'ml', unitPrice: 0, blindMarkId: null, keepBottleId: k.id
    };
    document.getElementById('kb-drink-modal').style.display = 'none';
    if (typeof _drinkCtx.onAdd === 'function') _drinkCtx.onAdd(item);
  }

  // ========================================================================
  // Phase 4/5: 会計時の重量振り分け（＋部分会計の再起点）
  // ========================================================================
  var _allocCtx = null, _allocQueue = [], _allocCur = null;

  async function openAllocation(ctx) {
    ctx = ctx || {}; var bizDate = ctx.bizDate || nowDate();
    var coVks = ctx.checkoutVisitKeys || [];
    var coMembers = {};
    (ctx.allVisits || []).forEach(function (v) { if (coVks.indexOf(v.id) >= 0 && v.memberId) coMembers[v.memberId] = 1; });
    var keeps = [];
    try {
      var snap = await db().collection('keepBottles').where('status', '==', 'active').get();
      snap.docs.forEach(function (d) {
        var k = Object.assign({ id: d.id }, d.data());
        if (!(k.sessionActive && k.sessionDate === bizDate)) return;
        if ((k.userMemberIds || []).some(function (o) { return coMembers[o]; })) keeps.push(k);
      });
    } catch (e) { }
    if (!keeps.length) return false;
    _allocCtx = ctx; _allocCtx.bizDate = bizDate; _allocQueue = keeps.slice();
    ensureAllocModal();
    nextAllocation();
    return true;
  }

  function ensureAllocModal() {
    if (document.getElementById('kb-alloc-modal')) return;
    var w = document.createElement('div');
    w.id = 'kb-alloc-modal';
    w.style.cssText = 'position:fixed;inset:0;background:rgba(24,17,10,.55);z-index:9200;display:none;align-items:flex-start;justify-content:center;padding:16px;overflow-y:auto;font-family:inherit';
    w.innerHTML =
      '<div style="width:100%;max-width:560px;background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.3);margin-top:20px">' +
      '<div style="padding:14px 18px;border-bottom:1px solid #eee;font-weight:700;font-size:16px" id="kb-al-title">🍾 キープ精算</div>' +
      '<div style="padding:14px 18px;max-height:74vh;overflow-y:auto">' +
        '<div style="display:flex;gap:10px;align-items:flex-end;margin-bottom:8px">' +
          '<div style="flex:1"><div style="font-size:12px;color:#666;margin-bottom:4px">使用後の重量（g）</div><input id="kb-al-weight" type="number" style="width:100%;padding:9px;border:1px solid #ccc;border-radius:6px;font-size:14px"></div>' +
          '<button id="kb-al-even" style="padding:9px 12px;border:1px solid #7a5610;background:#efe3d4;color:#7a5610;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap">残を均等配分</button>' +
        '</div>' +
        '<div id="kb-al-summary" style="font-size:12px;color:#444;background:#faf6ee;border-radius:6px;padding:8px 10px;margin-bottom:10px;line-height:1.7"></div>' +
        '<div id="kb-al-rows"></div>' +
        '<div id="kb-al-err" style="color:#c0392b;font-size:12px;min-height:14px;margin-top:8px"></div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;padding:12px 18px;border-top:1px solid #eee;justify-content:flex-end">' +
        '<button id="kb-al-skip" style="padding:9px 16px;border:1px solid #ccc;background:#f5f5f5;border-radius:6px;cursor:pointer;font-size:13px">このボトルは後で</button>' +
        '<button id="kb-al-ok" style="padding:9px 18px;border:none;background:#7a5610;color:#fff;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">振り分け確定</button>' +
      '</div></div>';
    document.body.appendChild(w);
    document.getElementById('kb-al-weight').addEventListener('input', allocRecompute);
    document.getElementById('kb-al-even').addEventListener('click', allocEven);
    document.getElementById('kb-al-skip').addEventListener('click', function () { nextAllocation(); });
    document.getElementById('kb-al-ok').addEventListener('click', allocConfirm);
  }

  async function nextAllocation() {
    if (!_allocQueue.length) {
      document.getElementById('kb-alloc-modal').style.display = 'none';
      if (_allocCtx && typeof _allocCtx.onDone === 'function') _allocCtx.onDone();
      return;
    }
    var k = _allocQueue.shift();
    var bizDate = _allocCtx.bizDate;
    // 当セッションの当ボトルのKB注文（申告量）を visitKey ごとに集計
    var declared = {};
    try {
      var snap = await db().collection('orders').where('keepBottleId', '==', k.id).get();
      snap.docs.forEach(function (d) {
        var o = d.data();
        if (o.orderDate !== bizDate || o.served === 0) return;
        if (o.productType !== 'keep') return;
        if (o.kbSettle) return; // 精算注文は除外（申告のみ集計）
        var vk = o.visitKey; if (!vk) return;
        declared[vk] = (declared[vk] || 0) + (Number(o.qty) || 0);
      });
    } catch (e) { }
    // 当セッションの来場者（スタッフ除く）
    var visitors = (_allocCtx.allVisits || []).filter(function (v) {
      var vd = v.visitDate || (v.id || '').slice(0, 6);
      return vd === bizDate && !v.isStaff;
    }).map(function (v) {
      return { id: v.id, memberId: v.memberId || null, name: memberNameFromCtx(v.memberId) || ('ゲスト（' + v.id + '）'), declared: declared[v.id] || 0, added: 0 };
    });
    // 申告があるが visitors に無い（退場済み等）来場も拾う
    Object.keys(declared).forEach(function (vk) {
      if (!visitors.find(function (x) { return x.id === vk; })) {
        var v = (_allocCtx.allVisits || []).find(function (x) { return x.id === vk; });
        visitors.push({ id: vk, memberId: v ? v.memberId : null, name: (v && memberNameFromCtx(v.memberId)) || ('来場（' + vk + '）'), declared: declared[vk] || 0, added: 0 });
      }
    });
    _allocCur = { keep: k, visitors: visitors };
    document.getElementById('kb-al-title').textContent = '🍾 キープ精算 — ' + (k.bottleEs || k.bottleJa || k.id);
    document.getElementById('kb-al-weight').value = '';
    document.getElementById('kb-al-err').textContent = '';
    renderAllocRows();
    allocRecompute();
    document.getElementById('kb-alloc-modal').style.display = 'flex';
  }

  function memberNameFromCtx(id) {
    if (!id) return null;
    var arr = (_allocCtx && _allocCtx.members) || [];
    var m = arr.find ? arr.find(function (x) { return x.id === id || x.memberId === id; }) : null;
    return m ? (m.nickname || m.name || m.displayId || m.memberId || m.id) : null;
  }
  function renderAllocRows() {
    var rows = document.getElementById('kb-al-rows');
    rows.innerHTML = _allocCur.visitors.map(function (v, i) {
      return '<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #f0f0f0;font-size:13px">' +
        '<div style="flex:1"><b>' + esc(v.name) + '</b></div>' +
        '<div style="width:74px;text-align:right;color:#888">申告 ' + v.declared + '</div>' +
        '<div style="display:flex;align-items:center;gap:3px">＋<input type="number" class="kb-al-add" data-i="' + i + '" step="10" min="0" value="' + v.added + '" style="width:74px;padding:6px;border:1px solid #ccc;border-radius:5px;font-size:13px;text-align:right">ml</div>' +
        '<div style="width:70px;text-align:right;font-weight:600" data-total="' + i + '">' + (v.declared + v.added) + '</div>' +
        '</div>';
    }).join('') || '<div style="color:#aaa;font-size:12px;padding:8px">対象の来場者がいません</div>';
    Array.prototype.forEach.call(rows.querySelectorAll('.kb-al-add'), function (inp) {
      inp.addEventListener('input', function () {
        var i = parseInt(this.getAttribute('data-i'));
        _allocCur.visitors[i].added = Math.max(0, parseInt(this.value) || 0);
        allocRecompute();
      });
    });
  }
  function allocComputedRemaining() {
    var k = _allocCur.keep;
    var w = document.getElementById('kb-al-weight').value;
    if (w === '') return null;
    var wG = parseFloat(w) || 0;
    return remainFromWeightKeep(k, wG);
  }
  function allocRecompute() {
    var k = _allocCur.keep;
    var startRem = k.sessionStartRemaining != null ? Number(k.sessionStartRemaining) : (k.remaining != null ? Number(k.remaining) : null);
    var curRem = allocComputedRemaining();
    var consumed = (startRem != null && curRem != null) ? Math.max(0, startRem - curRem) : null;
    var sumDeclared = _allocCur.visitors.reduce(function (s, v) { return s + v.declared; }, 0);
    var sumAdded = _allocCur.visitors.reduce(function (s, v) { return s + v.added; }, 0);
    var remainder = (consumed != null) ? (consumed - sumDeclared) : null;
    _allocCur.visitors.forEach(function (v, i) { var el = document.querySelector('[data-total="' + i + '"]'); if (el) el.textContent = v.declared + v.added; });
    var s = document.getElementById('kb-al-summary');
    s.innerHTML =
      '開始残量：<b>' + (startRem != null ? startRem + 'ml' : '—') + '</b>　使用後残量：<b>' + (curRem != null ? curRem + 'ml' : '（重量入力待ち）') + '</b><br>' +
      '消費合計：<b>' + (consumed != null ? consumed + 'ml' : '—') + '</b>　申告合計：<b>' + sumDeclared + 'ml</b>　未申告(残)：<b style="color:' + (remainder != null && remainder < 0 ? '#c0392b' : '#1a6e58') + '">' + (remainder != null ? remainder + 'ml' : '—') + '</b><br>' +
      '追加合計：<b>' + sumAdded + 'ml</b>' + (remainder != null ? '　（残 ' + remainder + 'ml と一致させてください）' : '');
    var err = document.getElementById('kb-al-err');
    if (remainder != null && remainder < 0) err.textContent = '申告が消費量を超えています。使用後重量を確認してください。';
    else err.textContent = '';
  }
  function allocEven() {
    var k = _allocCur.keep;
    var startRem = k.sessionStartRemaining != null ? Number(k.sessionStartRemaining) : (k.remaining != null ? Number(k.remaining) : null);
    var curRem = allocComputedRemaining();
    if (startRem == null || curRem == null) { document.getElementById('kb-al-err').textContent = '先に使用後の重量を入力してください'; return; }
    var consumed = Math.max(0, startRem - curRem);
    var sumDeclared = _allocCur.visitors.reduce(function (s, v) { return s + v.declared; }, 0);
    var remainder = consumed - sumDeclared;
    var n = _allocCur.visitors.length;
    if (n === 0) return;
    if (remainder < 0) { document.getElementById('kb-al-err').textContent = '申告が消費量を超えています。'; return; }
    var each = Math.floor(remainder / n / 10) * 10;
    var used = each * n;
    _allocCur.visitors.forEach(function (v) { v.added = each; });
    var leftover = remainder - used;
    var idx = 0;
    while (leftover > 0 && n > 0) { _allocCur.visitors[idx % n].added += Math.min(10, leftover); leftover -= Math.min(10, leftover); idx++; }
    renderAllocRows(); allocRecompute();
  }
  async function allocConfirm() {
    var err = document.getElementById('kb-al-err'); err.textContent = '';
    var k = _allocCur.keep;
    var startRem = k.sessionStartRemaining != null ? Number(k.sessionStartRemaining) : (k.remaining != null ? Number(k.remaining) : null);
    var curRem = allocComputedRemaining();
    if (curRem == null) { err.textContent = '使用後の重量を入力してください'; return; }
    var endW = parseFloat(document.getElementById('kb-al-weight').value) || 0;
    var consumed = (startRem != null) ? Math.max(0, startRem - curRem) : null;
    var sumDeclared = _allocCur.visitors.reduce(function (s, v) { return s + v.declared; }, 0);
    var sumAdded = _allocCur.visitors.reduce(function (s, v) { return s + v.added; }, 0);
    if (consumed != null && (sumDeclared + sumAdded) !== consumed) {
      err.textContent = '申告＋追加（' + (sumDeclared + sumAdded) + 'ml）が消費合計（' + consumed + 'ml）と一致していません。';
      return;
    }
    var bizDate = _allocCtx.bizDate;
    var orderTime = _allocCtx.orderTime || nowTime();
    var staffUid = _allocCtx.staffUid || (firebase.auth().currentUser && firebase.auth().currentUser.uid) || null;
    var btn = document.getElementById('kb-al-ok'); btn.disabled = true;
    try {
      // 追加分の ¥0 注文を各来場へ差し込む
      var toAdd = _allocCur.visitors.filter(function (v) { return v.added > 0; });
      if (toAdd.length) {
        var bid = await nextBatchId(bizDate);
        var entries = [];
        for (var i = 0; i < toAdd.length; i++) {
          var v = toAdd[i];
          var ogid = await nextOrderGroupId(v.id);
          entries.push({
            orderTime: orderTime, customerId: v.memberId || null, visitKey: v.id,
            orderGroupId: ogid, batchId: bid, itemSeq: 1,
            productCode: k.id, productName: kbOrderName(k, '精算'), productType: 'keep',
            qty: v.added, unit: 'ml', unitPrice: 0,
            blindId: 0, blindMarkId: null, served: 1, keepBottleId: k.id, kbSettle: true
          });
        }
        await injectOrders(bizDate, entries);
      }
      // キープ更新（Phase 5: オーナーが残っていれば再起点、全員退出なら終了）
      var coVks = _allocCtx.checkoutVisitKeys || [];
      var owners = k.userMemberIds || [];
      var remainOwnersPresent = (_allocCtx.allVisits || []).some(function (vv) {
        return vv.memberId && owners.indexOf(vv.memberId) >= 0 && !vv.checkoutTime && coVks.indexOf(vv.id) < 0
          && ((vv.visitDate || (vv.id || '').slice(0, 6)) === bizDate);
      });
      var upd = { remaining: curRem, lastWeight: endW, updatedAt: FV().serverTimestamp() };
      if (remainOwnersPresent) {
        // 部分会計: 会計時点の重量を新しい使用開始基準にする
        upd.sessionStartWeight = endW; upd.sessionStartRemaining = curRem;
      } else {
        // 全オーナー退出: 今セッションを終了
        upd.sessionActive = false;
      }
      await db().collection('keepBottles').doc(k.id).update(upd);
      if (window.writeJournal) { try { window.writeJournal('update', 'keepBottles', k.id, null, upd); } catch (e) { } }
      db().collection('keepBottleLog').add({
        keepBottleId: k.id, type: remainOwnersPresent ? 'settle-partial' : 'settle', date: bizDate, time: nowTime(),
        memberId: null, weight: endW, remainingMl: curRem, amount: 0,
        note: remainOwnersPresent ? '会計精算（部分・再起点）' : '会計精算（セッション終了）', staffUid: staffUid, createdAt: FV().serverTimestamp()
      }).catch(function () { });
      nextAllocation();
    } catch (e) {
      err.textContent = '精算に失敗しました: ' + (e && e.message ? e.message : e);
    } finally { btn.disabled = false; }
  }

  return {
    openPurchase: openPurchase,
    onCheckin: onCheckin,
    openDrink: openDrink,
    openAllocation: openAllocation,
    injectOrders: injectOrders,
    nextOrderGroupId: nextOrderGroupId,
    nextBatchId: nextBatchId,
    remainingFromWeight: remainingFromWeight
  };
})();
