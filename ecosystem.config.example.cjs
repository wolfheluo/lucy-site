// =====================================================================
//  pm2 ecosystem 範本（新 VPS 常駐用）
//
//  使用：
//    1. 先照 README「上線前要做的」建好 .env（密碼/密鑰在 .env，不放這裡）
//    2. cp ecosystem.config.example.cjs ecosystem.config.cjs
//    3. 把 cwd 改成你的部署路徑（server 從 cwd 讀 .env）
//    4. pm2 start ecosystem.config.cjs && pm2 save
//
//  為什麼 env 只有兩個平台旗標？
//    - 服務參數（PORT/HOST/VAULT_*/TRUST_PROXY/VAULT_DATA_DIR）全部在 .env，
//      server 啟動時 process.loadEnvFile() 自動讀取（cwd/.env）——單一來源
//    - NODE_ENV 與 START_SERVER 是「啟動平台」專屬，換 systemd/docker 時本來就要重寫
//
//  陷阱：pm2 fork 模式會把 argv[1] 包裝成 ProcessContainerFork.js，
//        server 的 isMain 判斷永遠失敗 → 不設 START_SERVER=1 就不會 listen。
// =====================================================================
module.exports = {
  apps: [
    {
      name: "lucy-site",
      script: "./dist-server/server/index.js",
      cwd: "/www/wwwroot/lucy-site", // ← 改成你的部署路徑（.env 從此目錄讀）
      instances: 1,
      max_memory_restart: "600M",
      env: {
        NODE_ENV: "production", // 自動 serve dist/、開啟 Secure cookie、啟用 H1 防呆
        START_SERVER: "1", // pm2 fork 需要此旗標才會 listen
      },
    },
  ],
};
