/**
 * bottle-weight.js — ボトル重量⇔残量(ml) 換算の共通ロジック
 *
 * 内容物は「エチルアルコール（度数×ml）＋水（(100−度数)×ml）」の理想混合と仮定。
 *   内容物重量(g) = ml×(度数/100)×エタノール密度 + ml×(1−度数/100)×水の密度
 *   空瓶重量(g)   = 満載重量(g) − 内容物重量(g)
 *   残量(ml)      = (実測重量 − 空瓶重量) / 内容物密度
 *
 * ボトルデータ管理・キープボトルの双方で使用する。
 */
var BottleWeight = (function(){
  var ETHANOL_DENSITY = 0.789; // g/mL (20℃)
  var WATER_DENSITY   = 0.998; // g/mL (20℃)

  // 内容物の密度 g/mL（度数に応じたエタノール＋水の理想混合）
  function mixtureDensity(abvPct){
    var a = Math.max(0, Math.min(100, Number(abvPct) || 0)) / 100;
    return a * ETHANOL_DENSITY + (1 - a) * WATER_DENSITY;
  }

  // 満載時の内容物重量(g)
  function contentWeight(volumeMl, abvPct){
    return (Number(volumeMl) || 0) * mixtureDensity(abvPct);
  }

  // 満載重量(g)・内容量(ml)・度数(%) → 空瓶重量(g)
  function emptyWeight(fullWeightG, volumeMl, abvPct){
    return Math.round((Number(fullWeightG) || 0) - contentWeight(volumeMl, abvPct));
  }

  // 実測重量(g)・空瓶重量(g)・度数(%) → 残量(ml)
  function remainingMl(measuredWeightG, emptyWeightG, abvPct){
    var d = mixtureDensity(abvPct);
    if (!d) return 0;
    var content = (Number(measuredWeightG) || 0) - (Number(emptyWeightG) || 0);
    return Math.max(0, Math.round(content / d));
  }

  // 残量(ml)・空瓶重量(g)・度数(%) → 想定重量(g)（逆算・確認用）
  function weightFromMl(remainingMlVal, emptyWeightG, abvPct){
    return Math.round((Number(emptyWeightG) || 0) + (Number(remainingMlVal) || 0) * mixtureDensity(abvPct));
  }

  return {
    ETHANOL_DENSITY: ETHANOL_DENSITY, WATER_DENSITY: WATER_DENSITY,
    mixtureDensity: mixtureDensity, contentWeight: contentWeight,
    emptyWeight: emptyWeight, remainingMl: remainingMl, weightFromMl: weightFromMl
  };
})();
