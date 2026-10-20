# ima 知识库

以下命令和参数对应当前 byCLI 命令清单。使用前可运行 `bycli ima <command> --help` 查看完整选项。

知识库读取依赖已登录的 Chrome 和 Browser Bridge；部分桌面回退能力仅适用于 macOS。下载命令要求知识库及文件标题精确匹配；重名文件需指定媒体编号。

## `download`

下载 ima 知识库中的完整原始文件（Linux 无需 IMA App）

```bash
bycli ima download <knowledgeBase> <file> --help
```

| 参数 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `knowledgeBase` | 是 | — | 知识库名称或 ID |
| `file` | 是 | — | 文件标题 |
| `--output` | 否 | . | 输出文件或目录 |
| `--mediaId` | 否 | — | IMA mediaId，用于精确定位 |
| `--viewerUrl` | 否 | — | 已打开的 IMA 查看器 URL（含 originUrl 签名参数；Linux 可省略） |

返回字段：`path`, `title`, `contentType`, `size`, `sha256`, `pages`。可使用 `-f json` 保留结构化输出。

## `knowledge`

按名称或 ID 获取 ima 知识库中的文章标题、URL 与文件夹路径

```bash
bycli ima knowledge <knowledgeBase> --help
```

| 参数 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `knowledgeBase` | 是 | — | 知识库的完整名称或 ima 页面中的 knowledgeBaseId |

返回字段：`knowledgeBaseId`, `knowledgeBase`, `folderPath`, `title`, `url`, `contentType`, `addedDate`, `mediaId`, `mediaType`, `mediaState`, `mediaAuditStatus`, `mediaTypeInfo`, `sourcePath`, `jumpUrl`, `createTime`, `updateTime`, `lastModifyTime`, `lastOpenTime`, `fileSize`, `abstract`, `introduction`, `tags`, `isTop`, `accessStatus`, `accessStatusUpdateTs`, `parseProgress`, `parseErrInfo`, `summaryState`, `coverUrls`, `logo`。可使用 `-f json` 保留结构化输出。

## `knowledge-list`

获取全部 ima 知识库的常用字段与原始元数据

```bash
bycli ima knowledge-list --help
```

返回字段：`id`, `name`, `type`, `typeName`, `raw`。可使用 `-f json` 保留结构化输出。
