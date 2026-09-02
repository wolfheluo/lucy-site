# tools/ —— lucy-site 工具集

每個 tool 一個資料夾，全棧一包（前端 + 後端 + 純資料）。新增 tool 只要五步：

## 新增一個 tool（範例：my-tool）

```
tools/my-tool/
├── meta.ts          # 1️⃣ 純資料（無 import side effect，client/server 共用）
├── server/          # 2️⃣ 後端（Hono router）
│   └── router.ts    #    export function registerMyTool(app, ctx)
└── client/          # 3️⃣ 前端（React 頁面，會自動 code-split）
    └── MyToolPage.tsx
```

**1️⃣ `meta.ts`** —— 基本資料 + 選用作品卡：
```ts
import type { ToolMeta, ToolProjectCard } from "../types.js";
export const myToolMeta: ToolMeta = { id: "my-tool", title: "MY TOOL", zhTitle: "我的工具" };
export const myToolProjectCard: ToolProjectCard = {
  title: "MY TOOL", zh: "我的工具", desc: "...", tags: ["Hono", "React"],
};
```

**2️⃣ `server/router.ts`** —— 後端自行掛路由（可掛多前綴）：
```ts
import { Hono } from "hono";
import type { ServerToolContext } from "../../types.js";
export function registerMyTool(app: Hono, ctx: ServerToolContext): void {
  app.route("/api/tools/my-tool", new Hono() /* ...admin API，用 requireAuth(ctx.sessionSecret) */);
}
```
- ctx 提供：`db`（共享 SQLite，含 `rate_limits` 表）、`dataDir`、`adminPassword`、`sessionSecret`
- 管理 API 記得掛 `requireAuth(ctx.sessionSecret)` middleware
- 認證輔助在 `server/auth.ts`（`requireAuth` / `issueSession`…）、rate limit 在 `server/rate-limit.ts`（`makeRateLimiter(db, {max, windowMs})`）

**3️⃣ `client/`** —— React 頁面（default export 元件）。管理頁若需登入，自己接 auth API。

**4️⃣ `server/registry.ts`** —— 加一行：
```ts
{ meta: myToolMeta, register: registerMyTool },
```

**5️⃣ `src/tools.ts`** —— 加一行（Component 用 lazy）：
```ts
const MyToolPage = lazy(() => import("../tools/my-tool/client/MyToolPage"));
{ meta: myToolMeta, Component: MyToolPage, projectCard: myToolProjectCard },
```

## 自動發生的事
- 前端 route `/tools/my-tool` 自動可用（ToolShell 精簡 chrome）
- 作品集 Projects 區自動長出作品卡（接在 content.ts 手動作品之後）
- server build 自動納入 `server/` 與 `tools/*/server/`

## 慣例與坑
- **server 檔的相對 import 要 `.js` 副檔名**（NodeNext）；client 檔不要
- `meta.ts` / `types.ts` 只允許 type-only import（會被編譯 erase，勿放 runtime 邏輯）
- 敏感資料一律走 env（`server/config.ts`），勿寫死
- 檔案資料放 `ctx.dataDir`（gitignored），勿提交二進位
- API response 統一 `{ ok: true, ... }` / `{ ok: false, error }`（管理端）；公開端視情境
