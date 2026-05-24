# ZernFlow Fork

這是 [zernio-dev/zernflow](https://github.com/zernio-dev/zernflow) 的**個人 fork**,
維護在 https://github.com/CodingWeiting/zernflow。

**策略:** 純個人版本維護,**不會 PR 回 upstream**。
- upstream 拉新功能 → merge 進 main → 解 conflict 後 push 自己 fork
- 自己加的 feature 直接在 main 或 feature branch 開發,push origin
- branch 命名只為自己日後翻看方便,不為 PR 準備

## Why fork?

主要目的:**重建被 upstream 拔掉的 comment automation,並加上 ManyChat-style 的「特定貼文」trigger filter**。

Upstream commit `d9d8485` (2026-03-19) 把 comment polling cron + processor 整個拔掉
(`app/api/cron/comments/route.ts` -236 行 / `lib/comment-processor.ts` -286 行),
commit message 說「webhooks handle it now」但實際 webhook handler 並沒有加上 comment
event 處理。當前狀態:

- `comment_keyword` trigger type 在 UI 還在(`components/flow-builder/panels/TriggerPanel.tsx`)
- 後端 `lib/flow-engine/trigger-matcher.ts` 沒處理這個 type → 死功能
- `comment_logs` table 仍存在但沒寫入

## Repo layout

```
zernflow-fork/
├─ app/ components/ lib/ supabase/ public/ scripts/  ← upstream(不動)
├─ docker/                                            ← fork(本機 dev)
│  ├─ Dockerfile.dev
│  └─ docker-compose.yml
├─ docs/                                              ← fork(這份文件)
│  ├─ FORK.md
│  └─ LOCAL_DEV.md
├─ .dockerignore .env.local .mcp.json .gitignore     ← 配置(.env/.mcp gitignored)
└─ 上游 root files(package.json, next.config.ts, ...)
```

詳細 local dev 跑法看 [LOCAL_DEV.md](LOCAL_DEV.md)。

## Sync upstream

定期拉 upstream 更新,降低 merge conflict:

```bash
git fetch upstream
git checkout main
git merge upstream/main
# 解 conflict 後
git push origin main
```

## Custom features (work in progress)

| Feature | Status | 影響檔案 |
|---------|--------|---------|
| Comment webhook handler | 規劃中 | `app/api/webhooks/late/route.ts`, `lib/flow-engine/trigger-matcher.ts` |
| `post_id` filter for comment_keyword | 規劃中 | `lib/types/database.ts`, `components/flow-builder/panels/TriggerPanel.tsx`, `lib/flow-engine/trigger-matcher.ts` |
| Post selector UI(從 Zernio API 抓 IG 貼文清單)| 規劃中 | `components/flow-builder/panels/PostSelector.tsx`(新增)|

實作進度更新時改這張表。每個 feature 一條 git branch:`feature/comment-webhook`, `feature/post-filter`, `feature/post-selector`。
