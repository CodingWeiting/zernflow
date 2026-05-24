# Local Development

## 一次性設定(已完成)

| 項目 | 內容 |
|------|------|
| Supabase Cloud project | `mihgecqghfqifbufbzih.supabase.co`(Singapore region)|
| Migrations 1-10 | 已透過 Supabase MCP 跑入 |
| ngrok static domain | `bridged-epiphany-tinfoil.ngrok-free.dev` |
| Supabase MCP | `.mcp.json`(gitignored,含 PAT)|

如需重新跑 migrations 或重設環境,看 `.env.example` 跟 `supabase/migrations/`。

## 日常啟動 / 關閉

從 repo root:

```powershell
# 起來(背景跑)
docker compose -f docker/docker-compose.yml up -d --build

# 看 log(即時)
docker compose -f docker/docker-compose.yml logs -f app

# 關掉(保留 volume / 資料)
docker compose -f docker/docker-compose.yml stop

# 完全收掉(連 named volume 一起殺)
docker compose -f docker/docker-compose.yml down -v
```

或者進 `docker/` 後不用 `-f`:

```powershell
cd docker
docker compose up -d --build
docker compose logs -f app
docker compose down
```

## 訪問點

| URL | 用途 |
|-----|------|
| http://localhost:3000 | ZernFlow UI(瀏覽器開) |
| https://bridged-epiphany-tinfoil.ngrok-free.dev | 對外公開,Zernio webhook 打的位址 |
| https://bridged-epiphany-tinfoil.ngrok-free.dev/api/webhooks/late | Zernio → ZernFlow webhook 接收端 |
| http://localhost:4040 | ngrok inspector(每個 webhook payload 都能看)|

## 為什麼 Docker 而不是直接 `npm run dev`?

1. **process 持久性**:背景跑不依賴 VSCode / Claude session
2. **乾淨環境**:Linux container 跑 npm install,避免 Windows 的 `node_modules` binary 問題
3. **整個 stack 一起管**:Next.js + ngrok 同一個 compose 起來,不用兩個 PowerShell 視窗

## Hot reload 細節

- Source code 從 repo root bind mount 進 `/app`,改 `.tsx` / `.ts` 檔 Turbopack 自動重編譯
- `node_modules` 跟 `.next` 用 named volume **覆蓋** bind mount,因為:
  - 主機是 Windows,`node_modules` 內的 native binary 是 Windows ABI,容器是 Linux 跑不起
  - `.next` build cache 在容器內生成更快
- 改 `package.json` 要 `docker compose up -d --build` 重 build,光 hot reload 不會抓到新 dep

## 環境變數

`.env.local` 在 repo root,**不要 commit**(`.gitignore` 已擋)。需要的欄位:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
CRON_SECRET
NEXT_PUBLIC_APP_URL=https://bridged-epiphany-tinfoil.ngrok-free.dev
```

範本看 `.env.example`。

## Troubleshooting

### Port 3000 already in use
其他 process 在用 3000(可能是舊 Docker stack)。檢查:
```powershell
docker ps --filter "publish=3000"
```
全部 stop / down 後重啟。

### ngrok 顯示 ERR_NGROK_3200(endpoint offline)
ngrok container 掛了。`docker compose logs ngrok` 看原因(常見:authtoken 過期、agent 版本太舊 — 已用 ngrok/ngrok:latest 解決)。

### Next.js 改 code 沒 hot reload
WATCHPACK_POLLING 應該 ON(`docker/docker-compose.yml` 已設)。如果還是不行,試 `docker compose restart app`。

### Supabase MCP 失效
VSCode reload window(`Ctrl+Shift+P` → Developer: Reload Window)。`.mcp.json` 改了也要 reload。
