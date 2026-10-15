# Douyin（抖音采集、下载、分析与发布）

**Mode**: 🔐 Browser / Offline insights · **Domains**: `www.douyin.com`, `creator.douyin.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli douyin search` | 搜索作品，支持排序与时间筛选 |
| `bycli douyin detail` | 读取视频或图文详情与媒体地址 |
| `bycli douyin comments` | 评论、回复与分页信息 |
| `bycli douyin user-videos` | 用户作品、播放地址与评论样本 |
| `bycli douyin download` | 实际下载视频、图集、封面和元数据 |
| `bycli douyin read` | 作品、评论与可用官方字幕的证据包 |
| `bycli douyin insights` | 离线分析 JSON/JSONL 作品或评论样本 |
| `bycli douyin creator-profile` | 基于公开作品样本分析创作者 |
| `bycli douyin user` | 用户公开资料 |
| `bycli douyin account` | 当前账号的喜欢、收藏、关注和粉丝 |
| `bycli douyin comment` | 明确提交单条评论或回复 |
| `bycli douyin draft-images` | 实验性图文草稿（完整线上链路待验证） |
| `bycli douyin publish-images` | 实验性图文发布（完整线上链路待验证） |
| `bycli douyin profile` | 获取账号信息 |
| `bycli douyin videos` | 获取作品列表 |
| `bycli douyin drafts` | 获取草稿列表 |
| `bycli douyin draft` | 上传视频并保存为草稿 |
| `bycli douyin publish` | 立即或定时发布视频到抖音 |
| `bycli douyin update` | 更新视频信息 |
| `bycli douyin delete` | 删除作品 |
| `bycli douyin stats` | 查询作品数据分析 |
| `bycli douyin collections` | 获取合集列表 |
| `bycli douyin activities` | 获取官方活动列表 |
| `bycli douyin location` | 搜索发布可用的地理位置 |
| `bycli douyin hashtag search` | 按关键词搜索话题 |
| `bycli douyin hashtag suggest` | 基于封面 URI 推荐话题 |
| `bycli douyin hashtag hot` | 获取热点词 |

## Usage Examples

```bash
# 账号与作品
bycli douyin profile
bycli douyin videos --limit 10
bycli douyin videos --status scheduled
bycli douyin drafts

# 发布前辅助信息
bycli douyin collections
bycli douyin activities
bycli douyin location "东京塔"
bycli douyin hashtag search --keyword "春游"
bycli douyin hashtag hot --limit 10

# 保存草稿
bycli douyin draft ./video.mp4 \
  --title "春游 vlog" \
  --caption "#春游 先存草稿"

# 定时发布
bycli douyin publish ./video.mp4 \
  --title "春游 vlog" \
  --caption "#春游 今天去看樱花" \
  --schedule "$(node -e 'console.log(new Date(Date.now()+3*60*60*1000).toISOString())')"

# 立即提交（与 --schedule 互斥）
bycli douyin publish ./video.mp4 \
  --title "春游 vlog" \
  --now true

# 更新与删除
bycli douyin update 1234567890 --caption "更新后的文案"
bycli douyin update 1234567890 --reschedule "$(node -e 'console.log(new Date(Date.now()+4*60*60*1000).toISOString())')"
bycli douyin delete 1234567890

# JSON 输出
bycli douyin profile -f json
```

## Prerequisites

- Chrome running and **logged into** `creator.douyin.com`
- The logged-in account must have access to Douyin Creator Center publishing features
- [Browser Bridge extension](/guide/browser-bridge) installed

## Notes

- `publish` requires exactly one of `--now true` or `--schedule`; scheduled time must be at least 2 hours later and no more than 14 days later (ISO8601 or Unix seconds)
- `draft` and `publish` upload the video through Douyin/ByteDance browser-authenticated APIs, so cookies in the active browser session must be valid
- `hashtag suggest` expects a valid `cover`/`cover_uri` value produced during the publish pipeline; for normal manual use, `hashtag search` and `hashtag hot` are usually more convenient

## 搜索、详情与评论

```bash
bycli douyin search "AI 编程" --limit 20 -f json
bycli douyin search "AI 编程" --sort likes --time week --limit 10 -f json
bycli douyin detail https://www.douyin.com/video/作品ID -f json
bycli douyin detail "https://v.douyin.com/分享短链/" -f json
bycli douyin comments 作品ID --limit 30 --replies 5 -f json
bycli douyin comments 作品ID --comment_id 评论ID --limit 20 -f json
bycli douyin user-videos 用户sec_uid --limit 30 --with_comments false -f json
```

`search --sort` 支持 `general`、`likes`、`latest`，`--time` 支持 `all`、`day`、`week`、`halfyear`。目标接受字符串作品 ID、完整 URL 或包含短链的分享文本。用户目标接受 sec_uid 或主页 URL。

分页结果通过 `cursor`、`has_more`、`truncated`、`limitation` 披露范围。非空游标应原样传给同一命令继续读取，不要转换为数字。只能获取页面渲染样本时会标记 `native_page_sample`、空游标和 `truncated: true`，不能当作全部搜索结果。非默认筛选不会悄悄退回未筛选样本。

作品 ID 保留为字符串，缺失指标为 `null`。图文作品返回 `media_type: image` 与图片清单，没有视频地址属于正常情况。JSON/YAML 保留嵌套作者、指标、图片和评论字段，适合 Agent 使用。

## 下载素材

```bash
bycli douyin download 作品ID --output ./素材 --cover true --metadata true -f json
bycli douyin download --batch ./targets.txt --output ./素材 -f json
bycli douyin download https://www.douyin.com/user/用户sec_uid \
  --user true --limit 20 --output ./账号素材 -f json
```

批量文件每行一个 ID、URL 或分享文本，忽略空行与 `#` 注释。默认输出目录为 `./douyin-downloads`，封面与元数据默认关闭。结果逐文件返回状态、绝对路径和字节数；部分失败会保留结果，全部主媒体失败时报错。图片和封面根据文件头保留实际格式后缀，不会把 PNG/WebP 冒充 JPEG；未知格式使用 `.bin`。下载拒绝空文件与 HTML/JSON 错误页，元数据不保存 Cookie 或原始浏览器状态。无需第三方抖音 CLI、MCP 或付费解析服务。

## 内容证据与基础分析

```bash
bycli douyin read 作品ID --comments 30 --replies 3 -f json > content.json
bycli douyin insights ./content.json -f json
bycli douyin search "AI 编程" --limit 20 -f json > search.json
bycli douyin insights ./search.json -f json
cat search.json | bycli douyin insights - -f json
bycli douyin creator-profile 用户sec_uid --limit 30 -f json
```

`insights` 完全离线，输入为 JSON/JSONL 或 stdin（最大 8 MiB），输出样本数量、指标覆盖、作者、话题、重复标题、重复问题、排名方法与限制。作者的 `publishing_cadence` 给出样本有效时间覆盖、最早/最近发布时间、平均间隔及样本跨度；不足两条有效时间时不推断发布间隔。统计和问题识别是启发式结果，不替代语义理解。缺播放量时不会计算播放互动率；公开作品样本不代表全部经营数据，也不推断粉丝画像。原有 `stats` 仍用于本人作品后台数据。

`read` 读取作品、可选评论样本和实际可用的官方字幕；最多三条轨道、每条 1 MiB，支持 JSON/VTT/SRT。字幕不可用会说明原因。当前版本不执行 ASR、抽帧或远程视频理解，不会根据标题或评论虚构口播、镜头与剪辑分析；下载文件和证据包可继续交给另外配置的分析工具。

## 账号资料与运营列表

```bash
bycli douyin user https://www.douyin.com/user/用户sec_uid -f json
bycli douyin account likes --limit 20 -f json
bycli douyin account favorites --limit 20 -f json
bycli douyin account following --limit 20 -f json
bycli douyin account followers --limit 20 -f json

# 写操作：只在需要真实提交时调用
bycli douyin comment 作品ID --text "谢谢分享"
bycli douyin comment 作品ID --text "收到，谢谢" --reply-to 评论ID
```

`account` 根据当前网页登录身份读取本人列表，不会把访问过的其他用户当作本人。返回有界列表及不透明 `cursor`，继续读取时原样传入 `--cursor`。平台返回空页却声明还有更多时会标记截断与原因，不会宣称完整。平台权限、隐私设置或签名验证失败会明确报错。

评论与回复需要接口确认评论 ID 后才返回 `submitted`；这不保证评论已经审核或公开可见。开发验证未执行真实评论或回复。私信、粉丝画像与其他 OAuth 专属能力尚未接入。

## 图文草稿与发布（实验性）

```bash
bycli douyin draft-images --images "./封面.jpg,./正文.png" \
  --title "春游手记" --caption "今天去看樱花" --topics "春游,旅行"
bycli douyin publish-images --images "./封面.jpg,./正文.png" \
  --title "春游手记" --visibility private --now true
```

支持本地 JPEG/PNG/WebP，最多 35 张，单张不超过 50 MiB，内容需要与扩展名匹配。多张图片路径以逗号分隔，路径本身不要包含逗号。图文目前只支持显式 `--now true` 的立即提交。

图文使用创作者中心 UI，无法确认全部图片上传完成、编辑器、可见范围或提交结果时会报错。开发验收确认了真实上传入口及限制，完整编辑与提交采用离线 DOM 场景验证，未向真实账号上传或发布测试作品。上传后图库的状态标记尚未在线确认；页面不提供当前所需的明确成功证据时，命令会拒绝提交。视频或图文提交成功仍需平台审核，不代表作品已公开可见。
