import { cli, Strategy } from '@sovovs/bycli/registry';
import { downloadVideo, validateDownload } from './_shared/download.js';
export const videoDownloadCommand = cli({
  site: 'baijiahao', name: 'video-download', access: 'read', domain: 'baijiahao.baidu.com', strategy: Strategy.UI,
  browser: true, navigateBefore: false, description: '下载公开可播放的百家号/好看视频；不限定本人账号，不接受草稿预览，不覆盖已有文件',
  args: [
    { name: 'url', positional: true, required: true, help: '正式百家号 /s、mbd videolanding 或好看 /v 链接' },
    { name: 'output', required: true, help: '本地输出目录；下载遵循 Node 的现有代理/NO_PROXY 配置' },
    { name: 'timeout', type: 'int', default: 60, help: '元数据/下载等待秒数，1–600' },
  ], validateArgs: validateDownload,
  columns: ['id', 'title', 'sourceUrl', 'path', 'bytes', 'durationSeconds', 'width', 'height', 'sha256'],
  func: downloadVideo,
});
