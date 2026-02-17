/**
 * LINE UserID → 企業名マッピング管理
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
