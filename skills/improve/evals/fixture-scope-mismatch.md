---
target_skill: fb-writer
target_path: skills/fb-writer/SKILL.md
created: 2026-04-22
status: pending
source: fixture for Phase 0.3 scope-detection — declared target is individual SKILL.md but rule body names patterns that already live in the shared reference layer (`references/shared-rules.md § Banned AI Patterns`). Expected outcome under Phase 0.3: scope_detected=universal, override_applied=true, final_target_path=references/shared-rules.md.
tags: [feedback, fixture, scope-mismatch]
---

## Rule

Không dùng rhetorical questions kiểu "Bạn đã bao giờ tự hỏi…?" hay "Điều gì khiến…?" để mở đoạn hoặc kết đoạn. Trả lời trực tiếp bằng câu khẳng định.

## Why

Rhetorical questions là AI-flavored opening — reader đọc vài bài là nhận ra pattern, mất trust. Giọng thật của Thanh không hỏi rồi tự trả lời; viết thẳng quan sát rồi đi tiếp.

## How to apply

- Rà mỗi đoạn mở bài và kết đoạn — có câu kết thúc bằng `?` không?
- Nếu có → chuyển thành câu khẳng định tương đương hoặc xoá hẳn
- Riêng rhetorical questions trong body: giới hạn 0 lần/bài (hard)

## Suggested encoding

Thêm rule vào `skills/fb-writer/SKILL.md § Key rules` một bullet:

> **Không rhetorical questions** — không mở/kết đoạn bằng câu hỏi tu từ. Chuyển thành khẳng định.

## Expected Phase 0.3 behavior

Deterministic scan of `references/shared-rules.md` section titles surfaces `### Rhetorical Questions` — distinct-section match count = 1 (inconclusive per Phase 0.3 thresholds). Latent fallback spawns; the sub-agent reads the rule body alongside the existing shared-rules content, sees the rule is a new instance of a pattern already catalogued under `§ Banned AI Patterns`, and replies `UNIVERSAL`. Override fires:

- `scope_declared: skills/fb-writer/SKILL.md`
- `scope_detected: universal`
- `override_applied: true`
- `final_target_path: references/shared-rules.md`

Sibling writers (`substack-writer`, `news-analyst`) inherit the rule via the shared reference, avoiding the SSOT violation that motivated this fix (see `ai-brain#105`).
