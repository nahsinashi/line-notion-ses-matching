/**
 * 06_LINEマッピング.gs
 *
 * 【機能概要】
 * LINE UserIDと企業名の対応関係を管理
 *
 * 【用途】
 * - LINE受信時に送信元の企業名を特定
 * - 配信時の宛先企業フィルタリング
 * - 未マッピングUserIDの管理者通知
 *
 * 【初期設定】
 * setupLineUserMapping() を実行してマッピングを登録
 * 新しいパートナー追加時もこの関数を更新して再実行
 */

/**
 * マッピングを初期化/設定する
 * 手動で実行してマッピングを登録
 */
function setupLineUserMapping() {
  const mapping = {
    "U1a1ba3866d295703c3108691279428f9": "なっしー（テスト）",
    // ここに追加していく
    // "Uxxxxxxxxxxxxx": "株式会社ABC",
    // "Uyyyyyyyyyyyyy": "株式会社XYZ",
  };
  
  const props = PropertiesService.getScriptProperties();
  props.setProperty("LINE_USER_MAPPING", JSON.stringify(mapping));
  
  Logger.log("✅ LINEユーザーマッピングを設定しました");
  Logger.log(JSON.stringify(mapping, null, 2));
}

/**
 * UserIDから企業名を取得
 */
function getCompanyNameByUserId(userId) {
  const props = PropertiesService.getScriptProperties();
  const mappingJson = props.getProperty("LINE_USER_MAPPING");
  
  if (!mappingJson) {
    Logger.log("⚠️ マッピングが未設定です");
    return null;
  }
  
  const mapping = JSON.parse(mappingJson);
  return mapping[userId] || null;
}

/**
 * 新しいユーザーをマッピングに追加
 */
function addLineUserMapping(userId, companyName) {
  const props = PropertiesService.getScriptProperties();
  const mappingJson = props.getProperty("LINE_USER_MAPPING") || "{}";
  const mapping = JSON.parse(mappingJson);
  
  mapping[userId] = companyName;
  props.setProperty("LINE_USER_MAPPING", JSON.stringify(mapping));
  
  Logger.log(`✅ 追加しました: ${userId} → ${companyName}`);
}

/**
 * 現在のマッピングを確認
 */
function showCurrentMapping() {
  const props = PropertiesService.getScriptProperties();
  const mappingJson = props.getProperty("LINE_USER_MAPPING") || "{}";
  Logger.log("現在のマッピング:");
  Logger.log(mappingJson);
}
