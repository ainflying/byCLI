# 内容发布必须先保存草稿并由用户确认

适用于知乎文章、视频、回答，视频号视频，以及百家号视频、图文、文章。上层 Agent 必须遵守以下顺序：

1. 准备素材，调用草稿准备命令，保存到平台草稿箱并重新核对。上传预览和本地操作记录不能代替平台草稿。
2. 向用户展示平台、账号、标题或描述、正文、视频/图片/封面、AI 声明及具体草稿身份。此时结束准备阶段，等待用户对当前内容明确确认发布。准备素材或上传的授权不能替代这次确认；内容变化后须重新核对、确认。
3. 获得确认后，单独调用同一操作记录的 `--mode submit --execute --user-confirmed`。未确认时保持草稿，不调用提交。
4. 用状态和数据读取命令核对结果。验证码由用户完成；未知提交状态不能自动重复发布。

`--user-confirmed` 是上层已完成确认的显式声明，CLI 无法独立验证聊天记录。该参数只接受布尔值，只能用于单独的 `submit`，不能在准备阶段预先授权。通用浏览器的点击或脚本能力不受这些专用命令的参数检查控制；上层 Agent 同样不得用它们绕过草稿与确认流程。

| 平台与内容 | 准备与核对 | 用户确认后单独提交 |
| --- | --- | --- |
| 知乎文章 | `article-draft`，需要时 `article-publish --mode reopen` | `article-publish --mode submit --user-confirmed` |
| 知乎视频 | `video-draft`，需要时 `video-publish --mode reopen` | `video-publish --mode submit --user-confirmed` |
| 知乎回答 | `answer-submit --mode prepare`，需要时 `--mode reopen` | `answer-submit --mode submit --user-confirmed` |
| 视频号视频 | `video-publish --mode prepare` 自动保存并重开；`resume` 重新核对已保存草稿；`adopt-draft` 接管精确已有草稿 | `video-publish --mode submit --user-confirmed` |
| 百家号视频、图文、文章 | 对应 `*-publish --mode prepare`，需要时 `--mode reopen` | 对应 `*-publish --mode submit --user-confirmed` |

所有写入阶段还需要 `--execute`，所有阶段复用同一 `--operation` 路径。操作记录含正文、素材信息等内容，应存放在私有目录。知乎旧 `answer` 直接发布入口已停用，调用会明确报错，改用 `answer-submit`。

视频号通过原生“保存草稿”按钮提交保存请求，从当前请求的成功回执取得精确 `export/...` 草稿 ID，再通过草稿箱对应卡片的编辑控件重开，核对描述、视频、AI 声明。结果的 `editor.draft_id` 和操作记录的 `source_draft_id` 表示原草稿 ID，与发表后新管理 ID 分开。

`draft_saved` 表示已保存重开，但封面或其他条件尚未就绪；`prepared` 表示已保存且当前可提交，仍须等待用户确认。`draft_save_unknown` 保留保存尝试，不能自动再次保存；应检查草稿箱并按精确 ID 接管。旧版仅有预览的 `prepared` 记录不能提交，须先保存并核对平台草稿。重新打开时平台可能清空 AI 标注，适配器只恢复记录中的明确选择。

本轮没有公开发布测试内容。视频号自动上传、保存草稿、原生成功回执、按精确卡片重开核对已真实通过；三平台未确认提交拒绝、未知保存防重和旧版入口关闭由回归测试覆盖。新增确认参数之后的正式发布未再次实测。
