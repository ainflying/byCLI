# Weixin Channels（微信视频号助手）

发布前必须先保存、重开核对平台草稿，向用户展示具体内容并获得明确确认；然后单独调用 `--mode submit --execute --user-confirmed`。准备阶段不得预先传入确认参数。详见[三平台发布确认流程](../../guide/publishing-confirmation.md)。

**Mode**: 🔐 Browser · **Domain**: `channels.weixin.qq.com`

这组只读命令通过当前视频号助手登录会话查询账号统计和作品数据。先在 Chrome 中打开[视频号助手](https://channels.weixin.qq.com/)并扫码登录目标视频号，确保 byCLI 的 [Browser Bridge](/guide/browser-bridge) 已连接。公众号后台的登录状态不能代替视频号助手登录。

## 命令

| 命令 | 用途 | 默认日期窗口 |
| --- | --- | --- |
| `bycli weixin-channels overview` | 账号指标概览，返回一行 | 昨日 |
| `bycli weixin-channels trend` | 账号逐日指标，按日期排列 | 最近 7 天 |
| `bycli weixin-channels sources` | 按后台来源标签汇总账号指标及播放占比 | 最近 7 天 |
| `bycli weixin-channels posts` | 按发布时间筛选作品，返回作品累计指标 | 最近 30 天 |
| `bycli weixin-channels post-detail <id>` | 单篇作品概览、趋势、来源占比、逐日来源明细和留存，返回一行 | 最近 7 天 |

默认窗口均截至 **Asia/Shanghai 的昨日**，不含今天尚未结算的数据。命令读取当前登录账号，不接受 Cookie 或签名参数。

## 使用示例

```bash
# 昨日账号概览
bycli weixin-channels overview --format json

# 最近 7 天的账号逐日趋势
bycli weixin-channels trend --days 7 --format json

# 最近 7 天的来源汇总
bycli weixin-channels sources --days 7 --format json

# 最近 30 天发布的作品，最多 20 条
bycli weixin-channels posts --days 30 --limit 20 --format json

# 将 posts 返回的完整 id 填入这里，再查询这篇作品
bycli weixin-channels post-detail '<id>' --days 7 --format json
```

`id` 是作品的 `objectId`，始终是数字字符串。复制时保留完整数字；它可能超过 JavaScript 的安全整数范围，不能先转成数值再传入。

五个命令都支持成对的自定义日期，起止日均包含：

```bash
bycli weixin-channels overview \
  --start-date 2026-10-01 --end-date 2026-10-07 --format json

bycli weixin-channels posts \
  --start-date 2026-09-01 --end-date 2026-09-30 --limit 50 --format json

bycli weixin-channels post-detail '<id>' \
  --start-date 2026-10-01 --end-date 2026-10-07 --format json
```

`--days` 与 `--start-date` / `--end-date` 互斥。日期格式必须为 `YYYY-MM-DD`，起日不能晚于止日，止日最晚为上海昨日；单次窗口最多 366 天。`--days` 必须是 1–366 的整数，`posts --limit` 必须是 1–1000 的整数。这些选项均须提供值，裸 `--days`、`--limit` 或日期选项会报告参数错误。

## 输出与指标口径

推荐使用 `--format json`（或 `-f json`），尤其是 `post-detail`：JSON 保留嵌套的概览、趋势、来源和留存，以及未列入表格的作品字段。

| 输出字段 | 含义 | 后台字段 |
| --- | --- | --- |
| `views` | 播放次数 | `browse` / `readCount` |
| `recommendations` | 推荐次数 | `like` / `likeCount` |
| `likes` | 喜欢次数 | `fav` / `favCount` |
| `comments` | 评论次数 | `comment` / `commentCount` |
| `shares` | 后台的分享汇总次数 | `forwardAggregation` / `forwardAggregationCount` |
| `follows` | 每日统计为净新增关注；作品列表为后台累计关注指标 | `follow` / `followCount` |
| `completion_rate` | 完播率，单位为百分数，例如 `1.95` 表示 1.95% | `fullPlayRate` × 100 |
| `avg_play_seconds` | 平均播放时长，单位为秒 | `avgPlayTimeSec` |
| `views_pct` | 来源播放占所选周期总播放的百分比，例如 `64.29` 表示 64.29% | 来源 `browse` 之和 ÷ `totalData.browse` 之和 × 100 |

`shares` 使用后台提供的分享汇总，包含其统计的分享渠道；不能把它当作仅“转发给朋友”的 `forward`，也不能把汇总值再与各分享渠道相加。推荐和喜欢是两个不同指标，分别保留。

账号和单篇作品的每日统计中，推荐、喜欢、评论、关注按后台的**净变化**口径计算，扣除取消推荐、取消喜欢、删除评论和取消关注。因此某一天或所选周期的汇总可能出现负数；命令保留这些值。`posts` 返回的作品字段仍是后台提供的累计指标。

计数 `0` 表示后台明确给出零；`null` 表示未提供该指标。空数组、缺失值和不支持的指标不会被补成零。鉴权、请求或数据结构异常会报告错误，不会生成一组成功的零计数。

`overview` 返回 `start_date`、`end_date` 和上述六项计数，是所选日期的**每日统计之和**；`trend` 返回 `date` 和逐日计数。`sources` 使用后台返回的来源名称和 ID，不根据名称合并来源；JSON 中保留 `source_id`、`start_date` 和 `end_date`。

`sources` 的 `views_pct` 保留两位小数，分母是账号或作品的后台总播放次数，不使用已返回来源播放次数之和代替。总播放为零或缺失、该来源播放缺失时返回 `null`；总播放大于零且该来源播放明确为零时返回 `0`。各来源独立舍入后占比之和可能不恰好等于 100。

`posts` 的日期只用于筛选**作品发布时间**，作品计数是后台返回的**累计指标**，不会因为指定了日期窗口就变成该窗口内的增量。因此作品列表计数之和不应直接与账号 `overview` 对账。没有符合发布时间条件的作品时，JSON 返回 `[]`。

`post-detail` 返回一个包含以下字段的对象：

| 字段 | 内容 |
| --- | --- |
| `id`、`start_date`、`end_date` | 原样保留的作品 ID 和统计窗口 |
| `overview` | 该作品在所选统计周期内的指标汇总 |
| `trend` | 该作品在所选统计周期内的逐日指标 |
| `sources` | 该作品在所选统计周期内的来源汇总及 `views_pct` |
| `data_details` | 逐日来源明细，按日期升序排列；每行含 `date`、`source_id`、`source` 和六项计数，同日按后台来源顺序排列 |
| `retention` | `video_seconds`、`max_loss_second` 和 `points`；每个点含 `second` 与百分数 `retained_pct` |
| `fans_breakdown_available` | 后台是否提供可用的粉丝拆分数据 |

留存曲线描述作品播放进度上的留存，`second` 为播放到的秒数；它不是日历日期序列。

`data_details` 保留各来源的每日数据，`trend` 是全部来源的每日统计，二者不能相加。不存在来源时明细返回 `[]`；来源存在但某项指标未提供时保留 `null`。同名但 ID 不同的来源保持独立，净变化指标中的负数原样保留。

## Agent / 技能接入

调用方先用 `bycli list -f json` 动态发现 `weixin-channels`，再查看相应命令的 `--help`；采集命令使用 `-f json`。浏览器桥接按调用方技能的统一入口预检，适配器自行管理 TAB，无需预先运行 raw browser 命令。

`weixin-channels` 是视频号统计命名空间。`bycli weixin` 的公众号登录 Runner 不接受它，不能将命令改写成公众号命令。`post-detail` 的结果为对象数组，明细位于第一项的 `data_details`，调用方应完整保存嵌套 JSON。

通过 `knowledge-collection` 归档时，统计 JSON 可作为会话 `raw/` 下的原始证据；正式物化产物仍须符合该技能的 Markdown 与 sanitized 目录契约。统计数据不属于公众号文章全文，不能交给公众号下载 materializer 或标记为 `full-text`。完整归档流程还需要上游提供 Session Root 和合法的采集会话；这里只提供网站执行层的结构化数据。

## 会话与登录

会话凭据从当前浏览器内的后台请求获取，仅保留在命令内存中。Cookie、会话标识和请求签名不写入文件、不出现在结果中。

登录失效时在视频号助手重新扫码，确认当前账号后重试。命令沿用后台允许的访问范围和数据可用性。
