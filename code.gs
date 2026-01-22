/* V4.0 Commander ELO System - Backend
   特色：將 ELO 計算邏輯外包給 'backend' 分頁的公式處理
*/

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('Commander ELO System V4.0')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// 取得全域資料
function getGlobalData() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const userSheet = ss.getSheetByName('Users');
    if (!userSheet) return { status: "success", searchData: [], leaderboard: [] };

    const data = userSheet.getDataRange().getValues();
    let searchData = [];
    let leaderboard = [];

    // 從第 2 行開始讀取
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const id = row[0];   // A欄: ID
      const elo = row[1];  // B欄: ELO
      const name = row[4]; // E欄: 暱稱

      if (id && name) {
        searchData.push({ value: `${name} (${id})` });
        leaderboard.push({
          id: id,
          name: name,
          elo: parseFloat(elo).toFixed(0)
        });
      }
    }
    leaderboard.sort((a, b) => b.elo - a.elo);
    return { status: "success", searchData: searchData, leaderboard: leaderboard };
  } catch (e) {
    return { status: "error", message: "讀取資料失敗: " + e.toString() };
  }
}

// 查詢玩家戰績
function queryPlayerStats(searchStr) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const userSheet = ss.getSheetByName('Users');
    const matchSheet = ss.getSheetByName('Matches');
    
    const users = userSheet.getDataRange().getValues();
    const extractID = (str) => {
      const m = str.match(/\(([^)]+)\)$/);
      return m ? m[1] : str;
    };
    const targetID = extractID(searchStr);
    let playerInfo = null;
    let pMap = {};

    for (let i = 1; i < users.length; i++) {
      const pid = users[i][0];
      const mainNick = users[i][4] || pid;
      pMap[pid] = mainNick;
      if (pid === targetID) {
        playerInfo = { id: pid, name: mainNick, elo: parseFloat(users[i][1]).toFixed(1) };
      }
    }

    if (!playerInfo) return { status: "error", message: "找不到該玩家資料。" };

    const matchData = matchSheet.getDataRange().getValues();
    let history = [];
    
    for (let i = matchData.length - 1; i >= 1; i--) {
      const r = matchData[i];
      if (!r[2]) continue;
      const pIDs = [r[2], r[5], r[8], r[11]];
      
      if (pIDs.includes(targetID)) {
        let eloObj = { before: [0,0,0,0], diff: [0,0,0,0], after: [0,0,0,0] };
        try {
          if (r[15]) eloObj = JSON.parse(r[15]);
        } catch(e) {}

        history.push({
          timestamp: Utilities.formatDate(new Date(r[0]), "GMT+8", "MM-dd HH:mm"),
          matchID: r[1],
          pNames: pIDs.map(id => pMap[id] || id),
          pIDs: pIDs,
          cmds: [[r[3],r[4]], [r[6],r[7]], [r[9],r[10]], [r[12],r[13]]],
          winner: r[14],
          eloData: eloObj
        });
      }
      if (history.length >= 10) break;
    }
    return { status: "success", player: playerInfo, history: history };
  } catch (e) {
    return { status: "error", message: "查詢錯誤: " + e.toString() };
  }
}

// ========== V4.0 核心：透過 backend 分頁計算 ==========
function submitMatch(data) {
  const LOCK = LockService.getScriptLock();
  
  try {
    // 1. 取得鎖定 (極重要！防止多人同時寫入 backend 分頁導致計算錯誤)
    // 等待最多 30 秒
    LOCK.waitLock(30000); 

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const userSheet = ss.getSheetByName('Users');
    const matchSheet = ss.getSheetByName('Matches');
    const calcSheet = ss.getSheetByName('backend'); // 您的計算分頁

    if (!calcSheet) throw new Error("找不到 'backend' 分頁，請確認名稱是否正確");

    // 2. 準備玩家 ID
    const userVals = userSheet.getDataRange().getValues();
    let userMap = {}; // { "Nickname (ID)": rowIndex }
    let idMap = {};   // { "Nickname (ID)": "ID" }

    for (let i = 1; i < userVals.length; i++) {
      let uString = `${userVals[i][4]} (${userVals[i][0]})`;
      userMap[uString] = i + 1; // 1-based index
      idMap[uString] = userVals[i][0];
    }

    const inputNames = [data.p1, data.p2, data.p3, data.p4];
    const playerIDs = [];
    
    // 驗證並轉換為 ID
    inputNames.forEach(name => {
      if (idMap[name]) {
        playerIDs.push([idMap[name]]); // 二維陣列 [[id1], [id2]...] 用於寫入直欄
      } else {
        throw new Error("找不到玩家: " + name);
      }
    });

    // 3. 處理勝者 ID
    let winnerInputVal = "";
    let winnerIDForRecord = "";

    if (data.winner === "Draw") {
      // 若和局，讀取 backend!A2 的值
      const drawToken = calcSheet.getRange("A2").getValue(); 
      winnerInputVal = drawToken;
      winnerIDForRecord = "Draw";
    } else {
      if (!idMap[data.winner]) throw new Error("勝者資料錯誤");
      winnerInputVal = idMap[data.winner];
      winnerIDForRecord = idMap[data.winner];
    }

    // 4. 寫入 backend 進行計算
    // A3:A6 填入 ID
    calcSheet.getRange("A3:A6").setValues(playerIDs);
    // C8 填入勝者 (或和局代碼)
    calcSheet.getRange("C8").setValue(winnerInputVal);

    // 強制刷新，確保公式完成運算
    SpreadsheetApp.flush(); 

    // 5. 讀取計算結果
    // B3:B6 = Before, C3:C6 = Diff, D3:D6 = After
    const resultRange = calcSheet.getRange("B3:D6").getValues();

    let beforeElos = [];
    let diffs = [];
    let afterElos = [];

    for(let i=0; i<4; i++) {
      beforeElos.push(parseFloat(resultRange[i][0]));
      diffs.push(parseFloat(resultRange[i][1]));
      afterElos.push(parseFloat(resultRange[i][2]));
    }

    // 6. 更新 Users 資料表 (寫入新的 ELO)
    inputNames.forEach((name, idx) => {
      let rowIdx = userMap[name];
      // 寫入 Users 的 B 欄 (第2欄)
      userSheet.getRange(rowIdx, 2).setValue(afterElos[idx]);
    });

    // 7. 寫入 Matches 歷史紀錄
    const timestamp = new Date();
    const matchID = Utilities.formatDate(timestamp, "GMT+8", "yyyyMMddHHmmss");
    
    const eloRecord = JSON.stringify({
      before: beforeElos,
      diff: diffs,
      after: afterElos
    });

    // 將二維 ID 陣列轉回一維以便儲存
    const flatIDs = playerIDs.map(r => r[0]);

    matchSheet.appendRow([
      timestamp, matchID,
      flatIDs[0], data.p1c1, data.p1c2,
      flatIDs[1], data.p2c1, data.p2c2,
      flatIDs[2], data.p3c1, data.p3c2,
      flatIDs[3], data.p4c1, data.p4c2,
      winnerIDForRecord, eloRecord
    ]);

    return { status: "success" };

  } catch (e) {
    return { status: "error", message: "處理失敗: " + e.toString() };
  } finally {
    // 確保最後解鎖
    LOCK.releaseLock();
  }
}
